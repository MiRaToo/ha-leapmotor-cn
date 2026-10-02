"""传感器: 车况(电量/续航/胎压/更新时间) + 里程能耗 + 诊断。"""

from __future__ import annotations

import json
from datetime import datetime, timezone
from typing import Any

from homeassistant.components.sensor import (
    SensorDeviceClass,
    SensorEntity,
    SensorStateClass,
)
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from homeassistant.const import (
    EntityCategory,
    UnitOfPressure,
    UnitOfTemperature,
)

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator, token_expiry
from .entity import LeapmotorEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([
        # ── 实时车况(电量/续航/充电/车辆状态/车内温度 → 胎压) ──
        LeapmotorBattery(c),
        LeapmotorRange(c),
        LeapmotorChargingState(c),
        LeapmotorVehicleState(c),
        LeapmotorStateUpdated(c),
        LeapmotorInteriorTemp(c),
        LeapmotorTire(c, "fl", "胎压-左前"),
        LeapmotorTire(c, "fr", "胎压-右前"),
        LeapmotorTire(c, "rl", "胎压-左后"),
        LeapmotorTire(c, "rr", "胎压-右后"),
        # ── 里程 / 能耗 ──
        LeapmotorTotalMileage(c),
        LeapmotorMileage7d(c),
        LeapmotorEnergy7d(c),
        LeapmotorHundredKmEc(c),
        LeapmotorEnergyRank(c),
        LeapmotorDeliveryDays(c),
        # ── 诊断 / 杂项(设备页里会归到"诊断"区) ──
        LeapmotorParkingUrl(c),
        LeapmotorChargeConfig(c),
        LeapmotorLastResult(c),
        LeapmotorSession(c),
    ])


class _Base(LeapmotorEntity, SensorEntity):
    key = "sensor"

    def __init__(self, coordinator: LeapmotorCoordinator, name: str) -> None:
        super().__init__(coordinator, self.key)
        self._attr_name = name


class LeapmotorBattery(_Base):
    """动力电池电量(%)。车端同时上报整数(1204)和带小数(100003)两个值, 取精确值。"""

    key = "battery"
    _attr_device_class = SensorDeviceClass.BATTERY
    _attr_state_class = SensorStateClass.MEASUREMENT
    _attr_native_unit_of_measurement = "%"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "电量")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return round(st.soc, 1) if st and st.soc is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "soc_raw": st.get("soc"),
            "battery_min_temp": st.get("battery_min_temp"),
            "battery_heating": st.flag("battery_heating"),
            "charging_voltage": st.get("charging_voltage"),
            "charging_current": st.get("charging_current"),
        }


class LeapmotorRange(_Base):
    """剩余续航(km)。优先车端直报值, 依次回落到实时值/综合续航。"""

    key = "range"
    _attr_device_class = SensorDeviceClass.DISTANCE
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "续航")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return st.range_km if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "cltc_range": st.get("range_cltc"),
            "live_range": st.get("range_live"),
            "combined_range": st.get("range_combined"),
            "fuel_range": st.get("range_fuel"),
            "fuel_level": st.get("fuel_level"),
        }


class LeapmotorTire(_Base):
    """单轮胎压(bar)。车端上报 kPa, 这里换算成 bar(2.5 那种读数)。"""

    _attr_device_class = SensorDeviceClass.PRESSURE
    _attr_native_unit_of_measurement = UnitOfPressure.BAR
    _attr_state_class = SensorStateClass.MEASUREMENT

    _ALARM = {"fl": "tire_alarm_fl", "fr": "tire_alarm_fr",
              "rl": "tire_alarm_rl", "rr": "tire_alarm_rr"}

    def __init__(self, c: LeapmotorCoordinator, corner: str, name: str) -> None:
        # key 决定 unique_id —— 四个轮子必须各有一个, 否则只会注册成功第一个
        self.key = f"tire_{corner}"
        super().__init__(c, name)
        self._corner = corner

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return st.tire_bar(self._corner) if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        raw = st.get(f"tire_{self._corner}")
        return {
            "kpa": raw,
            "alarm": st.get(self._ALARM[self._corner]),
        }


