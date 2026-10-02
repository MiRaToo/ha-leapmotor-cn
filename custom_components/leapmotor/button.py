"""按钮: 寻车 / 后备箱 / 车窗 / 遮阳帘 / 电池预热 / 刷新车况。"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import BUTTONS, DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([LeapmotorButton(c, k, n, method) for k, n, method in BUTTONS])
    add([LeapmotorRefreshButton(c)])


class LeapmotorButton(LeapmotorEntity, ButtonEntity):
    def __init__(self, coordinator: LeapmotorCoordinator, key: str, name: str,
                 method: str) -> None:
        super().__init__(coordinator, key)
        self._attr_name = name
        self._method = method

    async def async_press(self) -> None:
        await self.coordinator.async_call(self._method)


class LeapmotorRefreshButton(LeapmotorEntity, ButtonEntity):
    """立刻拉一次最新车况(电量/位置/胎压…), 不用等下一个轮询周期。"""

    _attr_name = "刷新车况"
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "refresh_state")

    async def async_press(self) -> None:
        await self.coordinator.async_request_refresh()

