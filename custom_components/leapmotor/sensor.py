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

from .api import is_reev, reev_ranges
from .const import DOMAIN
from .coordinator import LeapmotorCoordinator, token_expiry
from .entity import LeapmotorEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    st0 = c.car_state
    _reev = is_reev(st0.signals if st0 is not None else {})
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
        # ── 增程车型的燃油数据(纯电车上这些信号缺失 → 不创建; 见 is_reev) ──
        *([LeapmotorFuelLevel(c), LeapmotorFuelRange(c), LeapmotorTotalRange(c),
           LeapmotorFuelConsumption(c)] if _reev else []),
        # ── 行程记录(自己采样; 云端没有逐条行程接口, 见 trips.py) ──
        LeapmotorLastTrip(c),
        LeapmotorTripTrack(c),
        LeapmotorTripStats(c),
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
            # 车窗开度 % —— CN 车端用 644/645/865/866(左前/左后/右前/右后);
            # EU 表里的 3727/3728/1879/1880 在 CN 车上是**后排座椅**, 别再混用。
            "windows_percent": {
                "left_front": st.get("window_percent_left_front"),
                "left_rear": st.get("window_percent_left_rear"),
                "right_front": st.get("window_percent_right_front"),
                "right_rear": st.get("window_percent_right_rear"),
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
        return "plugged" if st.charge_plugged else "unplugged"

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
    """驻车/底盘照片的 OSS 地址 + 照片新旧信息(upload_time / pending)。"""

    _attr_entity_category = EntityCategory.DIAGNOSTIC
    key = "parking_url"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "驻车照片地址")

    @property
    def native_value(self) -> str | None:
        return (self.coordinator.data or {}).get("parking_url") or None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        """照片的新旧信息: uploadTime(车端拍照/上传时刻)与 pending(还在等新照片)。

        用途: 一眼看出"这张照片是什么时候拍的、是不是还在等上传" —— 车端拍照是异步上传的,
        停车后可能需要几分钟才会换成新照片(见 coordinator 的照片重试窗口)。
        """
        d = self.coordinator.data or {}
        ms = d.get("photo_upload_ms") or 0
        return {
            "upload_time": (datetime.fromtimestamp(ms / 1000, tz=timezone.utc)
                            .astimezone().isoformat(timespec="seconds")) if ms else None,
            "pending": bool(d.get("photo_pending")),
        }


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
            # 诊断: 请求本身约 0.2 秒; 这里若常年几十秒, 说明在网络层等超时(见 PROTOCOL §3)
            "上一轮轮询耗时_秒": round(getattr(self.coordinator, "last_cycle_seconds", 0.0), 1),
            # 诊断: 这辆车的能力位/授权清单 —— 后排座椅(22/67/85/93)与增程的实体是否出现,
            # 就取决于它; 让别人远程排查时, 把这两个值报回来即可(见 docs/test-c16-reev.md)
            "能力位": list(getattr(self.coordinator.vehicle, "abilities", None) or []),
            "授权清单": list(getattr(self.coordinator.vehicle, "right_list", None) or []),
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


# ── 行程记录(见 trips.py) ──
def _trips(c: LeapmotorCoordinator):
    return getattr(c, "trips", None)


def _iso(ts: float | None) -> str | None:
    if not ts:
        return None
    return datetime.fromtimestamp(ts, tz=timezone.utc).astimezone().isoformat(timespec="seconds")


class LeapmotorLastTrip(_Base):
    """最近一次行程: 里程 / 时长 / 耗电 / 能耗。

    状态是**里程(km)**; 详情都在属性里。带 `reconstructed` 的表示"车端失联期间只靠
    总里程跳变补记的行程"(没有轨迹)。
    """

    key = "last_trip"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "最近行程")
        self._attr_native_unit_of_measurement = "km"
        self._attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> float | None:
        rec = _trips(self.coordinator)
        trip = rec.last_trip if rec else None
        return round(trip.distance_km, 2) if trip and trip.distance_km is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        rec = _trips(self.coordinator)
        trip = rec.last_trip if rec else None
        if trip is None:
            return {"备注": "还没有记录到行程"}
        return {
            "id": trip.id,
            "开始": _iso(trip.started_at),
            "结束": _iso(trip.ended_at),
            "时长_分钟": round(trip.duration_min, 1) if trip.duration_min else None,
            "里程_km": trip.distance_km,
            "里程口径": ("总里程差分(整数, 误差±1km)"
                        if getattr(trip, "distance_source", "") == "odo"
                        else "GPS 轨迹(采样稀疏时会偏小)"
                        if getattr(trip, "distance_source", "") == "gps" else None),
            "耗电_kwh": round(trip.energy_kwh, 2) if trip.energy_kwh else None,
            "百公里能耗_kwh": round(trip.efficiency, 1) if trip.efficiency else None,
            "平均速度_kmh": round(trip.avg_speed_kmh, 1) if trip.avg_speed_kmh else None,
            "起始电量_%": trip.start_soc,
            "结束电量_%": trip.end_soc,
            "起点": [trip.start_lat, trip.start_lon] if trip.start_lat else None,
            "终点": [trip.end_lat, trip.end_lon] if trip.end_lat else None,
            "轨迹点数": len(trip.points),
            "靠里程跳变补记": trip.reconstructed,
            "时间近似": trip.approx_time,          # 补记时: 时间只是"两次观测之间"
            "未观测区间_秒": trip.gap_seconds,
            "车端失联收尾": trip.frozen,
        }


