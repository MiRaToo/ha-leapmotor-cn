# 零跑汽车云 API 协议

> 本文是**结论性**文档:接口怎么发、字段是什么、坑在哪。验证过程与内部笔记不在此公开。
>
> 所有结论都在真实账号 + 真车(C10,2026 款)上实测过。**接口随时可能被服务端改动**,以实测为准。

## 1. 服务拓扑

一共三套服务,域名和前缀都不同,别记混:

| 用途 | 基址 | 前缀 |
|---|---|---|
| 账号(登录/验证码/用户信息) | `https://appuser.leapmotor.cn` | `/app-user` |
| 全局服务(车辆列表/车端交换/车路由) | `https://app-gw-global-master.leapmotor.com` | `/app/app-global-service` |
| 车控(指令/车况/配置/里程) | `https://appgateway.leapmotor.com` | `/carownerservice` |
| **车况信号** | `https://appgateway.leapmotor.com` | `/app/app-signal-service`(注意不在 `carownerservice` 下) |

备用/其它环境:`app-gw-global-slave.leapmotor.com`、`app-front-gateway.leapmotor.com`、
`apptec.leapmotor.cn`、`lpservice.leapmotor.cn`、`mqtt-center.leapmotor.cn`。

## 2. 登录(两步,纯 HTTP)

### 2.1 发短信验证码

```
GET https://appuser.leapmotor.cn/app-user/applogin/compliance/sendmessagecode?phoneNo=<明文手机号>
```

返回 `code=200` 表示已发送。常见错误码:`36` 发送过于频繁、`1023` 环境被风控(冷却)。

### 2.2 手机号 + 验证码登录

```
POST https://appuser.leapmotor.cn/app-user/applogin/check_login_with_phone
Content-Type: application/x-www-form-urlencoded

phoneNoCiphertext=<RSA 加密的手机号>&smsCode=<验证码>&os=android&pageUrl=精选&deviceID=<设备号>
```

* 手机号用 **RSA/ECB/PKCS1Padding** 加密后 base64url(公钥见 `poller/api_client.py` 的 `RSA_PUBLIC_KEY`)
* 成功:`data.appLoginVO = {accountId, token, refreshToken, tokenExpireTime, signParam{r2,r3}}`
* **`token` 只有约 6 小时**(`tokenExpireTime`),但可以**免短信续期**(见 §2.4)

### 2.4 账号 token 免密续期(重要)

```
GET https://appuser.leapmotor.cn/app-user/appuseroperate/getnewtoken
    ?timespan=<毫秒>&nonce=<随机数>&deviceID=<登录时的设备号>
    &accountId=<accountId>&accountNumber=<RSAurl(手机号)>
    &signStr=<MD5(排序拼接六值)[8:24]>
XFX-CDN-CROSS-REFRESH-NODE: <refreshToken>
```

* **refreshToken 走请求头** `XFX-CDN-CROSS-REFRESH-NODE`(不是 query/body);缺这个头会直接 500
* 签名串 = `{accountId, accountNumber, deviceID, nonce, refreshtoken, timespan}` 六个值按 key
  字典序拼接后取 **MD5 十六进制第 8~24 位**;`refreshtoken` 只参与签名、不作为参数发送
* `deviceID` 必须与**登录时**一致(服务端把 refreshToken 绑在登录设备上),否则 `code=45 refreshtoken失效`
* 账号 token 头(`XFX-CDN-CROSS-NODE`)服务端**不校验** —— **已过期的账号 token 也能救回来**
* 响应:`{"code":200,"data":{"token":<新 token>,"refreshToken":<原值>,"tokenExpired":"21600"}}`
  —— **refreshToken 不轮换**,只要它自身有效就能无限续期(6 小时 → 长期免登录)

### 2.3 车端交换(账号 token → 车端 JWT)

```
POST https://app-gw-global-master.leapmotor.com/base/base-user/account/v1/login
Content-Type: application/json; charset=utf-8

{"identifier":"<accountId>","security":"<账号 token>","identifierType":"1"}
```

返回 `data = {accessToken(车端 JWT), refreshToken, signParam{r2,r3}, encryptParam{r2,r3}}`。

**这个端点的签名是 SHA256(不是 HMAC)**,因为此时还没有签名密钥:

```
sign = SHA256( 排序拼接( 6 个基础头 ∪ nonce ∪ body 的三个字段 ) ).upper()
```

