"""零跑汽车集成 —— 在 HA 里登录并控制车辆。

架构: 纯 HTTP(不需要 MQTT、不需要附加组件)。
  config_flow 里: 手机号 + 短信验证码 → 车端交换 → 本地派生签名密钥
  coordinator: 轮询车辆信息, 车端 token 快过期时用账号 token 自动续期
  www/: 自带一张「零跑车辆地图」卡片(高德底图, 见 docs/dashboard.md)
"""

from __future__ import annotations

import logging
from pathlib import Path

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, ConfigEntryNotReady

from .const import DOMAIN, PLATFORMS
from .coordinator import LeapmotorCoordinator

log = logging.getLogger(__name__)

# 前端模块: 把 www/leapmotor-map.js 注册成全局卡片(用户无需手动放 www/ 或配资源)
_CARD_FILE = "leapmotor-map.js"
_CARD_URL = "/leapmotor-card/leapmotor-map.js"
CARD_VERSION = "1.4.1"


async def async_setup(hass: HomeAssistant, config: dict) -> bool:
    """注册自带的前端卡片。失败不影响集成本体。"""
    try:
        from homeassistant.components.frontend import add_extra_js_url
        from homeassistant.components.http import StaticPathConfig

        path = Path(__file__).parent / "www" / _CARD_FILE
        await hass.http.async_register_static_paths(
            [StaticPathConfig(_CARD_URL, str(path), cache_headers=False)]
        )
        add_extra_js_url(hass, f"{_CARD_URL}?v={CARD_VERSION}")
        await _ensure_lovelace_resource(hass, f"{_CARD_URL}?v={CARD_VERSION}")
        log.debug("已注册地图卡片 %s", _CARD_URL)
    except Exception as err:  # noqa: BLE001
        log.warning("地图卡片注册失败(不影响控车): %s", err)
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
    try:
        await coordinator.async_config_entry_first_refresh()
    except ConfigEntryAuthFailed:
        raise
    except Exception as err:  # noqa: BLE001
        raise ConfigEntryNotReady(str(err)) from err

    hass.data.setdefault(DOMAIN, {})[entry.entry_id] = coordinator
    await hass.config_entries.async_forward_entry_setups(entry, PLATFORMS)
    entry.async_on_unload(entry.add_update_listener(_async_update_listener))
    return True


async def async_unload_entry(hass: HomeAssistant, entry: ConfigEntry) -> bool:
    ok = await hass.config_entries.async_unload_platforms(entry, PLATFORMS)
    if ok:
        hass.data.get(DOMAIN, {}).pop(entry.entry_id, None)
    return ok


async def _async_update_listener(hass: HomeAssistant, entry: ConfigEntry) -> None:
    """选项变更(如填了操作密码)后重载。"""
    await hass.config_entries.async_reload(entry.entry_id)
