"""零跑汽车集成常量。"""

from __future__ import annotations

from .api import (  # noqa: F401  对外转出, 供各平台引用
    APP_VERSION,
    CMD_AC,
    CMD_CHARGE_BOOK,
    CMD_DOOR,
    CMD_FIND,
    CMD_PREHEAT,
    CMD_SUNSHADE,
    CMD_TRUNK,
    CMD_WINDOW,
    Session,
    Vehicle,
    LeapmotorClient,
    derive_hkdf_key,
    new_device_id,
)

DOMAIN = "leapmotor"

CONF_PHONE = "phone"
CONF_SMS_CODE = "sms_code"
CONF_OPERATE_PWD = "operate_pwd"          # 车辆操作密码(PIN), 4 位数字
CONF_OPERATE_PWD_MODE = "operate_pwd_mode"  # 密码编码方式(不同车型可能不同)
# 实测(2026-09-27): 唯一能被服务端接受的是 aes_jwt ——
#   oppwd = base64(AES-128-CBC(PKCS7(PIN), key=md5(车端JWT[:32])[8:24], iv=md5(车端JWT[32:64])[8:24]))
# 其余模式保留仅为兼容排查(plain/md5mid16/md5/rsa 实测均被拒)。
PWD_MODES = ["aes_jwt", "aes", "plain", "md5mid16", "md5", "rsa"]
DEFAULT_PWD_MODE = "aes_jwt"
CONF_POLL_SECONDS = "poll_seconds"
CONF_DRIVING_POLL_SECONDS = "driving_poll_seconds"   # 行驶中的轮询间隔
CONF_VIN = "vin"
CONF_LAUNCH_BOOST = "launch_boost"        # 解锁/上电/非 P 挡时立刻按行程采样间隔轮询
CONF_SHORT_STOP_SECONDS = "short_stop_seconds"   # 短停快档: 行程结束后这段时间内仍用快档(0=关)
CONF_BATTERY_KWH = "battery_kwh"          # 电池可用容量, 用于把 ΔSOC 折算成 kWh

DEFAULT_LAUNCH_BOOST = True
DEFAULT_SHORT_STOP_SECONDS = 300          # 默认 5 分钟; 设 0 关闭
MAX_SHORT_STOP_SECONDS = 1800
DEFAULT_BATTERY_KWH = 67.0                # C10 纯电 RWD **可用**容量(mate #246 实测实证; 69.9 是毛容量)
MIN_BATTERY_KWH = 20.0
MAX_BATTERY_KWH = 150.0

# ── 重数据取数策略(见 coordinator._refresh_car_data)──
HEAVY_REFRESH_SECONDS = 600        # 停车时里程/能耗/配置的最小刷新间隔(行驶中一律跳过)
# 「上周能耗拆分」的缓存时长: 它是**周汇总**(只在周一零点翻篇), 按需取(卡片打开/手动刷新),
# 不占轮询; 缓存过了这个时长、或"上周"窗口翻篇了, 下次读卡片时再拉一次。
LASTWEEK_EC_REFRESH_SECONDS = 3600
# 驻车照片: 新泊车事件后的"等上传"窗口。
# 车端拍照后异步上传, 时长不定 —— 所以窗口给足(默认 15 分钟), 但**重试节奏递增退避**:
# 前 15s 每 15 秒试一次(照片通常很快到), 之后 30s → 60s → 120s → 300s;
# **一旦拿到新的 uploadTime 就立即停止**(见 coordinator._photo_due)。
PHOTO_RETRY_WINDOW_SECONDS = 900   # 窗口总长(15 分钟)
PHOTO_RETRY_STEPS = (15, 30, 60, 120, 300)   # 逐次重试的间隔(递增退避)
PHOTO_RETRY_EVERY_SECONDS = 30     # (旧值, 兼容保留: 未配置 steps 时的兜底)
RATE_LIMIT_COOLDOWN_SECONDS = 900  # 命中限流/风控后的冷却时间(期间用慢档)
LAUNCH_BOOST_MAX_SECONDS = 600     # 出发提速的最长持续时间, 防止"解锁后不开车"长期高频

# 停车轮询: 默认与官方 App 的静止档一致(60 s), 但**下限放宽到 20 s 可调** ——
# 调低可以让"起步头一分钟"的缺口更小(代价是停车时的请求量成比例增加)。
# 注意每轮只拉**车况帧**一个请求, 里程/能耗/配置/照片另有节流(见 coordinator 的重数据策略)。
DEFAULT_POLL_SECONDS = 60
MIN_POLL_SECONDS = 20

# 行驶中把轮询调快(位置/速度这类数据只有开车时才有意义)。
# 参考 EU 版的双档轮询思路(它按"是否安静"切档), 这里按"是否在开"切:
#   行驶中 → DRIVING_POLL_SECONDS; 其余(停车/充电/未锁) → poll_seconds
# 停车时**不能完全停轮询** —— 那样就发现不了"车又开始动了"。
# 行程采样间隔(行驶中): 官方 App 前台对**同一个车况接口**就是 6 秒一次。
# 6 s × 1 个请求 = 10 请求/分钟, 与官方同节奏; 这也是行程轨迹点的时间分辨率。
DRIVING_POLL_SECONDS = 6
DEFAULT_DRIVING_POLL_SECONDS = DRIVING_POLL_SECONDS
MIN_DRIVING_POLL_SECONDS = 6

# 车端 token 剩余不足这么多秒就自动续期(用账号 token, 不需短信)
RENEW_SKEW_SECONDS = 600

# 平台顺序 = **设备页里实体的显示顺序**(HA 按注册顺序列实体), 所以按"先能操作的、
# 后看状态的、诊断垫底"排:
#   门锁 / 开关(后备箱·遮阳帘·方向盘·后视镜·充电) / 空调 / 座椅·充电上限 /
#   预约时间 / 按钮(寻车·车窗·预热·刷新) / 传感器 / 位置 / 照片 / 原始指令
PLATFORMS = ["lock", "switch", "climate", "number", "time", "button", "sensor",
             "device_tracker", "image", "text"]

# 按钮: (唯一键, 名称, 客户端方法名) —— 内容编码见 api_client 的 CMD_* 说明
# 开关类的(后备箱/遮阳帘/…)不放这里, 见 switch.py
BUTTONS: list[tuple[str, str, str]] = [
    ("find", "寻车鸣笛", "find_car"),
    # 车窗是 0~10 刻度(见 api_client.WINDOW_LEVELS): 2=微开 / 5=半开 / 10=全开
    ("window_open", "车窗-全开", "windows_open"),
    ("window_vent", "车窗-微开", "windows_vent"),
    ("window_half", "车窗-半开", "windows_half"),
    ("window_close", "车窗-关", "windows_close"),
    ("preheat_on", "电池预热-开", "preheat_on"),
    ("preheat_off", "电池预热-关", "preheat_off"),
]