车端 `accessToken` 有效期 **2 小时**;到期后用账号 token 重新交换即可(不需要短信)。

## 3. 请求头与签名

### 3.1 头

**参与签名**的 7 个:

| 头 | 说明 |
|---|---|
| `acceptLanguage` | `zh-CN` |
| `channel` | `1` |
| `deviceType` | `Android` |
| `source` | `leapmotor` |
| `timestamp` | 毫秒 |
| `version` | App 版本(如 `1.22.98`) |
| `deviceId` | 设备号(32 位 hex) |

**不参与签名**:`token`(车端 JWT)、`userId`、`carvin`、`cartype`、`x-region`、`x-subversion`、
`x-api-signature-version`。

### 3.2 签名

```
merged = 签名头 ∪ 业务参数(查询串或表单字段)
sign   = HMAC-SHA256(HKDFKey, 按 key 排序后只取 value 顺序拼接).hexdigest()
```

`sign` 与 `digest` 两个头都填同一个值。

### 3.3 签名密钥派生

```
HKDFKey = base64url_decode(signParam.r2) XOR base64url_decode(signParam.r3) XOR base64url_decode(carJWT.split(".")[2])
```

取三者最小长度逐字节异或 —— 纯 Python 可复现,不需要模拟器。车端 token 重新交换后密钥随之变化。

## 4. 车况(全量信号)

```
POST https://appgateway.leapmotor.com/app/app-signal-service/signal/info/query
Content-Type: application/x-www-form-urlencoded

vin=<VIN>
```

返回:

```json
{"code":0,"data":{"vin":"…","collectTime":1790456795283,
  "signalMap":{"2":120.125678,"3":30.281234,"100003":36.9,"1318":12345,"2646":247}}}
```

* `collectTime` = **状态更新时间**(服务端采集时刻,ms);`signalMap.sts` 是车端上报时刻
* `signalMap` 是 `{信号号: 值}` 的裸表,90+ 项 —— 翻译表见 `poller/api_client.py` 的 `SIGNAL_IDS`
* 客户端封装:`LeapmotorClient.get_car_state()` → `CarState`

**注意**:路径不在 `/carownerservice` 下、必须用 **POST**(GET 会 404 或落到默认页)、
`/carownerservice/acct/...` 之类的路径在国内网关上不存在。

### 4.1 关键信号表(完整表见代码)

