# 车型能力与素材来源

控车卡「设置 → 车型能力与状态」显示本次采样的能力情况。它是证据表，不是仅按 C10/C11 等车型名称推断的配置表。

| 标签 | 含义 |
|---|---|
| 可用 | 本次有效采样包含所需信号；不代表该命令已在所有车型验证 |
| 信号缺失 | 车况有效，但所需信号不完整；不能据此断言车辆不支持 |
| 不支持 | 有明确能源类型或已核对能力位作为证据 |
| 暂不可用 | 车况读取失败、没有有效时间或采样超过 15 分钟 |
| 命令后待确认 | 指令已受理，尚未取得与目标相符的车端状态 |

指令接受后的乐观回显不会作为 3D 车窗、后备箱的实测状态。车端新状态确认后退出待确认；未知信号无法自动确认。枚举车窗逐窗顺序尚未核对时，只使用全开/全关或具名开度，混合状态不猜左右。

## 2D 整车图

优先使用已有按 VIN 获取外观图接口。该接口无图时，若已有明确年款、能源类型、配置版本和颜色，可尝试官方公开购车配置；没有匹配项不显示车辆图片。自定义外观图入口保留。

已实际读取官方公开 App 目录和购车页：

- [App 车型目录](https://ueapp.oss-cn-hangzhou.aliyuncs.com/nativeApp/loveCar/love_car_default_header.txt) 的 `actionButtons.jumpUrl` 指向公开购车配置页。
- [C10 在售配置页](https://www-app.leapmotor.cn/configuration-v4.html?carCode=2027C10) 使用 `carod-center.leapmotor.cn` 的公开配置接口。
- 顺序为 `mallResourceConfig/getByCode` → 返回的 `carType` → `getVehicleModelSeatListV4` → 该列表返回的 `carModel` → `getVehicleProductConfigV4`。
- 整车素材是 `outColor[].appearanceCarImgs`；目录 `carBackImageURL` 是竖幅场景图，`carTypeImgs` 是配置横幅，都不用于替代整车图。

已经收集验证的是 2027 C10 纯电某配置的 1500×1120 透明 PNG，不能据此给 2026 C10 自动换图。商城当前在售配置不是历史全车型图库；未知年款或颜色/版本不匹配时留空。

可手动收集供审核：

```powershell
python tools/collect_car_images.py --model C10 --year 2027 --energy bev
```

可用 `--edition`、`--color` 精确筛选。未指定时，工具选择列表首个匹配项并输出配置与颜色供人工核对；HA 自动匹配要求四项信息齐全。工具只读取公开配置，不使用账号、VIN、订单或支付接口；输出默认进入 Git 忽略的 `.apk-cache/work/official-2d/`。
