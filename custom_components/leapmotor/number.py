"""数值类: 充电上限 + 四个座椅的加热/通风档位(0~3)。"""

from __future__ import annotations

from homeassistant.components.number import NumberEntity, NumberMode
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .api import seat_rows
from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    st = c.car_state
    _rows = seat_rows(st.signals if st is not None else {},
                      getattr(c.vehicle, "abilities", None) or ())
    add([
        LeapmotorSeat(c, "seat_heat_driver", "主驾座椅加热", "driver", heat=True,
                      signal="seat_heat_driver", icon="mdi:car-seat-heater"),
        LeapmotorSeat(c, "seat_heat_copilot", "副驾座椅加热", "copilot", heat=True,
                      signal="seat_heat_passenger", icon="mdi:car-seat-heater"),
        LeapmotorSeat(c, "seat_vent_driver", "主驾座椅通风", "driver", heat=False,
                      signal="seat_vent_driver", icon="mdi:car-seat-cooler"),
        LeapmotorSeat(c, "seat_vent_copilot", "副驾座椅通风", "copilot", heat=False,
                      signal="seat_vent_passenger", icon="mdi:car-seat-cooler"),
        LeapmotorChargeLimit(c),
        # ── 后排座椅(C16 这类多排座车型; 纯电 C10 上这些信号缺失 → 不会创建) ──
        #   CN App 的取值: 二排 left_rear/right_rear、三排 left_third/right_third;
        #   加热复用 cmdId 301、通风复用 370, payload 与前排同形。
        #   ⚠️ 后排**没有真车实测样本**(EU 三个项目也都没测过), 以 App 源码为准。
        *([LeapmotorSeat(c, "seat_heat_rear_left", "二排左座椅加热", "left_rear",
                         heat=True, signal="seat_heat_rear_left", icon="mdi:car-seat-heater"),
           LeapmotorSeat(c, "seat_heat_rear_right", "二排右座椅加热", "right_rear",
                         heat=True, signal="seat_heat_rear_right", icon="mdi:car-seat-heater")]
          if _rows.get("rear_heat") else []),
        *([LeapmotorSeat(c, "seat_vent_rear_left", "二排左座椅通风", "left_rear",
                         heat=False, signal="seat_vent_rear_left", icon="mdi:car-seat-cooler"),
           LeapmotorSeat(c, "seat_vent_rear_right", "二排右座椅通风", "right_rear",
                         heat=False, signal="seat_vent_rear_right", icon="mdi:car-seat-cooler")]
          if _rows.get("rear_vent") else []),
        *([LeapmotorSeat(c, "seat_heat_third_left", "三排左座椅加热", "left_third",
                         heat=True, signal="seat_heat_third_left", icon="mdi:car-seat-heater")]
          if _rows.get("third_heat_left") else []),
        *([LeapmotorSeat(c, "seat_heat_third_right", "三排右座椅加热", "right_third",
                         heat=True, signal="seat_heat_third_right", icon="mdi:car-seat-heater")]
          if _rows.get("third_heat_right") else []),
    ])


class LeapmotorChargeLimit(LeapmotorEntity, NumberEntity):
    """充电上限 50~100(下发 cmdId 190, 保留当前计划的其它字段)。"""

    _attr_name = "充电上限"
    _attr_native_min_value = 50
    _attr_native_max_value = 100
    _attr_native_step = 5
    _attr_native_unit_of_measurement = "%"
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "charge_limit")

    @property
    def native_value(self) -> float | None:
        plan = (self.coordinator.data or {}).get("charge_plan") or {}
        v = plan.get("percent")
        return float(v) if v is not None else None

    async def async_set_native_value(self, value: float) -> None:
        resp = await self.coordinator.async_call("set_charge_plan", soc=int(value))
        if isinstance(resp, dict) and resp.get("code") == 0:
            # 立刻反映到界面, 再拉一次真实值(车端写库有延迟)
            self.coordinator.set_charge_plan_cache("percent", int(value))
            await self.coordinator.async_request_refresh()
        self.async_write_ha_state()


class LeapmotorSeat(LeapmotorEntity, NumberEntity):
    """座椅加热/通风: 0=关, 1~3=档位。

    实测形态(EU 版在 B10/C10 上验证): {"position":"driver","level":"2"}
    """

    _attr_native_min_value = 0
    _attr_native_max_value = 3
    _attr_native_step = 1
    _attr_mode = NumberMode.SLIDER

    def __init__(self, coordinator: LeapmotorCoordinator, key: str, name: str,
                 position: str, heat: bool, signal: str = "", icon: str = "") -> None:
        super().__init__(coordinator, key)
        self._key = key                      # remember/recall 用(基类只存 _attr_unique_id)
        self._attr_name = name
        self._position = position
        self._heat = heat
        self._signal = signal
        self._level = 0.0
        if icon:
            self._attr_icon = icon

    @property
    def _real(self) -> float | None:
        remembered = self.coordinator.recall(self._key)
        if remembered is not None:
            return float(remembered)
        st = self.coordinator.car_state
        if st is None or not self._signal:
            return None
        return st.get(self._signal)

    @property
    def native_value(self) -> float:
        real = self._real
        return real if real is not None else self._level

    @property
    def assumed_state(self) -> bool:
        return self._real is None

    async def async_set_native_value(self, value: float) -> None:
        self._level = value
        await self.coordinator.async_call(
            "set_seat", position=self._position, level=int(value), heat=self._heat)
        self.coordinator.remember(self._key, value)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()
