# 地理围栏与自动化(全部用 HA 原生功能)

> 目标:不写代码,只用 HA 自带的 **区域(zone)**、**距离(proximity)** 和 **自动化**,
> 做出"到家提醒插枪""离家检查车窗""车被移动提醒"这类功能。
>
> 前提:集成已装好,`device_tracker.车辆位置` 有坐标(见 [SETUP.md](SETUP.md))。

## 0. 三个原生积木

| 积木 | 作用 | 在哪 |
|---|---|---|
| **区域 `zone`** | 一个有名字的圆形范围(圆心 + 半径)。HA 用它给 `device_tracker` 定状态 | 地图面板 → 编辑;或 `configuration.yaml` |
| **`device_tracker.车辆位置`** | 状态就是"车在哪个区域":在家的范围内显示 `home`,在别的区域显示区域名,都不在显示 `not_home` | 集成自带 |
| **`proximity` 距离传感器** | 车离某个区域多远(km)、在靠近还是远离 | `configuration.yaml`(只支持 YAML) |

自动化里能用的触发器(都不需要写模板):
`区域(Zone)` 触发器(进入/离开)、`状态` 触发器、`数值` 触发器(距离小于 X)、`模板` 触发器。

## 1. 怎么画围栏(两种方式)

### 方式 A(推荐,国内一定能用):在集成自带的地图卡上画

集成自带的高德底图地图卡(**底图在国内能正常显示**,而 HA 原生地图依赖 OpenStreetMap,
国内常常加载不出来)现在支持区域:

1. 打开「零跑」仪表盘(或任意放这张卡的地方),地图右上角点 **＋**
2. 地图正中心一直有一个**准星**(小红十字)—— 它标的就是"地图中心"这个位置,
   面板不会挡住它(面板是紧凑的两行)
3. 填区域名称(默认「停车位」)和半径(默认 200 米)
4. 选位置:
   * **用地图中心** —— 拖动地图,把准星对准目标,再点它
   * **用车的位置** —— 把车停在目的地,点一下就圈住当前停车点(最省事)
5. 点 **创建区域** → 区域立刻出现在地图上(圆圈),HA 里也多了一个 `zone.xxx`

> 卡片读的是车端坐标并自动换算成 WGS-84 提交,所以圆圈和车标、手机定位都在同一口径。
> 已有区域会**自动画成圆圈**显示在地图上,方便你确认车在不在里面。
> 需要管理员权限(普通用户只能看,不能建)。
> **建错了想删?** 地图右上角 **☰** 就是「管理区域」:列出所有界面建的区域,
> 点「定位」把地图移过去、点「删」→「确认删」两步删除 —— 不用去 HA 设置里找。

### 方式 B:HA 原生区域编辑器

**地图面板 → 右上角铅笔(编辑)** → 拖动/新增圆圈。
HA 原生地图用的是 OpenStreetMap 瓦片 —— 如果你的网络加载不出底图(空白),
就用方式 A;或者把 `zone` 写进 `configuration.yaml`(见下)。

## 2. 把"家"设对(必做)

HA 出厂默认的"家"在**阿姆斯特丹**(52.373, 4.890)。如果你的 `zone.home` 没改过,
车会永远显示 `not_home`,任何围栏自动化都不会触发。

**先确认**:开发者工具 → 状态 → 找 `zone.home`,看中心坐标是不是你家(不在你家就按下面改)。

**家的坐标怎么来**(两个办法):

1. 把车停在家里 → 读 `device_tracker.车辆位置` 的 `latitude` / `longitude`(已是 WGS-84,可直接填)
2. 从历史里找最常停的位置:开发者工具 → 历史,选这个实体,看最密集的那一片
3. 或者最简单:**在地图面板上直接拖圆** —— 车标在哪,圆就画在哪

**怎么设**:

* **地图面板 → 右上角铅笔(编辑)→ 把 home 标记拖到你家**(最直观)
* 或者 `configuration.yaml`:

```yaml
zone:
  - name: 家
    latitude: 30.281234      # ← 用 device_tracker 报的经纬度(WGS-84)
    longitude: 120.125678
    radius: 200              # 150~300 米足够; 不用为了坐标系偏差放大
    icon: mdi:home
```

### 坐标系:集成已经帮你转好了

车端上报的是 **GCJ-02**(火星坐标,和官方 App、高德一致),而 HA 的地图、区域、
手机定位都用 **WGS-84** —— 同一地点两者相差约 **370 米**。

集成**对外发布的是 WGS-84**(自动换算,往返误差毫米级),所以:

