"""实体基类。"""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator


class LeapmotorEntity(CoordinatorEntity[LeapmotorCoordinator]):
    """所有实体共用的设备信息与命名。

    ⚠️ 只挂**一个**设备(整车) —— 曾经按官方 App 的分区把"空调与舒适"拆成子设备,
    用户反馈"怎么变成两个设备了", 已改回。实体之间的顺序见 const.PLATFORMS 与
    各平台的 add() 顺序(设备页按注册顺序显示)。
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: LeapmotorCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.vin}_{key}"

    @property
    def device_info(self) -> DeviceInfo:
        v = self.coordinator.vehicle
        return DeviceInfo(
            identifiers={(DOMAIN, self.coordinator.vin)},
            manufacturer="Leapmotor",
            name=f"零跑 {v.car_type if v else ''} {self.coordinator.vin[-6:]}".strip(),
            model=(v.car_type if v else None),
            serial_number=self.coordinator.vin,
            configuration_url="https://github.com/MiRaToo/ha-leapmotor-cn",
        )