| 信号 | 含义 | 说明 |
|---|---|---|
| `2` / `3` | 经度 / 纬度 | **基准是 GCJ-02**(火星坐标),与高德/腾讯底图一致;集成对外发布时自动换算成 WGS-84(见下) |
| `3724` / `3725` | 经度 / 纬度(仅绝对值) | 回落用;南半球会丢负号 |
| `2190` / `2191` | 旧版经纬度 | 再回落 |
| `100003` / `1204` | 电量 %(精确 / 整数) | |
| `3260` / `2188` | 剩余续航 km | |
| `3257` | CLTC 续航 km | |
| `1318` / `1319` | 总里程 km / 车速 km/h | 总里程与里程接口交叉验证过 |
| `1010` | 档位(1,3=行驶;0,2=驻车) | |
| `1298` | 车门锁(1=已锁,0=未锁) | |
| `2646/2653/2660/2667` | 四轮胎压 kPa(左前/右前/左后/右后) | 除以 100 得 bar |
| `2641/2648/2655/2662` | 四轮胎压报警位 | |
| `1149` / `1197` | 充电枪连接 / 直流枪 | `1149` 取值: **1=充电中 / 2·3·4=已插枪**(2=待机, 3·4=预约等待) / **0=未插枪 / 5=非连接**。判「是否插枪」用**白名单 {1,2,3,4}** —— `5` 会在未插枪驻车时与 `0` 交替出现, 不能视为插枪(实测)。|
| `1177` / `1178` | 充电电压 V / 电流 A | |
| `1200` | 剩余充电分钟 | |
| `1182` / `1186` | 电池最低温 ℃ / 电池加热中 | |
| `48` | 健康充电开关 | |
| `1938` / `3713` | 空调开关 / 空调模式(0关 1极速冷 3极速热 4换气) | |
| `2183` / `2184` | 空调设定温度(左/右) | |
| `1349` | 车内温度 ℃ | |
| `2100/2101/2118/2119` | 主驾加热/通风、副驾加热/通风(0~3) | |
| `1624` | 方向盘加热剩余分钟(>0 视为开) | |
| `49` / `50` | 左 / 右后视镜加热 | |
| `1693/1694/1695/1696` | **四车窗状态**(0=关, 2=开) | 本车实测: 发"开窗"后四条一起变 2(四窗全开), 关窗后 20 秒内回到 0 |
| `3727/3728/1879/1880` | 四车窗开度 % | ⚠️ EU 表用这几个, 但**本车恒为 0** —— 判断车窗请用 `1693~1696` | |
| `3235` / `3263` | **剩余燃油 %** / **燃油量(*毫升*)** | 增程车才有;3263 是毫升(48L 油箱报 45382) |
| `3256` / `3259` | **CLTC / WLTC 燃油续航** km | 增程车;工况由 `3262` 选(0=CLTC, 1=WLTC, 缺失按 WLTC) |
| `3258` / `3261` | **CLTC / WLTC 油电总续航** km | 增程车 App 主页那个大数字;`总续航 = 燃油 + 纯电` |
| `3257` / `3260` | CLTC / WLTC **纯电续航** km | 与 `2188`(纯电车表显)不是一回事 |
| `3262` | 当前工况 0=CLTC / 1=WLTC | 决定上面几组取哪一套 |
| `2956` | 燃油加热器油量档位 0~4 | 增程/带燃油加热器的车型 |
| `1879` / `1880` | **二排左 / 右座椅加热档位** | ⚠️ EU 表把这几个当"车窗开度", CN 车上是**后排座椅** |
| `3727` / `3728` | **二排左 / 右座椅通风档位** | 同上 |
| `12276` / `12277` | **三排左 / 右座椅加热档位** | C16 这类 6 座车;三排**没有**通风 |
| `644` / `645` / `865` / `866` | CN **车窗开度 %**(左前/左后/右前/右后) | 与状态位 `1693~1696` 配套 |
| `3636` / `3638` | **哨兵模式开/关**(0/1) / 驻车照片可用 | 用官方 App 开启哨兵后 `3636` 立刻 0→1(实测稳定), 状态位可信 |
| `1724` | **遮阳帘开度 %**(0=全关, 100=全开) | 实测跟随指令 `240`: 开 → 0→100, 关 → 0, 全量差分里只有它变。EU 表称「天窗开度」, 本车上就是遮阳帘 |
| `1941` / `1939` | 空调风速档位 / 自动or手动 | ⚠️ `1941` **不是**行驶状态 |

> ⚠️ 判断行驶状态请用 `1010` 档位 + `1319` 车速 —— 早期版本误用过 `1941`(那是空调风速)。
> **坐标系**:`signalMap` 里的经纬度是 GCJ-02(与官方 App、高德一致);集成的
> `device_tracker` **对外发布 WGS-84**(GCJ→WGS 换算,往返误差毫米级),这样 HA 地图、
> `zone` 区域、手机定位都在同一口径;原始值保留在属性 `latitude_gcj/longitude_gcj`。
> 自带的高德地图卡再反向换算回 GCJ-02 绘制。

> 未上报的信号(如 `6047/6048/12054` 限速识别、`2189` 自动泊车)在部分车型上才有 ——
> 这些已经在 `SIGNAL_IDS` 里备好, 车型支持时会自动出现。

### 4.2 含义尚未确认的信号

下面这些信号**车端会上报, 但目前没有权威命名**(官方 App 未公开, 公开资料里也没有对应字段)。
它们的值多为 0/1, 无法靠取值反推 —— 需要长期观察与实车验证。**欢迎社区补充**:

```
94  644  645  865  866  10111  1282  1943  1945  1949  3366  6469
11259  11260  11270  11271  14742  14743  14745  14746
```

集成把它们的原值放在 `CarState.raw` 里(不生成实体), 对齐后只需在 `SIGNAL_IDS` 里加一行。

## 5. 其它只读接口(实测可用)

