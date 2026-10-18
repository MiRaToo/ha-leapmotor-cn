"""给前端卡片用的 WebSocket 命令: 行程列表 / 轨迹 / 删除 / 逐日里程能耗。

**为什么走 WebSocket 而不是实体属性**: 轨迹点数组很大, 塞进实体属性会跟着状态一起写进
HA 的 recorder 数据库(每次变化存一份), 得不偿失。所以:
  * 实体上只放"最近一段、抽稀到 ≤100 点"的轨迹(给自带地图卡与自动化用);
  * 完整的行程历史与任意一段的完整轨迹走这里的命令按需取 —— 我们的卡片本来就在用
    `hass.callWS`(例如 `zone/list`), 这条路已经验证可行。

命令:
  * `leapmotor/trips/list`   → {trips: [摘要…], months: [{month, count, km}…],
                                store: {tracks_mb, index_mb, limit_mb, months},
                                stats: {...}, active: 摘要|null, vin}
    可选窗口: `month="YYYY-MM"`(整月)或 `days=N` + `end`(滚动窗口, 默认锚在现在);
    都不给 = 全部(兼容旧卡片)。`months` 供卡片的"时间范围 / 月份跳转"控件。
  * `leapmotor/trips/track`  → {trip: 摘要, points: [[lat, lon, speed, ts], …]}(WGS-84)
  * `leapmotor/trips/tracks` → {tracks: [{trip: 摘要, points: […]}, …]}(批量, 卡片"叠加"用;
    `before` 锚点默认现在, 取截至该时刻最近 `limit`(≤50) 段有轨迹的行程, 点在服务端抽稀)
  * `leapmotor/trips/delete` → {deleted: bool}(需要管理员; 摘要与它的轨迹一起删)
  * `leapmotor/energy/daily` → {source, days: [{day, km, kwh, eff, kwh_src, drv, ac, oth}],
                                summary, pending, vin}
    耗电取**官方 getEC 逐日拆分**(任意窗口, 见 energy_daily.py; 不含驻停/待机),
    官方缺的日子用本机自记兜底(标 kwh_src:"trip"); 里程优先自记、缺了用云端逐日。
    pending = 还差几天官方数据(卡片会稍后自动续拉)。
  * `leapmotor/energy/lastweek` → {week, breakdown: {driver, ac, other, total}, vin}
    (上周能耗拆分; 按需取(缓存 1 小时), refresh=true 强制重取)
  * `leapmotor/car3d/info`   → {ready, viewer, model, base_url, model_param, colors, options…}
    3D 车模的现状(读磁盘, 不联网): 素材是否已装配、车型参数、该车型的车漆色表、
    以及集成选项里的颜色/背景/自定义外观图。卡片进卡片时先问这个。
  * `leapmotor/car3d/market-pictures` → {pictures: [{color, url}], actual_color, year, edition}
    用户切换到 2D 时按指定商城车型配置读取颜色渲染图; 未指定时尝试本车配置。
  * `leapmotor/car3d/market-catalog` / `market-variants`
    按需读取商城车型目录及所选车型的年款、能源类型和版本。
  * `leapmotor/car3d/ensure` → {state, started, info}
    确保 3D 素材就绪: 没装过就起后台装配任务(最多 3 个只读 GET, 每个 VIN 一次),
    立即返回; 卡片随后轮询 info 直到 state 变成 ready/error。
"""

from __future__ import annotations

import logging
import time
import functools
from typing import Any

import voluptuous as vol

from homeassistant.components import websocket_api
from homeassistant.core import HomeAssistant, callback
from homeassistant.helpers import device_registry as dr

from . import car3d
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
    websocket_api.async_register_command(hass, ws_tracks)
    websocket_api.async_register_command(hass, ws_delete)
    websocket_api.async_register_command(hass, ws_energy_daily)
    websocket_api.async_register_command(hass, ws_energy_lastweek)
    websocket_api.async_register_command(hass, ws_car3d_info)
    websocket_api.async_register_command(hass, ws_car3d_market_catalog)
    websocket_api.async_register_command(hass, ws_car3d_market_variants)
    websocket_api.async_register_command(hass, ws_car3d_market_pictures)
    websocket_api.async_register_command(hass, ws_car3d_ensure)
    websocket_api.async_register_command(hass, ws_charging_history)
    websocket_api.async_register_command(hass, ws_charging_tariff)
    websocket_api.async_register_command(hass, ws_charging_price)
    from .vehicle_tools import register
    register(hass)
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
    for entry_id, coord in (hass.data.get(DOMAIN) or {}).items():
        if msg.get("entry_id") and msg["entry_id"] != entry_id:
            continue
        if getattr(coord, "trips", None) is None:
            continue
        if msg.get("vin") and getattr(coord, "vin", None) != msg["vin"]:
            continue
        return coord
    return None