class LeapmotorStateUpdated(_Base):
    """车况的采集时间(服务端 collectTime)—— 判断数据是否"新鲜"。"""

    key = "state_updated"
    _attr_device_class = SensorDeviceClass.TIMESTAMP

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "状态更新时间")

    @property
    def native_value(self) -> datetime | None:
        st = self.coordinator.car_state
        if st is None or not st.collect_time:
            return None
        return datetime.fromtimestamp(st.collect_time / 1000, tz=timezone.utc)

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        attrs: dict[str, Any] = {}
        if st.get("signal_time"):
            attrs["signal_time"] = datetime.fromtimestamp(
                st.get("signal_time") / 1000, tz=timezone.utc).isoformat()
        return attrs


class LeapmotorVehicleState(_Base):
    """行驶状态(行驶中/已驻车)+ 档位、车速、门窗。"""

    key = "vehicle_state"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["driving", "parked"]

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "车辆状态")

    @property
    def native_value(self) -> str | None:
        st = self.coordinator.car_state
        return st.vehicle_state if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "speed": st.get("speed"),
            "gear": st.get("gear"),
            "parking_brake": st.flag("parking_brake"),
            "trunk_open": st.flag("trunk_open"),
            # 车窗: 本车用 1693~1696(0=关/2=开), EU 表里的百分比信号在本车恒为 0
            "windows_open": st.windows_open,
            "windows_state": {
                "1": st.get("window_state_1"),
                "2": st.get("window_state_2"),
                "3": st.get("window_state_3"),
                "4": st.get("window_state_4"),
            },
            "windows_percent_raw": {
                "front_left": st.get("window_front_left"),
                "front_right": st.get("window_front_right"),
                "rear_left": st.get("window_rear_left"),
                "rear_right": st.get("window_rear_right"),
            },
            "locked": st.locked,
            # 遮阳帘: 实测 1724 跟随指令 240(0=全关, 100=全开)
            "sunshade_open": st.sunshade_open,
            "sunshade_percent": st.get("sunshade_percent"),
        }


class LeapmotorChargingState(_Base):
    """充电状态(充电中/已插枪/未插枪)+ 剩余充电时间。"""

    key = "charging_state"
    _attr_device_class = SensorDeviceClass.ENUM
    _attr_options = ["charging", "plugged", "unplugged"]

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "充电状态")

    @property
    def native_value(self) -> str | None:
        st = self.coordinator.car_state
        if st is None:
            return None
        if st.charging is None:
            return None
        if st.charging:
            return "charging"
        conn = st.get("charge_connection")
        return "plugged" if conn is not None and int(conn) > 0 else "unplugged"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "remaining_minutes": st.get("remaining_charge_minutes"),
            "connection_code": st.get("charge_connection"),
            "dc_connected": st.flag("dc_cable_connected"),
            "healthy_charging": st.flag("healthy_charging"),
        }


class LeapmotorInteriorTemp(_Base):
    """车内温度(℃)。"""

    key = "interior_temp"
    _attr_device_class = SensorDeviceClass.TEMPERATURE
    _attr_native_unit_of_measurement = UnitOfTemperature.CELSIUS
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "车内温度")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return st.get("interior_temp") if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "climate_on": st.flag("climate_on"),
            "set_temp_left": st.get("climate_temp_left"),
            "set_temp_right": st.get("climate_temp_right"),
        }


class LeapmotorChargeConfig(_Base):
    """充电日程/上限等配置(config.3 这一段, 原样 JSON)。"""

    _attr_entity_category = EntityCategory.DIAGNOSTIC


    key = "charge_config"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "充电配置")

    @property
    def native_value(self) -> str | None:
        charge = (self.coordinator.data or {}).get("charge_plan")
        if not charge:
            return None
        return "已启用" if str(charge.get("isEnable")) == "1" else "未启用"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        return {"charge": (self.coordinator.data or {}).get("charge_plan") or {}}


class LeapmotorParkingUrl(_Base):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    """驻车/底盘照片的 OSS 地址。"""

    key = "parking_url"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "驻车照片地址")

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get("parking_url") or None


class LeapmotorTotalMileage(_Base):
    """总里程(km)+ 交付天数。"""

    key = "total_mileage"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "总里程")
        self._attr_native_unit_of_measurement = "km"
        self._attr_state_class = SensorStateClass.TOTAL_INCREASING

    @property
    def native_value(self) -> float | None:
        v = ((self.coordinator.data or {}).get("mileage") or {}).get("totalmileage")
        return float(v) if v is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        m = (self.coordinator.data or {}).get("mileage") or {}
        return {"deliveryDays": m.get("deliveryDays"), "raw": m}


