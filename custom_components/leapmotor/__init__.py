"""零跑汽车集成 —— 在 HA 里登录并控制车辆。

架构: 纯 HTTP(不需要 MQTT、不需要附加组件)。
  config_flow 里: 手机号 + 短信验证码 → 车端交换 → 本地派生签名密钥
  coordinator: 轮询车辆信息, 车端 token 快过期时用账号 token 自动续期
  www/: 自带五张卡片 —— 「零跑车辆地图」(高德底图)、「零跑·行程浏览」(行程+轨迹)、
        「零跑·车辆控制」(App 风格主界面)、「零跑·里程耗电」(逐日折线)与
        「零跑·上周能耗」(能耗拆分), 见 docs/dashboard.md
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady
from homeassistant.helpers import config_validation as cv

from .const import DOMAIN, DEFAULT_POLL_SECONDS, PLATFORMS
from .coordinator import LeapmotorCoordinator

log = logging.getLogger(__name__)

# 本集成只通过「配置条目」接入(手机号验证码登录), 不支持 YAML 配置。
# `async_setup` 仅用于注册自带卡片, 因此声明 config-entry-only 的 schema。
CONFIG_SCHEMA = cv.config_entry_only_config_schema(DOMAIN)

# 前端模块: 把 www/ 下的五张卡片注册成全局卡片(用户无需手动放 www/ 或配资源)。
# CARD_VERSION 与各自 JS 文件头里的同名常量保持一致(改 JS 记得一起升, 好让浏览器拿到新文件)。
CARD_VERSION = "1.6.1"            # leapmotor-map.js
TRIPS_CARD_VERSION = "1.1.6"      # leapmotor-trips.js
CONTROL_CARD_VERSION = "1.7.2"    # leapmotor-control.js
ENERGY_CARD_VERSION = "1.2.2"     # leapmotor-energy.js
LASTWEEK_CARD_VERSION = "1.0.1"   # leapmotor-lastweek.js
_CARDS = (
    ("leapmotor-map.js", "/leapmotor-card/leapmotor-map.js", CARD_VERSION),
    ("leapmotor-trips.js", "/leapmotor-card/leapmotor-trips.js", TRIPS_CARD_VERSION),
    ("leapmotor-control.js", "/leapmotor-card/leapmotor-control.js", CONTROL_CARD_VERSION),
    ("leapmotor-energy.js", "/leapmotor-card/leapmotor-energy.js", ENERGY_CARD_VERSION),
    ("leapmotor-lastweek.js", "/leapmotor-card/leapmotor-lastweek.js", LASTWEEK_CARD_VERSION),
)
_FRONTEND_KEY = "_frontend_registered"


async def async_migrate_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    """配置条目迁移(累积式: 老条目会一路补到最新版本)。

    v1 → v2(行程记录): 轮询默认值改了语义 —— 停车 300→60 秒、行驶 60→6 秒,
    并新增「出发提速」与「电池可用容量」。老条目里存的是旧默认值, 这里显式换成新默认,
    免得升级后仍停在"停车 300 秒"(那样行程起点会晚最多 5 分钟才被发现)。
    v2 → v3(短停快档): 新增「短停快档」时长(行程结束后仍用快档的窗口, 0=关)。
    v3 → v4(可用容量修正): 电池默认从 69.9(毛容量)改为 67.0(**可用**容量, mate #246
    实测实证)。只改"恰好是旧默认 69.9"的条目 —— 用户自己调过的值一律不动。
    """
    if entry.version >= 4:
        return True
    new = dict(entry.options)
    from .const import (CONF_BATTERY_KWH, CONF_DRIVING_POLL_SECONDS, CONF_LAUNCH_BOOST,
                        CONF_POLL_SECONDS, CONF_SHORT_STOP_SECONDS, DEFAULT_BATTERY_KWH,
                        DEFAULT_DRIVING_POLL_SECONDS, DEFAULT_LAUNCH_BOOST,
                        DEFAULT_POLL_SECONDS, DEFAULT_SHORT_STOP_SECONDS)
    if entry.version < 2:
        if int(new.get(CONF_POLL_SECONDS) or 0) in (0, 300):
            new[CONF_POLL_SECONDS] = DEFAULT_POLL_SECONDS
        if int(new.get(CONF_DRIVING_POLL_SECONDS) or 0) in (0, 60):
            new[CONF_DRIVING_POLL_SECONDS] = DEFAULT_DRIVING_POLL_SECONDS
        new.setdefault(CONF_LAUNCH_BOOST, DEFAULT_LAUNCH_BOOST)
        new.setdefault(CONF_BATTERY_KWH, DEFAULT_BATTERY_KWH)
    new.setdefault(CONF_SHORT_STOP_SECONDS, DEFAULT_SHORT_STOP_SECONDS)
    if entry.version < 4:
        try:
            if float(new.get(CONF_BATTERY_KWH) or 0) == 69.9:   # 旧的 C10 默认(毛容量)
                new[CONF_BATTERY_KWH] = DEFAULT_BATTERY_KWH
                log.info("配置条目迁移: 电池容量 69.9 → %.1f kWh(可用容量口径)", DEFAULT_BATTERY_KWH)
        except (TypeError, ValueError):
            new[CONF_BATTERY_KWH] = DEFAULT_BATTERY_KWH
    hass.config_entries.async_update_entry(entry, options=new, version=4)
    log.info("配置条目已迁移到 v4: 停车 %ss / 行程采样 %ss / 出发提速 %s / 短停快档 %ss / 电池 %s kWh",
             new.get(CONF_POLL_SECONDS), new.get(CONF_DRIVING_POLL_SECONDS),
             new.get(CONF_LAUNCH_BOOST), new.get(CONF_SHORT_STOP_SECONDS),
             new.get(CONF_BATTERY_KWH))
    return True


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """注册自带的前端卡片(幂等: 重复 setup 不会重复注册静态路径/资源)。失败不影响集成本体。"""
    data = hass.data.setdefault(DOMAIN, {})
    if data.get(_FRONTEND_KEY):
        return True
    # 先置位再注册: 静态路径重复注册在有些 HA 版本会直接抛错, 宁可失败后等下个版本修
    data[_FRONTEND_KEY] = True
    try:
        from homeassistant.components.frontend import add_extra_js_url
        from homeassistant.components.http import StaticPathConfig

        base = Path(__file__).parent / "www"
        await hass.http.async_register_static_paths(
            [StaticPathConfig(url, str(base / name), cache_headers=False)
             for name, url, _ver in _CARDS]
            # 车模图(按车型的官方外观图, 控制卡用): 目录映射, **不要**放进 _CARDS
            # —— 上面那个循环会把每一项都当 JS 模块注入首页。
            + [StaticPathConfig("/leapmotor-card/carimg", str(base / "carimg"),
                                cache_headers=False)]
        )
        for _name, url, ver in _CARDS:
            versioned = f"{url}?v={ver}"
            add_extra_js_url(hass, versioned)
            await _ensure_lovelace_resource(hass, versioned)
            log.debug("已注册卡片 %s", url)
    except Exception as err:  # noqa: BLE001
        log.warning("前端卡片注册失败(不影响控车): %s", err)
    return True


async def _ensure_lovelace_resource(hass: HomeAssistant, url: str) -> None:
    """把卡片同时登记成仪表盘"资源"。

    只靠 `add_extra_js_url` 有个坑:那行 import 是写进首页 HTML 的, 浏览器若缓存了
    旧首页(或用了缓存很凶的 App), 卡片模块就永远不会被加载 —— 界面上表现为
    "配置错误 / Custom element doesn't exist: leapmotor-map"。
    资源列表是前端每次渲染仪表盘时读取的, 因此这条路不受首页缓存影响。
    """
    try:
        from homeassistant.components.lovelace import LOVELACE_DATA

        data = hass.data.get(LOVELACE_DATA)
        resources = getattr(data, "resources", None) if data else None
        if resources is None or not hasattr(resources, "async_create_item"):
            log.debug("lovelace 资源集合不可用, 跳过资源登记")
            return
        if not getattr(resources, "loaded", True):
            await resources.async_load()          # 资源是懒加载的, 先拉一次
        for item in resources.async_items():
            if str(item.get("url", "")).split("?")[0] == url.split("?")[0]:
                if item.get("url") != url:        # 版本变了就更新, 避免旧 URL 被缓存
                    await resources.async_update_item(item["id"], {"url": url})
                return
        await resources.async_create_item({"res_type": "module", "url": url})
        log.debug("已登记仪表盘资源 %s", url)
    except Exception as err:  # noqa: BLE001
        log.debug("登记仪表盘资源失败(不影响 add_extra_js_url 那条路): %s", err)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    coordinator = LeapmotorCoordinator(hass, entry)
    # 首轮只拉车况帧: 里程/能耗/配置/照片留到下一个轮询周期。
    # 实测教训: 网络慢时首轮那 10 来个请求(车况 + 换 token 重试 + 4 个重数据 + 照片)
    # 每个都可能等满 20 秒超时, 把 HA 启动拖了 4 分钟; 而启动其实只需要"车况能用"。
    coordinator.light_first_refresh = True
    try:
        await coordinator.async_config_entry_first_refresh()
    except ConfigEntryAuthFailed:
        raise
    except Exception as err:  # noqa: BLE001
        raise ConfigEntryNotReady(str(err)) from err
    finally:
        coordinator.light_first_refresh = False

    # ── 行程记录器 ──
    # 数据全部来自轮询帧(云端没有逐条行程接口, 见 trips.py 的模块说明);
    # 挂在协调器上, 每轮 `_refresh_car_data()` 结束时喂一帧。
    from .const import CONF_BATTERY_KWH, DEFAULT_BATTERY_KWH
    from .energy_daily import EnergyDayStore
    from .trips import TripRecorder
    recorder = TripRecorder(
        hass, coordinator.vin,
        capacity_kwh=float(entry.options.get(CONF_BATTERY_KWH) or DEFAULT_BATTERY_KWH),
        poll_seconds_getter=lambda: (
            int(coordinator.update_interval.total_seconds())
            if coordinator.update_interval else DEFAULT_POLL_SECONDS),
    )
    await recorder.async_load()
    coordinator.trips = recorder
    # ── 官方逐日能耗缓存(getEC; 见 energy_daily.py)──
    # 卡片/传感器的「每日耗电」数据源。已完结的日子拉一次进持久缓存, 历史不变。
    energy_days = EnergyDayStore(hass, coordinator.vin)
    await energy_days.async_load()
    coordinator.energy_days = energy_days
    _register_ws_api(hass)

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    # ⚠️ 这里**故意不注册"条目更新就重载"的监听器**(定位到的重载风暴):
    # 集成每 ~2 小时把续期后的 token 写回条目(data 变化), 而 HA 的 update listener
    # 在**任何**条目变化(含仅 data)时都会触发 —— 于是每天几十次整批实体 unavailable、
    # 内存态(乐观状态/照片窗口/行程记录器)反复重建。正确做法:
    #   * 选项变更 → 由 OptionsFlowWithReload 自动重载(见 config_flow), 两者 HA 明确互斥;
    #   * token 落盘 → 什么都不该发生;
    #   * 重新认证写回新会话 → 由认证流程自己调度一次重载。
    return True


def _register_ws_api(hass: HomeAssistant) -> None:
    """注册给前端卡片用的 WebSocket 命令(幂等)。"""
    try:
        from .ws_api import async_register as _reg
        _reg(hass)
    except Exception as err:  # noqa: BLE001
        log.warning("注册行程 WebSocket 命令失败(卡片会退化成只读属性): %s", err)


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return ok
