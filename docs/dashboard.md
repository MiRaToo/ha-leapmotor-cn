# 仪表盘与图表

集成自带数据已经足够画 App 里那几张图。本仓库为你在 HA 里**建好了一个仪表盘**:
侧边栏 → **零跑**(url_path `leapmotor-car`), 里面有:

| 卡片 | 数据来源 | 类型 |
|---|---|---|
| **车辆位置** | `device_tracker.*_che_liang_wei_zhi`(车况信号 2/3 的经纬度) | `custom:leapmotor-map`(集成自带的高德底图卡) |
| **车况** | 电量 / 续航 / 充电状态 / 车辆状态 / 车内温度 / 状态更新时间 / 门锁 / 健康充电 / 哨兵 | `entities` |
| **胎压(bar)** | 四个 `sensor.*_tai_ya_*`(车端 kPa 已换算) | `entities` |
| 车辆控制 | 门锁/空调/座椅/加热/充电/按钮 等实体 | `entities` |
| 每日里程(近 7 天) | `sensor.*_zong_li_cheng` 的长期统计(change/bar) | `statistics-graph` |
| 近 7 天里程 / 能耗 | `sensor.*_jin_7tian_li_cheng` / `_jin_7tian_neng_hao` | `history-graph` |
| 能耗概览 | 百公里能耗 / 排名 / 每周明细(Jinja 读 `weeklyEC` 属性) | `markdown` |
| 驻车照片 | `image.*_zhu_che_zhao_pian` | `picture-entity` |

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
  # 逐日能耗: 直接用"近7天能耗"的历史做折线
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
