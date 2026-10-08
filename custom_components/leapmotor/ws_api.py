"""给前端卡片用的 WebSocket 命令: 行程列表 / 轨迹 / 删除 / 逐日里程能耗。

**为什么走 WebSocket 而不是实体属性**: 轨迹点数组很大, 塞进实体属性会跟着状态一起写进
HA 的 recorder 数据库(每次变化存一份), 得不偿失。所以:
  * 实体上只放"最近一段、抽稀到 ≤100 点"的轨迹(给自带地图卡与自动化用);
  * 完整的行程历史与任意一段的完整轨迹走这里的命令按需取 —— 我们的卡片本来就在用
    `hass.callWS`(例如 `zone/list`), 这条路已经验证可行。

命令:
  * `leapmotor/trips/list`   → {trips: [摘要…], stats: {...}, active: 摘要|null, vin}
  * `leapmotor/trips/track`  → {trip: 摘要, points: [[lat, lon], …]}(WGS-84)
  * `leapmotor/trips/delete` → {deleted: bool}(需要管理员)
  * `leapmotor/energy/daily` → {source, days: [{day, km, kwh, eff, kwh_src, drv, ac, oth}],
                                summary, pending, vin}
    耗电取**官方 getEC 逐日拆分**(任意窗口, 见 energy_daily.py; 不含驻停/待机),
    官方缺的日子用本机自记兜底(标 kwh_src:"trip"); 里程优先自记、缺了用云端逐日。
    pending = 还差几天官方数据(卡片会稍后自动续拉)。
  * `leapmotor/energy/lastweek` → {week, breakdown: {driver, ac, other, total}, vin}
    (上周能耗拆分; 按需取(缓存 1 小时), refresh=true 强制重取)
"""

from __future__ import annotations

import logging
import time
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback

from .const import DOMAIN

log = logging.getLogger(__name__)

_registered = False


@callback
def async_register(hass: HomeAssistant) -> None:
    """注册命令(重复调用无副作用)。"""
    global _registered
    if _registered:
        return
    _registered = True
    websocket_api.async_register_command(hass, ws_list)
    websocket_api.async_register_command(hass, ws_track)
    websocket_api.async_register_command(hass, ws_delete)
    websocket_api.async_register_command(hass, ws_energy_daily)
    websocket_api.async_register_command(hass, ws_energy_lastweek)
    log.debug("行程 WebSocket 命令已注册")


def _recorder(hass: HomeAssistant, msg: dict):
    """找到行程记录器(单车的集成, 直接取; 多车按 vin 选)。"""
    for coord in (hass.data.get(DOMAIN) or {}).values():
        rec = getattr(coord, "trips", None)
        if rec is None:
            continue
        if msg.get("vin") and getattr(coord, "vin", None) != msg["vin"]:
            continue
        return rec
    return None


def _coordinator(hass: HomeAssistant, msg: dict):
    """找到协调器(云端数据在里面; 多车按 vin 选)。"""
    for coord in (hass.data.get(DOMAIN) or {}).values():
        if getattr(coord, "trips", None) is None:
            continue
        if msg.get("vin") and getattr(coord, "vin", None) != msg["vin"]:
            continue
        return coord
    return None


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/trips/list",
    vol.Optional("vin"): str,
    vol.Optional("limit", default=200): vol.All(int, vol.Range(min=1, max=2000)),
})
@websocket_api.async_response
async def ws_list(hass: HomeAssistant, connection, msg: dict) -> None:
    rec = _recorder(hass, msg)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    connection.send_result(msg["id"], {
        "vin": rec.vin,
        "trips": rec.list_trips(int(msg["limit"])),
        "stats": rec.stats(),
        "active": rec.active.summary() if rec.active is not None else None,
        "gaps": list(rec.gaps[-20:]),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/trips/track",
    vol.Required("trip_id"): str,
    vol.Optional("vin"): str,
    vol.Optional("max_points", default=0): vol.All(int, vol.Range(min=0, max=20000)),
})
@websocket_api.async_response
async def ws_track(hass: HomeAssistant, connection, msg: dict) -> None:
    rec = _recorder(hass, msg)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    trip = rec.get(msg["trip_id"])
    if trip is None:
        connection.send_error(msg["id"], "not_found", "没有这段行程")
        return
    connection.send_result(msg["id"], {
        "trip": trip.summary(),
        "points": rec.track(msg["trip_id"], int(msg["max_points"])),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/trips/delete",
    vol.Required("trip_id"): str,
    vol.Optional("vin"): str,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_delete(hass: HomeAssistant, connection, msg: dict) -> None:
    rec = _recorder(hass, msg)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    connection.send_result(msg["id"], {"deleted": rec.delete(msg["trip_id"])})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/energy/lastweek",
    vol.Optional("vin"): str,
    vol.Optional("refresh", default=False): bool,
})
@websocket_api.async_response
async def ws_energy_lastweek(hass: HomeAssistant, connection, msg: dict) -> None:
    """上周能耗拆分(驱动/空调/其它)。

    按需取: 协调器里有 1 小时缓存, 窗口翻篇(周一)自动失效; `refresh=true` 强制重取
    (卡片右上角刷新按钮)。拿不到时 `breakdown` 为 None —— 卡片显示"稍后重试"。
    """
    coord = _coordinator(hass, msg)
    if coord is None or getattr(coord, "trips", None) is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    cache = await coord.ensure_lastweek_ec(force=bool(msg.get("refresh")))
    out: dict[str, Any] = {"vin": getattr(coord, "vin", "") or ""}
    if cache:
        vals = [cache.get("driver"), cache.get("ac"), cache.get("other")]
        total = sum(v for v in vals if v is not None)
        out.update({
            "week": {"begin": cache.get("begin"), "end": cache.get("end")},
            "breakdown": {"driver": cache.get("driver"), "ac": cache.get("ac"),
                          "other": cache.get("other"), "total": round(total, 1)},
            "fetched_at": cache.get("fetched_at"),
        })
    else:
        out["breakdown"] = None
    connection.send_result(msg["id"], out)


# 逐日里程/能耗: 取数全部在协调器(官方 getEC 缓存 + 自记兜底 + 补拉), 这里只做薄壳。
@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/energy/daily",
    vol.Optional("vin"): str,
    vol.Optional("days", default=7): vol.All(int, vol.Range(min=1, max=31)),
})
@websocket_api.async_response
async def ws_energy_daily(hass: HomeAssistant, connection, msg: dict) -> None:
    """逐日里程/能耗(绘图用)。

    数据源: 官方 getEC 逐日拆分(驱动/空调/其它, **不含驻停**; 见 energy_daily.py 的说明)
    为主; 官方缺的日子用本机自记行程兜底(标 kwh_src:"trip")。里程优先自记行程、缺了
    退回云端逐日里程。`pending` 是还差几天官方数据 —— 卡片会稍后自动续拉(分批取数)。
    """
    coord = _coordinator(hass, msg)
    if coord is None or getattr(coord, "trips", None) is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    days = int(msg["days"])
    body = await coord.ensure_energy_days(days)
    km = [d["km"] for d in body["days"] if d.get("km") is not None]
    kwh = [d["kwh"] for d in body["days"] if d.get("kwh") is not None]
    connection.send_result(msg["id"], {
        "vin": getattr(coord, "vin", "") or "",
        "days": days,
        **body,
        "summary": {"km": round(sum(km), 1), "kwh": round(sum(kwh), 2)},
        "generated_at": time.time(),
    })