| 数据 | 接口 |
|---|---|
| 车辆列表 | `GET /app/app-global-service/v1/vehicle/list` |
| 车路由(区域 + MQTT 主机) | `GET /app/app-global-service/v1/vehicle/getCarRoute?vin=` |
| 车辆配置(充电计划在 `config.3`) | `GET /carownerservice/v3/api/vehicleinfo/commonConfig?vin=` |
| 总里程 / 交付天数 | `GET /carownerservice/v3/api/drivingrecord/mileage/energy/detail?vin=` |
| 百公里能耗 + 排名 + 周明细 | `GET /carownerservice/v3/api/drivingrecord/getLastNweeks100kmECAndRank?carvin=` |
| 上周能耗拆分(驱动/空调/其它) | `GET /carownerservice/v3/api/drivingrecord/getLastweekEC?carvin=&begintime=&endtime=` |
| 近 7 天逐日里程/能耗 | `GET /carownerservice/v3/api/drivingrecord/mileage/energy/detail?vin=&begintime=&endtime=` |
| 驻车照片 | `GET /carownerservice/v3/api/chassis/query?vin=` |
| 3D 车模 | `GET /carownerservice/v3/api/carpicture/3d/key?vin=` |
| 未读推送数 | `GET /carownerservice/v3/api/push/record/unread?carvin=` |

> 字段名不统一:里程明细用 `vin`,能耗类用 `carvin`,传错会报"缺少参数"。
> **子账号被权限挡住**(`code 40`):OTA 版本、定时任务 `schedule/*`、车辆共享成员列表。

## 6. 车控

```
POST https://appgateway.leapmotor.com/carownerservice/v3/api/appremotectl
Content-Type: application/x-www-form-urlencoded

cmdid=<指令码>&state=<JSON 对象字符串>&carvin=<VIN>&nonce=<随机数>&oppwd=<加密后的操作密码>
```

两步:先 `POST v3/api/appoperate/verifyoperatepwdnew`(表单 `vin` + `oprpwd`)校验密码,
通过后再发指令。`state` 必须是 **JSON 对象且枚举值是字符串**(`{"value":"lock"}`),写错车不执行。

### 6.1 操作密码(oppwd)的编码

```
oppwd = base64( AES-128-CBC( PKCS7(PIN), key = md5(车端JWT[:32])[8:24], iv = md5(车端JWT[32:64])[8:24] ) )
```

* 明文、完整 MD5、RSA 等其它写法实测都被服务端拒绝
* 密码由服务端校验,**连错 3 次锁定 5 分钟**(`code 70`)

### 6.2 指令码(cmdId)

App 权限表(`assets/allcarper.json`)只列了 16 项,但车端支持的更多:

| cmdId | 功能 | state 形状 |
|---|---|---|
| 110 | 车门 | `{"value":"lock"}` / `{"value":"unlock"}` |
| 120 | 寻车鸣笛 | `{"value":"true"}` |
| 130 | 后备箱 | `{"value":"true"/"false"}` |
| 160 | PTC 预热 | `{"value":"ptcon"/"ptcoff"}` |
| 170 | 空调 | 开: `{"operate":"manual"/"auto","circle":"out","mode":"wind","position":"all","temperature":"26","windlevel":3,"wshld":"0"}`<br>关: `{"operate":"off",…同上字段…,"wshld":"1"}` —— ⚠️ **是 `"off"` 不是 `"close"`**: 实测 `"close"` 云端 `code=0` 但车端**毫无反应**(读信号 1938 不变), `"off"` 18 秒内关掉。官方 App 里 `"close"` 这个取值一次都没被用到过 |
| 190 | 预约充电 / 充电上限 | 充电计划对象(见 §6.3) |
| 230 | 车窗 | `{"value":"0"/"2"/"5"/"10"}` —— **刻度是 0~10, 四档**: `0`=关, `2`=微开(≈20%), `5`=半开(≈50%), `10`=全开。<br>证据: EU 版在 B10 上量出 "only 0 / 2 / 5 / 10 move the car"(其余取值云端回"请求成功"但车不动);我们在 C10 上复核 `100`/`1` 车不动、`0`/`2`/`5`/`10` 都能让车动。<br>⚠️ 车端**只回报开/关一位**(`1693~1696`: 0=关, 非 0=开), 量不出开度 —— 开度大小只能人眼确认 |
| 240 | 遮阳帘 | `{"value":"10"/"0"}` |
| 301 | 座椅加热 | `{"position":"driver","level":"0~3"}` |
| 320 | 方向盘加热 | `{"level":"2"}` 开 / `{"level":"1"}` 关 |
| 370 | 座椅通风 | `{"position":"driver","level":"0~3"}` |
| 440 | 后视镜加热 | `{"value":"2"}` 开 / `{"value":"1"}` 关 |
| 480 | 健康充电 | 用专用接口 `v3/api/healthyCharging/control`(表单 `carvin`+`state`+`oppwd`) |

