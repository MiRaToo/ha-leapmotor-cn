"""配置流程: 手机号 + 短信验证码 → 车端交换 → 建立集成。

全程在 HA 的「设备与服务」里完成, 不需要 MQTT、不需要附加组件。
"""

from __future__ import annotations

import logging
from dataclasses import asdict
from typing import Any

import voluptuous as vol

from homeassistant import config_entries
from homeassistant.helpers import selector
from homeassistant.core import HomeAssistant
from homeassistant.config_entries import ConfigFlowResult

from .api import LeapmotorClient, Session, new_device_id
from .const import (
    CONF_BATTERY_KWH,
    CONF_LAUNCH_BOOST,
    DEFAULT_BATTERY_KWH,
    DEFAULT_LAUNCH_BOOST,
    MAX_BATTERY_KWH,
    MIN_BATTERY_KWH,
    CONF_DRIVING_POLL_SECONDS,
    DEFAULT_DRIVING_POLL_SECONDS,
    MIN_DRIVING_POLL_SECONDS,
    CONF_OPERATE_PWD,
    CONF_OPERATE_PWD_MODE,
    DEFAULT_PWD_MODE,
    PWD_MODES,
    CONF_PHONE,
    CONF_POLL_SECONDS,
    CONF_SMS_CODE,
    DEFAULT_POLL_SECONDS,
    DOMAIN,
    MIN_POLL_SECONDS,
)

log = logging.getLogger(__name__)

RISK_COOLDOWN = 1023      # 环境疑似高风险(冷却中)
SMS_TOO_OFTEN = 36        # 验证码发送频繁


class LeapmotorConfigFlow(config_entries.ConfigFlow, domain=DOMAIN):
    """手机号 + 验证码登录 → 换取车端 token → 建条目。"""

    VERSION = 2      # v2: 行程记录(采样 6s / 停车 60s / 提速 / 电池容量)

    def __init__(self) -> None:
        self._phone = ""
        self._session: dict[str, Any] = {}
        self._reauth_entry: config_entries.ConfigEntry | None = None

    # ── 第一步: 填手机号, 发验证码 ──
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None:
            phone = str(user_input[CONF_PHONE]).strip()
            sess = Session()
            sess.device_id = new_device_id()
            client = LeapmotorClient(sess)
            try:
                resp = await self.hass.async_add_executor_job(client.request_sms_code, phone)
            except Exception as err:  # noqa: BLE001
                log.exception("发送验证码失败")
                errors["base"] = "cannot_connect"
                resp = {"code": -1, "message": str(err)}
            code = resp.get("code")
            if code == 200:
                self._phone = phone
                self._session = asdict(sess)
                return await self.async_step_code()
            if code == RISK_COOLDOWN:
                errors["base"] = "risk_cooldown"
            elif code == SMS_TOO_OFTEN:
                errors["base"] = "sms_too_often"
            elif not errors:
                errors["base"] = "sms_failed"
                log.warning("发送验证码返回: %s", str(resp)[:200])

        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_PHONE): str}),
            errors=errors,
            description_placeholders={"notice": "请使用【子账号】, 不要用主账号"},
        )

    # ── 第二步: 填验证码, 完成登录 ──
    async def async_step_code(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None and user_input.get("resend"):
            # 勾了「重新发送验证码」: 只重发, 不校验(验证码只有 5 分钟有效,
            # 超时后不必退出流程重来 —— 这一步就是给用户原地重发的)
            sess = Session(**self._session)
            client = LeapmotorClient(sess)
            try:
                resp = await self.hass.async_add_executor_job(
                    client.request_sms_code, self._phone)
                if resp.get("code") != 200:
                    errors["base"] = ("sms_too_often" if resp.get("code") == SMS_TOO_OFTEN
                                      else "sms_failed")
                    log.warning("重发验证码返回: %s", str(resp)[:200])
            except Exception:  # noqa: BLE001
                log.exception("重发验证码失败")
                errors["base"] = "cannot_connect"
            user_input = None            # 落回"再显示一次表单"
        if user_input is not None:
            code = str(user_input[CONF_SMS_CODE]).strip()
            sess = Session(**self._session)
            client = LeapmotorClient(sess)
            try:
                r = await self.hass.async_add_executor_job(client.login, self._phone, code)
            except Exception:  # noqa: BLE001
                log.exception("登录失败")
                errors["base"] = "cannot_connect"
                r = {}
            if not errors:
                if r.get("code") != 200 or not sess.token:
                    errors["base"] = (
                        "risk_cooldown" if r.get("code") == RISK_COOLDOWN else "invalid_auth"
                    )
                    log.warning("登录返回: %s", str(r)[:200])
                else:
                    try:
                        r2 = await self.hass.async_add_executor_job(client.car_login)
                    except Exception:  # noqa: BLE001
                        log.exception("车端交换失败")
                        errors["base"] = "cannot_connect"
                        r2 = {}
                    if not errors and not (sess.car_token and sess.sign_param):
                        errors["base"] = "car_login_failed"
                        log.warning("车端交换返回: %s", str(r2)[:200])
            if not errors:
                sess.seal_key()
                try:
                    vehicles = await self.hass.async_add_executor_job(client.get_vehicle_list)
                except Exception:  # noqa: BLE001
                    vehicles = []
                if not vehicles:
                    errors["base"] = "no_vehicle"
                else:
                    v = vehicles[0]
                    data = asdict(sess)
                    data[CONF_PHONE] = self._phone
                    data["vin"] = v.vin
                    data["car_type"] = v.car_type or data.get("car_type", "")
                    data["car_nickname"] = v.nick_name
                    if self._reauth_entry is not None:
                        # 重新认证: 把新会话写回原条目并重载(不要新建条目)
                        log.info("重新认证成功, 更新原条目")
                        return self.async_update_reload_and_abort(
                            self._reauth_entry, data=data)
                    await self.async_set_unique_id(f"{DOMAIN}_{v.vin}")
                    self._abort_if_unique_id_configured()
                    return self.async_create_entry(
                        title=f"零跑 {v.car_type or ''} {v.vin[-6:]}".strip(),
                        data=data,
                    )

        return self.async_show_form(
            step_id="code",
            data_schema=vol.Schema({
                vol.Required(CONF_SMS_CODE): str,
                vol.Optional("resend", default=False): bool,
            }),
            errors=errors,
            description_placeholders={"phone": self._phone},
        )

    # ── 重新认证: 账号 token(约 6 小时)过期后, HA 会弹出「重新认证」 ──
    async def async_step_reauth(self, entry_data: dict[str, Any]) -> ConfigFlowResult:
        """重新登录: 手机号已知, 直接发验证码, 用户只填 6 位数字即可。

        deviceId 沿用原条目的 —— 账号 token 与设备绑定, 换 id 等于换设备,
        容易在服务端留下多余会话。
        """
        self._reauth_entry = self._get_reauth_entry()
        self._phone = str(entry_data.get(CONF_PHONE) or
                          self._reauth_entry.data.get(CONF_PHONE) or "")
        sess = Session()
        sess.device_id = str(self._reauth_entry.data.get("device_id") or new_device_id())
        sess.version = str(self._reauth_entry.data.get("version") or sess.version)
        sess.sub_version = str(self._reauth_entry.data.get("sub_version") or sess.sub_version)
        self._session = asdict(sess)
        try:
            client = LeapmotorClient(sess)
            resp = await self.hass.async_add_executor_job(client.request_sms_code, self._phone)
            if resp.get("code") == 200:
                return await self.async_step_code()
            log.warning("重新认证发送验证码返回: %s", str(resp)[:200])
            err = "risk_cooldown" if resp.get("code") == RISK_COOLDOWN else "sms_failed"
        except Exception:  # noqa: BLE001
            log.exception("重新认证发送验证码失败")
            err = "cannot_connect"
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema({vol.Required(CONF_PHONE): str}),
            errors={"base": err},
            description_placeholders={"notice": "请使用【子账号】, 不要用主账号"},
        )

    @staticmethod
    def async_get_options_flow(entry: config_entries.ConfigEntry) -> "LeapmotorOptionsFlow":
        return LeapmotorOptionsFlow(entry)


