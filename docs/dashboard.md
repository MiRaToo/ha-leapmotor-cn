# 仪表盘与图表

集成自带五张前端卡片（安装后自动注册为 Lovelace 资源，在任意仪表盘里直接添加即可）
与足够的实体数据，可以组合出 App 里那几张图。下面是一份参考布局与每张卡的详细用法：

| 卡片 | 数据来源 | 类型 |
|---|---|---|
| **车辆位置** | `device_tracker.*_che_liang_wei_zhi`(车况信号 2/3 的经纬度) | `custom:leapmotor-map`(集成自带的高德底图卡) |
| **里程 / 能耗** | 逐日里程(自记, 缺则云端)与逐日耗电(官方 getEC 拆分 + 自记兜底) | `custom:leapmotor-energy`(集成自带的折线卡) |
| **车况** | 电量 / 续航 / 充电状态 / 车辆状态 / 车内温度 / 状态更新时间 / 门锁 / 健康充电 | `entities` |
| **胎压(bar)** | 四个 `sensor.*_tai_ya_*`(车端 kPa 已换算) | `entities` |
| 车辆控制 | 门锁/空调/座椅/加热/充电/按钮 等实体 | `entities` |
| 能耗概览 | 百公里能耗 / 排名 / 每周明细(Jinja 读 `weeklyEC` 属性) | `markdown` |
| 驻车照片 | `image.*_zhu_che_zhao_pian` | `picture-entity` |

## 里程 / 耗电卡(`custom:leapmotor-energy`,按天折线)

**为什么按"天"画**: 里程、耗电这类数据只在天的粒度上有意义 —— 把轮询采样点直接连成线,
反映的是轮询节奏而不是车用了多少。这张卡按自然日聚合:

```yaml
type: custom:leapmotor-energy
title: 里程 / 耗电        # 可选, 不填就只显示摘要
range: week              # 可选, week(默认) | month; 用户点过[周]/[月]后会记住
show_mileage: true       # 可选, 默认 true(蓝线, km)
show_energy: true        # 可选, 默认 true(橙线, 每日 kWh)
show_efficiency: true    # 可选, 默认 true(绿线, 百公里能耗 kWh/100km)
```

* 共享横轴(日期)。三条线各自独立开关(至少留一条): **里程(蓝, km)**、
  **耗电(橙, 每日 kWh)**、**百公里能耗(绿, kWh/100km)**; 点某天会浮出当天所有可见数值
  (各指标**逐行**显示; 耗电那天如果有官方拆分, **驱动 / 空调 / 其它 合在同一行**, 以「·」分隔)。
  图表最多标两根刻度轴(按 里程 → 耗电 → 百公里能耗 的顺序分配左/右, 颜色跟着线走),
  三条全开时第三条不标刻度 —— 点一下看精确值即可;
* **耗电(橙)用官方 getEC 逐日拆分**(`getLastweekEC` 传任意窗口, 与官方 App 的周报同源;
  驱动/空调/其它, **不含驻停/待机**)。已完结的日子服务端只拉一次并持久缓存 —— 月视图
  第二次打开零请求; 没补完的天卡片右下角标「官方数据补拉中(N 天)」并自动续拉(分批取数);
  官方缺的日子用本机自记 ΔSOC 兜底(卡片上不标注数据来源);
  ⚠️ 不再用云端 `mileage/energy/detail` 的逐日 `accumulatedEnergyConsume` ——
  实测该字段不可靠(逐日为 0、求和远小于官方聚合), 详见 `docs/PROTOCOL.md`;
* **里程(蓝)优先本机自记行程**(与行程卡同口径: 按行程结束时刻归日, 0.1 km 级),
  自记没覆盖的日子退回云端逐日里程(整数 km)。**集成安装前的日子是空档**(折线断开);
* **百公里能耗(绿)** = 当日耗电(同上, 官方优先) ÷ 当日里程; 里程不足 0.5 km 的日不给;
* 官方数据拿不到、或没有新版集成(命令未注册)时: 整卡退化为读「近7天里程」传感器的属性 ——
  不会出现"配置错误"。

## 上周能耗卡(`custom:leapmotor-lastweek`,能耗拆分)