def _coordinator_for_device(hass: HomeAssistant, msg: dict):
    """按卡片解析出的设备 ID 找车辆协调器, 避免多车时错用第一辆车。"""
    device_id = msg.get("device_id")
    if not device_id:
        return _coordinator(hass, msg)
    device = dr.async_get(hass).async_get(device_id)
    if device is None:
        return None
    entries = hass.data.get(DOMAIN) or {}
    vins = {str(identifier) for domain, identifier in device.identifiers if domain == DOMAIN}
    for entry_id in device.config_entries:
        coord = entries.get(entry_id)
        if coord is None or getattr(coord, "trips", None) is None:
            continue
        if vins and str(getattr(coord, "vin", "")) not in vins:
            continue
        return coord
    return None


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/charging/history",
    vol.Optional("vin"): str,
    vol.Optional("entry_id"): str,
    vol.Optional("days", default=30): vol.All(int, vol.Range(min=1, max=31)),
})
@websocket_api.async_response
async def ws_charging_history(hass: HomeAssistant, connection, msg: dict) -> None:
    coord = _coordinator(hass, msg)
    rec = getattr(coord, "charges", None)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "充电记录尚未就绪")
        return
    rec.expire(time.time())
    body = rec.view(int(msg["days"]))
    consumption = coord.energy_days_view(int(msg["days"]))
    used = {d["day"]: d.get("kwh") for d in consumption.get("days", [])}
    for day in body["days"]:
        day["consumed_kwh"] = used.get(day["day"])
    connection.send_result(msg["id"], {**body, "vin": coord.vin})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/charging/tariff",
    vol.Optional("vin"): str,
    vol.Optional("entry_id"): str,
    vol.Required("tariff"): dict,
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_charging_tariff(hass: HomeAssistant, connection, msg: dict) -> None:
    coord = _coordinator(hass, msg)
    rec = getattr(coord, "charges", None)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "充电记录尚未就绪")
        return
    try:
        tariff = await rec.set_tariff(msg["tariff"])
    except ValueError as err:
        connection.send_error(msg["id"], "invalid_tariff", str(err))
        return
    except Exception:
        connection.send_error(msg["id"], "save_failed", "电价保存失败，请重试")
        return
    connection.send_result(msg["id"], {"tariff": tariff})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/charging/price",
    vol.Optional("vin"): str, vol.Optional("entry_id"): str,
    vol.Required("session_id"): str, vol.Required("mode"): vol.In(["auto","unit","total"]),
    vol.Optional("value"): vol.Any(None,vol.Coerce(float)),
})
@websocket_api.require_admin
@websocket_api.async_response
async def ws_charging_price(hass: HomeAssistant, connection, msg: dict) -> None:
    rec=getattr(_coordinator(hass,msg),"charges",None)
    if rec is None:connection.send_error(msg["id"],"not_found","充电记录尚未就绪");return
    try:await rec.set_session_price(msg["session_id"],msg["mode"],msg.get("value"))
    except ValueError as err:connection.send_error(msg["id"],"invalid_price",str(err));return
    except Exception:connection.send_error(msg["id"],"save_failed","价格保存失败，请重试");return
    connection.send_result(msg["id"],{"saved":True})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/trips/list",
    vol.Optional("vin"): str,
    vol.Optional("limit", default=200): vol.All(int, vol.Range(min=1, max=2000)),
    # 视图窗口二选一: month="YYYY-MM"(整月跳转) 或 days=N(+end 锚点, 默认现在) —— 滚动窗口。
    # 都不给 = 全部(老卡片的兼容路径)。
    vol.Optional("month"): vol.Match(r"^\d{4}-\d{2}$"),
    vol.Optional("days"): vol.All(int, vol.Range(min=1, max=3650)),
    vol.Optional("end"): vol.Coerce(float),
})
@websocket_api.async_response
async def ws_list(hass: HomeAssistant, connection, msg: dict) -> None:
    rec = _recorder(hass, msg)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    connection.send_result(msg["id"], {
        "vin": rec.vin,
        "trips": rec.list_trips(int(msg["limit"]), month=msg.get("month"),
                                days=msg.get("days"), end=msg.get("end")),
        "months": rec.months_index(),            # 有数据的月份(新→旧): 卡片月份跳转用
        "store": await rec.async_store_usage(),  # 轨迹/摘要占用(带缓存): 卡片底部小字用
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
        "points": await rec.track(msg["trip_id"], int(msg["max_points"])),
    })


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/trips/tracks",
    vol.Optional("vin"): str,
    vol.Optional("before"): vol.Coerce(float),
    vol.Optional("limit", default=20): vol.All(int, vol.Range(min=1, max=50)),
    vol.Optional("max_points", default=400): vol.All(int, vol.Range(min=3, max=4000)),
})
@websocket_api.async_response
async def ws_tracks(hass: HomeAssistant, connection, msg: dict) -> None:
    """批量取轨迹(卡片"叠加最近 N 段"用)。

    取**截至 `before`**(默认现在)的最近 N 段**有轨迹**的行程, 与列表当前显示哪个月无关 ——
    月初看当月时叠加照样能取到上个月的轨迹。点已在服务端抽稀(默认 400 点/段),
    比"逐段拉全量再由前端裁剪"省一个数量级的流量。
    """
    rec = _recorder(hass, msg)
    if rec is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    tracks = await rec.tracks_for(before=msg.get("before"), limit=int(msg["limit"]),
                                  max_points=int(msg["max_points"]))
    connection.send_result(msg["id"], {"vin": rec.vin, "tracks": tracks})


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
    connection.send_result(msg["id"], {"deleted": await rec.delete(msg["trip_id"])})


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
    vol.Optional("entry_id"): str,
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
    reev = bool(getattr(coord,"reev",False))
    fuel_store = getattr(coord,"fuel_days",None)
    fuel = fuel_store.snapshot() if reev and fuel_store else {}
    for day in body["days"]:
        day["fuel"] = fuel.get(day["day"]) if reev else None
        day["fuel_src"] = "tank_delta" if day["fuel"] is not None else None
    km = [d["km"] for d in body["days"] if d.get("km") is not None]
    kwh = [d["kwh"] for d in body["days"] if d.get("kwh") is not None]
    connection.send_result(msg["id"], {
        "vin": getattr(coord, "vin", "") or "",
        "days": days,
        "reev": reev,
        "fuel_average": (((coord.data or {}).get("plug_energy") or {}).get("hundredKmEC") or {}).get("oc100km") if reev else None,
        **body,
        "summary": {"km": round(sum(km), 1), "kwh": round(sum(kwh), 2)},
        "generated_at": time.time(),
    })