class LeapmotorSession(_Base):
    """会话状态: 正常 / 需要重新登录 / 本轮刷新失败的原因(诊断用)。

    账号 token 实测只有约 6 小时, 过期后集成会走 HA 的「重新认证」——
    在 设置 → 设备与服务 里点一下、收一条短信即可, 不用删集成重装。
    """

    key = "session"
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    _attr_icon = "mdi:account-key"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "会话状态")

    @property
    def native_value(self) -> str:
        problem = (self.coordinator.data or {}).get("session_problem")             or self.coordinator.session_problem
        return problem[:255] if problem else "正常"

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        s = self.coordinator.session
        return {
            "账号会话到期(本地估算)": s.account_token_expires_at or None,
            "车端token到期": token_expiry(s.car_token) or None,
            # 车况这一路是否取到: 空值说明"车端信号没拉回来", 与账号会话无关
            "车况": (self.coordinator.data or {}).get("car_state_problem")
                    or self.coordinator.car_state_problem or "正常",
        }


class LeapmotorDeliveryDays(_Base):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    """交付天数。"""

    key = "delivery_days"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "交付天数")

    @property
    def native_value(self) -> int | None:
        v = ((self.coordinator.data or {}).get("mileage") or {}).get("deliveryDays")
        return int(v) if v is not None else None


class LeapmotorHundredKmEc(_Base):
    """最近百公里能耗(kWh/100km)+ 每周明细。"""

    key = "hundred_km_ec"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "百公里能耗")
        self._attr_native_unit_of_measurement = "kWh/100km"

    @property
    def native_value(self) -> float | None:
        v = (((self.coordinator.data or {}).get("energy") or {}).get("rankResult") or {}).get("hundredKmEC")
        return float(v) if v is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        e = (self.coordinator.data or {}).get("energy") or {}
        return {"weeklyEC": e.get("weeklyEC")}


class LeapmotorEnergyRank(_Base):
    """能耗排名。"""

    key = "energy_rank"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "能耗排名")

    @property
    def native_value(self) -> str | None:
        return (((self.coordinator.data or {}).get("energy") or {}).get("rankResult") or {}).get("rank")


class LeapmotorMileage7d(_Base):
    """近 7 天累计里程(km)+ 逐日明细(绘图用)。"""

    key = "mileage_7d"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "近7天里程")
        self._attr_native_unit_of_measurement = "km"

    @property
    def _range(self) -> dict[str, Any]:
        return ((self.coordinator.data or {}).get("mileage") or {}).get("mileage7") or {}

    @property
    def native_value(self) -> float | None:
        v = self._range.get("totalAccumulatedMileage")
        return float(v) if v is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        det = self._range.get("detail") or []
        return {
            "days": [x.get("day") for x in det],
            "daily_km": [x.get("accumulatedMileage") for x in det],
            "daily_kwh": [x.get("accumulatedEnergyConsume") for x in det],
            "odometer": [x.get("currentMileage") for x in det],
        }


class LeapmotorEnergy7d(_Base):
    """近 7 天累计能耗(kWh)。"""

    key = "energy_7d"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "近7天能耗")
        self._attr_native_unit_of_measurement = "kWh"

    @property
    def native_value(self) -> float | None:
        det = (((self.coordinator.data or {}).get("mileage") or {}).get("mileage7") or {}).get("detail") or []
        vals = [x.get("accumulatedEnergyConsume") or 0 for x in det]
        return float(sum(vals)) if vals else None


class LeapmotorLastResult(_Base):
    _attr_entity_category = EntityCategory.DIAGNOSTIC
    """最近一次指令的服务端回执(排查用)。"""

    key = "last_result"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "最近指令回执")

    @property
    def native_value(self) -> str | None:
        v = (self.coordinator.data or {}).get("last_result") or self.coordinator.last_result
        return v[:255] if v else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        v = (self.coordinator.data or {}).get("last_result") or ""
        try:
            return {"json": json.loads(v)}
        except Exception:  # noqa: BLE001
            return {}