上一整周(周一~周日)的能耗拆成 驱动 / 空调 / 其它 —— 数据来自云端官方
`getLastweekEC`(与官方 App 的周报同源), 集成按需取(打开卡片时读, 缓存 1 小时,
周一零点自动翻篇; 右上角刷新按钮可强制重取):

```yaml
type: custom:leapmotor-lastweek
title: 上周能耗        # 可选
```

* 一根**按比例分段的堆叠条**(蓝=驱动 / 青=空调 / 灰=其它), 下面三行给各自的 kWh
  与占比, 底部是合计;
* 头部标注数据所属的周窗口(如「9月21日 – 9月27日」), 右下角是获取时间;
* 云端返回字符串数值; 缺字段显示 "—"(与真实的 0 区分), 拿不到时保留上次数据并注明;
* 老版本集成(命令未注册)只在卡片上给一行提示, 不是"配置错误"。

> 注意: 接口名叫 `getLastweekEC`, 但**实测支持任意窗口**(单日窗口也能查);
> 传任意区间都会按窗口返回; 窗口终点晚于"现在"回 `code=2`, 该窗口没行驶能耗回
> `code=100 未找到数据!`。本周起「里程/耗电卡」的逐日耗电就靠它(每天一次单日窗口)。
> 这张「上周能耗」卡仍只取整周窗口 —— 那是它的产品语义(周报), 不是接口限制。

## 想要更像 App 的"复合卡片"(柱状图 + 折线同一张)

用 HACS 装 `apexcharts-card` 后, 把下面这段贴到自己的仪表盘:

```yaml
type: custom:apexcharts-card
header:
  show: true
  title: 近 7 天里程与能耗
graph_span: 7d
span:
  end: day
series:
  # 逐日里程: 用里程传感器的每日变化量做柱状
  - entity: sensor.ling_pao_c10_123456_zong_li_cheng
    name: 每日里程(km)
    type: column
    group_by:
      func: diff
      duration: 1d
  # 逐日能耗(旧法): 直接用"近7天能耗"的历史做折线
  - entity: sensor.ling_pao_c10_123456_jin_7tian_neng_hao
    name: 近7天能耗(kWh)
    type: line
    curve: smooth
```

## 周能耗分布(bar + 周百公里能耗)

`百公里能耗` 传感器带 `weeklyEC` 属性(每周的 `hundredKmEC`), 用 markdown 卡片即可列表展示
(自带仪表盘里已经这样做了); 想画成柱状可以把每周值写进模板传感器, 或直接用
`apexcharts-card` 的 `data_generator` 读属性:

```yaml
type: custom:apexcharts-card
header: {show: true, title: 每周百公里能耗(kWh/100km)}
graph_span: 8w
series:
  - entity: sensor.ling_pao_c10_123456_bai_gong_li_neng_hao
    name: 周百公里能耗
    type: column
    data_generator: |
      return entity.attributes.weeklyEC.map((w) => [new Date(w.weekStart).getTime(), w.hundredKmEC]);
```

## 车辆位置(地图)

集成自带一张地图卡 `custom:leapmotor-map`, **底图用高德**:

```yaml
type: custom:leapmotor-map
entity: device_tracker.ling_pao_c10_123456_che_liang_wei_zhi
zoom: 17          # 可选, 3~18, 默认 16
height: 320       # 可选, 卡片高度 px
satellite: false  # 可选, true = 卫星影像
follow: true      # 可选, 车动了自动居中(手动拖动后自动关掉)
```

### 为什么不用 HA 自带的 `type: map`

自带地图卡只能选 OpenStreetMap / Google 两种图源。`tile.openstreetmap.org`
**在国内网络基本连不上**(实测 HA 主机 curl 它 12 秒超时, 而高德瓦片 55 ms 返回),
于是地图卡就只剩一个图标、没有任何底图。这张卡直接取高德瓦片
(`webrd0x.is.autonavi.com`, 带中文路名), 国内秒开; 连不上高德时自动回落到 OSM。

卡片的 JS 由集成注册成前端模块(见 `custom_components/leapmotor/__init__.py` 的
`async_setup`), **不需要 HACS、不需要往 `www/` 拷文件、不需要手动加资源**。

