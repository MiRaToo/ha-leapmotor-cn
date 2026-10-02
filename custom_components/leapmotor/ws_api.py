"""给前端卡片用的 WebSocket 命令: 行程列表 / 轨迹 / 删除。

**为什么走 WebSocket 而不是实体属性**: 轨迹点数组很大, 塞进实体属性会跟着状态一起写进
HA 的 recorder 数据库(每次变化存一份), 得不偿失。所以:
  * 实体上只放"最近一段、抽稀到 ≤100 点"的轨迹(给自带地图卡与自动化用);
  * 完整的行程历史与任意一段的完整轨迹走这里的命令按需取 —— 我们的卡片本来就在用
    `hass.callWS`(例如 `zone/list`), 这条路已经验证可行。

命令:
  * `leapmotor/trips/list`   → {trips: [摘要…], stats: {...}, active: 摘要|null, vin}
  * `leapmotor/trips/track`  → {trip: 摘要, points: [[lat, lon], …]}(WGS-84)
  * `leapmotor/trips/delete` → {deleted: bool}(需要管理员)
"""

from __future__ import annotations

import logging

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
