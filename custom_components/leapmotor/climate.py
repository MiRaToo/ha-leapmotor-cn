"""空调: 开关 + 温度 + 四个快捷模式(极速降温/极速升温/快速除味/风挡除霜)。"""

from __future__ import annotations

import logging
import time
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

# "刚点过的预设"记多久: 降温/升温车端不回报, 界面靠它点亮(车端报状态或空调关闭即作废)
PRESET_MEMO_SECONDS = 3600

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
        # 本地"刚点过的预设"记忆(标签, 到期时刻): 极速降温/升温 车端不回报状态, 只能靠它点亮;
        # 车端一旦报了预设(除霜/除味) 或明确说空调关了, 立即清掉。
        self._preset_memo: tuple[str, float] | None = None

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
    def preset_mode(self) -> str | None:
        """当前快捷预设: **车端信号优先**, 其次用本地"刚点过"的记忆。

        实测: 除霜(`1945`)与除味(`3713=4`)车端会回报状态(App 里也能看到开关亮);
        而极速降温/升温车端**不回报**(App 里同样不显示), 所以那两项要靠本地记忆点亮,
        否则界面上"点了却没有任何状态"。车端报了预设、或明确说空调已关 → 记忆立刻作废。
        """
        st = self.coordinator.car_state
        real = st.ac_preset if st is not None else None
        if real:
            self._preset_memo = None                     # 车端有准信 → 以车端为准
            return real
        memo = self._preset_memo
        if memo is None:
            return None
        label, until = memo
        if time.time() >= until or (st is not None and st.flag("climate_on") is False):
            self._preset_memo = None                     # 过期 / 车端说空调关了 → 作废
            return None
        return label

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
        actual_on = st.flag("climate_on") if st else None
        actual_mode = None
        if st is not None:
            if actual_on is False:
                actual_mode = HVACMode.OFF
            else:
                actual_mode = {1: HVACMode.COOL, 3: HVACMode.HEAT,
                               4: HVACMode.FAN_ONLY}.get(st.get("climate_mode"))
        actual_temp = st.get("climate_temp_left") if st else None
        statuses = [self.coordinator.confirmation_pending(key, actual, st.collect_time if st else 0)
                    for key, actual in (("ac_on", actual_on), ("ac_hvac", actual_mode),
                                        ("ac_temp", actual_temp))]
        attrs = {
            "pending_confirmation": any(statuses),
            "confirmation_status": "pending" if any(statuses) else
                ("unconfirmed" if any(self.coordinator.overrides.confirmation_result(k) == "unconfirmed"
                                      for k in ("ac_on", "ac_hvac", "ac_temp")) else "idle"),
        }
        if st is not None:
            attrs.update({
                "climate_mode_code": st.get("climate_mode"),
                "ac_mode_code": st.get("ac_mode"),
                "fan_level": st.get("ac_fan_level"),
                "set_temp_right": st.get("climate_temp_right"),
                "fast_cooling": st.flag("fast_cooling"),
                "fast_heating": st.flag("fast_heating"),
                "windshield_defrost": st.flag("windshield_defrost"),
                "ptc_power": st.get("ptc_power"),
            })
        return attrs

    async def async_set_hvac_mode(self, hvac_mode: HVACMode) -> None:
        if hvac_mode == HVACMode.OFF:
            self._preset_memo = None
            await self.coordinator.async_call("ac_off")
            self._attr_hvac_mode = HVACMode.OFF
            self.coordinator.remember("ac_on", False)
            self.coordinator.remember("ac_hvac", HVACMode.OFF)
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
        target = float(temp)
        await self.coordinator.async_call("ac_on", temperature=target)
        self._attr_target_temperature = target
        self.coordinator.remember("ac_temp", self._attr_target_temperature)
        self._attr_hvac_mode = HVACMode.COOL if self._attr_hvac_mode == HVACMode.OFF else self._attr_hvac_mode
        self.async_write_ha_state()

    async def async_set_preset_mode(self, preset_mode: str) -> None:
        key = PRESET_MODES.get(preset_mode, "boost_cool")
        await self.coordinator.async_call("ac_quick", mode=key)
        self._attr_preset_mode = preset_mode
        self._preset_memo = (preset_mode, time.time() + PRESET_MEMO_SECONDS)
        # 命令后车端上报有延迟: 先给本地乐观值(否则"空调开着"要等下一帧才显示出来),
        # 车端信号一到就自动让位(recall 的宽限期逻辑)。
        self.coordinator.remember("ac_on", True)
        self.coordinator.remember("ac_hvac", {
            "boost_cool": HVACMode.COOL,
            "boost_heat": HVACMode.HEAT,
            "deodorize": HVACMode.FAN_ONLY,
            "defrost": HVACMode.FAN_ONLY,
        }.get(key, HVACMode.COOL))
        await self.coordinator.async_request_refresh()
        self.async_write_ha_state()

    async def async_turn_on(self) -> None:
        await self.async_set_hvac_mode(HVACMode.COOL)

    async def async_turn_off(self) -> None:
        await self.async_set_hvac_mode(HVACMode.OFF)