# 3D 车模: 现状(读磁盘) / 确保素材就绪(按需装配, 后台跑)。
@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/car3d/info",
    vol.Optional("vin"): str,
})
@websocket_api.async_response
async def ws_car3d_info(hass: HomeAssistant, connection, msg: dict) -> None:
    """3D 车模现状(不联网): 素材是否就绪、车型参数、车漆色表、集成选项。"""
    coord = _coordinator(hass, msg)
    if coord is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    connection.send_result(msg["id"], await car3d.async_info(hass, coord))


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/car3d/market-catalog",
})
@websocket_api.async_response
async def ws_car3d_market_catalog(hass: HomeAssistant, connection, msg: dict) -> None:
    """读取官方商城车型目录; 只返回安全目录中配置页对应的车型名称。"""
    try:
        from .market_picture import fetch_market_catalog
        result = await hass.async_add_executor_job(fetch_market_catalog)
        connection.send_result(msg["id"], result)
    except Exception as err:  # noqa: BLE001 商城目录不可用不影响控车
        log.debug("读取官方商城车型目录失败: %s", type(err).__name__)
        connection.send_result(msg["id"], {"models": [], "reason": "商城车型暂时无法读取"})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/car3d/market-variants",
    vol.Required("model"): str,
    vol.Optional("year"): str,
})
@websocket_api.async_response
async def ws_car3d_market_variants(hass: HomeAssistant, connection, msg: dict) -> None:
    """按车型读取已知版本; 按需核验某一年款的历史官网接口。"""
    try:
        from .market_picture import fetch_market_variants
        result = await hass.async_add_executor_job(
            functools.partial(fetch_market_variants, msg["model"], year=msg.get("year")))
        connection.send_result(msg["id"], result)
    except Exception as err:  # noqa: BLE001 商城配置不可用不影响控车
        log.debug("读取官方商城车型配置失败: %s", type(err).__name__)
        connection.send_result(msg["id"], {"variants": [], "reason": "车型配置暂时无法读取"})


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/car3d/market-pictures",
    vol.Optional("device_id"): str,
    vol.Optional("vin"): str,
    vol.Optional("model"): str,
    vol.Optional("year"): str,
    vol.Optional("energy"): str,
    vol.Optional("edition"): str,
    vol.Optional("model_id"): str,
})
@websocket_api.async_response
async def ws_car3d_market_pictures(hass: HomeAssistant, connection, msg: dict) -> None:
    """按用户选择的商城配置读取颜色渲染图; 未指定配置时尝试本车配置。"""
    if msg.get("model"):
        if not all(msg.get(key) for key in ("year", "energy", "edition", "model_id")):
            connection.send_result(msg["id"], {"pictures": [], "error": "请选择完整车型配置"})
            return
        if msg["energy"] not in ("纯电", "增程"):
            connection.send_result(msg["id"], {"pictures": [], "error": "商城能源类型不受支持"})
            return
        try:
            from .market_picture import fetch_market_pictures
            result = await hass.async_add_executor_job(functools.partial(
                fetch_market_pictures, msg["model"], msg["year"],
                reev=msg["energy"] == "增程", edition=msg["edition"], model_id=msg["model_id"]))
            connection.send_result(msg["id"], {
                **result, "model": msg["model"], "year": result.get("year", msg["year"]),
                "energy": msg["energy"], "edition": result.get("edition", msg["edition"]),
                "model_id": msg["model_id"],
            })
        except Exception as err:  # noqa: BLE001 商城图片不应影响车控卡其余功能
            log.debug("读取所选官方商城图片失败: %s", type(err).__name__)
            connection.send_result(msg["id"], {
                "pictures": [], "error": "商城颜色图片暂时无法读取",
            })
        return

    coord = _coordinator_for_device(hass, msg)
    if coord is None:
        connection.send_result(msg["id"], {"pictures": [], "error": "没有匹配的车辆会话"})
        return
    try:
        info = await car3d.async_info(hass, coord)
        param = info.get("model_param") or {}
        # 2D-only 车型可能没有本地 3D manifest。用户手动选择 2D 时只读一次车型参数,
        # 不下载查看器或模型素材, 后续商城检索严格限定同年款和版本。
        if not param:
            params = car3d.asset_params(coord.client, coord.vin)
            response = await hass.async_add_executor_job(functools.partial(
                coord.client.car_call, "v3/api/carpicture/3d/key", params, method="GET"))
            param = car3d._model_param(car3d._data(response))
        model = str(param.get("carType") or "").strip()
        year = param.get("year")
        edition = str(param.get("carTypeCode") or "").strip()
        if not model or not year or not edition:
            connection.send_result(msg["id"], {
                "pictures": [],
                "model": model,
                "year": str(year or ""),
                "energy": "增程" if bool(getattr(coord, "reev", False)) else "纯电",
                "edition": edition,
                "error": "车端未提供精确年款和版本，暂不能安全匹配商城图片",
            })
            return
        from .market_picture import fetch_market_pictures
        result = await hass.async_add_executor_job(functools.partial(
            fetch_market_pictures, model, year, reev=bool(getattr(coord, "reev", False)),
            edition=edition))
        pictures = result.get("pictures") or []
        actual_color = ""
        color_code = param.get("colorCode")
        if color_code not in (None, ""):
            actual_color = next((str(item.get("name") or "") for item in info.get("colors", [])
                                 if str(item.get("tsp")) == str(color_code)), "")
        connection.send_result(msg["id"], {
            "pictures": pictures,
            "actual_color": actual_color,
            "model": model,
            "year": result.get("year", year),
            "energy": "增程" if bool(getattr(coord, "reev", False)) else "纯电",
            "edition": result.get("edition", edition),
            "error": result.get("reason", ""),
        })
    except Exception as err:  # noqa: BLE001 商城图片不应影响车控卡其余功能
        log.debug("读取官方商城整车图片失败: %s", type(err).__name__)
        connection.send_result(msg["id"], {
            "pictures": [], "error": "商城颜色图片暂时无法读取，请稍后重试",
        })


@websocket_api.websocket_command({
    vol.Required("type"): "leapmotor/car3d/ensure",
    vol.Optional("vin"): str,
    vol.Optional("force", default=False): bool,
})
@websocket_api.async_response
async def ws_car3d_ensure(hass: HomeAssistant, connection, msg: dict) -> None:
    """确保 3D 素材就绪(只读 GET; 每个 VIN 只下一次)。卡片轮询 info 看进度。"""
    coord = _coordinator(hass, msg)
    if coord is None:
        connection.send_error(msg["id"], "not_found", "没有可用的车辆会话")
        return
    res = await car3d.async_ensure(hass, coord, force=bool(msg.get("force")))
    connection.send_result(msg["id"], {**res, "info": await car3d.async_info(hass, coord)})