> 健康充电用专用接口更可靠;`480` 作为 cmdId 也"受理"但不一定执行。
> 座椅/方向盘/后视镜这三个的 state 形状来自 EU 版在真车上的验证;
> **空调关(`operate:"off"`)与车窗四档已在真车上复核过**(见 §6.2)。

### 6.2.1 真车复核结果

逐条"读车端信号 → 发指令 → 轮询信号确认 → 恢复原值", 10 项结果:

| 指令 | 读的信号 | 结论 |
|---|---|---|
| 130 后备箱 | `1281` 0→1 | ✅ |
| 301 主驾座椅加热 | `2100` 0→2 | ✅ |
| 301 副驾座椅加热 | `2118` 0→2 | ✅ |
| 370 主驾座椅通风 | `2101` 0→2 | ✅ |
| 370 副驾座椅通风 | `2119` →2 | ✅ |
| 320 方向盘加热 | `1816` 0→2 | ✅ |
| 440 后视镜加热 | `49`/`50` 0→1 | ✅ |
| 480 健康充电 | `48` 1→0 | ✅ |
| 170 空调开(26℃) | `1938` 0→1, `2183` 24→26 | ✅ |
| 170 空调**关** | `1938` 1→0 | ✅ 前提是用 `"off"`(用 `"close"` 则无效) |
| 哨兵(旧码 220) | `3636` | ❌ 当时用 `220` 发的: 云端 `code=0` 但车端 6 分钟毫无变化。**后来查明 220 是错的, 正确的是 400**(见下一行) |

> 复核方法(可复现): 直接调 `LeapmotorClient.remote_control` 并读
> `get_car_state().raw[信号号]`, 与上表逐条对照。

### 6.3 逐条行程 / 帧身份 / 驻车照片(实测)

为做行程记录而验证的三件事(全部只读):

| 验证项 | 结论 |
|---|---|
| **云端逐条行程** | `mileage/energy/detail`(带毫秒窗口)的 `detail[]` 里**确实有 `drivingRecordList` 字段, 但恒为空数组**。与官方 App 里的文案「因相关法规规定, 不再提供查看里程详情功能」一致 → **云端拿不到逐条行程**(起止地点名/单次能耗都没有), 行程只能自记录 |
| **帧身份** | 车端上报时刻 `sts` 在停车/休眠时**保持不变**, 而 `collectTime`(服务器取数时间)每次都变 → 判断"这一帧是不是新数据"要用 `sts`, 不能用 `collectTime` |
| **驻车照片** | `chassis/query` 除 `fileUrl` 外还返回 **`uploadTime`**(照片上传时刻); 图片 URL 的签名是固定的、对图片发 HEAD 会 403(拿不到 ETag/Last-Modified)→ 判断"照片有没有更新"只能用 `uploadTime` |
| `getLastweekEC` 窗口 | ~~只认整周窗口~~ **已修正: 支持任意窗口**(接口名有误导)。实测: 单日窗口返回 `{"driverEC":"7.0","acEC":"0.5","otherEC":"0.9"}`; 两日/800 天窗口同样有效, 800 天 = 终身拆分(驱动 1310.8 + 空调 363.7 + 其它 201.9)。规则: ①**窗口终点晚于"现在"** → `code=2 请求参数含非法字符`(收敛到 min(now, 当日 23:59:59) 即可); ②**该窗口没有行驶能耗** → `code=100 未找到数据!`(过去的日子按真实的 0; 今天按"还没记到"处理, 回退自记); ③粒度只到"天"。集成里: 「上周能耗」卡用整周窗口; 「里程/能耗」卡的逐日耗电 = 每天一次单日窗口(见 `energy_daily.py`; 已完结的日子拉一次进持久缓存) |
| 每日能耗(云端逐日字段) | ⚠️ `detail[].accumulatedEnergyConsume` **实测不可靠, 不要用作"每日耗电"**: 核对(7 天窗口)逐日大量为 0(有 17 km 记 0、40 km 记 1 的日子), 求和 11 kWh vs 官方 getEC 同期 44.6; 30 天窗口里"沉淀"一个月的老日子也照样偏低(6~11 kWh/100km), 且与云端自家聚合(上周 driverEC 33.2、官方 19.2 kWh/100km)对不上。kerniger 版标它为 `energy_scope: presumed_driving_only` + `confirmed: false` 并警告"别当总消耗、别拿它算 kWh/100km"; mate 完全不用它。**要逐日耗电请用 getEC 任意窗口** |

