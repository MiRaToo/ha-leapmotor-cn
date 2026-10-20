"""HA 标准诊断导出("设置 → 设备与服务 → 零跑 → ⋮ → 下载诊断")。

用途:① 排查用户问题;② **多车型对比** —— 不同车型上报的信号键/实体差异, 是这个
项目最难靠自测覆盖的部分, 由车主各自导出即可汇聚。

⚠️ 安全:导出物是**要发给别人**的, 集成条目里存着操作密码与 token、原始信号里有
经纬度。所有脱敏集中在 `diag_redact.py`(纯函数 + 单测钉死), 这里只负责取材。
"""
from __future__ import annotations

from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant

from . import _CARDS, CARD_VERSION, CONTROL_CARD_VERSION, ENERGY_CARD_VERSION, \
    LASTWEEK_CARD_VERSION, TRIPS_CARD_VERSION, car3d
from .api import is_reev
from .const import DOMAIN
from .diag_redact import redact_entry_data, redact_signals, vin_fingerprint

# 诊断里额外点名关心的"翻译后字段"(这些是多车型差异的高发区)
INTERESTING_FIELDS = (
    # 燃油 / 续航
    "fuel_level", "fuel_ml", "range_fuel_wltc", "range_fuel_cltc",
    "range_total_wltc", "range_total_cltc", "range_ev_wltc", "range_ev_cltc",
    "range_live", "range_cltc", "range_mode_code",
    # 电池 / 充电
    "soc", "soc_precise", "charging_state", "charge_plugged", "charge_limit",
    # 座椅 / 车窗(车型差异大)
    "seat_heat_driver", "seat_heat_copilot", "seat_heat_rear_left",
    "seat_heat_rear_right", "seat_heat_third_left", "seat_heat_third_right",
    "seat_vent_driver", "seat_vent_copilot", "window_state_1", "window_state_2",
    "window_state_3", "window_state_4", "sunshade", "trunk_open",
    # 空调
    "climate_on", "climate_mode", "windshield_defrost", "fast_cooling", "fast_heating",
)


def _coordinator(hass: HomeAssistant, entry: ConfigEntry) -> Any:
    return (hass.data.get(DOMAIN) or {}).get(entry.entry_id)


async def async_get_config_entry_diagnostics(
    hass: HomeAssistant, entry: ConfigEntry
) -> dict[str, Any]:
    """返回该条目的诊断数据(已脱敏)。"""
    coord = _coordinator(hass, entry)
    state = getattr(coord, "state", None)
    raw = dict(getattr(state, "raw", None) or {})
    signals = dict(getattr(state, "signals", None) or {})

    # 点名关心的字段:只导出**确实存在**的(键的存在性本身就是信息)
    interesting = {k: signals.get(k) for k in INTERESTING_FIELDS if k in signals}

    # 3D 车模素材:装配现状 + 最近一次失败的可定位细节(车主反馈"下载失败"时全靠这一块;
    # "3dkey 响应异常"/"不是 zip"这两类都是云端响应形状问题, 本地无法复现)。
    car3d_info: dict[str, Any] = {}
    try:
        base = car3d.root(hass)
        car3d_info = await hass.async_add_executor_job(car3d.status, base)
        car3d_info.pop("dir", None)                    # 本机路径对排查没用
        car3d_info.pop("colors", None)                 # 色表很长, 与故障无关
        st = (hass.data.get(DOMAIN) or {}).get(car3d.STATE_KEY) or {}
        car3d_info["state"] = st.get("state")
        car3d_info["last_error"] = st.get("error") or ""
        car3d_info["last_error_detail"] = st.get("detail") or ""
    except Exception as err:  # noqa: BLE001  诊断本身绝不能因为子系统异常而失败
        car3d_info = {"status_error": str(err)[:120]}

    diag: dict[str, Any] = {
        "integration": {
            "version": _manifest_version(),
            "entry_version": getattr(entry, "version", None),
            "entry_data": redact_entry_data(dict(entry.data or {})),
            "vin_fingerprint": vin_fingerprint(
                (entry.data or {}).get("vin") or (entry.data or {}).get("car_vin")),
            "card_versions": {
                "map": CARD_VERSION,
                "trips": TRIPS_CARD_VERSION,
                "control": CONTROL_CARD_VERSION,
                "energy": ENERGY_CARD_VERSION,
                "lastweek": LASTWEEK_CARD_VERSION,
            },
            "frontend_files": [name for name, _v in _CARDS],
        },
        "vehicle_state": {
            # 增程判定:结果 + 输入(用于复盘"这辆车为什么被判成/没被判成增程")
            "reev_latched": bool(getattr(coord, "reev", False)) if coord else None,
            "reev_pref": getattr(coord, "energy_pref", lambda: None)() if coord else None,
            "reev_now": is_reev(signals),
            "has_signals": bool(signals),
            "signal_key_count": len(raw),
            # 键清单:某车型上报哪些信号 —— 多车型对比最有用的一项
            "raw_signal_keys": sorted(raw.keys(), key=lambda x: (len(str(x)), str(x))),
            # 原始帧(键原样, 位置类掩码)
            "raw_signals": redact_signals(raw),
            "interesting_fields": interesting,
        },
        "car3d": car3d_info,
        "diagnostics": {
            "car_state_problem": getattr(coord, "car_state_problem", "") if coord else "",
            "car_state_request": getattr(getattr(coord, "client", None), "last_state_meta", {}),
            "entities": _entity_ids(hass, entry),
            "entity_count": len(_entity_ids(hass, entry)),
            "poll_interval_s": (
                int(coord.update_interval.total_seconds())
                if coord is not None and getattr(coord, "update_interval", None)
                else None
            ),
        },
    }
    return diag


def _entity_ids(hass: HomeAssistant, entry: ConfigEntry) -> list[str]:
    """本条目创建了哪些实体(排序后)。车型差异(缺哪些实体)一看便知。"""
    try:
        from homeassistant.helpers import entity_registry as er

        reg = er.async_get(hass)
        return sorted(
            e.entity_id
            for e in reg.entities.values()
            if e.platform == DOMAIN and e.config_entry_id == entry.entry_id
        )
    except Exception:  # noqa: BLE001
        return []


def _manifest_version() -> str:
    """读本集成的 manifest 版本(诊断里要能看出"车主跑的是哪个构建")。"""
    try:
        import json
        from pathlib import Path
        p = Path(__file__).with_name("manifest.json")
        return str(json.loads(p.read_text(encoding="utf-8")).get("version") or "")
    except Exception:  # noqa: BLE001
        return ""
