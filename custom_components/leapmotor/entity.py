"""实体基类。"""

from __future__ import annotations

from homeassistant.helpers.device_registry import DeviceInfo
from homeassistant.helpers.update_coordinator import CoordinatorEntity

from .const import DOMAIN
from .coordinator import LeapmotorCoordinator


class LeapmotorEntity(CoordinatorEntity[LeapmotorCoordinator]):
    """所有实体共用的设备信息与命名。

    ⚠️ 只挂**一个**设备(整车) —— 曾经按官方 App 的分区把"空调与舒适"拆成子设备,
    那会让设备页凭空多出一个条目, 已改回。实体之间的顺序见 const.PLATFORMS 与
    各平台的 add() 顺序(设备页按注册顺序显示)。
    """

    _attr_has_entity_name = True

    def __init__(self, coordinator: LeapmotorCoordinator, key: str) -> None:
        super().__init__(coordinator)
        self._attr_unique_id = f"{coordinator.vin}_{key}"
        # `translation_key` = 这个实体的**机器可读名字**(就是各平台传进来的 key, 全局唯一)。
        # 前端卡片不该靠 entity_id 拼字符串认实体(中文名/语言一变就失效) —— 用
        # "platform=leapmotor + 同一设备 + translation_key" 才是稳的, 我们的卡片就是这么找的。
        # 注意: 这里**不影响**实体显示名 —— 显式 `_attr_name` 优先于翻译, 中文名照旧。
        self._attr_translation_key = key

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