### 坐标基准: 卡片自动换算, 用户不用管

集成对外发布的是 **WGS-84**(HA 地图/区域/手机的口径), 而**高德瓦片是 GCJ-02**,
两者在国内相差 300~500 米。所以卡片绘制前会**自动把 WGS-84 换算成 GCJ-02**, 车标才落在
高德底图的正确位置 —— 实图对照: 换算后正好落在马路边; 不换算会偏到几百米外的空地里。

* 卡片默认按 `coordinate_system: auto` 判断: 实体属性里声明 `GCJ-02` 就不换算, 否则按 WGS-84 处理
* 也可以显式写 `coordinate_system: wgs84` 或 `gcj02`
* 车端原始坐标(GCJ-02)在 `device_tracker` 的 `latitude_gcj/longitude_gcj` 属性里

### 实体可以不用填

从卡片选择器添加时, 卡片会**自动找到车辆位置实体**(本集成的 `device_tracker`);
找不到时也只在卡片上显示一句提示, 不会出现"配置错误"。想指定别的实体再手动填 `entity:`。

### 在卡片上直接画区域(围栏)

卡片右上角的 **＋** 可以在**当前地图上创建 HA 区域(zone)** —— 这是国内可用的可视化做法
(HA 原生区域编辑器依赖 OpenStreetMap 底图,国内常加载不出来):

* 面板弹出后地图中心自动上移, 并用**准星**标出"即将圈住的位置"(不会被面板挡住)
* 填名称(默认「停车位」)/半径 → 选「用地图中心」(拖地图对准准星)或「用车的位置」→ 点「创建区域」
* 已有区域会**自动画成蓝色圆圈**显示,一眼看出车在不在里面
* 提交给 HA 的坐标是 WGS-84(卡片内部自动换算),与手机定位、原生区域同一口径
* 右上角 **☰** 是**管理区域**:列出所有用界面建的区域,可「定位」(把地图移过去)与「删」
  —— 删除是**二次确认**(点一下变「确认删」,再点才真删,3 秒不点自动复位),不用再去 HA 设置里翻

实体属性里还带 `odometer`(总里程)、`speed`(车速)、`vehicle_state`(行驶/驻车),
以及三个原始坐标信号(`raw_latitude/raw_longitude` = 2/3, `alt_*` = 3724/3725),
万一定位异常可以对照排查。

## 车况卡片(电量 / 续航 / 胎压 / 更新时间)

```yaml
type: entities
title: 车况
state_color: true
entities:
  - entity: sensor.ling_pao_c10_123456_dian_liang
    name: 电量
  - entity: sensor.ling_pao_c10_123456_xu_hang
    name: 续航
  - entity: sensor.ling_pao_c10_123456_chong_dian_zhuang_tai
    name: 充电状态
  - entity: sensor.ling_pao_c10_123456_che_liang_zhuang_tai
    name: 车辆状态
  - entity: sensor.ling_pao_c10_123456_che_nei_wen_du
    name: 车内温度
  - entity: sensor.ling_pao_c10_123456_zhuang_tai_geng_xin_shi_jian
    name: 状态更新时间
```

> 电量/续航/胎压这类数值传感器都带 `MEASUREMENT` 状态类, 会被 HA 记入长期统计 ——
> 想画"近 7 天电量曲线"直接用 `history-graph` 或 ApexCharts 选这几个实体即可。

> 数据字段与信号表见 [PROTOCOL.md](PROTOCOL.md) §4 与 §5。


## 行程记录(轨迹 + 每趟的数据)

集成自己记录行程(原理与参数见 [trips.md](trips.md)),仪表盘上有两种看法:

### 行程浏览卡片(推荐)

```yaml
type: custom:leapmotor-trips
overlay_count: 5      # 可选: 叠加显示最近 5 段轨迹
```

左边是按天分组的行程列表(时间/时长/里程/能耗,补记与失联会标记),点一段就在右边地图上
画出它的轨迹(起终点标记、断档虚线)与数据面板;支持"叠加最近 N 段"和两步确认删除。

