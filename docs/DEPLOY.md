# 部署到 Home Assistant

| 路线 | 适合 | 需要 |
|---|---|---|
| **⓪ 自定义集成**(推荐, 也是唯一推荐路线) | 所有人 | 能往 `config/custom_components/` 放文件 |
| **① 直接跑进程**(开发/非 HA OS) | HA Container / 群晖 Docker / 树莓派 | 能跑 Python 或 Docker |

---

## 路线 ⓪(推荐):自定义集成 —— 出现在「设备与服务」里

不需要 MQTT、不需要附加组件,体验和 HACS 集成一致。

```bash
# 方式 1: 直接复制(HACS 用户可把本仓库加为自定义仓库)
#   把 custom_components/leapmotor/ 放到 HA 的 config/custom_components/ 下
#   然后重启 HA → 设置 → 设备与服务 → 添加集成 → 搜「零跑」
```

- 会话保存在该集成条目里;车端 token 自动续期;账号 token 过期会提示重新认证
- 操作密码、轮询间隔在集成条目的「配置」里

---

## 路线 ①:命令行验证(仅开发用)

不装集成、先确认协议能跑通:

```bash
pip install cryptography
python scripts/login.py --phone 138xxxxxxxx -o session.json     # 或 python scripts/login_web.py
```

## 装好之后(路线 ⓪)

登录成功后:

- 设置 → 设备与服务 里出现 **零跑汽车** 设备, 带 47 个实体:
  车辆位置 / 电量 / 续航 / 四轮胎压 / 车门锁 / 空调 / 座椅 / 车窗 / 遮阳帘 /
  后备箱 / 寻车 / 健康充电 / 充电上限 / 预约充电 / 状态更新时间 / 会话状态 …
- 仪表盘会自动出现「零跑」面板(含高德底图地图卡)

不需要 MQTT broker、不需要附加组件。

---

## 排错

| 现象 | 原因 / 处理 |
|---|---|
| 添加集成时搜不到「零跑」 | 目录层级不对(应为 `config/custom_components/leapmotor/manifest.json`),或没重启 HA |
| 登录提示"账号下没有可用车辆" | 子账号还没被共享车辆 —— 见 SETUP.md 第 0 步 |
| 提示 `1023 环境被风控` | **静默等 30 分钟,期间不要重试**(重试会延长冷却),之后只试一次 |
| 实体出现但点了没反应 | 看「最近指令回执」实体;`result:40 无此权限` = 该子账号在这辆车上没有这条指令的授权 |
| 提示"账号会话已过期,需要重新登录" | refresh token 失效(例如在别处重新登录过)。点集成里的「重新认证」,收短信填验证码即可 |
| 电量/续航一直是旧值 | 看「状态更新时间」;车端休眠时不刷新属正常,车辆唤醒后会自动更新 |
| 地图没有底图 | 集成自带的高德地图卡应能显示;若用的是 HA 自带 `map` 卡片,国内加载不出 OSM 瓦片 —— 换 `custom:leapmotor-map`(见 dashboard.md) |
| 改了 `poller/api_client.py` 但集成行为没变 | 忘了同步:`python tools/sync_api.py` 后再部署 |

部署后的验证:

```bash
# 在 HA 的 SSH 附加组件里
bash -lc 'ha core logs | grep -i leapmotor | tail -20'
```