* ✅ **直接在地图上拖一个圆当围栏就行** —— 车标、区域、手机都在同一套坐标里
* 车端原始坐标(GCJ-02)保留在属性 `latitude_gcj` / `longitude_gcj` 里,排查时用
* 自带的高德地图卡会**再换算回 GCJ-02** 显示(高德瓦片是火星坐标),所以地图上车标位置也准

> 也就是说:不需要任何手工换算,也不需要"把半径放大到 500 米"这种权宜做法。

## 3. 手把手:手动建一条自动化(不写 YAML)

以「**车到家 → 通知提醒插枪**」为例,全程在 HA 界面点几下:

1. **设置 → 自动化与场景 → 创建自动化 → 从空白自动化开始**
2. 点 **添加触发器** → 选 **区域(Zone)**
   * **实体**:`device_tracker.…_che_liang_wei_zhi`(车辆位置)
   * **区域**:选你刚建的那个(例如「停车位」/「家」)
   * **触发时机**:**进入**(离开就选「离开」)
3. 点 **添加动作** → 选 **通知**(手机要装 HA App 并登录同一账号)
   * **标题**:`车到家了`
   * **消息**(可以直接写模板):

     ```jinja
     电量 {{ states('sensor.ling_pao_c10_123456_dian_liang') }}%,
     续航 {{ states('sensor.ling_pao_c10_123456_xu_hang') }} km —— 记得插枪
     ```

     > 只想在 HA 侧边栏看到,就把动作换成 **持久通知(Persistent Notification)**。
4. 右上角 **保存** → 起个名字,例如「车到家提醒」。保存后自动化默认就是**启用**的。
5. **测试**:在自动化列表里点开它 → 右上角 **⋮ → 运行** —— 这会跳过触发器只跑动作,
   用来确认通知能收到;真实触发看同页面的 **跟踪**,里面会列出每次触发与判定结果。

### 再加一条:车离开 → 检查车窗

* 触发器同上,把 **触发时机** 改成 **离开**
* **条件** → 添加条件 → **模板**:

  ```jinja
  {{ state_attr('sensor.ling_pao_c10_123456_che_liang_zhuang_tai', 'windows_open')
     | dictsort | map(attribute=1) | map('float', 0) | max > 0 }}
  ```

* 动作:持久通知「⚠️ 车走了但车窗没关」

### 常见坑

| 现象 | 原因 |
|---|---|
| 自动化不触发 | 区域选错了(要用你**自己建的那个** zone);或车还没被判定"进入/离开"(轮询延迟,停车时最多几分钟) |
| 通知收不到 | 手机没装 HA App 或没登录同一账号 —— 先用「持久通知」验证逻辑 |
| 想手动验证 | 自动化 → 点开 → **⋮ → 运行**(只跑动作) |
| 想看为什么没触发 | 自动化 → 点开 → 右上角 **跟踪** |

## 4. 四个可以直接抄的自动化

### 2.1 到家提醒插枪(最实用)

```yaml
alias: 车到家 → 提醒插枪
trigger:
  - platform: zone
    entity_id: device_tracker.ling_pao_c10_123456_che_liang_wei_zhi
    zone: zone.home
    event: enter
action:
  - service: persistent_notification.create
    data:
      title: 车到家了
      message: >-
        电量 {{ states('sensor.ling_pao_c10_123456_dian_liang') }}%,
        续航 {{ states('sensor.ling_pao_c10_123456_xu_hang') }} km。
        记得插枪充电。
```

UI 做法:设置 → 自动化与场景 → 创建自动化 → 触发器选 **区域(Zone)** → 实体选车辆位置、
区域选「家」、动作选「进入」→ 动作里加 **通知**。

### 2.2 离家时检查车窗/门锁

```yaml
alias: 车离家 → 检查车窗与门锁
trigger:
  - platform: zone
    entity_id: device_tracker.ling_pao_c10_123456_che_liang_wei_zhi
    zone: zone.home
    event: leave
condition:
  # 车窗: 属性 windows_open(是否有关着的窗外面) 与 windows_state(1~4 各窗: 0=关, 非 0=开)
  # 注: 车端只上报"开/关", 没有开度百分比
  - condition: template
    value_template: >-
      {{ state_attr('sensor.ling_pao_c10_123456_che_liang_zhuang_tai', 'windows_open')
         | dictsort | map(attribute=1) | map('float', 0) | max > 0 }}
action:
  - service: persistent_notification.create
    data:
      title: ⚠️ 车走了但车窗没关
      message: 请检查车窗与天窗。
```

### 2.3 离家 3 公里提前开空调

先加一个距离传感器(`configuration.yaml`,改完重启 HA):

```yaml
proximity:
  home:
    zone: home
    devices:
      - device_tracker.ling_pao_c10_123456_che_liang_wei_zhi
    tolerance: 200
    unit_of_measurement: km
```