> **看轨迹请用「行程浏览」卡**(上面那张): 地图卡只画车标与围栏, 不再画最近一段行程的
> 轨迹 —— 一张卡专注一件事(地图卡负责看位置/建围栏, 行程卡负责轨迹与历史)。
> 轨迹点仍在 `sensor.*_xing_cheng_gui_ji` 实体的属性里, 自动化或自己写的卡片可以直接用。

### 用 Jinja 自己拼一个"行程摘要"

```yaml
type: markdown
title: 最近行程
content: |
  {% set a = state_attr('sensor.ling_pao_c10_123456_zui_jin_xing_cheng', '开始') %}
  {% set b = state_attr('sensor.ling_pao_c10_123456_zui_jin_xing_cheng', '结束') %}
  最近一段: {{ a }} → {{ b }}
  里程 {{ states('sensor.ling_pao_c10_123456_zui_jin_xing_cheng') }} km,
  耗电 {{ state_attr('sensor.ling_pao_c10_123456_zui_jin_xing_cheng', '耗电_kwh') }} kWh,
  百公里 {{ state_attr('sensor.ling_pao_c10_123456_zui_jin_xing_cheng', '百公里能耗_kwh') }}

  今日 {{ state_attr('sensor.ling_pao_c10_123456_xing_cheng_tong_ji', '今日') }}
  近7天 {{ state_attr('sensor.ling_pao_c10_123456_xing_cheng_tong_ji', '近7天') }}
```


## App 风格控制卡(`custom:leapmotor-control`)

集成自带一张"照着官方 App 主界面做"的控制卡:顶部车况(状态徽标 / 电量 / 续航 / 锁 / 更新时间;
**增程车在总续航下方直接给出「纯电」「燃油」两个小胶囊**),中间是**车模**——
默认按**你的车型**显示官方实车图(**所有车型优先按 VIN 从官方接口获取**);
官方图加载失败时回退内置车型图(**C10 / C01 / T03 是正俯视**、车头朝左;
**C16 / B10 / C11 是官方 3/4 视角**); 未收录车型或内置图加载失败时显示跨界 SUV 简笔画。
点右下「胎压」按钮
可在车模四角叠加四轮胎压(**按方位**显示、越界标黄/红; 俯视图会按车头朝向正确映射左右),
下面依次是四个圆钮(解锁·上锁 / 后备箱 /
车窗 / 遮阳帘)、空调卡与位置卡、以及充电 / 座椅与加热 / 燃油(增程) 这几个**默认收起**的块
(点标题行展开)。

- **车窗**点圆钮后弹出一个**气泡**选四档(全开 / 微开 / 半开 / 关),点外部或选完自动收起;
- **解锁、上锁、后备箱**都会**二次确认**;行驶中这些动作按钮禁用;
- **位置卡**:在区域内显示区域名,不在任何区域时显示「**外出**」,并把驻车照片作为卡片背景
  (照片只在泊车时拍一次, 上传晚的话集成会自动重试);
- 空调卡用中文显示模式(制冷 / 制热 / 送风 / 除湿 / 自动 / 关),风扇图标即开关。

```yaml
type: custom:leapmotor-control
# 只有一辆车时下面这些都可以省
# device: <device_id 或该车任一实体 id>
# name: 我的零跑
# show: [hero, actions, climate, seats, charging, fuel, tires, trip, location]
# compact: true          # 紧凑模式: 不显示车模上的胎压开关
# tire_range: [2.2, 2.6] # 胎压告警区间(bar), 留空则只显示数值
# entities: {battery: sensor.xxx}   # 逐项手工覆盖
```

**它怎么认实体**:按"设备 + `translation_key`"—— 本集成所有实体都带稳定的机器键,所以卡片不怕
改名/换语言;注册表读不到时会退化为按名字猜并在卡片顶部提示,也可以用 `entities` 手工指定。

**多车型**:面板**按键解析到了没有显示** —— 纯电车不会出现"燃油"这一块,五座车不会出现二排/三排座椅,
七座车的三排只显示加热(没有通风)。这正是集成后端"按能力位/车端信号决定实体是否存在"的延续:
**后端是唯一判据,前端只做"有就画"**。
