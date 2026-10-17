"""按钮: 寻车 / 后备箱 / 车窗 / 遮阳帘 / 电池预热 / 刷新车况。"""

from __future__ import annotations

from homeassistant.components.button import ButtonEntity
from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.helpers.entity_platform import AddEntitiesCallback

from .const import BUTTONS, DOMAIN
from .coordinator import LeapmotorCoordinator
from .entity import LeapmotorEntity

# 车窗四档命令 → "命令后车窗应该是什么状态"(见 LeapmotorButton.async_press 的说明)
WINDOW_EXPECT = {
    "windows_open": True, "windows_vent": True, "windows_half": True, "windows_close": False,
}


async def async_setup_entry(hass: HomeAssistant, entry: ConfigEntry,
                            add: AddEntitiesCallback) -> None:
    c = hass.data[DOMAIN][entry.entry_id]
    add([LeapmotorButton(c, k, n, method) for k, n, method in BUTTONS])
    add([LeapmotorRefreshButton(c)])


class LeapmotorButton(LeapmotorEntity, ButtonEntity):
    def __init__(self, coordinator: LeapmotorCoordinator, key: str, name: str,
                 method: str) -> None:
        super().__init__(coordinator, key)
        self._attr_name = name
        self._method = method

    async def async_press(self) -> None:
        await self.coordinator.async_call(self._method)
        # 车窗四档: 命令受理 ≠ 界面立刻变 —— `windows_open` 来自车端信号(1693~1696),
        # 要等下一轮停车轮询(最多 ~60 秒)才会回报新状态; 这段时间里"关了窗还是提示未关"
        # (实机反馈)。命令成功后先按**预期**顶住(与锁/空调/开关同一套 override 机制:
        # 车端回报命令之后的新状态、且过了宽限期, 就自动失效、以车端为准)。
        expect = WINDOW_EXPECT.get(self._method)
        if expect is not None:
            self.coordinator.remember("windows", expect)
            self.coordinator.async_update_listeners()   # 立刻把新状态推给传感器与卡片


class LeapmotorRefreshButton(LeapmotorEntity, ButtonEntity):
    """立刻拉一次最新车况(电量/位置/胎压…), 不用等下一个轮询周期。"""

    _attr_name = "刷新车况"
    _attr_icon = "mdi:refresh"

    def __init__(self, coordinator: LeapmotorCoordinator) -> None:
        super().__init__(coordinator, "refresh_state")

    async def async_press(self) -> None:
        # 手动刷新 = 明确要"现在就去拿一遍": 强制重取驻车照片与里程/能耗(绕过节流)
        self.coordinator.force_photo_refresh()
        await self.coordinator.async_request_refresh()