class LeapmotorTripTrack(_Base):
    """最近一次行程的轨迹(抽稀到 ≤100 点, WGS-84)。

    给自带的地图卡画线用; **每段行程只更新一次**(行程结束时), 所以不会把 recorder 写爆。
    需要完整轨迹或多段历史 → 走 `leapmotor/trips/track` 命令(见 ws_api.py)。
    """

    key = "trip_track"
    _attr_icon = "mdi:map-marker-path"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "行程轨迹")
        self._attr_native_unit_of_measurement = "点"

    @property
    def _trip(self):
        rec = _trips(self.coordinator)
        return rec.last_trip if rec else None

    @property
    def native_value(self) -> int | None:
        trip = self._trip
        return len(trip.points) if trip and trip.points else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        from .trips import downsample
        trip = self._trip
        if trip is None or not trip.points:
            return {"trip_id": None, "points": []}
        return {
            "trip_id": trip.id,
            "coordinate_system": "WGS-84",
            "points": downsample(trip.points, 100),      # 属性要小: recorder 每次变化都会存一份
            "point_count_full": len(trip.points),
        }


class LeapmotorTripStats(_Base):
    """行程统计: 今日里程 + 今日/近7天/近30天 的次数·里程·耗电·能耗, 以及最近 10 段摘要。"""

    key = "trip_stats"
    _attr_icon = "mdi:car-traction-control"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "行程统计")
        self._attr_native_unit_of_measurement = "km"
        self._attr_state_class = SensorStateClass.MEASUREMENT

    @property
    def native_value(self) -> float | None:
        rec = _trips(self.coordinator)
        if rec is None:
            return None
        return rec.stats().get("today", {}).get("km")

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        rec = _trips(self.coordinator)
        if rec is None:
            return {}
        st = rec.stats()
        return {
            "今日": st.get("today"),
            "近7天": st.get("days7"),
            "近30天": st.get("days30"),
            "累计": st.get("total"),
            "补记段数": st.get("reconstructed"),
            "漏采记录数": st.get("gaps"),
            "最近行程": [
                {k: v for k, v in item.items() if k in (
                    "id", "started_at", "ended_at", "distance_km", "duration_min",
                    "energy_kwh", "efficiency", "reconstructed")}
                for item in rec.recent(10)
            ],
        }


# ── 增程(REEV)的燃油数据 ──
#   只在**车端确实在报燃油信号**的车上创建实体(见 api.is_reev):
#   纯电车没有这些信号, 自然就没有这几个实体, 不需要用户配置。
class LeapmotorFuelLevel(_Base):
    """剩余燃油(%): 车端信号 3235;升数在属性里(3263 的单位是**毫升**)。"""

    key = "fuel_level"
    _attr_icon = "mdi:gas-station"
    _attr_native_unit_of_measurement = "%"

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "剩余燃油")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return st.get("fuel_level") if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        ml = st.get("fuel_ml")
        return {
            "燃油量_L": round(ml / 1000.0, 2) if ml is not None else None,
            "燃油加热器档位": st.get("fuel_heater_level"),
            "说明": "3263 的单位是毫升(48L 油箱报 45382), 已换算成升",
        }


class LeapmotorFuelRange(_Base):
    """燃油续航(km): 按工况取(3262: 0=CLTC/1=WLTC), 见 api.reev_ranges。"""

    key = "fuel_range"
    _attr_icon = "mdi:gas-station-outline"
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "燃油续航")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return reev_ranges(st.signals)["fuel_km"] if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        return {"工况": reev_ranges(st.signals)["mode"]} if st else {}


class LeapmotorTotalRange(_Base):
    """(油电)总续航(km) —— 就是增程车 App 主页那个大数字。"""

    key = "total_range"
    _attr_icon = "mdi:map-marker-distance"
    _attr_native_unit_of_measurement = "km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "油电总续航")

    @property
    def native_value(self) -> float | None:
        st = self.coordinator.car_state
        return reev_ranges(st.signals)["total_km"] if st else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        r = reev_ranges(st.signals)
        return {"工况": r["mode"], "纯电续航_km": r["ev_km"], "燃油续航_km": r["fuel_km"],
                "说明": "总续航 = 纯电 + 燃油;两个数值由车端分别上报"}


class LeapmotorFuelConsumption(_Base):
    """油耗(L/100km)+ 电耗(属性): 来自云端接口 getPlugInLastNweeks100kmEC。"""

    key = "fuel_consumption"
    _attr_icon = "mdi:fuel"
    _attr_native_unit_of_measurement = "L/100km"
    _attr_state_class = SensorStateClass.MEASUREMENT

    def __init__(self, c: LeapmotorCoordinator) -> None:
        super().__init__(c, "油耗")

    @property
    def _ec(self) -> dict:
        d = (self.coordinator.data or {}).get("plug_energy") or {}
        ec = d.get("hundredKmEC") if isinstance(d, dict) else None
        return ec if isinstance(ec, dict) else {}

    @property
    def native_value(self) -> float | None:
        v = self._ec.get("oc100km")
        return float(v) if v is not None else None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        ec = self._ec
        return {"电耗_kwh_100km": ec.get("ec100km"),
                "说明": "增程车的电耗/油耗是分开上报的(App 里也是两张图)"}
