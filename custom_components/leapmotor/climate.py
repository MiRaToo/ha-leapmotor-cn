"""空调: 开关 + 温度 + 四个快捷模式(极速降温/极速升温/快速除味/风挡除霜)。"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.climate import (
    ClimateEntity,
    ClimateEntityFeature,
    HVACMode,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.const import ATTR_TEMPERATURE, UnitOfTemperature
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

log = logging.getLogger(__name__)

# 中文标签 → 客户端里的快捷模式键
PRESET_MODES = {
    "极速降温": "boost_cool",
    "极速升温": "boost_heat",
    "快速除味": "deodorize",
    "风挡除霜": "defrost",
}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    add([LeapmotorClimate(hass.data[DOMAIN][entry.entry_id])])


class LeapmotorClimate(LeapmotorEntity, ClimateEntity):
    """实测: cmdId 170, 内容 {"circle","mode","operate","position","temperature","windlevel","wshld"}。"""

    _attr_name = "空调"
    _attr_temperature_unit = UnitOfTemperature.CELSIUS
    _attr_min_temp = 16
    _attr_max_temp = 32
    _attr_target_temperature_step = 1
    _attr_hvac_modes = [HVACMode.OFF, HVACMode.COOL, HVACMode.HEAT, HVACMode.FAN_ONLY]
    _attr_preset_modes = list(PRESET_MODES.keys())
    _attr_supported_features = (
        ClimateEntityFeature.TARGET_TEMPERATURE | ClimateEntityFeature.PRESET_MODE
    )

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "ac")
        self._attr_hvac_mode = HVACMode.OFF
        self._attr_target_temperature = 24.0
        self._attr_preset_mode = None

    # ── 真实状态(车况信号) ──
    @property
    def _real_on(self) -> bool | None:
        # 命令后先看本地值(车端上报有延迟, 否则"关空调"会被旧值顶回去)
        remembered = self.coordinator.recall("ac_on")
        if remembered is not None:
            return bool(remembered)
        st = self.coordinator.car_state
        return st.flag("climate_on") if st else None

    @property
    def hvac_mode(self) -> HVACMode:
        """信号 1938=开关, 3713=模式(0=关, 1=极速降温, 3=极速升温, 4=换气)。

        注意 1939 是"自动/手动", **不是**冷暖 —— 冷暖看 3713(EU 版实测结论)。
        """
        remembered = self.coordinator.recall("ac_hvac")
        if remembered is not None:
            return remembered
        st = self.coordinator.car_state
        if st is None:
            return self._attr_hvac_mode
        on = st.flag("climate_on")
        if on is False:
            return HVACMode.OFF
        mode = st.get("climate_mode")
        if mode is not None:
            code = int(mode)
            if code == 0:
                return HVACMode.OFF if on is None else HVACMode.FAN_ONLY
            if code == 1:
                return HVACMode.COOL
            if code == 3:
                return HVACMode.HEAT
            if code == 4:
                return HVACMode.FAN_ONLY
        if on is None:
            return self._attr_hvac_mode
        return self._attr_hvac_mode if self._attr_hvac_mode != HVACMode.OFF else HVACMode.COOL

    @property
    def current_temperature(self) -> float | None:
        st = self.coordinator.car_state
        return st.get("interior_temp") if st else None

    @property
    def target_temperature(self) -> float | None:
        remembered = self.coordinator.recall("ac_temp")
        if remembered is not None:
            return float(remembered)
        st = self.coordinator.car_state
        if st is None:
            return self._attr_target_temperature
        v = st.get("climate_temp_left")
        return v if v is not None else self._attr_target_temperature

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "climate_mode_code": st.get("climate_mode"),
            "ac_mode_code": st.get("ac_mode"),
            "fan_level": st.get("ac_fan_level"),
            "set_temp_right": st.get("climate_temp_right"),
            "fast_cooling": st.flag("fast_cooling"),
            "fast_heating": st.flag("fast_heating"),
            "ptc_power": st.get("ptc_power"),
        }

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode == HVACMode.OFF:
            await self.coordinator.async_call("ac_off")
            self._attr_hvac_mode = HVACMode.OFF
            self.coordinator.remember("ac_on", False)
            self.coordinator.remember("ac_hvac", HVACMode.OFF)
            await self.coordinator.async_request_refresh()
        else:
            mode = {HVACMode.COOL: "cold", HVACMode.HEAT: "hot",
                    HVACMode.FAN_ONLY: "wind"}.get(hvac_mode, "wind")
            await self.coordinator.async_call(
                "ac_on", temperature=self._attr_target_temperature, mode=mode)
            self._attr_hvac_mode = hvac_mode
            self._attr_preset_mode = None
            self.coordinator.remember("ac_on", True)
            self.coordinator.remember("ac_hvac", hvac_mode)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()

    async def async_set_temperature(self, **kwargs: Any) -> None:
        temp = kwargs.get(ATTR_TEMPERATURE)
        if temp is None:
            return
        self._attr_target_temperature = float(temp)
        await self.coordinator.async_call("ac_on", temperature=self._attr_target_temperature)
        self.coordinator.remember("ac_temp", self._attr_target_temperature)
        self._attr_hvac_mode = HVACMode.COOL if self._attr_hvac_mode == HVACMode.OFF else self._attr_hvac_mode
        self.async_write_ha_state()

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        key = PRESET_MODES.get(preset_mode, "boost_cool")
        await self.coordinator.async_call("ac_quick", mode=key)
        self._attr_preset_mode = preset_mode
        self.coordinator.remember("ac_on", True)
        if self._attr_hvac_mode == HVACMode.OFF:
            self._attr_hvac_mode = HVACMode.COOL
        self.async_write_ha_state()

    async def async_turn_on(self) -> None:
        await self.async_set_hvac_mode(HVACMode.COOL)

    async def async_turn_off(self) -> None:
        await self.async_set_hvac_mode(HVACMode.OFF)
