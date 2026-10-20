"""诊断导出的**脱敏**闸门。

为什么要单独的测试:诊断文件是用户"点一下、发给别人"的东西 —— 里面一旦漏出
操作密码(集成的 `operate_pwd`)、token 或车辆经纬度, 就是一次真实的凭据泄露。
这里把"不许出现什么"钉死, 并做静态守卫防止将来有人绕过脱敏模块。

`diag_redact.py` 不 import HA, 所以可以像 `cardfiles.py` 那样按**顶层模块**直接
导入(不触发 `custom_components/leapmotor/__init__.py`)。
"""
from __future__ import annotations

import ast
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
PKG = ROOT / "custom_components" / "leapmotor"
sys.path.insert(0, str(PKG))

from diag_redact import (ENTRY_DATA_ALLOWLIST, LOCATION_SIGNAL_IDS,  # noqa: E402
                         mask_value, redact_entry_data, redact_signals,
                         vin_fingerprint)

# 这些键**绝不允许**出现在导出里(集成的 entry.data 里真实存在的敏感字段)
FORBIDDEN_KEYS = (
    "operate_pwd", "operate_pwd_mode", "token", "refresh_token",
    "account_token_expires_at", "car_token", "car_refresh_token",
    "hkdf_key_hex", "sign_param", "encrypt_param", "device_id",
    "user_id", "phone", "vin", "car_vin",
)


def test_entry_data_drops_every_secret():
    """真实形态的 entry.data → 导出里不能有任何敏感键或它们的值。"""
    real = {
        "vin": "LFVXXXXXXXX123456",
        "car_vin": "LFVXXXXXXXX123456",
        "car_type": "C10",
        "sub_version": "1.2.3",
        "phone": "13800000000",
        "operate_pwd": "s3cret-pwd",
        "operate_pwd_mode": "plain",
        "token": "eyJhbGciOi...",
        "refresh_token": "refresh-abc",
        "car_token": "car-tok",
        "hkdf_key_hex": "deadbeef",
        "sign_param": "sp",
        "encrypt_param": "ep",
        "device_id": "dev-1",
        "user_id": "u-1",
        "account_token_expires_at": 1799999999,
        "version": 1,
    }
    out = redact_entry_data(real)
    # 键层面: 白名单之外的键一个都不留
    assert set(out) <= set(ENTRY_DATA_ALLOWLIST)
    for k in FORBIDDEN_KEYS:
        assert k not in out, f"敏感键 {k} 泄漏到诊断里"
    # 值层面: 敏感值不能以任何形式出现(防止换了个键名又把值带出来)
    dumped = repr(out)
    for secret in ("s3cret-pwd", "eyJhbGciOi", "refresh-abc", "deadbeef",
                   "LFVXXXXXXXX123456", "13800000000", "dev-1", "u-1"):
        assert secret not in dumped, f"敏感值 {secret!r} 泄漏到诊断里"
    # 该留的还在(否则诊断就没用了)
    assert out["car_type"] == "C10"
    assert out["sub_version"] == "1.2.3"


def test_entry_data_handles_empty_and_none():
    assert redact_entry_data(None) == {}
    assert redact_entry_data({}) == {}
    # 只带车型也应正常
    assert redact_entry_data({"car_type": "C16"}) == {"car_type": "C16"}


def test_vin_fingerprint_is_stable_but_not_reversible():
    vin = "LFVXXXXXXXX123456"
    a = vin_fingerprint(vin)
    b = vin_fingerprint(vin)
    assert a == b, "同一辆车的指纹必须稳定(否则多份诊断没法归类)"
    assert vin not in a and "123456" not in a, "指纹里不能留可还原的信息"
    assert vin_fingerprint("LFVYYYYYYYY654321") != a, "不同车应有不同指纹"
    assert vin_fingerprint(None) == "" and vin_fingerprint("") == ""


def test_location_signals_are_masked_but_others_survive():
    """位置类信号必须掩码; 其余信号(诊断价值所在)必须原样保留。"""
    raw = {"2": 120.1234, "3": 30.5678, "3724": 12.5, "3725": 12.6,
           "100003": 62, "3235": 55.5, "3261": 480, "1693": 2, "1318": 0}
    out = redact_signals(raw)
    for k in LOCATION_SIGNAL_IDS:
        assert out[k] == "<masked-location>", f"位置信号 {k} 没被掩码"
    # 非位置信号: 值与键都要在(不然"某车型上报什么"就无从对比)
    assert out["3235"] == 55.5 and out["3261"] == 480 and out["100003"] == 62
    assert set(out) == set(raw), "键清单必须完整保留"


def test_signals_empty():
    assert redact_signals(None) == {}
    assert redact_signals({}) == {}


def test_named_t03_coordinates_and_legacy_coordinates_are_masked():
    raw = {"latitude": 31.123456, "longitude": 121.987654, "2190": 31.123456,
           "2191": 121.987654, "soc": 56, "totalMileage": 73489}
    result = redact_signals(raw)
    for key in ("latitude", "longitude", "2190", "2191"):
        assert result[key] == "<masked-location>"
    assert result["soc"] == 56 and result["totalMileage"] == 73489
    assert "31.123456" not in repr(result) and "121.987654" not in repr(result)


def test_mask_value_keeps_only_shape():
    assert mask_value("s3cret") == "<str:len6>"
    assert mask_value(12345) == "<int:len5>"
    assert mask_value(None) == "" and mask_value("") == ""
    assert "s3cret" not in mask_value("s3cret")


def test_diagnostics_module_delegates_redaction():
    """静态守卫: diagnostics.py 必须走 diag_redact, 不许自己拼原始数据。

    防的是"以后有人图快, 在 diagnostics 里直接 return entry.data" —— 那会一次性
    把操作密码与 token 全导出去。
    """
    src = (PKG / "diagnostics.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    imported = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.ImportFrom) and (node.module or "").endswith("diag_redact"):
            imported |= {a.name for a in node.names}
    assert {"redact_entry_data", "redact_signals"} <= imported, (
        "diagnostics.py 没有使用脱敏函数(redact_entry_data / redact_signals)"
    )
    # 绝不允许把整份 entry.data 或原始 signals 直接塞进返回值
    assert "dict(entry.data or {})" in src, "entry.data 应只在传给脱敏函数时出现"
    for bad in ('"entry_data": dict(entry.data', '"raw_signals": raw'):
        assert bad not in src, f"发现未脱敏的直出写法: {bad}"
