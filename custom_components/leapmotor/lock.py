"""车门锁: 状态取自车况信号 1298(1=已锁, 0=未锁)。"""

from __future__ import annotations

import logging

from homeassistant.components.lock import LockEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

log = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    add([LeapmotorLock(hass.data[DOMAIN][entry.entry_id])])


class LeapmotorLock(LeapmotorEntity, LockEntity):
    """车门锁: 下发 state=1 上锁 / state=2 解锁。

    状态来自车况信号 **1298**(1=已锁, 0=未锁)。车端还没上报过(信号缺失)时
    退回"假定状态", 这样实体仍可点、不会显示成 Unknown。
    """

    _attr_name = "车门锁"

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "lock")

    @property
    def _real(self) -> bool | None:
        remembered = self.coordinator.recall("lock")
        if remembered is not None:
            return bool(remembered)
        st = self.coordinator.car_state
        return st.locked if st else None

    @property
    def is_locked(self) -> bool | None:
        real = self._real
        return real if real is not None else self._attr_is_locked

    @property
    def assumed_state(self) -> bool:
        return self._real is None

    async def async_lock(self, **kwargs) -> None:
        await self.coordinator.async_call("lock")
        self._attr_is_locked = True
        self.coordinator.remember("lock", True)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()

    async def async_unlock(self, **kwargs) -> None:
        await self.coordinator.async_call("unlock")
        self._attr_is_locked = False
        self.coordinator.remember("lock", False)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()
