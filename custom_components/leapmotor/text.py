"""原始指令(排查/收敛参数用): 填 `cmdid [state] k=v ...` 或 `cmdid state={...}`。"""

from __future__ import annotations

import json
import logging
from typing import Any

from homeassistant.components.text import TextEntity, TextMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import EntityCategory
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

log = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    add([LeapmotorRawCommand(hass.data[DOMAIN][entry.entry_id])])


class LeapmotorRawCommand(LeapmotorEntity, TextEntity):
    _attr_name = "原始指令(cmdId)"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    # 用法: `110 {"value":"lock"}` / `170 {"operate":"off"}` / `180 {}`
    _attr_mode = TextMode.TEXT
    _attr_native_max = 200

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "raw_cmd")
        self._value = ""

    @property
    def native_value(self) -> str:
        return self._value

    async def async_set_value(self, value: str) -> None:
        self._value = value
        self.async_write_ha_state()
        try:
            bits = value.split(maxsplit=1)
            cmd_id = int(bits[0])
            state: dict[str, Any] = {}
            if len(bits) > 1 and bits[1].strip():
                state = json.loads(bits[1])          # 例如: 110 {"value":"lock"}
                if not isinstance(state, dict):
                    raise ValueError("state 必须是 JSON 对象")
            await self.coordinator.async_call("remote_control", cmd_id=cmd_id, state=state)
        except Exception as err:  # noqa: BLE001
            log.error("原始指令解析/下发失败 %r: %s", value, err)