**顺带修正一条旧记录**: §6.2.1 里"哨兵 `3636` 有延迟"的结论是错的 —— 用官方 App 开启哨兵后
`3636` 立刻由 0 变 1, 状态位一直很准; 当时不动是因为我们发错了指令码。

### 6.2.2 第二轮(B 组 4 项)

| 指令 | 读的信号 | 结论 |
|---|---|---|
| 240 遮阳帘 开 / 关 | `1724` 0→100→0 | ✅ 执行, 且**这就是它的状态信号**(可做状态回读 / 自动化) |
| 170 空调温度同步 | `2183` | ✅ 设 20 → 15 秒内 `2183`=20.0; 设 28 → 28.0。`2184`(右区)本车不上报, 实际舱温是 `1349` |
| 160 PTC 电池预热 | `1348`(ptc_power)/`1186` | ⚠️ **无法判定**: 云端 `code=0`, 但 3 分钟内 `1348` 恒为 0。当时电池 32℃、充电枪未插 —— 车端大概率按「条件不满足」拒绝执行(与 App 文案「当前温度良好, 不需要预热」一致) |
| 400 哨兵模式 | `3636` | ✅ 指令码已确认(`{"value":"on"/"off"}`); ⚠️ 本子账号未被授权 400 → `code=40 无此权限`, 因此未能在本车验证执行效果。App 端证据: 用官方 App 开启哨兵后 `3636` 立刻 0→1(状态位可信) |
| 170 空调**快捷模式**(极速降温/升温/除味/除霜) | — | ❌ **`code=40 无此权限`**, 5 次全部被拒(持久性)。授权清单 `rightList` 里有 170, 却仍被云端在分发前拦下 —— 判断是**子账号没有快捷模式的权限**, 需主账号或另行授权 |
| 120 寻车鸣笛 | 无状态信号 | 未做自动验证(凌晨会扰民) —— 需人工听/看 |
| 230 车窗四档 0/2/5/10 | `1693~1696` | ✅ 关→发值→状态位翻"开"→再关, 四档都能让车动;开度大小需人眼(见 §6.2 的 230 行) |

### 6.3 充电计划(充电上限 + 预约充电)

读:`GET v3/api/vehicleinfo/commonConfig?vin=` → `data.config["3"]`:

```json
{"percent":90,"isEnable":1,"beginTime":"00:00","endTime":"08:00",
 "cycles":"1,1,1,1,1,1,1","circulation":1,"recharge":1,"updateTime":"…"}
```

写:cmdId `190`,state 为同样字段的对象(保留未改动的字段)。

## 7. 会话寿命与已知限制

| 项 | 现状 |
|---|---|
| 账号 token | 约 6 小时,但**可免密续期**(§2.4),集成里自动做 —— 正常情况下不再需要短信 |
| refresh token | **不轮换**,自身有效期未知(失效时会提示重新认证);换 `deviceID` 会立即失效 |
| 车端 token | 2 小时,用账号 token 自动重新交换即可(无需短信) |
| 车端 refresh token | 7 天有效期,但对应的刷新接口签名参数未攻破,暂不使用 |
| 子账号权限 | 无 OTA / 定时任务 / 共享管理;车辆列表 `rightList` 给出被授权的 cmdId 清单 |

集成对会话过期的处理:提前 30 分钟发 HA 通知 → 过期后走 HA「重新认证」(一键 + 短信验证码,
验证码页面可原地重发),过期期间若车端 token 仍有效则继续服务(约多撑 2 小时)。

## 8. 数据来源与免责

* 全部接口由**用户自己的账号**在**自己的车**上调用,使用的是官方 App 的公开行为,未做任何绕过或攻击
* **请务必使用子账号**(主账号共享车辆给子账号):国内云单账号单会话,用主账号会把手机 App 顶下线
* 验证过程与内部笔记不随本仓库分发
