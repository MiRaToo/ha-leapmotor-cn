"""车辆定位: 把车况里的经纬度喂给 HA 地图与「区域(zone)」。

数据来自 `signal/info/query` 的 signalMap:

    纬度 = 信号 3 (带符号) → 3725 → 2190
    经度 = 信号 2 (带符号) → 3724 → 2191

车端同时上报"带符号"和"仅绝对值"两套坐标 —— EU 版踩过的坑是绝对值那套
在南/西半球会丢负号(kerniger/leapmotor-ha 的 location.py),所以这里优先用
带符号的 2/3, 只有它缺失时才回落到绝对值版本。

★ 坐标系: 车端给的是 **GCJ-02**(火星坐标), 本实体**对外发布 WGS-84** ——
   这样用户才能直接在 HA 地图上拖一个圆当围栏(HA 的区域判断用的是标准坐标),
   也能和手机定位、其它设备对齐。原始 GCJ-02 放在属性 `latitude_gcj/longitude_gcj`。
   自带的高德地图卡会再换算回 GCJ-02 显示(否则车标会偏 300~500 米)。
"""

from __future__ import annotations

from typing import Any

from homeassistant.components.device_tracker import SourceType, TrackerEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    add([LeapmotorTracker(hass.data[DOMAIN][entry.entry_id])])


class LeapmotorTracker(LeapmotorEntity, TrackerEntity):
    """车辆位置(GPS)。"""

    _attr_name = "车辆位置"
    _attr_source_type = SourceType.GPS
    _attr_icon = "mdi:car-connected"

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "tracker")

    @property
    def latitude(self) -> float | None:
        """纬度(WGS-84, 见模块说明)。"""
        st = self.coordinator.car_state
        return st.latitude_wgs if st else None

    @property
    def longitude(self) -> float | None:
        """经度(WGS-84, 见模块说明)。"""
        st = self.coordinator.car_state
        return st.longitude_wgs if st else None

    @property
    def available(self) -> bool:
        return self.coordinator.car_state is not None and self.latitude is not None

    @property
    def extra_state_attributes(self) -> dict[str, Any]:
        st = self.coordinator.car_state
        if st is None:
            return {}
        return {
            "odometer": st.get("odometer"),
            "speed": st.get("speed"),
            "vehicle_state": st.vehicle_state,
            # 本实体发布的是 WGS-84; 车端原始值(GCJ-02)与备用信号一并给出, 便于排查
            "coordinate_system": "WGS-84",
            "latitude_gcj": st.latitude,
            "longitude_gcj": st.longitude,
            "raw_latitude": st.raw.get("3"),
            "raw_longitude": st.raw.get("2"),
            "alt_latitude": st.raw.get("3725"),
            "alt_longitude": st.raw.get("3724"),
        }
