"""开关类: 后备箱 / 遮阳帘 / 健康充电 / 方向盘加热 / 后视镜加热 / 预约充电。"""

from __future__ import annotations

import logging
from typing import Any

from homeassistant.components.switch import SwitchEntity
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
        # 后备箱 / 遮阳帘: 原来是"开/关"两个按钮, 现在各一个开关 —— 车端有真实状态位
        # (1281 / 1724), 所以不会出现"点了又弹回去"。
        # ⚠️ 哨兵模式**不在这里**: 指令码是 cmdId 400(取证见 api_client.sentry), 但权限码
        # 同为 400, 而零跑主账号侧**无法**把哨兵授权给子账号, 云端只会回 `code=40 无此权限`
        # —— 本集成强制子账号, 所以这个开关对本项目没有意义, 已移除(协议知识仍留在文档里)。
        LeapmotorSimpleSwitch(c, "trunk", "后备箱", method="trunk",
                              signals=("trunk_open",), icon="mdi:car-door"),
        LeapmotorSimpleSwitch(c, "sunshade", "遮阳帘", method="sunshade",
                              signals=("sunshade_percent",), icon="mdi:window-shutter"),
        LeapmotorSimpleSwitch(c, "steering_heat", "方向盘加热", method="steering_heat",
                              # ⚠️ 用 1816(开关位), **不能**用 1624 —— 后者实测常驻 15,
                              # 会让实体永远显示"开"(用户实测: App 里从未开过)
                              signals=("steering_wheel_heating",), icon="mdi:steering"),
        LeapmotorSimpleSwitch(c, "mirror_heat", "后视镜加热", method="mirror_heat",
                              signals=("mirror_heat_left", "mirror_heat_right"),
                              icon="mdi:car-side"),
        LeapmotorSimpleSwitch(c, "healthy_charge", "健康充电", method="healthy_charging",
                              signals=("healthy_charging",), icon="mdi:battery-heart-variant"),
        LeapmotorChargeScheduleSwitch(c),
    ])


class LeapmotorSimpleSwitch(LeapmotorEntity, SwitchEntity):
    """开关 → 客户端上的一个方法(on=True / off=False)。

    `signals` 是车况里能反映这个开关的信号名(见 api.SIGNAL_IDS):
    有实时值就用实时值, 没有才退回"假定状态"。后视镜加热左右任一开即视为开。

    ⚠️ 选信号时别用"剩余时间/档位"那类字段当开关 —— 方向盘加热踩过:
    原先用 `1624`(剩余分钟)判断, 而该信号在真车上常驻 15, 导致实体永远显示
    "开"(App 里其实从未开过), 关掉后下一轮又被拉回"开"。正确的是开关位 `1816`。
    
    """

    def __init__(self, coordinator: LeapmotorCoordinator, key: str, name: str,
                 method: str, signals: tuple[str, ...] = (), icon: str = "",
                 enabled_default: bool = True) -> None:
        super().__init__(coordinator, key)
        self._attr_name = name
        self._method = method
        self._signals = signals
        if icon:
            self._attr_icon = icon
        # 已知"云端受理但车端不执行"的指令默认隐藏, 免得变成"点了又弹回去"的坑
        self._attr_entity_registry_enabled_default = enabled_default

    @property
    def _real(self) -> bool | None:
        remembered = self.coordinator.recall(self._method)
        if remembered is not None:
            return bool(remembered)
        st = self.coordinator.car_state
        if st is None or not self._signals:
            return None
        for name in self._signals:
            v = st.get(name)
            if v is not None:
                return v > 0
        return None

    @property
    def is_on(self) -> bool | None:
        real = self._real
        return real if real is not None else self._attr_is_on

    @property
    def assumed_state(self) -> bool:
        return self._real is None

    async def async_turn_on(self, **kwargs: Any) -> None:
        await self.coordinator.async_call(self._method, on=True)
        self._attr_is_on = True
        self.coordinator.remember(self._method, True)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()

    async def async_turn_off(self, **kwargs: Any) -> None:
        await self.coordinator.async_call(self._method, on=False)
        self._attr_is_on = False
        self.coordinator.remember(self._method, False)
        self.async_write_ha_state()
        await self.coordinator.async_request_refresh()


class LeapmotorChargeScheduleSwitch(LeapmotorEntity, SwitchEntity):
    """预约充电开关(cmdId 190 的 chargeEnable, 其它字段沿用当前计划)。"""

    _attr_name = "预约充电"

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "charge_book")

    @property
    def is_on(self) -> bool | None:
        plan = (self.coordinator.data or {}).get("charge_plan") or {}
        if not plan:
            return None
        return str(plan.get("isEnable", "0")) == "1"

    async def async_turn_on(self, **kwargs: Any) -> None:
        resp = await self.coordinator.async_call("set_charge_plan", enable=1)
        if isinstance(resp, dict) and resp.get("code") == 0:
            self.coordinator.set_charge_plan_cache("isEnable", 1)
            await self.coordinator.async_request_refresh()
        self.async_write_ha_state()

    async def async_turn_off(self, **kwargs: Any) -> None:
        resp = await self.coordinator.async_call("set_charge_plan", enable=0)
        if isinstance(resp, dict) and resp.get("code") == 0:
            self.coordinator.set_charge_plan_cache("isEnable", 0)
            await self.coordinator.async_request_refresh()
        self.async_write_ha_state()