会得到 `proximity.home`(属性含 `dir_of_travel` 靠近/远离)。自动化:

```yaml
alias: 快到家 → 提前开空调
trigger:
  - platform: numeric_state
    entity_id: proximity.home
    below: 3
condition:
  - condition: state
    entity_id: sensor.ling_pao_c10_123456_che_liang_zhuang_tai
    state: driving            # 只在开车回来时触发, 不是停在那
  - condition: state
    entity_id: proximity.home
    attribute: dir_of_travel
    state: towards            # 正在靠近(不是刚出门)
action:
  - service: climate.set_temperature
    target: {entity_id: climate.ling_pao_c10_123456_kong_diao}
    data: {temperature: 24}
  - service: climate.turn_on
    target: {entity_id: climate.ling_pao_c10_123456_kong_diao}
```

> `proximity.home` 的距离是按 `zone.home` 的圆心算的;有 370 米坐标系偏移,
> 所以"3 公里"实际可能是 2.6~3.4 公里 —— 做提前量够用。

### 2.4 车被移动提醒(不需要围栏)

比围栏更值钱、也更可靠:车**锁着且驻车**时,里程却在涨(或被拖走)。

```yaml
alias: ⚠️ 车被移动
trigger:
  - platform: state
    entity_id: sensor.ling_pao_c10_123456_zong_li_cheng   # 总里程(整数 km)
  - platform: state
    entity_id: sensor.ling_pao_c10_123456_che_liang_zhuang_tai
    to: driving
condition:
  - condition: state
    entity_id: lock.ling_pao_c10_123456_che_men_suo
    state: locked
action:
  - service: persistent_notification.create
    data:
      title: ⚠️ 车在锁车状态下动了
      message: >-
        里程 {{ states('sensor.ling_pao_c10_123456_zong_li_cheng') }} km,
        位置 {{ state_attr('device_tracker.ling_pao_c10_123456_che_liang_wei_zhi','latitude') }},
             {{ state_attr('device_tracker.ling_pao_c10_123456_che_liang_wei_zhi','longitude') }}
```

注意事项:

* 里程是**整数公里**,挪动不到 1 公里不会触发;要更灵敏就用位置变化(见下)
* 家人开车也会触发 —— 可以加"家人不在家"之类的条件过滤
* 地库/信号差时 GPS 会漂,所以**别用纯 GPS 位移**做判断;里程 + 行驶状态更稳

## 5. 让触发更快(轮询是延迟的来源)

车的位置来自**轮询**,而且车休眠时根本不上报 —— 所以"离开小区"这种事件可能晚几分钟
才被 HA 发现。集成默认按状态自动切档:**行驶中 60 秒、停车 300 秒**;停车时不会完全
停止轮询(否则就发现不了"车又开始动了")。

| 办法 | 做法 | 效果 |
|---|---|---|
| 缩短轮询 | 集成「配置」→ **停车时轮询间隔**改小(默认 300 秒) | 请求变多(账号会话会自动续期,不用担心) |
| 行驶中自动加快 | 集成默认:**开车时 60 秒一拉**(可在「配置」里改) | 开车时位置/速度才是活的;同时会跳过里程/能耗等不常变的数据,避免请求翻倍 |
| 先刷新再判断 | 自动化动作里先调 `button.…_shua_xin_che_kuang`,再判断 | 用于"我现在就要准确值"的场景 |
| 判断数据新鲜度 | 条件里加 `sensor.…_zhuang_tai_geng_xin_shi_jian` 距今 < 10 分钟 | 避免用几小时前的坐标做判断 |
| 想要秒级 | 需要打通车端 MQTT 推送(见 PROJECT 文档里的会话/车况章节) | 未实现 |

## 6. 调试技巧

* **看车在哪**:开发者工具 → 状态 → `device_tracker.车辆位置`,看 `latitude/longitude/state`
* **算距离**(模板):开发者工具 → 模板,粘贴:

```jinja
距离家 {{ distance('zone.home', 'device_tracker.ling_pao_c10_123456_che_liang_wei_zhi') | round(2) }} km
车窗 {{ '未关' if state_attr('sensor.ling_pao_c10_123456_che_liang_zhuang_tai', 'windows_open') else '已关' }}
电量 {{ states('sensor.ling_pao_c10_123456_dian_liang') }}%  续航 {{ states('sensor.ling_pao_c10_123456_xu_hang') }} km
状态更新时间 {{ states('sensor.ling_pao_c10_123456_zhuang_tai_geng_xin_shi_jian') }}
```

* **看自动化为什么没触发**:设置 → 自动化 → 点开该自动化 → 右上角「跟踪」,能看到每次触发的判定过程
* **手动跑一次**:自动化页面点「运行」(会跳过触发器,只跑动作)
