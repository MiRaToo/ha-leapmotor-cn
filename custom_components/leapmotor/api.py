"""零跑汽车 API 客户端 —— **本文件由 tools/sync_api.py 从 poller/api_client.py 生成**。

不要直接改这里:改动会在下次同步时被覆盖。请改 poller/api_client.py, 然后跑
    python tools/sync_api.py
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import math
import logging
import random
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlencode

log = logging.getLogger(__name__)

# ── 协议常量(全部实证) ──────────────────────────────────────────────
BASE_URL = "https://appgateway.leapmotor.com"        # 车控服务
API_PREFIX = "/carownerservice/"

# 账号/登录域(解密字符串 URL_APPTEC_NEW_OFFICIAL)
ACCOUNT_BASE = "https://appuser.leapmotor.cn/app-user"

# 全局服务域:车辆列表等挂在这里(与车控服务是两套 host/前缀)
GLOBAL_BASE = "https://app-gw-global-master.leapmotor.com"
GLOBAL_PREFIX = "/app/app-global-service/"

# 应用标识(与 App 实际发出的头一致)
APP_SOURCE = "leapmotor"
APP_CHANNEL = "1"
APP_DEVICE_TYPE = "android"
APP_VERSION = "1.22.98"          # 实测自 App 内存
APP_SUBVERSION = "3.21.3-2"      # 实测自 App 内存
X_API_SIGNATURE_VERSION = "2.0"
DEFAULT_LANGUAGE = "zh-CN"
DEFAULT_REGION = "CN"

# ── 端点 ────────────────────────────────────────────────────────────
# 车控服务 appgateway.leapmotor.com/carownerservice/
EP_REMOTE_CTL = "v3/api/appremotectl"                    # POST form 指令下发
EP_REMOTE_CTL_QUERY = "v3/api/appremotectl/query"        # GET  指令结果查询(需 msgID)
EP_VEHICLE_CONFIG = "v3/api/vehicleinfo/commonConfig"    # GET  车辆配置/能力(需 vin)
EP_HEALTHY_CHARGE = "v3/api/healthyCharging/control"     # 健康充电
EP_PARKING_QUERY = "v3/api/vehicleinfo/parking/query"    # 泊车状态
EP_VERIFY_PWD = "v3/api/appoperate/verifyoperatepwdnew"  # 操作密码(PIN)校验
EP_AGREEMENT = "v3/api/agreement/queryAppAgreement"      # 协议
# 里程 / 能耗(实测可用)
EP_MILEAGE_DETAIL = "v3/api/drivingrecord/mileage/energy/detail"          # 总里程(字段名 vin)
EP_ENERGY_RANK = "v3/api/drivingrecord/getLastNweeks100kmECAndRank"       # 百公里能耗+排名
EP_PLUG_ENERGY = "v3/api/drivingrecord/getPlugInLastNweeks100kmEC"        # 电耗/油耗
EP_LASTWEEK_EC = "v3/api/drivingrecord/getLastweekEC"                     # 上周能耗拆分(驱动/空调/其它)
EP_CAR_PICTURE = "v3/api/carpicture/key"                 # 车辆外观图(返回 OSS 地址)
EP_CHASSIS_QUERY = "v3/api/chassis/query"                # 底盘/驻车照片(返回 OSS 地址)

# 车况信号: **不在 /carownerservice 下**, 而是网关的另一条路由(见 docs/PROTOCOL.md §4)
EP_SIGNAL_QUERY = "/app/app-signal-service/signal/info/query"

# 全局服务 app-gw-global-master.leapmotor.com/app/app-global-service/
EP_CAR_LOGIN = "base/base-user/account/v1/login"         # 交换:账号token → 车端JWT
EP_CAR_REFRESH = "base/base-user/token/v1/refresh"       # 刷新:车端refreshToken → 新token对
EP_VEHICLE_LIST = "v1/vehicle/list"                      # 车辆列表

# 账号服务 appuser.leapmotor.cn/app-user/
EP_SMS_CODE = "applogin/compliance/sendmessagecode"      # GET  发短信验证码
EP_LOGIN = "applogin/check_login_with_phone"             # POST 手机号+验证码登录
EP_TOKEN_EXIST = "applogin/tokenExist"
EP_USER_INFO = "appuserinfo/compliance/queryuserinfo"
EP_LOGOUT = "appuseroperate/logout"
EP_ACCOUNT_REFRESH = "appuseroperate/getnewtoken"        # GET  账号 token 免短信续期(实测可用)

# 登录用的 RSA 公钥(RSA-1024 / PKCS#1 v1.5),硬编码在 App 内,与商城 H5 同一把。
RSA_PUBLIC_KEY = (
    "MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDHUIQKhkwNqJFTZPe98mC1lmpbY9r/+7PEWZg8ebqY"
    "XT3sumKRaQ0zcoTx42x0iybmCRXy4CcZrgGAbwKzwqwNw0rFquJ6c7mgQA6k3lZU3p96qBlzK7DSko"
    "FR6mO9pjcd2hlJ8wH+IwI5b8IWWZhwVN/4cM7npG0S0zeRn3soEwIDAQAB"
)

# 操作密码的 AES 兜底密钥(EU 版 SDK 里的同名常量; token 短于 64 字符时使用)
DEFAULT_OPERPWD_AES_KEY = "f1cf0c025baec0e2"
DEFAULT_OPERPWD_AES_IV = "6b6a1fe94e133fd7"

# 操作密码校验端点(EU 是 /oversea/vehicle/v1/operPwd/verify)
EP_VERIFY_OPER_PWD = "v3/api/appoperate/verifyoperatepwdnew"

# 参与签名的请求头(顺序无关, 排序由 key 决定)
SIGNED_HEADERS = (
    "acceptLanguage", "channel", "deviceType", "source", "timestamp", "version", "deviceId",
)

# 账号侧固定头
_ACCOUNT_HEADERS = {
    "APPPlatform": "Android",
    "APPVersion": APP_VERSION,
    "C-VERSIONS": "APP",
    "Content-Type": "application/json;charset=UTF-8",
}


# ── 基础工具 ────────────────────────────────────────────────────────
def b64url_decode(text: str) -> bytes:
    """base64url 解码(容忍缺失的 padding)。"""
    text = text.replace("-", "+").replace("_", "/")
    text += "=" * (-len(text) % 4)
    return base64.b64decode(text)


def derive_hkdf_key(car_token: str, sign_param: dict[str, Any]) -> str:
    """★ 签名密钥派生 —— 纯 Python 实现, 不需要 App / 模拟器 / root ★

    实证: 通过动态调试调用 App 内的 native 派生函数
    `LoginInfoManager.OooO00o(carJWT, r2, r3)` 做差分分析, 得到:

        HKDFKey = b64d(r2) XOR b64d(r3) XOR b64d(carJWT 的第三段)

    两轮独立会话(捕获会话 / 当时活动会话)分别逐字节吻合。
    差分特征也一致:交换 r2/r3 结果不变(异或交换律)、r2==r3 时只剩 JWT 段、
    截断输入则输出等长截断 —— 均符合异或语义。

    :param car_token:  交换响应里的 accessToken(形如 aaa.bbb.ccc 的 JWT)
    :param sign_param: 交换响应里的 signParam {"r2": "...", "r3": "..."}
    :return: 32 字节密钥的 hex 字符串
    """
    parts = car_token.split(".")
    if len(parts) != 3:
        raise ValueError("car_token 不是合法 JWT(需要 3 段)")
    r2 = b64url_decode(sign_param["r2"])
    r3 = b64url_decode(sign_param["r3"])
    sig = b64url_decode(parts[2])
    n = min(len(r2), len(r3), len(sig))
    key = bytes(a ^ b ^ c for a, b, c in zip(r2[:n], r3[:n], sig[:n]))
    return key.hex()


def sort_and_concat(values: dict[str, Any]) -> str:
    """按 key 字典序排序后拼接各 value —— 与 App 的 ParamHeaderExt 一致。

    实证:用本函数复现 App 的签名, 与 App 实际发出的签名
    实际输入串逐字节一致(见 docs/PROTOCOL.md §3)。
    """
    return "".join(str(values[k]) for k in sorted(values))


def md5_mid16(text: str) -> str:
    """App 的 ParamHeaderExt.getEncryptString —— MD5 十六进制串的第 8~24 位。

    实测验证:'a' → c0f1b6a831c399e2;'abc' → 3cd24fb0d6963f7d(均为 MD5 中段)。
    """
    return hashlib.md5(text.encode("utf-8")).hexdigest()[8:24]


def derive_operpwd_key_iv(token: str | None) -> tuple[str, str]:
    """由 token 派生操作密码的 AES-128 key/iv(与 EU SDK 一致)。

    token 至少 64 字符时: key = md5(token[:32])[8:24], iv = md5(token[32:64])[8:24];
    否则回落到内置默认值 —— 注意 **CN 的账号 token 只有 32 字符**, 所以很可能走默认值。
    """
    if not token or len(token) < 64:
        return DEFAULT_OPERPWD_AES_KEY, DEFAULT_OPERPWD_AES_IV
    return (hashlib.md5(token[:32].encode("utf-8")).hexdigest()[8:24],
            hashlib.md5(token[32:64].encode("utf-8")).hexdigest()[8:24])


def encrypt_operate_pwd(pin: str, token: str | None = None) -> str:
    """把操作密码加密成请求里要发的值: AES-128-CBC + PKCS7 + base64。

    与 EU 版 SDK 的 `encrypt_operate_password(pin, token)` 完全一致 ——
    **这才是服务端期望的形态**(明文 / MD5 都会被判"操作密码错误")。
    """
    import base64 as _b64

    from cryptography.hazmat.primitives import padding as _pad
    from cryptography.hazmat.primitives.ciphers import Cipher as _Cipher
    from cryptography.hazmat.primitives.ciphers import algorithms as _alg
    from cryptography.hazmat.primitives.ciphers import modes as _modes

    key, iv = derive_operpwd_key_iv(token)
    padder = _pad.PKCS7(128).padder()
    data = padder.update(pin.encode("utf-8")) + padder.finalize()
    enc = _Cipher(_alg.AES(key.encode("utf-8")), _modes.CBC(iv.encode("utf-8"))).encryptor()
    return _b64.b64encode(enc.update(data) + enc.finalize()).decode("ascii")


def encode_operate_pwd(pwd: str, mode: str = "aes", token: str | None = None) -> str:
    """把操作密码按指定方式编码后放进 `oppwd` 字段。

    实测:服务端会校验该值(错误会累计, 3 次锁 5 分钟), 因此编码方式必须与 App 一致。
    哪种方式正确取决于车型/固件, 所以做成可切换; 默认 plain。
    """
    mode = (mode or "aes").lower()
    if mode in ("aes", "aes_default"):          # 默认 key/iv 或由账号 token 派生
        return encrypt_operate_pwd(pwd, token)
    if mode == "aes_jwt":                        # 由车端 JWT 派生
        return encrypt_operate_pwd(pwd, token)
    if mode == "md5mid16":
        return md5_mid16(pwd)
    if mode == "md5":
        return hashlib.md5(pwd.encode("utf-8")).hexdigest()
    if mode == "rsa":
        return rsa_encrypt_b64url(pwd)
    return pwd


def rsa_encrypt_b64url(text: str) -> str:
    """登录参数加密: RSA-1024 PKCS#1 v1.5 → base64url(去 padding)。

    对应 App 的 `RSAUtils.defaultPublicEncrypt(...)`。
    实测验证:密文 128 字节 / 171 字符, 服务端能正确解出手机号。
    """
    import base64 as _b64

    from cryptography.hazmat.primitives import serialization as _ser
    from cryptography.hazmat.primitives.asymmetric import padding as _pad

    pub = _ser.load_der_public_key(_b64.b64decode(RSA_PUBLIC_KEY))
    ct = pub.encrypt(text.encode("utf-8"), _pad.PKCS1v15())
    return _b64.urlsafe_b64encode(ct).decode("ascii").rstrip("=")


def new_device_id() -> str:
    """生成 32 位 hex 设备标识(App 的 deviceId / APPImei 同源)。

    实测:deviceId 由客户端自选(服务端不校验其来源), 但**必须参与签名**。
    """
    return uuid.uuid4().hex


# ── 会话 ────────────────────────────────────────────────────────────
@dataclass
class Vehicle:
    """车辆条目(来自 /v1/vehicle/list)。"""

    vin: str = ""
    car_id: str = ""
    car_type: str = ""
    nick_name: str = ""
    plate_number: str = ""
    series_name: str = ""
    abilities: list = field(default_factory=list)
    raw: dict = field(default_factory=dict)

    @property
    def year(self) -> int:
        return int(self.raw.get("year") or 0)

    @property
    def right_list(self) -> list[str]:
        """该账号在此车上被授权的 cmdId 列表(rightList 字段)。"""
        raw = self.raw.get("rightList") or ""
        return [x for x in str(raw).split(",") if x]

    def can(self, cmd_id: int) -> bool:
        """该车 + 该账号是否被授权执行某指令。"""
        rl = self.right_list
        return not rl or str(cmd_id) in rl


# ── 坐标系换算(GCJ-02 ↔ WGS-84) ─────────────────────────────────────
# 车端上报的经纬度是 **GCJ-02**(火星坐标,与官方 App / 高德地图一致),
# 而 Home Assistant 的地图、zone(区域)、手机定位都用 **WGS-84** ——
# 同一地点两者在国内相差约 300~500 米(温州实测约 370 米)。
#
# 因此:集成**对外发布 WGS-84**(device_tracker 用换算后的坐标, 用户才能直接
# 在地图上拖一个圆当围栏), 原始 GCJ-02 保留在属性里; 自带的高德地图卡则
# 反向换算回 GCJ-02 再画, 保证车标落在高德底图的正确位置。
#
# 算法即公开的 GCJ-02 偏移公式(国测局加密算法), 逆变换用一次近似迭代,
# 精度在米级, 对"进/出区域"完全够用。

_A_GCJ = 6378245.0                     # 克拉索夫斯基椭球长半轴
_EE_GCJ = 0.00669342162296594323       # 第一偏心率平方


def _out_of_china(lat: float, lon: float) -> bool:
    """国境之外不做偏移(GCJ-02 只在中国大陆生效)。"""
    return not (73.66 < lon < 135.05 and 3.86 < lat < 53.55)


def _transform_lat(x: float, y: float) -> float:
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _transform_lon(x: float, y: float) -> float:
    """经度偏移多项式。

    ⚠️ GCJ-02 算法有**两个**不同多项式: 纬度用 `_transform_lat`、经度用本函数。
    ⚠️ 坑(已修): 经度方向原来也调的是 `_transform_lat`(纬度多项式) —— 后果是
    对外发布的 WGS-84 偏东 300~800 米(南北向只差米级); 自家卡片因为正反都用同一套
    错误公式、误差往返相消, 界面上反而"看着准", 直到把坐标交给第三方(ha_gaode
    的标准转换)才暴露。修复后: 与公开实现/eviltransform 的参考向量逐位吻合(有单测钉住)。
    """
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def _delta(lat: float, lon: float) -> tuple[float, float]:
    d_lat = _transform_lat(lon - 105.0, lat - 35.0)
    d_lon = _transform_lon(lon - 105.0, lat - 35.0)
    rad_lat = lat / 180.0 * math.pi
    magic = math.sin(rad_lat)
    magic = 1 - _EE_GCJ * magic * magic
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((_A_GCJ * (1 - _EE_GCJ)) / (magic * sqrt_magic) * math.pi)
    d_lon = (d_lon * 180.0) / (_A_GCJ / sqrt_magic * math.cos(rad_lat) * math.pi)
    return d_lat, d_lon


def wgs84_to_gcj02(lat: float, lon: float) -> tuple[float, float]:
    """WGS-84 → GCJ-02(给高德/腾讯底图用)。"""
    if _out_of_china(lat, lon):
        return lat, lon
    d_lat, d_lon = _delta(lat, lon)
    return lat + d_lat, lon + d_lon


def gcj02_to_wgs84(lat: float, lon: float) -> tuple[float, float]:
    """GCJ-02 → WGS-84(车端原始坐标 → HA 地图/区域用的坐标)。

    用"减去一次偏移量"的近似法(误差米级), 再迭代一次把误差压到亚米级。
    """
    if _out_of_china(lat, lon):
        return lat, lon
    d_lat, d_lon = _delta(lat, lon)
    w_lat, w_lon = lat - d_lat, lon - d_lon
    # 迭代一次: 用换算结果再算一次偏移, 收敛到 <1 m
    d_lat2, d_lon2 = _delta(w_lat, w_lon)
    return lat - d_lat2, lon - d_lon2


# ── 命令后的"乐观状态"覆盖 ──────────────────────────────────────────
# 车端状态上报有延迟(通常几十秒~几分钟, 车休眠时更久)。如果命令发出后立刻
# 回读车端信号, 会读到**旧值** —— 表现就是"空调能开不能关""开关点完自己弹回去",
# HomeKit/Siri 也会因为读回的状态没变而认为命令失败。
#
# 做法: 命令成功后记下"我认为它现在是什么状态", 直到车端上报了**更新的**
# collectTime 才恢复用真实信号(另加一个兜底 TTL, 防止车端长时间不更新)。
#
# ⚠️ "更新的帧"必须**新到车来得及执行**(真机回弹事故):
# 用户 17:43:35 开遮阳帘, 17:43:36 云端就给了一帧 collect=09:43:36 的新采集 ——
# 它只比命令晚 1 秒, 车根本还没动, 信号 1724 仍是 0。旧逻辑"只要帧更新就失效"
# 被这一帧清掉了乐观状态, 界面 1 秒后从"开"弹回"关", 60 秒后才由真实上报改回 "开"。
# 所以: 帧比命令时戳新、但 **新得不足 OVERRIDE_GRACE_SECONDS** 时, 仍以覆盖值为准。
OVERRIDE_GRACE_SECONDS = 120.0     # 命令后至少"宽限"这么久, 才允许新帧改写状态


class StateOverrides:
    """按 key 记住命令后的临时状态, 车端上报"新到足以生效"的数据后自动失效。"""

    def __init__(self, ttl_seconds: float = 900.0,
                 grace_seconds: float = OVERRIDE_GRACE_SECONDS) -> None:
        self._items: dict[str, tuple[Any, int, float]] = {}
        self.ttl = ttl_seconds
        self.grace_ms = int(max(0.0, grace_seconds) * 1000)

    def remember(self, key: str, value: Any, collect_time: int = 0) -> None:
        """记下 key 的临时值; `collect_time` 是当前这帧车况的采集时刻。"""
        self._items[key] = (value, int(collect_time or 0), time.time() + self.ttl)

    def recall(self, key: str, collect_time: int = 0) -> Any:
        """取临时值; 车端给出"命令后且已过宽限期"的新状态(或超时)时返回 None。"""
        item = self._items.get(key)
        if item is None:
            return None
        value, stamp, expires = item
        if time.time() > expires:
            self._items.pop(key, None)
            return None
        if collect_time and stamp and int(collect_time) > stamp:
            # 帧是命令后的采集, 但命令刚发出时车还没执行 —— 宽限期内的旧值不能作数
            if int(collect_time) - stamp >= self.grace_ms:
                self._items.pop(key, None)      # 车端已有充分时间执行 → 以车端为准
                return None
        return value

    def forget(self, key: str) -> None:
        self._items.pop(key, None)


def previous_week_window_seconds(now=None) -> tuple[int, int]:
    """上一个**完整自然周**(上周一 00:00:00 ~ 上周日 23:59:59, 本地时区), 秒。

    `getLastweekEC` 要的就是这个"周汇总"窗口(与 EU 版 App 的算法一致):
    传整周返回 driverEC/acEC/otherEC; 传小窗口(如 15 分钟)直接回 `100 未找到数据!`
    —— 它**不是**任意区间接口(实测见 docs/PROTOCOL.md §6.3)。
    用 `datetime.now()`(宿主本地时区), 与集成其它日界(stats/daily_series)同一口径。
    """
    import datetime as _dt
    now = now or _dt.datetime.now()
    this_monday = (now - _dt.timedelta(days=now.weekday())).replace(
        hour=0, minute=0, second=0, microsecond=0)
    start = this_monday - _dt.timedelta(days=7)
    end = this_monday - _dt.timedelta(seconds=1)
    return int(start.timestamp()), int(end.timestamp())


def parse_lastweek_ec(data: Any) -> dict[str, float | None]:
    """把 `getLastweekEC` 的 data 归一成 `{"driver":…, "ac":…, "other":…}`(kWh, float)。

    服务端给的是字符串(实测 `{"driverEC":"86.9","acEC":"8.6","otherEC":"6.2"}`);
    缺字段给 None —— 与 0.0 区分(None = 没这个字段/拿不到, 0.0 = 真的一点都没用)。
    """
    def _f(v):
        try:
            return float(v)
        except (TypeError, ValueError):
            return None

    d = data if isinstance(data, dict) else {}
    return {"driver": _f(d.get("driverEC")),
            "ac": _f(d.get("acEC")),
            "other": _f(d.get("otherEC"))}


# ── 轮询策略 ────────────────────────────────────────────────────────
MIN_POLL_SECONDS = 60          # (旧的两档函数用)全局下限
# 停车档的下限(可调): 官方 App 静止档是 60s, 但用户可按自己需要调低到 20s;
# 再低没有意义 —— 车端在停车时本来就很少上报新帧。
MIN_PARKED_POLL_SECONDS = 20


def order_addresses_by_family(infos: list, prefer_ipv4: bool = True) -> list:
    """把 `socket.getaddrinfo` 的结果重排: **优先 IPv4**, 同族内保持原顺序。

    为什么需要: 云端域名的 DNS 会返回 **两条 AAAA(IPv6) 且排在 IPv4 之前**;
    当本机/路由的 IPv6 出口变成"黑洞"(SYN 无响应)时, 标准库会顺着地址表**逐个串行**尝试,
    每个都等满客户端超时 —— 2 条 AAAA × 20 秒 = **每轮白等 40 秒**。
    证据: HA 里 351 个慢样本全部落在 40.2 秒的整数倍(×1/×2/×3/×5/×6), 2~40 秒之间一个都没有;
    同一时刻从外部发起同一个请求只要 0.2 秒。

    这里**不是禁用 IPv6**, 只是把它排到 IPv4 之后: v6 正常时依然会被用上(第一组就是 v6),
    真遇到黑洞也最多多等一次"连接超时"。
    """
    four, six, other = [], [], []
    for info in infos or []:
        fam = info[0] if isinstance(info, (tuple, list)) and info else None
        if fam == 2:          # AF_INET
            four.append(info)
        elif fam == 10:       # AF_INET6
            six.append(info)
        else:
            other.append(info)
    return (four + six + other) if prefer_ipv4 else (six + four + other)


def choose_poll_seconds(*, parked: int, trip: int, driving: bool, launch_boost: bool,
                        short_stop: bool = False, rate_limited: bool = False,
                        floor: int = 6) -> int:
    """轮询档位决策(纯函数, 便于单测)。

    档位与依据:
      * **行驶中** → `trip`(行程采样间隔, 默认 6s)。官方 App 前台对同一个车况接口就是 6 秒一次,
        这个值同时决定行程轨迹点的时间分辨率。
      * **出发提速**(解锁 / 上电 / 非 P 挡, 且开关打开) → 也用 `trip`:
        停车档默认 60s, 不提速的话"出发后的头一分钟"会整段丢掉(等价 EU 版 mate 的 PARKED_ALERT)。
      * **短停快档**(`short_stop`: 一趟行程刚结束的一段时间内) → 也用 `trip`:
        抓住"下车买个东西 / 接人, 很快又出发"这种短停再出发 —— 停车档 60s 时,
        这类短停+再出发很容易整段漏掉; 窗口长度可配(0 = 关闭)。
        注意: 提速的**判断本身**也要等下一帧才能看到(有 ≤parked 秒的固有延迟), 这是无法消除的。
      * **限流冷却中** → 退避:`max(parked, 下限) * 2`。
      * **其余**(停车 / 充电) → `parked`(默认 60s, 与官方 App 静止档一致; 下限 20s 可调)。

    停车时**不停止轮询**: 车端休眠时本来就不上报, 停轮询只会让"车又动了"发现不了。
    """
    base = max(int(parked), MIN_PARKED_POLL_SECONDS)
    if rate_limited:
        return max(base * 2, 120)
    if driving or launch_boost or short_stop:
        return max(int(trip), floor)
    return base


def reev_ranges(signals: dict) -> dict:
    """增程车的"燃油续航 / 纯电续航 / 油电总续航" —— 按工况选定(纯函数, 可单测)。

    工况来自信号 `3262`(0=CLTC, 1=WLTC; 缺失时按 WLTC —— 与官方 App 的分支默认一致)。
    三组各有 CLTC/WLTC 两套, 车端只报一套的情况也存在, 所以缺失时**互相回退**。
    验证过的算术关系(EU mate): 总续航 = 燃油续航 + 纯电续航。
    纯电车没有这些信号 → 全部返回 None。
    """
    if not signals:
        return {"fuel_km": None, "ev_km": None, "total_km": None, "mode": None}
    mode = signals.get("range_mode_code")
    wltc = mode != 0                      # 0=CLTC; 其余(含缺失)=WLTC

    def pick(a: str, b: str):
        first, second = (a, b) if wltc else (b, a)     # a=WLTC 名, b=CLTC 名
        v = signals.get(first)
        return v if v is not None else signals.get(second)

    return {
        "fuel_km": pick("range_fuel_wltc", "range_fuel_cltc"),
        "ev_km": pick("range_ev_wltc", "range_ev_cltc"),
        "total_km": pick("range_total_wltc", "range_total_cltc"),
        "mode": "WLTC" if wltc else "CLTC",
    }


def seat_rows(signals: dict, abilities=()) -> dict:
    """这辆车有没有二排/三排座椅, 以及各有什么功能(纯函数, 可单测)。

    ★ 门控为什么用**能力位**而不是"信号有没有值" ★
    实测(纯电 C10): 它**照样上报** `1879/1880/3727/3728 = 0` —— 值 0 既可能是
    "座椅关着", 也可能是"没这套硬件", 从值上分不出来; 三排的 `12276/12277` 则干脆缺席,
    可以用"是否存在"兜底。而能力位里 22=二排、67=二排通风、85/93=三排左/右加热(见 CN App
    `LpCarTempActivity` 的显隐条件), 实测那辆 C10 的 abilities **不含** 22/67/85/93 → 不会误显示。

    ⚠️ 能力位不是处处可靠(那辆 C10 的 abilities 里也有 "20", 而研究里它在 App 里是"增程"
    判据) —— 所以在二排这种"信号会假阳性"的地方用能力位, 在增程/燃油这种"信号不会假阳性"
    的地方用信号值(`is_reev`)。
    """
    ab = {str(x) for x in (abilities or ())}
    sig = signals or {}
    return {
        "rear_heat": "22" in ab,
        "rear_vent": "67" in ab,
        "third_heat_left": "85" in ab or sig.get("seat_heat_third_left") is not None,
        "third_heat_right": "93" in ab or sig.get("seat_heat_third_right") is not None,
    }


def is_reev(signals: dict) -> bool:
    """是不是增程车: 只要车端报了燃油量/燃油续航相关信号就是。

    依据: EU mate 用 `3235 is not None` 判定, 且"值存在才建实体"最稳(不依赖能力位,
    各车型的能力码并不统一)。纯电车这些信号一律缺失。
    """
    if not signals:
        return False
    for k in ("fuel_level", "fuel_ml", "range_fuel_wltc", "range_fuel_cltc",
              "range_total_wltc", "range_total_cltc"):
        if signals.get(k) is not None:
            return True
    return False


def pick_poll_seconds(poll_seconds: int, driving_seconds: int, driving: bool,
                      floor: int = MIN_POLL_SECONDS) -> int:
    """该用哪个轮询间隔: **行驶中快、停车慢**。

    参考 EU 版的双档轮询(它按"已锁 + 已驻车 + 未充电"判定安静后放慢);这里按
    "是否在开"切档: 位置/速度只有开车时才有意义, 停车时没必要高频拉。

    * 行驶间隔**不会超过**停车间隔(用户把停车调得比行驶还短时, 取更短的那个)
    * 有下限(默认 60 秒), 避免把请求打得过密

    停车时**不能停轮询** —— 车端休眠时本来就不上报, 停轮询只会让"车又动了"发现不了。
    """
    poll_seconds = max(int(floor), int(poll_seconds))
    if not driving:
        return poll_seconds
    return max(int(floor), min(int(driving_seconds), poll_seconds))


# ── 车况信号 ────────────────────────────────────────────────────────
# 服务端把全车信号压成一个 `signalMap`: {信号号: 值}。信号号→含义的对照表
# 不是我们猜的, 而是与 EU 版 HA 集成(kerniger/leapmotor-ha)交叉核对过的 ——
# 那份表标注"已用 APK 字段名 + C10/B10 实车校验", 且与国内 App 的
# `ServerCarInfoBean` 字段一一对应(见 docs/PROTOCOL.md §4)。
#
# 本表用来自动生成实体属性, 缺失的信号直接为 None, 不影响其它信号。
SIGNAL_IDS: dict[str, str] = {
    # 位置(优先带符号的 2/3, 依次回落到 3724/3725、2191/2190)
    "2": "longitude",
    "3": "latitude",
    "sts": "signal_time",                    # 车端最后一次上报时间(ms)
    # 电量 / 续航
    "100003": "soc_precise",                 # 电量 %(带小数, 如 36.9)
    "1204": "soc",                           # 电量 %(整数)
    "2188": "range_live",                    # 表显剩余续航 km(纯电车主页那个数)
    # ── 增程(REEV)的续航: CLTC / WLTC 两套, 用信号 3262 选(0=CLTC, 1=WLTC) ──
    #    取自 CN App 的字段名(权威): cltcGasolineRemainMileage / wltcGasolineRemainMileage …
    "3256": "range_fuel_cltc",               # CLTC 燃油续航 km
    "3259": "range_fuel_wltc",               # WLTC 燃油续航 km
    "3257": "range_ev_cltc",                 # CLTC 纯电续航 km
    "3260": "range_ev_wltc",                 # WLTC 纯电续航 km
    "3258": "range_total_cltc",              # CLTC 油电总续航 km
    "3261": "range_total_wltc",              # WLTC 油电总续航 km
    "3262": "range_mode_code",               # 当前工况: 0=CLTC, 1=WLTC
    "3235": "fuel_level",                    # 燃油量 %
    # ⚠️ 3263 的单位是**毫升**(EU 三个项目一致: mate 明确除以 1000;48 L 的油箱报 45382
    #    → 只能是毫升)。对外要 /1000 才是升 —— 名字里带单位, 免得再踩。
    "3263": "fuel_ml",
    # 里程 / 行驶
    "1318": "odometer",                      # 总里程 km(已与里程接口交叉验证)
    "1319": "speed",                         # 车速 km/h
    "1010": "gear",                          # 档位
    "1944": "vehicle_state_code",
    "1480": "parking_brake",                 # 驻车制动
    "1258": "ready",                         # 上电就绪(on3)
    # 四轮胎压(kPa)+ 报警位
    "2646": "tire_fl",
    "2653": "tire_fr",
    "2660": "tire_rl",
    "2667": "tire_rr",
    "2641": "tire_alarm_fl",
    "2648": "tire_alarm_fr",
    "2655": "tire_alarm_rl",
    "2662": "tire_alarm_rr",
    # 门窗
    "1298": "lock_status",                   # 1=已锁, 0=未锁
    "1281": "trunk_open",
    # ⚠️ 这里曾经按 EU 表把 1879/1880/3727/3728 当成"车窗开度" —— 在 CN 车上它们是**后排座椅**!
    #    证据(CN App, 权威): OooOOO0.java 里
    #        leftbackState=get_$1879 / rightbackState=get_$1880  → 二排加热档位
    #        twoLeftWindState=get_$3727 / twoRightWindState=get_$3728 → 二排通风档位
    #    CN 的车窗开度是下面那四个(644/645/865/866); 每轮读到的值都是 "开度 %"。
    "1879": "seat_heat_rear_left",           # 二排左 加热档位 0~3
    "1880": "seat_heat_rear_right",          # 二排右 加热档位
    "3727": "seat_vent_rear_left",           # 二排左 通风档位
    "3728": "seat_vent_rear_right",          # 二排右 通风档位
    "12276": "seat_heat_third_left",         # 三排左 加热档位(C16 6 座; 三排无通风)
    "12277": "seat_heat_third_right",        # 三排右 加热档位
    "644": "window_percent_left_front",      # CN 车窗开度 %: 左前
    "645": "window_percent_left_rear",       # 左后
    "865": "window_percent_right_front",     # 右前
    "866": "window_percent_right_rear",      # 右后
    "1946": "rear_window_heat",
    # 充电
    "1149": "charge_connection",             # 充电枪连接状态
    "1197": "dc_cable_connected",
    "1177": "charging_voltage",              # 充电电压 V
    "1178": "charging_current",              # 充电电流 A
    "1200": "remaining_charge_minutes",      # 剩余充电分钟
    "1182": "battery_min_temp",              # 电池最低温 ℃
    "1186": "battery_heating",               # 电池加热中
    "48": "healthy_charging",                # 健康充电开关
    "47": "charge_plug",
    "3737": "charge_schedule_cancelled",
    "3638": "parking_photo",                 # 驻车照片可用
    # 空调 / 座椅 / 加热
    "1938": "climate_on",
    "3713": "climate_mode",                  # 0=关, 1=极速降温, 3=极速升温, 4=换气
    "1939": "ac_mode",                       # 0=自动, 1=手动(不是冷暖!)
    "1941": "ac_fan_level",
    "2183": "climate_temp_left",
    "2184": "climate_temp_right",
    "1349": "interior_temp",                 # 车内温度 ℃
    "2100": "seat_heat_driver",
    "2101": "seat_vent_driver",
    "2118": "seat_heat_passenger",
    "2119": "seat_vent_passenger",
    "1624": "steering_heat_minutes",           # 剩余分钟/档位(实测常驻 15, 不能当开关用)
    "49": "mirror_heat_left",
    "50": "mirror_heat_right",
    "1348": "ptc_power",
    "2669": "fast_cooling",
    "2681": "fast_heating",
    # 其它
    # 实测(真车): 1724 精确跟随「遮阳帘」指令 240 —— 开后 0→100, 关后回 0,
    # 全量差分里只有它变化。EU 表把它叫天窗开度, 在本车就是**遮阳帘开度(%)**。
    "1724": "sunshade_percent",
    "2189": "park_assist_enabled",            # 自动泊车可用
    "6047": "speed_limit_unit",               # 限速单位
    "6048": "speed_limit_kmh",                # 限速值
    "12054": "speed_limit_enabled",           # 限速识别开关
    "2956": "fuel_heater_level",              # 燃油加热器油量档位 0~4
    "100011": "ext_100011",                   # 扩展信号(EU 亦未命名)
    "100012": "ext_100012",
    "100013": "ext_100013",
    "100014": "ext_100014",
    "100015": "ext_100015",
    "100016": "ext_100016",
    "100017": "ext_100017",
    "3636": "sentry_mode",
    "1255": "raw_1255",
    "1256": "remote_session",
    "1257": "raw_1257",
    "1277": "raw_1277",
    "1278": "raw_1278",
    "1279": "raw_1279",
    "1280": "raw_1280",
    "1282": "raw_1282",
    # 四窗状态: 0=关, 2=开(目视确认: 发 "2" 后四条一起变 2, 四窗全开)
    # ⚠️ 1693~1696 与"左前/右前/左后/右后"的**对应顺序尚未确认**(只验证了同开同关)
    "1693": "window_state_1",
    "1694": "window_state_2",
    "1695": "window_state_3",
    "1696": "window_state_4",
    "1816": "steering_wheel_heating",          # 方向盘加热开关位(0/1) —— 别用 1624 判断开关!
    "1943": "raw_1943",
    "1945": "raw_1945",
    "3366": "raw_3366",
    "3736": "raw_3736",
    "6469": "raw_6469",
    "100004": "raw_100004",
    "100010": "raw_100010",
    "11259": "raw_11259",
    "11260": "raw_11260",
    "11270": "raw_11270",
    "11271": "raw_11271",
    "14742": "raw_14742",
    "14743": "raw_14743",
    "14745": "raw_14745",
    "14746": "raw_14746",
}

# 这些信号在 signalMap 里是"开关/状态位", 统一按 0/1 语义解释
_ON_FLAGS = ("climate_on", "battery_heating", "ready", "trunk_open", "parking_brake",
             "healthy_charging", "sentry_mode", "charge_plug", "dc_cable_connected",
             "mirror_heat_left", "mirror_heat_right", "rear_window_heat", "fast_cooling",
             "fast_heating")


def _num(value: Any) -> float | None:
    """把信号值转成数字(信号可能是 int/float/数字字符串/None)。"""
    if value is None or isinstance(value, bool):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


@dataclass
class CarState:
    """一帧车况。字段见 SIGNAL_IDS;未上报的信号为 None。"""

    vin: str = ""
    collect_time: int = 0                    # 服务端采集时间(epoch ms)
    signals: dict[str, float] = field(default_factory=dict)   # 名称 → 值(已按表翻译)
    raw: dict[str, Any] = field(default_factory=dict)         # 原始 signalMap(保留原键)
    # 响应里的业务码(0=成功)。解析函数**不会**因非 0 抛异常(它只回空对象),
    # 所以调用方要拿这个码去判断"是限流/风控还是普通失败"(见 is_rate_limited)。
    resp_code: int | None = None

    # ── 便捷读取 ──
    def get(self, name: str) -> float | None:
        return self.signals.get(name)

    def flag(self, name: str) -> bool | None:
        """开关类信号: 0/1 → False/True;未知 → None。"""
        v = self.signals.get(name)
        if v is None:
            return None
        return bool(int(v))

    @property
    def latitude(self) -> float | None:
        """纬度(优先带符号信号 3, 回落到 3725、2190)。"""
        v = self.signals.get("latitude")
        if v is None:
            v = self.raw.get("3725")
        if v is None:
            v = self.raw.get("2190")
        v = _num(v)
        return v if v is not None and -90 <= v <= 90 else None

    @property
    def longitude(self) -> float | None:
        """经度(优先带符号信号 2, 回落到 3724、2191)。"""
        v = self.signals.get("longitude")
        if v is None:
            v = self.raw.get("3724")
        if v is None:
            v = self.raw.get("2191")
        v = _num(v)
        return v if v is not None and -180 <= v <= 180 else None

    @property
    def latitude_wgs(self) -> float | None:
        """纬度, **WGS-84**(HA 地图 / zone / 手机口径)。

        车端给的是 GCJ-02, 这里换算成国际标准坐标 —— 用户才能直接在地图上
        拖一个圆当围栏; 原始值见 `latitude`。
        """
        lat, lon = self.latitude, self.longitude
        if lat is None or lon is None:
            return None
        return gcj02_to_wgs84(lat, lon)[0]

    @property
    def longitude_wgs(self) -> float | None:
        """经度, WGS-84(说明见 `latitude_wgs`)。"""
        lat, lon = self.latitude, self.longitude
        if lat is None or lon is None:
            return None
        return gcj02_to_wgs84(lat, lon)[1]

    @property
    def soc(self) -> float | None:
        """电量 %(优先带小数的精确值)。"""
        v = self.signals.get("soc_precise")
        if v is None:
            v = self.signals.get("soc")
        return v

    @property
    def range_km(self) -> float | None:
        """剩余续航 km —— **就是官方 App 主页那个大数字**。

        纯电车取表显(2188);增程车取"油电总续航"(3261/3258, 按工况选) —— 两者不是同一个
        信号, 但都是 App 认为该显示给用户的那个数。见 `reev_ranges()`。
        """
        if is_reev(self.signals):
            r = reev_ranges(self.signals)          # 增程: 按工况取"油电总续航"
            for v in (r["total_km"], r["ev_km"]):
                if v is not None:
                    return v
        for k in ("range_live", "range_ev_wltc", "range_ev_cltc"):
            v = self.signals.get(k)
            if v is not None:
                return v
        return None

    def tire_bar(self, corner: str) -> float | None:
        """四轮胎压, 单位 bar(车端上报 kPa)。corner: fl/fr/rl/rr。"""
        v = self.signals.get(f"tire_{corner}")
        return None if v is None else round(v / 100.0, 2)

    @property
    def windows_open(self) -> bool | None:
        """是否有车窗开着(0=关, >0=开); 完全没数据时返回 None。

        ⚠️ 注意别写成 `any(...) or None` —— 那样"全关"(False)会被转成 None。
        本车用 1693~1696 表示四窗状态(0=关, 2=开)。
        """
        states = [self.signals.get(f"window_state_{i}") for i in (1, 2, 3, 4)]
        if all(v is None for v in states):
            return None
        return any(v is not None and v > 0 for v in states)

    @property
    def sunshade_open(self) -> bool | None:
        """遮阳帘是否开着(0=全关, >0=开); 车端没上报时 None。"""
        v = self.signals.get("sunshade_percent")
        return None if v is None else v > 0

    @property
    def locked(self) -> bool | None:
        """车门锁状态(信号 1298: 1=已锁, 0=未锁)。"""
        v = self.signals.get("lock_status")
        if v is None:
            return None
        return int(v) == 1

    @property
    def charging(self) -> bool | None:
        """是否正在充电。

        ★ 判据以官方 App 为准(已修正): **只有 `1149 == 1` 才算充电中**。
        App 里就是这么写的 —— `LPCarOwnerFragment` 用 `chargeState != 1` 来隐藏"充电中"提示,
        `OooOo00` 把 **0 和 5 并列**当作"未插枪"。

        之前的写法是"电流绝对值 > 1" —— **错的**: 行驶/能量回收时电池电流本来就不为零,
        于是出现过"车在开却显示充电中"。历史数据证实那时的 1149 是 **5**,
        而被我们当成了"插着枪"。

        已知取值(1149, 官方 App 与实测):
          0 = 未插枪 / 未充电
          1 = 充电中
          2 = 已插枪待机(实测出现过一次)
          3 / 4 = 已插枪(预约充电等待等; 见 EU 版同名项目的实测注释)
          5 = **非连接**(真机: 没插枪时与 0 交替出现, 详见 `charge_plugged`)
        除 1 以外都不算充电中 —— 即便插着枪, 只要车端没报"充电中"就不误报。

        ★ 行驶护栏(修 C16 反馈的"行驶中充电中"): 物理上行驶中不可能充电, 但**某些车型
        在行驶中踩电门(能量回收/驱动电流变化)时, 车端会把 `charge_connection` 瞬时报成 1**
        (疑似该信号在部分车型上混入了"能量流动"语义)。因此判据再加一条硬约束:
        **只要车辆正在行驶(D/R 挡或车速 > 0)一律返回 False**, 无论 1149 报什么。
        这样即便车端偶发脏帧, 也不会在行驶中凭空多出一颗"充电中"。
        """
        if self.vehicle_state == "driving":
            return False
        conn = self.signals.get("charge_connection")
        if conn is None:
            return None
        try:
            code = int(conn)
        except (TypeError, ValueError):
            return None
        return code == 1

    @property
    def charge_plugged(self) -> bool | None:
        """充电枪是否插着(1149 **白名单** {1,2,3,4}; None = 车端没上报)。

        ⚠️ 判据是"白名单"而不是"非 0 即插枪" —— **`5` 不是插枪**(已修正):
          * 当晚实测: 车没插枪, 1149 在 **0 与 5 之间每 6~12 秒交替**, 同期 1197(直流枪)=0,
            传感器跟着在"已插枪/未插枪"之间跳 —— 用户看到"没插枪却显示已插枪未充电"。
          * 官方 App(`OooOo00`): 对 S01/T03 这类小车, `chargeState == 0 || == 5` **并列**
            当作"未插枪"; 对 C10 等车干脆不用 1149 判插枪(用 1197/47 枪信号)。
          * EU 版同名项目注释: "state 5 is observed while driving and is not a connection",
            其插枪集合正是 {1,2,3,4}。
        取值语义(白名单): 1=充电中(必然插着) / 2=已插枪待机(实测出现过) /
        3、4=已插枪(预约充电等待等, 见 EU 实测) / 0=未插枪 / 5=非连接(见上)。
        未知值一律**不算插枪**: 误报会凭空多出一颗"已插枪"胶囊, 漏报只是不显示 —— 宁可漏。
        ★ 行驶护栏: 行驶中物理上不可能插着枪, 但个别车型在行驶中会瞬时把 1149 报成 1/2,
        与 `charging` 同样加"行驶中一律 False"的硬约束, 免得行驶中冒出"已插枪未充电"胶囊。
        """
        if self.vehicle_state == "driving":
            return False
        conn = self.signals.get("charge_connection")
        if conn is None:
            return None
        try:
            return int(conn) in (1, 2, 3, 4)
        except (TypeError, ValueError):
            return None

    @property
    def vehicle_state(self) -> str | None:
        """行驶状态: driving / parked(优先档位, 其次车速)。"""
        gear = self.signals.get("gear")
        if gear is not None:
            if int(gear) in (1, 3):
                return "driving"
            if int(gear) in (0, 2):
                return "parked"
        speed = self.signals.get("speed")
        if speed is not None:
            return "driving" if speed > 0 else "parked"
        return None


def parse_car_state(payload: dict) -> CarState:
    """把 `signal/info/query` 的响应解析成 CarState。"""
    data = (payload or {}).get("data") if isinstance(payload, dict) else None
    data = data if isinstance(data, dict) else {}
    raw = data.get("signalMap") if isinstance(data.get("signalMap"), dict) else {}
    signals: dict[str, float] = {}
    for sid, name in SIGNAL_IDS.items():
        if sid not in raw:
            continue
        v = raw.get(sid)
        if name in _ON_FLAGS and v is not None:
            n = _num(v)
            signals[name] = n if n is not None else v
        elif isinstance(v, (int, float)) and not isinstance(v, bool):
            signals[name] = float(v)
    # 带符号的经纬度可能因为第三方 JSON 序列化丢掉负号 —— 这里保留原始值,
    # 由 CarState.latitude/longitude 决定回落到哪个信号。
    try:
        resp_code = int(payload.get("code")) if isinstance(payload, dict) else None
    except (TypeError, ValueError):
        resp_code = None
    st = CarState(
        vin=str(data.get("vin") or ""),
        collect_time=int(data.get("collectTime") or 0),
        signals=signals,
        raw={str(k): v for k, v in raw.items()},
        resp_code=resp_code,
    )
    return st


@dataclass
class Session:
    """一套可用的车端会话材料。

    前 4 项来自两步登录(账号登录 + 车端交换);`hkdf_key_hex` 由
    `derive_hkdf_key()` 从 car_token + sign_param 直接算出。
    """

    hkdf_key_hex: str = ""          # 32 字节签名密钥(hex)
    token: str = ""                 # 账号 token(64 位 hex, 短信登录取到, 约 6 小时)
    refresh_token: str = ""         # 账号 refresh token(64 位 hex, 用于免短信续期)
    phone: str = ""                 # 登录手机号(refresh_account_token 需要 RSA(手机号))
    # ── 车端(第二步交换后得到) ──
    car_token: str = ""             # 车端 JWT(车辆/车控接口的 token 头)
    car_refresh_token: str = ""
    sign_param: dict = field(default_factory=dict)      # {"r2":..,"r3":..}
    encrypt_param: dict = field(default_factory=dict)   # {"r2":..,"r3":..}
    user_id: str = ""
    device_id: str = ""
    account_token_expires_at: int = 0   # 账号 token 的到期时刻(epoch 秒;0=未知)
    operate_pwd: str = ""               # 操作密码(PIN); 敏感指令需要
    # 密码在请求里的编码方式(不同车型/固件可能不同):
    #   plain    原样(默认, 最可能)
    #   md5mid16 MD5 十六进制中段(App 的 getEncryptString)
    #   md5      完整 MD5 十六进制
    #   rsa      RSA-1024 加密 + base64url(与登录参数同款)
    operate_pwd_mode: str = "plain"
    car_vin: str = ""
    car_type: str = ""
    version: str = APP_VERSION
    sub_version: str = APP_SUBVERSION

    @property
    def hkdf_key(self) -> bytes:
        return bytes.fromhex(self.hkdf_key_hex) if self.hkdf_key_hex else b""

    @property
    def usable(self) -> bool:
        """能否用于签名调用(密钥与车端 token 齐备)。"""
        return bool(self.hkdf_key_hex and self.car_token)

    def seal_key(self) -> str:
        """用已有材料算出签名密钥并写入 hkdf_key_hex(幂等)。"""
        if not self.hkdf_key_hex and self.car_token and self.sign_param:
            self.hkdf_key_hex = derive_hkdf_key(self.car_token, self.sign_param)
        return self.hkdf_key_hex

    def save(self, path: str | Path) -> None:
        Path(path).write_text(
            json.dumps(asdict(self), ensure_ascii=False, indent=2), encoding="utf-8"
        )

    @classmethod
    def load(cls, path: str | Path) -> "Session":
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        known = set(cls.__dataclass_fields__)
        return cls(**{k: v for k, v in data.items() if k in known})


# ── 客户端 ──────────────────────────────────────────────────────────
# ── HTTP 拨号策略: IPv4 优先 + 短连接超时(只重写 connect, 其余交给 http.client) ──
import http.client   # noqa: E402  (放在这里是为了 keep 文件上方"纯协议/纯函数"的整洁)
import socket        # noqa: E402

CONNECT_TIMEOUT = 5          # 仅"建连"用; 读响应仍用调用方给的 timeout(默认 20s)


class _IPv4FirstMixin:
    """共用的拨号逻辑: 按"IPv4 优先"的顺序逐个建连, 建连超时用 CONNECT_TIMEOUT。

    为什么不用 `socket.create_connection`: 它按 getaddrinfo **原顺序**逐个试, 且每个都用同一个
    （较长的)超时 —— 遇到黑洞地址族就是成倍的等待(见 order_addresses_by_family 的说明)。
    """

    def _open_socket(self):
        import socket

        infos = []
        try:
            infos = socket.getaddrinfo(self.host, self.port, type=socket.SOCK_STREAM)
        except OSError as err:
            raise OSError(f"DNS 解析失败: {err}") from err
        last_err = None
        for fam, stype, proto, _canon, sockaddr in order_addresses_by_family(infos):
            sock = None
            try:
                sock = socket.socket(fam, stype, proto)
                sock.settimeout(CONNECT_TIMEOUT)      # 只约束"建连"这一步
                sock.connect(sockaddr)
                return sock
            except OSError as err:
                last_err = err
                if sock is not None:
                    try:
                        sock.close()
                    except OSError:
                        pass
        raise last_err or OSError("没有可用地址")

    def connect(self):
        """建连成功后, 把 socket 超时换回调用方的值(读响应可能比建连慢)。"""
        import socket

        sock = self._open_socket()
        self.sock = sock
        if getattr(self, "_tunnel_host", None):
            self._tunnel()                                  # type: ignore[attr-defined]
        if self.timeout is not None and self.timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
            sock.settimeout(self.timeout)


class _IPv4FirstHTTPSConnection(_IPv4FirstMixin, http.client.HTTPSConnection):
    """HTTPS 版: 建连(TCP)走上面的策略, TLS 包装仍用 http.client 自己的实现。"""

    def connect(self):
        import socket

        sock = self._open_socket()
        if getattr(self, "_tunnel_host", None):
            self.sock = sock
            self._tunnel()
            sock = self.sock
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)
        if self.timeout is not None and self.timeout is not socket._GLOBAL_DEFAULT_TIMEOUT:
            self.sock.settimeout(self.timeout)


class _IPv4FirstHTTPConnection(_IPv4FirstMixin, http.client.HTTPConnection):
    """HTTP 版(仅用于排查/兼容: 我们访问的都是 https)。"""


def _build_opener(ctx):
    """构造一个"IPv4 优先"的 urllib opener(每次调用重建, 无全局状态)。"""
    import urllib.request

    class _HTTPHandler(urllib.request.HTTPHandler):
        def http_open(self, req):
            return self.do_open(_IPv4FirstHTTPConnection, req)

    class _HTTPSHandler(urllib.request.HTTPSHandler):
        def https_open(self, req):
            return self.do_open(_IPv4FirstHTTPSConnection, req, context=ctx)

    return urllib.request.build_opener(_HTTPHandler(), _HTTPSHandler())


def parse_car_picture_url(response: Any) -> str:
    """从车辆外观图接口响应中提取整车图片地址。"""
    if not isinstance(response, dict):
        return ""
    payloads = (response.get("data"), response)
    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        for key in ("shareBindUrl", "url", "imageUrl", "picUrl", "carPic"):
            value = payload.get(key)
            if not isinstance(value, str):
                continue
            url = value.strip()
            if url.lower().startswith("http://"):
                url = "https://" + url[7:]
            if url.lower().startswith("https://"):
                return url
    return ""


class LeapmotorClient:
    """零跑汽车客户端(仅标准库 + cryptography 做 RSA)。"""

    def __init__(self, session: Session | None = None, timeout: int = 20):
        self.session = session or Session()
        self.timeout = timeout
        if not self.session.device_id:
            self.session.device_id = new_device_id()

    # ---- HTTP 底层 ----
    def _http(self, method: str, url: str, headers: dict[str, str],
              body: Any = None, form: bool = False) -> dict:
        import ssl
        import urllib.error
        import urllib.request

        data = None
        hdrs = dict(headers)
        if isinstance(body, (bytes, bytearray)):
            data = bytes(body)
        elif body is not None:
            if form:
                data = urlencode(body).encode("utf-8")
                hdrs["Content-Type"] = "application/x-www-form-urlencoded"
            else:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                hdrs.setdefault("Content-Type", "application/json;charset=UTF-8")

        req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
        ctx = ssl.create_default_context()
        opener = _build_opener(ctx)          # IPv4 优先(见文件上方的拨号策略说明)
        try:
            with opener.open(req, timeout=self.timeout) as resp:
                raw = resp.read().decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            raw = e.read().decode("utf-8", "replace")
            log.warning("HTTP %s %s -> %s", e.code, url, raw[:200])
        except Exception as e:  # 网络层异常也给调用方一个可判断的结构
            log.warning("请求失败 %s: %s", url, e)
            return {"code": -1, "message": f"网络错误: {e}", "data": None}

        try:
            return json.loads(raw)
        except json.JSONDecodeError:
            return {"_raw": raw}

    # ---- 请求头 + 签名 ----
    def _signed_headers(self) -> dict[str, str]:
        """构造参与签名的 7 个头(其余头不参与)。"""
        s = self.session
        return {
            "acceptLanguage": DEFAULT_LANGUAGE,
            "channel": APP_CHANNEL,
            "deviceType": APP_DEVICE_TYPE,
            "source": APP_SOURCE,
            "timestamp": str(int(time.time() * 1000)),
            "version": s.version or APP_VERSION,
            "deviceId": s.device_id,
        }

    def _extra_headers(self) -> dict[str, str]:
        """发送但不参与签名的头。"""
        s = self.session
        h = {
            "x-region": DEFAULT_REGION,
            "x-subversion": s.sub_version or APP_SUBVERSION,
            "x-api-signature-version": X_API_SIGNATURE_VERSION,
        }
        if s.car_token:
            h["token"] = s.car_token
        if s.user_id:
            h["userId"] = str(s.user_id)
        if s.car_vin:
            h["carvin"] = s.car_vin
        if s.car_type:
            h["cartype"] = s.car_type
        return h

    def sign(self, payload: dict[str, Any]) -> str:
        """对「业务参数 ∪ 签名头」求 HMAC-SHA256。"""
        merged = dict(payload)
        merged.update(self._signed_headers())
        return hmac.new(
            self.session.hkdf_key, sort_and_concat(merged).encode("utf-8"), hashlib.sha256
        ).hexdigest()

    def build_headers(self, payload: dict[str, Any] | None = None) -> dict[str, str]:
        payload = dict(payload or {})
        headers = self._signed_headers()
        headers.update(self._extra_headers())
        sig = self.sign(payload)
        headers["sign"] = sig
        headers["digest"] = sig
        return headers

    def _require_session(self) -> None:
        if not self.session.hkdf_key_hex:
            raise RuntimeError("缺少签名密钥: 先调用 car_login() 或 session.seal_key()")

    # ---- 车控服务(appgateway /carownerservice/) ----
    def car_call(self, path: str, params: dict[str, Any] | None = None,
                 method: str = "GET", form: bool = False) -> dict:
        """调用车控接口。params 为查询串(GET)或表单字段(POST), **均参与签名**。"""
        self._require_session()
        params = dict(params or {})
        url = f"{BASE_URL}{API_PREFIX}{path.lstrip('/')}"
        headers = self.build_headers(params)
        if method == "GET":
            if params:
                url += ("&" if "?" in url else "?") + urlencode(params)
            return self._http("GET", url, headers)
        return self._http(method, url, headers, params, form=form)

    # ---- 全局服务(app-gw-global-master /app/app-global-service/) ----
    def global_call(self, path: str, params: dict[str, Any] | None = None) -> dict:
        self._require_session()
        params = dict(params or {})
        url = f"{GLOBAL_BASE}{GLOBAL_PREFIX}{path.lstrip('/')}"
        if params:
            url += ("&" if "?" in url else "?") + urlencode(params)
        return self._http("GET", url, self.build_headers(params))

    # ---- 账号 / 登录 ----
    def _account_headers(self) -> dict[str, str]:
        h = dict(_ACCOUNT_HEADERS)
        h["APPImei"] = self.session.device_id
        return h

    def request_sms_code(self, phone: str) -> dict:
        """发送短信验证码。

        实测:`GET /app-user/applogin/compliance/sendmessagecode?phoneNo=<RSA>`
        - 手机号必须 RSA 加密(base64url 去 padding), 否则报 1019
        - `smDeviceId`(数美反欺诈设备指纹)**可以省略** —— 省略时服务端直接放行
        - 同一号码 60s 内重复请求报错码 36(发送频繁)
        """
        url = f"{ACCOUNT_BASE}/{EP_SMS_CODE}?phoneNo={rsa_encrypt_b64url(phone)}"
        return self._http("GET", url, self._account_headers())

    def login(self, phone: str, sms_code: str) -> dict:
        """手机号 + 验证码登录 → 账号 token。

        实测(真实账号端到端跑通,抓包逐字段核对):

            POST /app-user/applogin/check_login_with_phone
                 ?phoneNoCiphertext=<RSA(手机号)>&smsCode=<明文验证码>
                 &os=android&pageUrl=精选&deviceID=<32位hex>

        三个容易写错的点(都踩过,报 `1019 参数不能为空`):
          1. 参数在 **query string** 里,不是表单体(请求体为空)
          2. 字段名是 `phoneNoCiphertext`(不是 `phoneNo`)、`smsCode`
          3. **验证码是明文** —— 只有手机号要 RSA 加密

        成功响应里 token 藏在 **`data.appLoginVO`**:
            {"code":200,"data":{"appLoginVO":{"token":"32位hex","refreshToken":"…",
              "tokenExpired":"21599","accountId":"…","nickname":"LP_xxx"}}}
        注意 `tokenExpired` 约 21600 秒(6 小时),与车端 token 的 2 小时不同。

        风控:同一环境短时间多次失败会返回
        `1023 您的账号环境疑似高风险，请10分钟后再尝试`。
        **该状态下的重试会延长冷却时间** —— 必须静默等待, 不要轮询重试
        (这个坑我们踩过:90s 轮询把 10 分钟冷却拖成了数小时)。
        """
        url = f"{ACCOUNT_BASE}/{EP_LOGIN}"
        query = urlencode({
            "phoneNoCiphertext": rsa_encrypt_b64url(phone),
            "smsCode": sms_code,                 # 明文, 不加密
            "os": "android",
            "pageUrl": "精选",
            "deviceID": self.session.device_id,
        })
        resp = self._http("POST", f"{url}?{query}", self._account_headers(), b"", form=False)

        s = self.session
        s.phone = phone
        data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
        vo: dict = {}
        for key in ("appLoginVO", "appOneLoginVO", "appOtherLoginVO"):
            if isinstance(data.get(key), dict):
                vo = data[key]
                break
        if not vo:
            vo = data if (data.get("token") or data.get("accessToken")) else {}
        if not vo and isinstance(resp.get("appLoginVO"), dict):
            vo = resp["appLoginVO"]

        token = vo.get("token") or vo.get("accessToken")
        if token:
            s.token = str(token)
        # 账号 token 约 6 小时(响应里的 tokenExpired 是剩余秒数, 实测 21599)
        try:
            ttl = int(float(vo.get("tokenExpired") or vo.get("expiresIn") or 0))
        except (TypeError, ValueError):
            ttl = 0
        if ttl > 0:
            s.account_token_expires_at = int(time.time()) + ttl
        if vo.get("refreshToken"):
            s.refresh_token = str(vo["refreshToken"])
        uid = vo.get("accountId") or vo.get("userId") or vo.get("id")
        if uid not in (None, ""):
            s.user_id = str(uid)
        return resp

    def refresh_account_token(self, phone: str | None = None) -> dict:
        """**账号 token 续期(免短信)** —— 实测拿到 `code=200`,token 延 6 小时。

        形状来源:抓取 App 自己发出的请求(叠加反汇编
        `com.leapmotor.network.TokenRefreshManager.getTokenRefreshCall()` +
        `BaseApi.getNewToken` + `HeadersInterceptor`),signStr 与抓包**逐字节一致**:

            GET https://appuser.leapmotor.cn/app-user/appuseroperate/getnewtoken
                ?timespan=<毫秒>&nonce=<5~8位随机>&deviceID=<登录时用的 deviceId>
                &accountId=<accountId>&accountNumber=<RSAurl(手机号)>
                &signStr=<MD5(按 key 排序拼接各 value)[8:24]>
            XFX-CDN-CROSS-REFRESH-NODE: <refreshToken>    ← 唯一必需的凭据头

        要点(全部实测, 见 docs/PROTOCOL.md §3):
          * refreshToken 走**请求头** `XFX-CDN-CROSS-REFRESH-NODE`,不是 query/body;
            缺这个头时服务端直接 500(之前所有"签名参数生成异常"的尝试都源于此)
          * 签名串 = {accountId, accountNumber, deviceID, nonce, refreshtoken, timespan}
            六个值按 key 字典序拼接,取 MD5 十六进制第 8~24 位(App 的
            `MD5Util.getEncryptString`);`refreshtoken` **只参与签名、不作为参数发送**
          * `deviceID` 必须与**登录时**一致(服务端把 refreshToken 绑在登录设备上):
            换成别的设备 id 返回 `code=45 refreshtoken失效`
          * 实测 `XFX-CDN-CROSS-NODE`(账号 token 头)服务端**不校验**:换成无效值、
            甚至删掉,都照样 200 → **账号 token 已过期也能救回来**
          * 响应 `{"code":200,"data":{"token":<新token>,"refreshToken":<原值>,
            "tokenExpired":"21600",...}}` —— refreshToken **不轮换**,只要它自身没过期
            就能无限续期(6 小时 → 长期免登录)

        成功时把新 token 写回 `session.token` 并刷新 `account_token_expires_at`。
        """
        s = self.session
        if not s.refresh_token:
            raise RuntimeError("缺少 refresh_token: 先 login() 或以会话材料载入")
        ph = phone or s.phone
        if not s.user_id or not ph:
            raise RuntimeError("缺少 accountId / 手机号, 无法构造账号刷新请求")
        params = {
            "timespan": str(int(time.time() * 1000)),
            "nonce": str(random.randint(10000, 10000000)),
            "deviceID": s.device_id or new_device_id(),
            "refreshtoken": s.refresh_token,     # 只进签名串, 不进 query
            "accountId": s.user_id,
            "accountNumber": rsa_encrypt_b64url(ph),
        }
        params["signStr"] = md5_mid16("".join(v for _, v in sorted(params.items())))
        params.pop("refreshtoken")
        headers = self._account_headers()
        headers.pop("Content-Type", None)        # GET 不带 body
        headers.update({
            "XFX-CDN-CROSS-REFRESH-NODE": s.refresh_token,
            "XFX-CDN-VRS": "v4",
            "C-VERSIONS": "APP",
        })
        if s.token:
            headers["XFX-CDN-CROSS-NODE"] = s.token   # 服务端不校验, 仅为与 App 一致
        url = f"{ACCOUNT_BASE}/{EP_ACCOUNT_REFRESH}?{urlencode(params)}"
        resp = self._http("GET", url, headers)
        data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
        if resp.get("code") in (0, 200) and data.get("token"):
            s.token = str(data["token"])
            if data.get("refreshToken"):         # 实测服务端返回同一个 refreshToken
                s.refresh_token = str(data["refreshToken"])
            try:
                ttl = int(float(data.get("tokenExpired") or 0))
            except (TypeError, ValueError):
                ttl = 0
            if ttl > 0:
                s.account_token_expires_at = int(time.time()) + ttl
            log.info("账号 token 刷新成功(免短信), %s 秒后过期", ttl or "?")
        else:
            log.warning("账号 token 刷新失败: code=%s msg=%s",
                        resp.get("code"), resp.get("msg") or resp.get("message"))
        return resp

    def _exchange_once(self, body: dict, *, with_sign: bool = True, upper: bool = True,
                       path: str = EP_CAR_LOGIN, host: str = GLOBAL_BASE) -> dict:
        """按指定变体发一次交换请求(见 car_login 的说明)。

        `path`/`host` 可换 —— 刷新接口(`/base/base-user/token/v1/refresh`)与交换
        同族、同签名方式, 只是路径不同。
        """
        url = f"{host.rstrip('/')}/{path.lstrip('/')}"
        ts = str(int(time.time() * 1000))
        # 与抓包逐字段一致:6 个基础头 + nonce;不送 deviceId/cartype/carvin/token
        core = {
            "acceptLanguage": DEFAULT_LANGUAGE,
            "channel": APP_CHANNEL,
            "deviceType": APP_DEVICE_TYPE,
            "source": APP_SOURCE,
            "timestamp": ts,
            "version": self.session.version or APP_VERSION,
            "nonce": str(random.randint(1000000, 9999999)),
        }
        headers = dict(core)
        headers.update({
            "x-region": DEFAULT_REGION,
            "x-subversion": self.session.sub_version or APP_SUBVERSION,
            "x-api-signature-version": X_API_SIGNATURE_VERSION,
            "Content-Type": "application/json; charset=utf-8",
        })
        if with_sign:
            # ★ 关键: 这个端点用 **SHA256**,不是 HMAC, 且**请求体字段参与签名**
            #   (离线穷举反推出来的, 见 docs/PROTOCOL.md §3)
            merged = {**core, **body}
            digest = hashlib.sha256(sort_and_concat(merged).encode("utf-8")).hexdigest()
            headers["sign"] = digest.upper() if upper else digest
            headers["digest"] = headers["sign"]
        return self._http("POST", url, headers, body, form=False)

    def car_login(self, tries: int = 4) -> dict:
        """**车端登录**: 用账号 token 换取车端 JWT 与签名密钥材料。

        请求形状来自运行时抓包,且签名算法是**离线穷举反推**出来的:

            POST https://app-gw-global-master.leapmotor.com/base/base-user/account/v1/login
            Content-Type: application/json; charset=utf-8
            body: {"identifier":"<accountId>", "security":"<账号token>", "identifierType":"1"}

            sign = SHA256( 排序拼接( 6个基础头 + nonce + **body 的 3 个字段** ) )

        实证过程(见 docs/PROTOCOL.md §3):
          * 抓包里这个端点的 sign 是 **SHA256**,不是 HMAC —— 因为交换发生在拿到
            签名密钥之前, 走的是"无需登录"分支(附录 A.4)
          * body 的 identifier / security / identifierType **参与签名**
          * 用**已过期**的账号 token 验证修复后, 错误从 `302002002 签名信息校验失败`
            变成 `302010202 第三方TOKEN失效` —— 即签名这关已过, 只剩 token 有效期

        成功响应:
            {"code":0,"message":"SUCCESS","data":{
               "accountId":…, "accessToken":"eyJ…",   # 车端 JWT
               "refreshToken":"eyJ…", "tokenExpireTime":7200,
               "signParam":{"r2":"…","r3":"…"}, "encryptParam":{"r2":"…","r3":"…"}}}

        本方法会自动调用 `derive_hkdf_key()` 把签名密钥算好 —— 之后即可直接调车控接口。

        :param tries: 签名变体最多试几次(大小写/带不带签名);正常情况第 1 次就成。
        """
        s = self.session
        if not s.token or not s.user_id:
            raise RuntimeError("需要先完成账号登录(缺少 token 或 userId)")
        body = {
            "identifier": str(s.user_id),
            "security": s.token,
            "identifierType": "1",
        }
        # 变体顺序: 抓包形态(大写) → 小写 → 不带签名。命中即停, 失败也不无限重试。
        variants = [(True, True), (True, False), (False, False)][:max(1, tries)]
        sig_err = SIGNATURE_ERROR_CODES
        last: dict = {}
        for with_sign, upper in variants:
            resp = self._exchange_once(body, with_sign=with_sign, upper=upper)
            last = resp
            data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
            if data.get("accessToken"):
                s.car_token = str(data.get("accessToken") or s.car_token)
                s.car_refresh_token = str(data.get("refreshToken") or s.car_refresh_token)
                if isinstance(data.get("signParam"), dict):
                    s.sign_param = data["signParam"]
                if isinstance(data.get("encryptParam"), dict):
                    s.encrypt_param = data["encryptParam"]
                uid = data.get("accountId")
                if uid not in (None, ""):
                    s.user_id = str(uid)
                s.hkdf_key_hex = ""          # 会话更新, 旧密钥作废
                s.seal_key()
                log.info("车端交换成功(签名=%s, 大小写=%s)",
                         "SHA256" if with_sign else "无", "大写" if upper else "小写")
                return resp
            if resp.get("code") not in sig_err:
                break                        # 不是签名问题(如 token 失效)→ 别浪费请求
        return last

    def refresh_car_token(self) -> dict:
        """**车端 token 刷新**: 用 refreshToken 换新的 accessToken/refreshToken。

        形状来自对官方 App 的反汇编(详见 docs/PROTOCOL.md §3):
        类 `com.dahua.leapmotor.lpcar_login.OooO00o` 的字节码等价于

            body = hashMapOf("refreshToken" to LoginInfoManager.getRefreshToken())
            url  = URLFactory.createURLData(ServerConfig.GLOBAL_SERVER_URL,
                                            "/base/base-user", "/token/v1/refresh")
            HttpRequestUtil.postJson(url, RequestLabel.REFRESH, body, callback)

        即:

            POST https://app-gw-global-master.leapmotor.com/base/base-user/token/v1/refresh
            Content-Type: application/json; charset=utf-8
            body: {"refreshToken": "<交换响应里的 refreshToken(JWT)>"}

            sign = SHA256( 排序拼接( 6个基础头 + nonce + body 字段 ) ).upper()

        与车端登录交换(`car_login`)共用同一条 `HttpRequestUtil.postJson` 通道与同一套
        签名规则(`_exchange_once`),只是 `RequestLabel` 从 LOGIN 换成 REFRESH。
        **不要**额外发 `token` 头 —— 实测带上它会变成签名校验失败(302002002)。

        实测: 手里会话的账号 token 05:41 过期、车端 accessToken 07:06 过期,
        之后该端点对正确形状返回 `302010219 登陆过期`(字段名认得出、会话已死);
        `{"refreshToken": <32位hex 账号refresh>}` 则返回 `TOKEN令牌刷新异常` ——
        即 body 里 `refreshToken` 字段是被服务端识别的,形状无误。**成功响应尚未实测到**。

        成功时(契约同交换:`data.accessToken` / `data.refreshToken` /
        `signParam` / `encryptParam`)本方法会把新 token 写回 `session` 并重算签名密钥;
        与 App 行为一致 —— App 每次刷新成功后也会保存新的 token 到 MMKV
        (`保存新的Token:` / `login_info_token` / `login_info_refresh_token`)。
        """
        s = self.session
        if not s.car_refresh_token:
            raise RuntimeError("缺少 car_refresh_token: 先 car_login() 或从会话材料载入")
        body = {"refreshToken": s.car_refresh_token}
        resp = self._exchange_once(body, with_sign=True, upper=True,
                                   path=EP_CAR_REFRESH, host=GLOBAL_BASE)
        data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
        if data.get("accessToken"):
            s.car_token = str(data["accessToken"])
            s.car_refresh_token = str(data.get("refreshToken") or s.car_refresh_token)
            if isinstance(data.get("signParam"), dict):
                s.sign_param = data["signParam"]
            if isinstance(data.get("encryptParam"), dict):
                s.encrypt_param = data["encryptParam"]
            uid = data.get("accountId")
            if uid not in (None, ""):
                s.user_id = str(uid)
            s.hkdf_key_hex = ""              # 会话更新, 旧密钥作废
            s.seal_key()
            log.info("车端 token 刷新成功")
        else:
            log.warning("车端 token 刷新失败: code=%s message=%s",
                        resp.get("code"), resp.get("message") or resp.get("msg"))
        return resp

    # ---- 车辆 ----
    def get_vehicle_list(self) -> list[Vehicle]:
        """车辆列表(GET 全局服务 /v1/vehicle/list)。

        实测:返回 data.sharedcars[] / bindcars[]。
        共享车(子账号被授权的车)在 sharedcars 里, 其 rightList 字段是
        **该账号在此车上被授权的 cmdId 清单** —— 判断某条指令能否下发就看它。
        """
        resp = self.global_call(EP_VEHICLE_LIST)
        items = _extract_vehicles(resp)
        if items:
            s = self.session
            # 只有一辆车时自动作为默认车辆, 后续车控头 carvin 即带上
            if not s.car_vin and len(items) == 1:
                s.car_vin = items[0].vin
                if items[0].car_type:
                    s.car_type = items[0].car_type
        return items

    def get_car_config(self, vin: str = "") -> dict:
        """车辆配置/能力(GET /v3/api/vehicleinfo/commonConfig?vin=...)。

        实测:返回 data.config —— 含充电日程(percent/cycles/endTime)等配置项。
        """
        vin = vin or self.session.car_vin
        old = self.session.car_vin
        self.session.car_vin = vin
        try:
            return self.car_call(EP_VEHICLE_CONFIG, {"vin": vin})
        finally:
            self.session.car_vin = old

    def remote_control(self, vin: str, cmd_id: int | str,
                       state: dict[str, Any] | None = None,
                       extra: dict[str, Any] | None = None) -> dict:
        """远程控制指令下发(POST form /v3/api/appremotectl)。

        表单必填: cmdid / state / carvin / nonce(缺任一回 `Required String parameter 'x'`)
        有操作密码时: 先 oprpwd 校验(verifyoperatepwdnew), 再带上 oppwd 下发。

        ★ `state` 是"指令内容"对象, 内容随指令而异, 而且**值都是字符串枚举** ★
        实测教训: 曾经用 `{"operate":1}` 下发车门 —— 服务端**受理**(code 0)但**车不会动**,
        因为车端不认这个结构。正确形态(见 CMD_* 辅助方法与 docs/PROTOCOL.md §6.2):

            车门 110     {"value":"lock"} / {"value":"unlock"}
            寻车 120     {"value":"true"}
            后备箱 130   {"value":"true"|"false"}
            车窗 230     {"value":"2"|"0"}   ← "2"=开(目视确认: 四窗全开)
            遮阳帘 240   {"value":"10"|"0"}
            电池预热 160 {"value":"ptcon"|"ptcoff"}
            充电开关 193 {"value":"start"|"stop"}
            空调 170     {"circle":"out","mode":"wind","operate":"manual|auto",
                          "position":"all","temperature":"26","windlevel":3,"wshld":"0"}
                         关: operate="off" (★不是 "close" —— 实测车端不执行, 见 ac_off)

        :param state: 指令内容(JSON 对象); 用下面的 lock()/unlock() 等封装更省事
        :param extra: 额外表单字段(排查用)
        """
        if self.session.operate_pwd:
            # 先校验密码; 不通过就直接返回(不再下发, 省得又记一次错误)
            v = self.verify_operate_pwd(vin or self.session.car_vin)
            if isinstance(v, dict) and v.get("code") not in (0, None):
                log.warning("操作密码校验未通过: %s", str(v)[:160])
                return v
        body: dict[str, Any] = {
            "cmdid": str(cmd_id),
            "state": json.dumps(state or {}, ensure_ascii=False, separators=(",", ":")),
            "carvin": vin or self.session.car_vin,
            "nonce": str(random.randint(1000000, 9999999)),
        }
        if self.session.operate_pwd:
            body["oppwd"] = self._encrypted_pwd()
        body.update(extra or {})
        old = self.session.car_vin
        if vin:
            self.session.car_vin = vin
        try:
            return self.car_call(EP_REMOTE_CTL, body, method="POST", form=True)
        finally:
            self.session.car_vin = old

    def _encrypted_pwd(self) -> str:
        """按当前模式把操作密码编码成请求值。aes_jwt 用车辆 token 派生密钥。"""
        s = self.session
        tok = (s.car_token or s.token) if s.operate_pwd_mode == "aes_jwt" else s.token
        return encode_operate_pwd(s.operate_pwd, s.operate_pwd_mode, tok)

    def verify_operate_pwd(self, vin: str = "") -> dict:
        """校验操作密码(车控前的第一步, 与 App 一致)。

        实测: 缺参数报 `Required String parameter 'vin'/'oprpwd' is not present`,
        所以字段是 **vin + oprpwd**; 密码值必须是加密后的(base64)。
        """
        vin = vin or self.session.car_vin
        return self.car_call(EP_VERIFY_OPER_PWD,
                             {"vin": vin, "oprpwd": self._encrypted_pwd()},
                             method="POST", form=True)

    def query_command(self, msg_id: str, vin: str = "") -> dict:
        """指令结果查询(GET /v3/api/appremotectl/query?msgID=...)。

        实测:缺少 msgID 会报 `Required String parameter 'msgID' is not present`。
        """
        old = self.session.car_vin
        if vin:
            self.session.car_vin = vin
        try:
            return self.car_call(EP_REMOTE_CTL_QUERY, {"msgID": str(msg_id)})
        finally:
            self.session.car_vin = old

    def wait_command(self, msg_id: str, vin: str = "", timeout: float = 25.0,
                     interval: float = 1.5) -> dict:
        """轮询指令结果直到有明确结论或超时。"""
        deadline = time.time() + timeout
        last: dict = {}
        while time.time() < deadline:
            last = self.query_command(msg_id, vin=vin)
            data = last.get("data") if isinstance(last.get("data"), dict) else {}
            status = str(data.get("status", data.get("result", ""))).lower()
            if status in ("1", "2", "success", "fail", "failed", "true", "false"):
                return last
            time.sleep(interval)
        return last

    # ---- 常用指令封装(state 内容全部来自 EU SDK 的实测映射 + CN App bean) ----
    def lock(self, vin: str = "") -> dict:
        """锁车(cmdId 110, state={"value":"lock"})。"""
        return self.remote_control(vin, CMD_DOOR, {"value": "lock"})

    def unlock(self, vin: str = "") -> dict:
        """解锁(cmdId 110, state={"value":"unlock"})。"""
        return self.remote_control(vin, CMD_DOOR, {"value": "unlock"})

    def find_car(self, vin: str = "") -> dict:
        return self.remote_control(vin, CMD_FIND, {"value": "true"})

    def trunk(self, vin: str = "", on: bool = True) -> dict:
        """后备箱开关(on=True 开 / False 关)。车端状态信号 `1281`(0=关, 1=开)。"""
        return self.remote_control(vin, CMD_TRUNK, {"value": "true" if on else "false"})

    def open_trunk(self, vin: str = "") -> dict:
        return self.trunk(vin, on=True)

    def close_trunk(self, vin: str = "") -> dict:
        return self.trunk(vin, on=False)

    # 车窗档位 → 指令值。**刻度是 0~10, 不是 0~100**:
    #   * EU 版开源项目在 B10 上的实测结论(他们文档里的 v1.11.x 记录):
    #     "only 0 / 2 / 5 / 10 move the car = closed / ~20% (vent) / ~50% / fully open",
    #     其余取值(1,3,4,6..9, 以及 25/50/100) 云端回"请求成功"但车端不动。
    #   * 我们自己在 C10 上复核过其中两点: `100` 与 `1` 发了车不动, `2`/`0` 确实动
    #     —— 与 0~10 刻度一致、与 0~100 刻度矛盾。
    #   * 车端只回报"开/关"这一个位(信号 1693~1696: 0=关, 非 0=开), **量不出开度**,
    #     所以"微开/半开/全开具体开多大"要靠肉眼确认(HA 里三个按钮分别发 2/5/10)。
    WINDOW_LEVELS: dict[str, str] = {"close": "0", "vent": "2", "half": "5", "open": "10"}

    def windows_open(self, vin: str = "", value: str = "") -> dict:
        """开窗。value 用 `WINDOW_LEVELS` 里的值: 0=关, 2=微开, 5=半开, 10=全开。

        默认全开("10");传 "2"/"5" 就是微开/半开 —— 对应官方 App 里的三档。
        """
        v = value or self.WINDOW_LEVELS["open"]
        return self.remote_control(vin, CMD_WINDOW, {"value": str(v)})

    def windows_vent(self, vin: str = "") -> dict:
        """微开(≈20%)。"""
        return self.windows_open(vin, value=self.WINDOW_LEVELS["vent"])

    def windows_half(self, vin: str = "") -> dict:
        """半开(≈50%)。"""
        return self.windows_open(vin, value=self.WINDOW_LEVELS["half"])

    def windows_close(self, vin: str = "") -> dict:
        """全关。"""
        return self.windows_open(vin, value=self.WINDOW_LEVELS["close"])

    def sunshade(self, vin: str = "", on: bool = True) -> dict:
        """遮阳帘开关(on=True 开 / False 关)。状态信号 `1724`(0=全关, 100=全开)。"""
        return self.remote_control(vin, CMD_SUNSHADE, {"value": "10" if on else "0"})

    def sunshade_open(self, vin: str = "") -> dict:
        return self.sunshade(vin, on=True)

    def sunshade_close(self, vin: str = "") -> dict:
        return self.sunshade(vin, on=False)

    def preheat_on(self, vin: str = "") -> dict:
        return self.remote_control(vin, CMD_PREHEAT, {"value": "ptcon"})

    def preheat_off(self, vin: str = "") -> dict:
        return self.remote_control(vin, CMD_PREHEAT, {"value": "ptcoff"})

    def ac_on(self, vin: str = "", temperature: float = 24.0,
              mode: str = "wind", operate: str = "manual",
              windlevel: int = 3, circle: str = "out") -> dict:
        """开空调(cmdId 170)。temperature 16~32, windlevel 1~7。"""
        content = {
            "circle": circle,               # in / out
            "mode": mode,                   # cold / hot / wind
            "operate": operate,             # manual / auto (关空调见 ac_off: 用 "off")
            "position": "all",
            "temperature": str(int(round(temperature))),
            "windlevel": int(windlevel),
            "wshld": "0",
        }
        return self.remote_control(vin, CMD_AC, content)

    def ac_off(self, vin: str = "", temperature: float = 26.0,
               windlevel: int = 4, mode: str = "nohotcold",
               circle: str = "out") -> dict:
        """关空调(cmdId 170)。

        ★★ 值必须是 `operate:"off"` —— **不是 `"close"`** ★★
        真车对比(读车端信号 1938):
          `{"operate":"close"}`         → 云端 code=0「请求成功」, 但车端**毫无反应**
          `{"operate":"off", 完整字段}` → 18 秒内 1938 由 1 变 0, 空调确实关闭 ✓
        报文形状照抄 App 的 `AirController.OooO00o(false)`: operate=off 加上
        温度/风量/模式/circle, 再显式 setPosition("all") / setWshld("1")。
        (`"close"` 在 CN 版 App 里**一次都没被调用过**, 属于早期从 EU 文档抄错的取值。)
        """
        content = {
            "circle": circle,
            "mode": mode,
            "operate": "off",
            "position": "all",
            "temperature": str(int(round(temperature))),
            "windlevel": int(windlevel),
            "wshld": "1",
        }
        return self.remote_control(vin, CMD_AC, content)

    # ---- 空调 ----
    AC_QUICK: dict[str, dict[str, Any]] = {
        # 与 App 上的四个快捷选项对应(EU 版实测表)
        "boost_cool": {"circle": "in",  "mode": "cold",      "operate": "manual",
                       "position": "all", "temperature": "18", "windlevel": 7, "wshld": "1"},
        "boost_heat": {"circle": "in",  "mode": "hot",       "operate": "manual",
                       "position": "all", "temperature": "32", "windlevel": 7, "wshld": "1"},
        "deodorize":  {"circle": "out", "mode": "nohotcold", "operate": "manual",
                       "position": "all", "temperature": "24", "windlevel": 4, "wshld": "1"},
        "defrost":    {"circle": "in",  "mode": "nohotcold", "operate": "auto",
                       "position": "all", "temperature": "24", "windlevel": 7, "wshld": "2"},
    }

    def ac_quick(self, vin: str = "", mode: str = "boost_cool") -> dict:
        """空调快捷模式: boost_cool(极速降温) / boost_heat(极速升温) /
        deodorize(快速除味) / defrost(风挡除霜)。"""
        content = dict(self.AC_QUICK.get(mode) or self.AC_QUICK["boost_cool"])
        return self.remote_control(vin, CMD_AC, content)

    # ---- 座椅 / 方向盘 / 后视镜 ----
    def set_seat(self, vin: str = "", position: str = "driver", level: int = 0,
                 heat: bool = True) -> dict:
        """座椅加热/通风。position: driver/copilot;level: 0(关)~3。

        实测(EU 版在 B10/C10 上验证过的形态): {"position":"driver","level":"2"}
        —— 不是库里旧的 {"value":"位置,档位"}。
        """
        cmd = CMD_SEAT_HEAT if heat else CMD_SEAT_VENT
        return self.remote_control(vin, cmd, {"position": position, "level": str(int(level))})

    def steering_heat(self, vin: str = "", on: bool = True) -> dict:
        """方向盘加热。

        ⚠️ 上游 EU 版实测(B10)用的是 **`{"level":"2"}` 开 / `{"level":"1"}` 关**,
        不是 SDK 里那个 `{"value":"on"/"off"}` —— 后者云端会受理但车不执行。
        """
        return self.remote_control(vin, CMD_STEERING_HEAT, {"level": "2" if on else "1"})

    def mirror_heat(self, vin: str = "", on: bool = True) -> dict:
        return self.remote_control(vin, CMD_MIRROR_HEAT, {"value": "2" if on else "1"})

    # ---- 哨兵 / 健康充电 ----
    def sentry(self, vin: str = "", on: bool = True) -> dict:
        """哨兵模式 —— **cmdId 400, 值用 "on"/"off"**。

        ★ 怎么找到的(别再改回 220)★
        从 CN 版 App 的 dex 里挖出点击「哨兵模式」开关的真实链路:

            // LPCarOwnerFragment 的开关回调 → Lo0000O0/OooOo;->OooO00o(Z…)
            MqttUtils.sendRemoteControl(getString2(1080), isChecked ? getString2(14399)
                                                                   : getString2(10124));
            // 1080="400", 14399="on", 10124="off"
            // sendRemoteControl(cmdId, value) → OooOOO0.OooO00o().OooO00o(400, value,
            //                                                 "normal_type") → appremotectl

        三条独立印证:
          * 该方法第一句就是 `can(400)`(`const/16 v1, 400` → 权限判断), 说明 400 是哨兵码;
          * `{"value":"off"}` / `{"value":"on"}` 与 App 的取值完全一致;
          * 车端侧: 官方 App 开哨兵后车况信号 `3636` 立刻由 0 变 1(实测稳定), 说明
            这条状态位是可信的 —— 之前用 220 时它永远不动, 是因为 220 根本不是哨兵指令
            (EU 版项目当年也只验到 "220 accepted but never actuates", 同样栽在这个码上)。

        ⚠️ **权限**: 哨兵的权限码就是 400 —— 子账号的 `rightList` 里通常没有它,
        云端会回 `code=40 无此权限`, 与报文无关。**而且零跑的主账号侧无法把哨兵
        授权给子账号**, 所以本集成(HOME ASSISTANT)里**不再暴露哨兵开关** ——
        方法保留只为把协议知识写清楚, 用主账号的脚本仍可调用。
        """
        return self.remote_control(vin, CMD_SENTRY, {"value": "on" if on else "off"})

    def healthy_charging(self, vin: str = "", on: bool = True) -> dict:
        """健康充电开关。

        ★ 实测: 应该用**专用接口**而不是 cmdId 480 ——

            POST /carownerservice/v3/api/healthyCharging/control
            表单: carvin=<VIN> & state=0|1 (& oppwd=<加密密码>)
            → {"code":0,"message":"请求成功"}         两个方向都实测通过

        cmdId 480 也"受理"(code 0)但车端可能不执行 —— 与哨兵模式同类问题。
        """
        vin = vin or self.session.car_vin
        if self.session.operate_pwd:
            v = self.verify_operate_pwd(vin)
            if isinstance(v, dict) and v.get("code") not in (0, None):
                log.warning("操作密码校验未通过: %s", str(v)[:160])
                return v
        body: dict[str, Any] = {"carvin": vin, "state": 1 if on else 0}
        if self.session.operate_pwd:
            body["oppwd"] = self._encrypted_pwd()
        return self.car_call(EP_HEALTHY_CHARGE, body, method="POST", form=True)

    # ---- 充电计划(充电上限 + 预约充电) ----
    def get_charge_plan(self, vin: str = "") -> dict:
        """读取当前充电计划 —— 直接复用 commonConfig 的 config.3 段。

        实测该段字段: {"cycles","endTime","percent","isEnable","recharge","beginTime",
        "circulation","updateTime"} —— 正好对应下发的字段(percent=充电上限)。
        """
        r = self.get_car_config(vin)
        cfg = ((r.get("data") or {}) if isinstance(r, dict) else {}).get("config") or {}
        return cfg.get("3") or {}

    def set_charge_plan(self, vin: str = "", *, enable: int | None = None,
                        soc: int | None = None, start: str | None = None,
                        end: str | None = None, cycles: str | None = None,
                        circulation: int | None = None, recharge: int | None = None) -> dict:
        """下发充电计划(cmdId 190)。只传要改的字段, 其余沿用当前计划。

        :param enable: 预约充电开关 0/1
        :param soc:    充电上限 50~100
        :param start:  开始时间 "HH:MM"
        :param end:    结束时间 "HH:MM"
        """
        cur = self.get_charge_plan(vin) or {}
        content = {
            "chargeEnable": int(cur.get("isEnable", 0) if enable is None else enable),
            "chargesoc": int(cur.get("percent", 80) if soc is None else soc),
            "circulation": int(cur.get("circulation", 0) if circulation is None else circulation),
            "cycles": str(cur.get("cycles", "1,1,1,1,1,1,1") if cycles is None else cycles),
            "endtime": str(cur.get("endTime", "08:00") if end is None else end),
            "recharge": int(cur.get("recharge", 0) if recharge is None else recharge),
            "starttime": str(cur.get("beginTime", "00:00") if start is None else start),
        }
        return self.remote_control(vin, CMD_CHARGE_PLAN, content)

    def climate_book(self, vin: str = "", controls: Any = None) -> dict:
        """空调预约(cmdId 171)。controls 结构未实测, 暂按 [] 下发。"""
        return self.remote_control(vin, CMD_CLIMATE_BOOK, {"controls": controls or []})

    # ---- 里程 / 能耗(实测可用) ----
    def get_mileage_range(self, vin: str = "", days: int = 7) -> dict:
        """近 N 天的逐日里程/能耗(绘图用)。

        实测 `GET .../mileage/energy/detail?vin=&begintime=&endtime=`(毫秒时间戳):
            {"totalAccumulatedMileage":604,   # 区间累计里程 km
             "totalEnergy":1935,              # 区间累计能耗 kWh
             "totalmileage":9598, "deliveryDays":436,
             "detail":[{"day":"2026-09-20","currentMileage":9015,
                        "accumulatedMileage":22,"accumulatedEnergyConsume":0}, …]}
        不带时间范围时只返回总里程(见 get_mileage_detail)。
        """
        vin = vin or self.session.car_vin
        end = int(time.time() * 1000)
        begin = end - int(days) * 86400 * 1000
        return self.car_call(EP_MILEAGE_DETAIL,
                             {"vin": vin, "begintime": begin, "endtime": end}, method="GET")

    def get_mileage_detail(self, vin: str = "") -> dict:
        """总里程与交付天数。

        实测 `GET v3/api/drivingrecord/mileage/energy/detail?vin=<VIN>`
        → {"totalmileage": 9598, "deliveryDays": 436}
        注意这个接口的字段名是 **vin**(不是 carvin)。
        """
        return self.car_call(EP_MILEAGE_DETAIL, {"vin": vin or self.session.car_vin})

    def get_energy_rank(self, vin: str = "") -> dict:
        """最近百公里能耗 + 排名 + 每周能耗明细。

        实测 GET v3/api/drivingrecord/getLastNweeks100kmECAndRank?carvin=<VIN>
        → {"rankResult":{"rank":"1%","hundredKmEC":21.2},
           "weeklyEC":[{"weekStart":"2026-08-10","hundredKmEC":19.8,"weekEnd":"..."},…]}
        """
        return self.car_call(EP_ENERGY_RANK, {"carvin": vin or self.session.car_vin})

    def get_plug_energy(self, vin: str = "") -> dict:
        """电耗/油耗(百公里): GET getPlugInLastNweeks100kmEC → ec100km / oc100km。"""
        return self.car_call(EP_PLUG_ENERGY, {"carvin": vin or self.session.car_vin})

    def get_lastweek_ec(self, vin: str = "", begintime: int | None = None,
                        endtime: int | None = None) -> dict:
        """上周能耗拆分: 驱动 / 空调 / 其它(单位 kWh)。

        实测(真车只读): `GET .../getLastweekEC?carvin=&begintime=&endtime=`
        传**整周窗口**(上周一 00:00:00 ~ 上周日 23:59:59, 秒)返回:
            {"driverEC": "86.9", "acEC": "8.6", "otherEC": "6.2"}
        值都是字符串(见 parse_lastweek_ec); 小窗口会回 `code=100 未找到数据!`,
        所以窗口由 `previous_week_window_seconds()` 统一算, 不要传任意区间。
        """
        vin = vin or self.session.car_vin
        if begintime is None or endtime is None:
            begintime, endtime = previous_week_window_seconds()
        return self.car_call(EP_LASTWEEK_EC,
                             {"carvin": vin, "begintime": int(begintime),
                              "endtime": int(endtime)}, method="GET")

    # ---- 车辆图片 ----
    def get_car_picture(self, vin: str = "") -> dict:
        """车辆外观图(GET /v3/api/carpicture/key)。返回整图/分部件图的 OSS 地址与 key。"""
        return self.car_call(EP_CAR_PICTURE, {"vin": vin or self.session.car_vin})

    def get_chassis_picture(self, vin: str = "") -> dict:
        """底盘/驻车照片(GET /v3/api/chassis/query)。

        实测返回 data.fileUrl —— OSS 上的 ChassisPicture 图片地址(带签名, 可直接 GET)。
        """
        return self.car_call(EP_CHASSIS_QUERY, {"vin": vin or self.session.car_vin})

    def chassis_info(self, vin: str = "") -> dict:
        """驻车照片的**地址与上传时间**(给"照片更新了没有"用)。

        实测:
            {"data": {"fileUrl": "http://lp-carnet.oss-.../ChassisPicture/prod/<VIN>?Expires=…",
                      "uploadTime": 1790590434026}}

        ★ 为什么需要它 ★
        驻车照片只在**泊车那一刻**拍一次, 之后异步上传到 OSS; 请求同一个接口只会拿回同一张。
        图片 URL 里的签名是固定的、对图片发 HEAD 会 403(取不到 ETag / Last-Modified),
        所以**唯一可用于判断"有新照片"的字段是 `uploadTime`**(车端上传时刻, 毫秒)。
        调用方应: 记住上次 uploadTime, 只有它变大时才认为照片更新了。
        """
        r = self.car_call(EP_CHASSIS_QUERY, {"vin": vin or self.session.car_vin})
        data = (r.get("data") or {}) if isinstance(r, dict) else {}
        if not isinstance(data, dict):
            data = {}
        try:
            upload = int(data.get("uploadTime") or 0)
        except (TypeError, ValueError):
            upload = 0
        return {"url": str(data.get("fileUrl") or ""), "upload_time_ms": upload, "raw": r}

    # ---- 车况(全量信号) ----
    def get_car_state(self, vin: str = "") -> CarState:
        """拉一帧完整车况(GPS / 电量 / 续航 / 四轮胎压 / 门窗 / 充电 / 空调...)。

        这是国内 App 车况页的唯一来源。踩过的坑, 换实现时别再犯:

          * 路径 **不在** `/carownerservice` 下 —— 它挂在网关的另一条路由上:
                POST https://appgateway.leapmotor.com/app/app-signal-service/signal/info/query
            用 `/carownerservice/...` 或 global 网关都会 404。
          * 方法必须是 **POST**; 表单字段 `vin=<VIN>`, 参数照样参与签名。
          * 返回 `data.signalMap` 是 {信号号: 值} 的裸表, 需要 SIGNAL_IDS 翻译;
            `data.collectTime` 即"状态更新时间"。

        路径见 docs/PROTOCOL.md: 从解密字符串里拿到
        `/app/app-signal-service` + `/signal/info/query` 两条常量, 再用
        `/app/app-control-service`(车控同族路由)在 appgateway 上探到同一网关,
        最终确认路由存在(此前返回 302002004 TOKEN已过期 而不是 404)。
        """
        vin = vin or self.session.car_vin
        self._require_session()
        body: dict[str, Any] = {"vin": vin}
        url = f"{BASE_URL}{EP_SIGNAL_QUERY}"
        resp = self._http("POST", url, self.build_headers(body), body, form=True)
        return parse_car_state(resp)


# ── 指令码(cmdId) ───────────────────────────────────────────────────
# 权威来源:App 资源 `assets/allcarper.json` 的权限码表(peimissCode → 名称)。
# 车辆列表里的 rightList 就是这些码的授权子集;车辆列表的 abilities 是能力位。
CMD_POWER = 100        # 点熄火
CMD_DOOR = 110         # 车门(state: 1=锁, 2=解锁; 以上车实测为准)
CMD_FIND = 120         # 寻车鸣笛
CMD_TRUNK = 130        # 后备箱
CMD_AUTO_PARK = 150    # 自动泊车
CMD_PREHEAT = 160      # PTC 预热
CMD_PREHEAT_BOOK = 161  # PTC 预热预约
CMD_AC = 170           # 空调控制
CMD_AC_BOOK = 171      # 空调预约
CMD_ROUTE_SYNC = 180   # 路径同步
CMD_CHARGE_BOOK = 190  # 预约充电
CMD_TRIP_LOG = 200     # 途记
CMD_DVR = 210          # 行车录像
CMD_TRIP = 220         # 行程
CMD_WINDOW = 230       # 车窗控制
CMD_SUNSHADE = 240     # 遮阳帘控制
CMD_SENTRY = 400              # 哨兵模式({"value":"on"/"off"}; 见 sentry() 的取证)
CMD_SEAT_HEAT = 301           # 座椅加热(position + level 0~3)
CMD_STEERING_HEAT = 320       # 方向盘加热(on/off)
CMD_SEAT_VENT = 370           # 座椅通风(position + level 0~3)
CMD_MIRROR_HEAT = 440         # 后视镜加热(2=开, 1=关)
CMD_HEALTHY_CHARGE = 480      # 健康充电(1=开, 0=关)
CMD_CHARGE_PLAN = 190         # 充电计划(充电上限 + 预约充电)
CMD_CLIMATE_BOOK = 171        # 空调预约
CMD_PREHEAT_BOOK = 161        # 电池预热预约


# ── 会话失效的判定 ──────────────────────────────────────────────────
# 这些是服务端"你的登录/token 不认了"的错误码 —— 与签名错(302002002)、
# 参数错(1)、业务错(其它)区分开, 因为只有它们需要用户重新登录。
AUTH_ERROR_CODES = {
    302002004,    # TOKEN已过期
    302010202,    # 第三方TOKEN失效
    302010219,    # 令牌刷新异常 / 登陆过期(实测于 token/v1/refresh)
    401,
}
# 注意: 302010205(签名信息校验失败) **不算**会话失效 —— 实测它也会在
# "HA 重启窗口内下发指令"时偶发(命令发出去了、服务端拒签), 误判会导致弹
# 无意义的"重新认证"。它属于可重试的临时错误, 交给用户重按或下轮轮询即可。
AUTH_ERROR_HINTS = ("TOKEN已过期", "TOKEN失效", "登陆过期", "登录已过期", "未登录",
                    "token已过期", "token 已过期", "not login")

# 账号会话最长可用时间(小时)。服务端对此的答复是 tokenExpireTime,
# 实测约 6 小时; 到期后必须重新收短信登录(除非刷新接口可用, 见 docs/PROTOCOL.md §3)。
ACCOUNT_SESSION_HOURS = 6


# 签名类错误: 请求**没被受理**, 与"会话失效"是两回事。
# 最常见的成因是车端 JWT 刚被轮换, 本地还在用换下来的旧密钥签名 —— 重新交换一次即可。
SIGNATURE_ERROR_CODES = {302002002, 302010205, 39}


# 指令"受理成功"的错误码: 车控/全局服务成功时给 0, 少数接口给 200, 不带 code 也当成功。
OK_CODES = (0, 200, None)


def command_failed(resp: Any) -> str | None:
    """指令是否**没被受理**: 失败时返回原因文本, 受理成功时返回 None。

    注意 `code=0` 只代表"请求合法", **不代表车执行了**(见 docs/PROTOCOL.md §6.2),
    所以这里只判"云端是否受理", 不代表车端动作已经发生。

    ★ 为什么需要它 ★ 之前实体在 `async_call` 之后**无条件**记下乐观状态,
    于是像 `code=40 无此权限`(实测: 子账号调空调快捷模式)这种被拒的指令,
    HA 界面也会显示"已开启" —— 对用户是撒谎。现在失败会抛给 HA 弹提示。
    """
    if not isinstance(resp, dict):
        return None
    code = resp.get("code")
    if code in OK_CODES:
        return None
    msg = resp.get("message") or resp.get("result") or ""
    return f"code={code} {msg}".strip()


# 限流/风控类错误: 官方提示语是 "环境被风控(1023)"。收到这类错误要**退避**,
# 不能继续按 6 秒的行程采样节奏硬冲 —— 否则会把冷却时间拖长。
RATE_LIMIT_CODES = {1023}


def is_rate_limited(resp: Any) -> bool:
    """服务端是否以"限流/风控"为由拒绝(调用方应拉长轮询间隔并冷却一段时间)。"""
    if not isinstance(resp, dict):
        return False
    try:
        if int(resp.get("code")) in RATE_LIMIT_CODES:
            return True
    except (TypeError, ValueError):
        pass
    text = str(resp.get("message") or "")
    return "风控" in text or "频繁" in text


def is_signature_error(resp: Any) -> bool:
    """服务端是否以"签名/密钥不对"为由拒收(可用于刷新车端 token 后原样重发)。"""
    if not isinstance(resp, dict):
        return False
    try:
        return int(resp.get("code")) in SIGNATURE_ERROR_CODES
    except (TypeError, ValueError):
        return False


def is_auth_error(resp: Any) -> bool:
    """响应是否表示"需要重新登录"。"""
    if not isinstance(resp, dict):
        return False
    code = resp.get("code")
    if isinstance(code, int) and code in AUTH_ERROR_CODES:
        return True
    text = f"{resp.get('message') or ''}{resp.get('description') or ''}{resp.get('data') or ''}"
    return any(h in text for h in AUTH_ERROR_HINTS)


def _extract_vehicles(resp: dict) -> list[Vehicle]:
    """从响应里抽出车辆条目(App 的响应形状多样, 这里做宽容解析)。"""
    out: list[Vehicle] = []
    if not isinstance(resp, dict):
        return out
    data = resp.get("data")
    if not isinstance(data, dict):
        return out
    items: list[dict] = []
    for key in ("sharedcars", "bindcars", "cars", "list", "vehicleList"):
        v = data.get(key)
        if isinstance(v, list):
            items.extend(x for x in v if isinstance(x, dict))
    if not items and isinstance(data.get("vin"), str):
        items.append(data)
    for item in items:
        out.append(Vehicle(
            vin=item.get("vin") or item.get("carVin") or item.get("carvin") or "",
            car_id=str(item.get("carId") or item.get("id") or ""),
            car_type=item.get("carType") or item.get("carTypeCode") or item.get("series") or "",
            nick_name=item.get("nickName") or item.get("vinNickname") or item.get("name") or "",
            plate_number=item.get("plateNumber") or item.get("plateNo") or "",
            series_name=item.get("seriesName") or "",
            abilities=list(item.get("abilities") or item.get("ability") or []),
            raw=item,
        ))
    return out
