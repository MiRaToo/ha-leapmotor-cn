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

DEFAULT_POLL_SECONDS = 300
MIN_POLL_SECONDS = 60

# 行驶中把轮询调快(位置/速度这类数据只有开车时才有意义)。
# 参考 EU 版的双档轮询思路(它按"是否安静"切档), 这里按"是否在开"切:
#   行驶中 → DRIVING_POLL_SECONDS; 其余(停车/充电/未锁) → poll_seconds
# 停车时**不能完全停轮询** —— 那样就发现不了"车又开始动了"。
DRIVING_POLL_SECONDS = 60
DEFAULT_DRIVING_POLL_SECONDS = DRIVING_POLL_SECONDS
MIN_DRIVING_POLL_SECONDS = 60      # 与全局下限一致(coordinator 里统一钳到 ≥60s)

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
