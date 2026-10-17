"""时间类: 预约充电的开始/结束时间(下发 cmdId 190 时保留其它字段)。"""

from __future__ import annotations

import datetime as dt
import logging

from homeassistant.components.time import TimeEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

log = logging.getLogger(__name__)


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([
        LeapmotorChargeTime(c, "charge_start", "预约充电-开始", "beginTime", "start"),
        LeapmotorChargeTime(c, "charge_end", "预约充电-结束", "endTime", "end"),
    ])


def _parse(value: str | None) -> dt.time | None:
    if not value:
        return None
    try:
        hh, mm = str(value).split(":")[:2]
        return dt.time(int(hh), int(mm))
    except Exception:  # noqa: BLE001
        return None


class LeapmotorChargeTime(LeapmotorEntity, TimeEntity):
    def __init__(self, coordinator: LeapmotorCoordinator, key: str, name: str,
                 plan_field: str, method_arg: str) -> None:
        super().__init__(coordinator, key)
        self._attr_name = name
        self._plan_field = plan_field
        self._arg = method_arg

    @property
    def native_value(self) -> dt.time | None:
        plan = (self.coordinator.data or {}).get("charge_plan") or {}
        return _parse(plan.get(self._plan_field))

    async def async_set_value(self, value: dt.time) -> None:
        hhmm = value.strftime("%H:%M")
        resp = await self.coordinator.async_call("set_charge_plan", **{self._arg: hhmm})
        if isinstance(resp, dict) and resp.get("code") == 0:
            self.coordinator.set_charge_plan_cache(self._plan_field, hhmm)
            await self.coordinator.async_request_refresh()
        self.async_write_ha_state()
