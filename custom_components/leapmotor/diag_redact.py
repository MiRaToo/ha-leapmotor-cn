"""诊断导出的**脱敏**逻辑 —— 纯函数, 不 import HA(便于离线单测)。

为什么单独一个模块: 诊断文件是**要发给别人**的东西(排查 / 多车型对比),
而集成条目里存着操作密码与一堆 token, 原始信号帧里还有车辆经纬度。
脱敏一旦漏掉就是"用户点一下就把车控密码和住址发出去" —— 所以:
  * 逻辑做成纯函数, 用测试把"密码/token 不出现、坐标被掩码"钉死;
  * 采用**白名单**而不是黑名单: 只放行明确安全的键, 其余一律丢弃 ——
    将来新增敏感字段时, 默认行为是"不导出"而不是"泄露"。
"""
from __future__ import annotations

import hashlib

# 车辆位置相关信号(原始帧里的键): 2=经度 3=纬度; 3724/3725=另一组(高度/备用坐标)。
# 这些是**住址级**信息, 导出时一律掩码。
LOCATION_SIGNAL_IDS = ("2", "3", "3724", "3725")
LOCATION_FIELD_NAMES = ("latitude", "longitude", "latitudeSigned", "longitudeSigned",
                        "lat", "lon", "lng", "2190", "2191")

# 条目里允许导出的键(白名单)。其余(尤其是 token/密钥/操作密码)一律不导出。
# ⚠️ 连 `operate_pwd_mode` 都不放行: 它与操作密码同属凭据配置, 诊断用不到。
ENTRY_DATA_ALLOWLIST = (
    "car_type",       # 车型(诊断的核心信息之一)
    "car_nickname",   # 车主自定义的车名(排查需要)
    "sub_version",    # 车机版本
    "version",        # 会话结构版本
    "reev",           # 增程判定记忆(只读布尔)
)


def mask_value(value: object) -> str:
    """把一个值替换成**类型 + 长度**的指纹(保留"有没有值/多长", 不保留内容)。"""
    if value is None or value == "":
        return ""
    s = str(value)
    return f"<{type(value).__name__}:len{len(s)}>"


def vin_fingerprint(vin: object) -> str:
    """VIN 只留**稳定指纹**(用于把多份诊断归类到同一辆车), 不留可还原的信息。

    为什么用哈希而不是"留后 6 位": 后 6 位足以在公开场合定位到具体车辆(且常被
    用作车友间的标识)。指纹只需要"同一辆车得到同一个值"。
    """
    s = str(vin or "")
    if not s:
        return ""
    return "vin-" + hashlib.sha256(s.encode("utf-8")).hexdigest()[:12]


def redact_entry_data(data: dict | None) -> dict:
    """条目数据 → 只保留白名单键(其余丢弃, 不保留键名以免泄露字段存在性)。"""
    out: dict = {}
    for k in ENTRY_DATA_ALLOWLIST:
        if k in (data or {}):
            out[k] = (data or {})[k]
    return out


def redact_signals(raw: dict | None) -> dict:
    """原始信号帧 → 键原样保留(键清单本身就是最有价值的诊断信息), 位置类**掩码**。

    ⚠️ 这里刻意**不**脱敏其它信号值: 信号号/值是协议层的公共信息, 是"某车型上报
    哪些信号"的唯一证据; 真正需要保护的是位置与账号凭据。
    """
    out: dict = {}
    for k, v in (raw or {}).items():
        if str(k) in LOCATION_SIGNAL_IDS or str(k) in LOCATION_FIELD_NAMES:
            out[str(k)] = "<masked-location>"
        else:
            out[str(k)] = v
    return out
