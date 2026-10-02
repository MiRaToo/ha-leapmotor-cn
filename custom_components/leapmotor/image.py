"""驻车/底盘照片。"""

from __future__ import annotations

import logging

from homeassistant.components.image import ImageEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.aiohttp_client import async_get_clientsession
from homeassistant.helpers.entity_platform import AddEntitiesCallback
from homeassistant.util import dt as dt_util

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

log = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    add([LeapmotorParkingImage(hass, hass.data[DOMAIN][entry.entry_id])])


class LeapmotorParkingImage(LeapmotorEntity, ImageEntity):
    """从接口拿到的 OSS 地址下载图片(同一地址只下一次)。"""

    _attr_name = "驻车照片"

    def __init__(self, hass: HomeAssistant, coordinator: LeapmotorCoordinator) -> None:
        LeapmotorEntity.__init__(self, coordinator, "parking")
        ImageEntity.__init__(self, hass)
        self._cached_url = ""
        self._cached: bytes | None = None

    @property
    def image_last_updated(self):
        return self.coordinator.last_update_success and dt_util.utcnow() or None

    async def async_image(self) -> bytes | None:
        url = (self.coordinator.data or {}).get("parking_url") or ""
        if not url:
            return None
        if url == self._cached_url and self._cached:
            return self._cached
        try:
            session = async_get_clientsession(self.hass)
            async with session.get(url, timeout=20) as resp:
                resp.raise_for_status()
                data = await resp.read()
            self._cached_url, self._cached = url, data
            return data
        except Exception as err:  # noqa: BLE001
            log.warning("下载驻车照片失败: %s", err)
            return self._cached