class LeapmotorOptionsFlow(config_entries.OptionsFlow):
    """选项: 操作密码 + 轮询间隔。"""

    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self._entry = entry

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        if user_input is not None:
            return self.async_create_entry(title="", data=user_input)
        opts = self._entry.options
        return self.async_show_form(
            step_id="init",
            data_schema=vol.Schema({
                # 车辆操作密码(4 位数字) —— 掩码输入, 解锁等敏感指令需要
                vol.Optional(
                    CONF_OPERATE_PWD, default=opts.get(CONF_OPERATE_PWD, "")
                ): selector.TextSelector(
                    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                ),
                vol.Optional(
                    CONF_OPERATE_PWD_MODE,
                    default=opts.get(CONF_OPERATE_PWD_MODE, DEFAULT_PWD_MODE),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=PWD_MODES, mode=selector.SelectSelectorMode.DROPDOWN,
                        translation_key="operate_pwd_mode",
                    )
                ),
                vol.Optional(
                    CONF_POLL_SECONDS,
                    default=opts.get(CONF_POLL_SECONDS, DEFAULT_POLL_SECONDS),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=MIN_POLL_SECONDS, max=3600, step=30,
                        mode=selector.NumberSelectorMode.BOX,
                        unit_of_measurement="秒",
                    )
                ),
                # 行程采样间隔: 行驶中的车况轮询(也是行程轨迹点的时间分辨率)。
                # 官方 App 前台对同一个接口就是 6 秒一次, 所以默认 6s; 调大可省请求。
                vol.Optional(
                    CONF_DRIVING_POLL_SECONDS,
                    default=opts.get(CONF_DRIVING_POLL_SECONDS, DEFAULT_DRIVING_POLL_SECONDS),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=MIN_DRIVING_POLL_SECONDS, max=300, step=1,
                        mode=selector.NumberSelectorMode.BOX,
                        unit_of_measurement="秒",
                    )
                ),
                vol.Optional(
                    CONF_LAUNCH_BOOST,
                    default=opts.get(CONF_LAUNCH_BOOST, DEFAULT_LAUNCH_BOOST),
                ): selector.BooleanSelector(),
                # 电池可用容量: 只用于把 ΔSOC 折算成 kWh(行程耗电/能耗)
                vol.Optional(
                    CONF_BATTERY_KWH,
                    default=opts.get(CONF_BATTERY_KWH, DEFAULT_BATTERY_KWH),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=MIN_BATTERY_KWH, max=MAX_BATTERY_KWH, step=0.1,
                        mode=selector.NumberSelectorMode.BOX,
                        unit_of_measurement="kWh",
                    )
                ),
            }),
        )
