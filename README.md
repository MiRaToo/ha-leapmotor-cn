<p align="center">
  <img src="docs/images/logo.png" alt="零跑汽车 Home Assistant 集成" width="112">
</p>

<h1 align="center">零跑汽车 Home Assistant 集成</h1>

<p align="center">
  在 Home Assistant 中查看零跑车辆状态、使用远程车控，并通过仪表盘卡片查看行程、能耗、充电和 3D 车模。
</p>

<p align="center">
  <a href="https://github.com/MiRaToo/ha-leapmotor-cn/releases/latest"><img alt="发布版 v0.3.1" src="https://img.shields.io/badge/%E7%A8%B3%E5%AE%9A%E7%89%88-v0.3.1-brightgreen.svg"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-AGPL--3.0-blue"></a>
  <img alt="Home Assistant" src="https://img.shields.io/badge/Home%20Assistant-2024.11%2B-41BDF5?logo=homeassistant&logoColor=white">
</p>

这是一个非官方的 Home Assistant 自定义集成。集成通过零跑云端接口登录，提供车辆实体、行程与能耗记录，以及六张可直接加入 Lovelace 仪表盘的卡片。项目与零跑汽车及其关联公司无隶属、合作或背书关系。

当前版本：**v0.3.1**。

代码托管：[GitHub](https://github.com/MiRaToo/ha-leapmotor-cn) · [GitCode 同步仓库](https://gitcode.com/MiraRato/ha-leapmotor-cn)。日常更新以 GitHub 为准，GitCode 通过仓库镜像自动同步代码、分支和标签。

## 功能

| 区域 | 能力 |
|---|---|
| 车辆控制 | 车门锁、后备箱、车窗、寻车、空调、座椅加热与通风、方向盘与后视镜加热、电池预热、健康充电和预约充电。可用控件按车辆实际能力显示。 |
| 车辆状态 | 位置、电量、续航、充电、空调、车身状态、车内温度和轮胎压力；增程车型显示燃油相关数据。 |
| 行程与能耗 | 本机记录行程轨迹、里程和电量变化；提供每日能耗、近期统计与图表。 |
| 充电 | 本地充电记录、充电与行驶能耗对照、交流峰谷价和直流分时价，以及单次价格修正。 |
| 车机工具 | 预约充电与预热、发送目的地、全景壁纸上传、高德地图搜索和多投影面车衣。 |
| 3D 车模 | 可旋转的整车模型、车漆与背景设置、车型素材采集，以及可导出的诊断信息。 |

### Lovelace 卡片

安装集成后，六张自带卡片会自动注册：

| 卡片 | 用途 |
|---|---|
| <code>custom:leapmotor-control</code> | 车辆状态、远程控制、空调、充电、轮胎和 3D 车模 |
| <code>custom:leapmotor-map</code> | 车辆位置与地理围栏 |
| <code>custom:leapmotor-trips</code> | 行程记录、轨迹和趋势 |
| <code>custom:leapmotor-energy</code> | 每日里程与能耗 |
| <code>custom:leapmotor-lastweek</code> | 近期能耗拆分 |
| <code>custom:leapmotor-metrics</code> | 自定义数据卡，可添加多张卡并分别选择指标 |

卡片提供玻璃拟态、轻阴影、新粗野主义、极简扁平和孟菲斯五种界面风格，默认使用玻璃拟态；风格设置在卡片间保持一致。自定义数据卡支持车辆状态、行程统计和 Home Assistant 实体数据，每张卡独立保存所选内容。卡片配置示例见[仪表盘与卡片说明](docs/dashboard.md)。

控制卡片的设置中可切换“自动 / 3D”与“仅 2D”；2D 外观可按商城车型、年款、能源、配置和颜色选择，并调整车图大小。“隐藏卡片外框”默认关闭，开启后去掉卡片最外层的边框和阴影，保留内部子卡片效果。

## 安全接入建议

建议使用单独的零跑子账号接入。零跑云同一账号通常只允许一个活跃登录，而集成需要持续轮询；使用主账号可能影响官方 App 的登录状态。

1. 在官方 App 中通过“车辆共享”邀请子账号，并由子账号接受邀请。
2. 在 Home Assistant 中使用子账号手机号和短信验证码完成登录。
3. 只在本人拥有或获得车主明确授权的车辆上使用远程控制。

## 安装

项目地址（可直接复制）：

GitHub：

```text
https://github.com/MiRaToo/ha-leapmotor-cn
```

GitCode 同步仓库：

```text
https://gitcode.com/MiraRato/ha-leapmotor-cn
```

### HACS

1. 在 HACS 的集成页面添加[自定义仓库](https://github.com/MiRaToo/ha-leapmotor-cn)，类型选择“集成”。
2. 下载“零跑汽车”并重启 Home Assistant。
3. 前往“设置 → 设备与服务 → 添加集成”，搜索“零跑汽车”并完成登录。

### 手动安装

从上方任一仓库下载代码，将 <code>custom_components/leapmotor</code> 目录复制到 Home Assistant 配置目录下的 <code>custom_components/</code>，重启 Home Assistant，再从“设置 → 设备与服务”添加“零跑汽车”。

安装后会创建车辆设备及对应实体。卡片资源由集成自动注册；在仪表盘中添加相应的自定义卡片即可。详细步骤见[接入指南](docs/SETUP.md)与[部署说明](docs/DEPLOY.md)。

## 配置与数据

集成选项可在“设置 → 设备与服务 → 零跑汽车 → 配置”中调整，包括轮询间隔、电池可用容量、轨迹存储上限和能源类型。高德地图 Web Key 与车机工具的使用方法见[预约与车机工具](docs/vehicle-tools.md)。

行程摘要、轨迹和充电账本保存在 Home Assistant 本机。车辆状态和车控请求通过零跑云端接口传输；此项目不提供零跑官方云服务。

## 文档

完整索引见[文档目录](docs/README.md)。

- [接入指南](docs/SETUP.md)
- [仪表盘与卡片](docs/dashboard.md)
- [行程记录](docs/trips.md)
- [充电记录与电费](docs/charging.md)
- [预约与车机工具](docs/vehicle-tools.md)
- [车型能力与素材](docs/vehicle-capabilities.md)
- [3D 车模诊断](docs/3D-TROUBLESHOOTING.md)
- [云 API 协议说明](docs/PROTOCOL.md)
- [HomeKit 与语音平台](docs/homekit.md)

## 致谢

本项目的部分协议实现与资料，参考并借鉴了以下开源项目：

- [ProtossBlaster/leapmotor-mate](https://github.com/ProtossBlaster/leapmotor-mate)
- [kerniger/leapmotor-ha](https://github.com/kerniger/leapmotor-ha)
- [markoceri/leapmotor-api](https://github.com/markoceri/leapmotor-api)

## 免责声明

**请在使用前完整阅读本节。继续安装或使用本项目，即视为你已知悉并接受以下全部内容。**

- **个人项目**：本项目由个人开发者出于自用与学习目的编写，**不是零跑汽车官方产品**，
  与零跑汽车及其关联公司无任何隶属、合作或背书关系，也未获得其授权或认可。
- **风险自负**：本项目需要你在 Home Assistant 中保存账号会话与**车辆操作密码**，
  并向零跑云下发真实的车辆控制指令。**使用本项目所产生的一切后果，由使用者自行承担** ——
  包括但不限于车辆状态异常、账号被限制或封禁、数据丢失、违反平台服务条款等。
  请先确认你清楚每条指令会对车辆做什么，**不要在不确定的场景下远程操作**。
- **接口可能失效**：本项目依赖零跑云端接口。零跑随时可能调整接口、
  签名方式、权限策略或风控规则，届时集成的**部分或全部功能可能失效**，
  作者无法保证持续可用，也没有义务为此提供支持或更新。
- **使用限制**：请仅在你**本人所有或获得车主明确授权**的车辆上使用本项目。
  **禁止**用于商业用途、批量或自动化滥用、规避平台风控，以及任何违反法律法规的用途。
- **无担保**：本项目按“现状（as is）”提供，不附带任何明示或暗示的担保，
  包括但不限于适销性与特定用途适用性；作者不承担任何直接或间接损失的赔偿责任。
- **第三方权利**：本项目涉及的第三方品牌、商标、服务名称与图标 ——
  包括零跑 / Leapmotor 的名称与商标、随项目使用的车型外观图素材、高德地图瓦片服务、
  Home Assistant 等 —— **均归各自权利人所有**。本项目仅在“标识与说明”的范围内引用，
  不主张任何相关权利；若权利人认为使用不当，请联系作者删除。
- **合规提醒**：请遵守你所在地区的法律法规以及零跑汽车的用户协议与隐私政策。
  因使用本项目而与第三方产生的纠纷，由使用者自行解决与承担。

## 许可证

[GNU AGPL-3.0](./LICENSE)
