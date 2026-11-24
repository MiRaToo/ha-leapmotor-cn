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
from .account_runtime import (AUTH_FIELDS, AUTH_GENERATION_FIELD, account_key, context_key,
                              sync_new_auth)
from .amap import CONF_AMAP_KEY, validate_key
from .const import (
    CAR3D_BG_MODES,
    CONF_BATTERY_KWH,
    CONF_CAR3D_BG,
    CONF_CAR3D_COLOR,
    CONF_CAR3D_IMAGE,
    CONF_ENERGY_TYPE,
    CONF_SHORT_STOP_SECONDS,
    DEFAULT_CAR3D_BG,
    DEFAULT_ENERGY_TYPE,
    DEFAULT_SHORT_STOP_SECONDS,
    ENERGY_TYPES,
    MAX_SHORT_STOP_SECONDS,
    CONF_LAUNCH_BOOST,
    CONF_TRIP_STORE_MB,
    DEFAULT_BATTERY_KWH,
    DEFAULT_LAUNCH_BOOST,
    DEFAULT_TRIP_STORE_MB,
    MAX_BATTERY_KWH,
    MAX_TRIP_STORE_MB,
    MIN_BATTERY_KWH,
    MIN_TRIP_STORE_MB,
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

    VERSION = 4      # v2: 行程记录(采样 6s / 停车 60s / 提速 / 电池容量); v4: 可用容量 67.0

    def __init__(self) -> None:
        self._phone = ""
        self._session: dict[str, Any] = {}
        self._reauth_entry: config_entries.ConfigEntry | None = None
        self._vehicles: list[Any] = []

    # ── 第一步: 填手机号, 发验证码 ──
    async def async_step_user(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        accounts = self._existing_accounts()
        if user_input is not None:
            existing_id = str(user_input.get("existing_account") or "")
            if existing_id:
                entry = next((e for e in self.hass.config_entries.async_entries(DOMAIN)
                              if e.entry_id == existing_id), None)
                if entry is None:
                    errors["base"] = "account_unavailable"
                else:
                    self._phone = str(entry.data.get(CONF_PHONE) or "").strip()
                    self._session = {**entry.data}
                    sess = Session(**{k: v for k, v in entry.data.items()
                                      if k in Session.__dataclass_fields__})
                    client = LeapmotorClient(sess)
                    sess, client, self._vehicles = await self._saved_account_vehicles(
                        entry, sess, client)
                    self._session = asdict(sess)
                    if self._vehicles:
                        available = self._available_vehicles(self._vehicles)
                        if not available:
                            errors["base"] = "no_new_vehicle"
                        elif len(available) == 1:
                            return await self._create_selected_entry(sess, available[0])
                        else:
                            self._vehicles = available
                            return await self.async_step_vehicle()
                    elif not errors:
                        errors["base"] = "no_vehicle"
            elif user_input.get(CONF_PHONE):
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
            elif accounts:
                errors["base"] = "choose_account"
            else:
                errors["base"] = "phone_required"

        schema: dict[Any, Any] = {vol.Optional(CONF_PHONE): str}
        if accounts:
            schema[vol.Optional("existing_account")] = selector.SelectSelector(
                selector.SelectSelectorConfig(options=[
                    {"value": entry_id, "label": label}
                    for entry_id, label in accounts.items()
                ], mode=selector.SelectSelectorMode.DROPDOWN)
            )
        return self.async_show_form(
            step_id="user",
            data_schema=vol.Schema(schema),
            errors=errors,
            description_placeholders={"notice": "请使用【子账号】, 不要用主账号"},
        )

    async def _saved_account_vehicles(self, entry: config_entries.ConfigEntry,
                                      sess: Session, client: LeapmotorClient
                                      ) -> tuple[Session, LeapmotorClient, list[Any]]:
        """读取已有账号车辆；失效时复用免短信续期，并优先使用运行时最新快照。"""
        wanted = context_key(entry.data, entry.entry_id)
        coordinator = next((item for item in (self.hass.data.get(DOMAIN) or {}).values()
                            if getattr(item, "entry", None) is not None
                            and context_key(item.entry.data, item.entry.entry_id) == wanted), None)
        if coordinator is not None:
            sess, client = coordinator.session, coordinator.client
        try:
            vehicles = await self.hass.async_add_executor_job(client.get_vehicle_list)
        except Exception as err:  # noqa: BLE001
            log.warning("读取已有账号车辆列表失败: %s", type(err).__name__)
            vehicles = []
        if vehicles or not sess.refresh_token:
            return sess, client, vehicles

        try:
            if coordinator is not None:
                from .account_runtime import async_refresh_account
                refreshed = await async_refresh_account(coordinator, force=True)
            else:
                response = await self.hass.async_add_executor_job(client.refresh_account_token)
                refreshed = response.get("code") in (0, 200) and bool(sess.token)
            if refreshed:
                vehicles = await self.hass.async_add_executor_job(client.get_vehicle_list)
        except Exception as err:  # noqa: BLE001
            log.warning("已有账号免短信续期或车辆列表刷新失败: %s", type(err).__name__)
            vehicles = []
        return sess, client, vehicles

    def _existing_accounts(self) -> dict[str, str]:
        """一个账号/登录设备只显示一次，复用时不再请求短信或创建新设备。"""
        choices: dict[tuple[str, str], tuple[str, str]] = {}
        for entry in self.hass.config_entries.async_entries(DOMAIN):
            phone = str(entry.data.get(CONF_PHONE) or "").strip()
            if not phone:
                continue
            key = context_key(entry.data, entry.entry_id)
            if key in choices:
                continue
            label = self._account_label(phone, entry.data)
            choices[key] = (entry.entry_id, label)
        return {entry_id: label for entry_id, label in choices.values()}

    @staticmethod
    def _account_label(phone: str, data: dict[str, Any]) -> str:
        digits = "".join(ch for ch in phone if ch.isdigit())
        if digits.startswith("86") and len(digits) == 13:
            digits = digits[2:]
        masked = (digits[:3] + "****" + digits[-4:]) if len(digits) >= 7 else "已保存账号"
        return f"{masked} · {str(data.get('car_nickname') or data.get('car_type') or '零跑账号')}"

    def _available_vehicles(self, vehicles: list[Any]) -> list[Any]:
        configured = {
            str(entry.data.get("vin") or "").upper()
            for entry in self.hass.config_entries.async_entries(DOMAIN)
            if entry.data.get("vin")
        }
        seen: set[str] = set()
        result = []
        for vehicle in vehicles:
            vin = str(getattr(vehicle, "vin", "") or "").strip()
            canonical = vin.upper()
            if not vin or canonical in seen or canonical in configured:
                continue
            seen.add(canonical)
            result.append(vehicle)
        return result

    def _vehicle_schema(self) -> vol.Schema:
        def label(vehicle: Any) -> str:
            kind = {"owner": "自有车辆", "shared": "共享车辆"}.get(
                str(getattr(vehicle, "source", "unknown")), "车辆")
            name = getattr(vehicle, "nick_name", "") or getattr(vehicle, "car_type", "") or "零跑"
            return f"{name} · {kind} · {str(vehicle.vin)[-6:]}"

        return vol.Schema({vol.Required("vin"): selector.SelectSelector(
            selector.SelectSelectorConfig(options=[
                {"value": str(v.vin), "label": label(v)}
                for v in self._vehicles
            ], mode=selector.SelectSelectorMode.DROPDOWN)
        )})

    async def async_step_vehicle(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if not self._vehicles:
            return self.async_abort(reason="no_new_vehicle")
        if user_input is not None:
            vehicle = next((v for v in self._vehicles
                            if str(v.vin) == str(user_input.get("vin"))), None)
            if vehicle is None:
                errors["base"] = "vehicle_unavailable"
            else:
                if self._reauth_entry is not None:
                    errors["base"] = "reauth_vehicle_mismatch"
                else:
                    return await self._create_selected_entry(Session(**{
                        k: v for k, v in self._session.items()
                        if k in Session.__dataclass_fields__
                    }), vehicle)
        return self.async_show_form(
            step_id="vehicle", data_schema=self._vehicle_schema(), errors=errors,
        )

    async def _create_selected_entry(self, sess: Session, vehicle: Any) -> ConfigFlowResult:
        # PIN and its encoding are vehicle settings, not part of the shared login.
        # A newly added car starts with the existing safe defaults for its own options.
        sess.operate_pwd = ""
        sess.operate_pwd_mode = DEFAULT_PWD_MODE
        sess.car_vin = str(vehicle.vin)
        sess.car_type = str(vehicle.car_type or "")
        data = asdict(sess)
        data.update({CONF_PHONE: self._phone or str(sess.phone or ""),
                     "vin": str(vehicle.vin), "car_type": str(vehicle.car_type or ""),
                     "car_nickname": str(vehicle.nick_name or ""),
                     "vehicle_source": str(getattr(vehicle, "source", "unknown"))})
        await self.async_set_unique_id(f"{DOMAIN}_{vehicle.vin}")
        self._abort_if_unique_id_configured()
        # Existing-account vehicle additions may have obtained a newer auth
        # snapshot. Persist that whole generation to sibling entries before the
        # new entry becomes available to the runtime.
        data[AUTH_GENERATION_FIELD] = sync_new_auth(self.hass, data)
        return self.async_create_entry(
            title=f"零跑 {vehicle.car_type or ''} {str(vehicle.vin)[-6:]}".strip(),
            data=data,
        )

    async def async_step_code(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors: dict[str, str] = {}
        if user_input is not None and user_input.get("resend"):
            sess = Session(**self._session)
            client = LeapmotorClient(sess)
            try:
                resp = await self.hass.async_add_executor_job(client.request_sms_code, self._phone)
                if resp.get("code") != 200:
                    errors["base"] = ("sms_too_often" if resp.get("code") == SMS_TOO_OFTEN
                                      else "sms_failed")
                    log.warning("重发验证码返回: %s", str(resp)[:200])
            except Exception:  # noqa: BLE001
                log.exception("重发验证码失败")
                errors["base"] = "cannot_connect"
            user_input = None
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
                    errors["base"] = ("risk_cooldown" if r.get("code") == RISK_COOLDOWN
                                      else "invalid_auth")
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
                    self._vehicles = await self.hass.async_add_executor_job(client.get_vehicle_list)
                except Exception:  # noqa: BLE001
                    self._vehicles = []
                if not self._vehicles:
                    errors["base"] = "no_vehicle"
                elif self._reauth_entry is not None:
                    old_vin = str(self._reauth_entry.data.get("vin") or "")
                    vehicle = next((v for v in self._vehicles if str(v.vin) == old_vin), None)
                    if vehicle is None:
                        errors["base"] = "reauth_vehicle_missing"
                    elif account_key(self._reauth_entry.data.get(CONF_PHONE)) != account_key(self._phone):
                        errors["base"] = "reauth_account_mismatch"
                    else:
                        data = dict(self._reauth_entry.data)
                        fresh = asdict(sess)
                        data.update({name: fresh[name] for name in AUTH_FIELDS if name in fresh})
                        data.update({"vin": old_vin, "car_vin": old_vin,
                                     "car_type": vehicle.car_type or data.get("car_type", ""),
                                     "car_nickname": vehicle.nick_name or data.get("car_nickname", ""),
                                     "vehicle_source": getattr(vehicle, "source", "unknown")})
                        data[AUTH_GENERATION_FIELD] = sync_new_auth(
                            self.hass, data,
                            excluded_entry_id=self._reauth_entry.entry_id)
                        log.info("重新认证成功, 更新原 VIN 条目及同会话车辆")
                        return self.async_update_reload_and_abort(
                            self._reauth_entry,
                            data_updates={k: data[k] for k in (*AUTH_FIELDS, AUTH_GENERATION_FIELD,
                                      "vin", "car_vin", "car_type", "car_nickname",
                                      "vehicle_source") if k in data},
                        )
                else:
                    available = self._available_vehicles(self._vehicles)
                    if not available:
                        errors["base"] = "already_configured"
                    elif len(available) == 1:
                        return await self._create_selected_entry(sess, available[0])
                    else:
                        self._session = asdict(sess)
                        self._phone = self._phone
                        self._vehicles = available
                        return await self.async_step_vehicle()

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


# HA 有 `OptionsFlowWithReload`(保存后由 HA 自动重载条目)时优先用它; 老版本没有
# 这个基类 —— 退回普通 OptionsFlow 并在保存后手动调度一次重载(见 async_step_init)。
_OptionsFlowBase = getattr(config_entries, "OptionsFlowWithReload", config_entries.OptionsFlow)


class LeapmotorOptionsFlow(_OptionsFlowBase):
    """选项: 操作密码 + 轮询间隔。

    设计约束(重载风暴的教训, 改动前先读):
      * 集成里**不得**再注册 update listener —— 它在任何条目变化(含集成自己落盘
        token 的 data 变化)时都会触发, 会造成每天几十次整批实体 unavailable;
      * 选项变更后的重载由 `OptionsFlowWithReload` 负责(HA 源码里与 update listener
        明确互斥); 老版本 HA 退回手动调度(见 async_step_init);
      * 重新认证的重载由它自己的流程调度(见 reauth 分支的 async_update_reload_and_abort)。
    """

    def __init__(self, entry: config_entries.ConfigEntry) -> None:
        self._entry = entry

    async def _usage_text(self) -> str:
        """配置页里显示的"当前占用"(取不到就留空 —— 不影响打开配置)。"""
        try:
            coord = (self.hass.data.get(DOMAIN) or {}).get(self._entry.entry_id)
            rec = getattr(coord, "trips", None)
            if rec is None:
                return ""
            usage = await rec.async_store_usage()
            text = (f"轨迹 {usage['tracks_mb']} MB + 摘要 {usage['index_mb']} MB"
                    f",共 {usage['months']} 个月")
            limit = usage.get("limit_mb") or 0
            return text + (f"(上限 {limit:.0f} MB)" if limit else "(当前不限空间)")
        except Exception:  # noqa: BLE001 — 显示用途, 任何异常都不该拦住配置页
            log.debug("行程占用统计不可用", exc_info=True)
            return ""

    async def async_step_init(self, user_input: dict[str, Any] | None = None) -> ConfigFlowResult:
        errors = {}
        if user_input is not None:
            try:
                user_input = {**user_input, CONF_AMAP_KEY: validate_key(user_input.get(CONF_AMAP_KEY))}
            except ValueError:
                errors[CONF_AMAP_KEY] = "invalid_amap_key"
                user_input = None
        if user_input is not None:
            result = self.async_create_entry(title="", data=user_input)
            if _OptionsFlowBase is config_entries.OptionsFlow:
                # 老版本 HA: 没有自动重载的基类, 这里补一次。
                # (选项本身每轮都被热读, 重载只是让实体/卡片立刻换到新设置。)
                self.hass.config_entries.async_schedule_reload(self._entry.entry_id)
            return result
        opts = self._entry.options
        return self.async_show_form(
            step_id="init",
            errors=errors,
            description_placeholders={"usage": await self._usage_text()},
            data_schema=vol.Schema({
                vol.Optional(CONF_AMAP_KEY, default=opts.get(CONF_AMAP_KEY, "")): selector.TextSelector(
                    selector.TextSelectorConfig(type=selector.TextSelectorType.PASSWORD)
                ),
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
                        min=MIN_POLL_SECONDS, max=3600, step=10,
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
                # 短停快档: 一趟行程结束后, 继续按"行程采样间隔"轮询这么久 ——
                # 便于抓住"下车买个东西/接人, 很快又出发"这种短停再出发(0 = 关闭)。
                vol.Optional(
                    CONF_SHORT_STOP_SECONDS,
                    default=opts.get(CONF_SHORT_STOP_SECONDS, DEFAULT_SHORT_STOP_SECONDS),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=0, max=MAX_SHORT_STOP_SECONDS, step=60,
                        mode=selector.NumberSelectorMode.BOX,
                        unit_of_measurement="秒",
                    )
                ),
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
                # 轨迹存储上限: 只约束"轨迹"(按月分片), 行程摘要是纯文本账本、永久保留;
                # 超出后从最老的月份整月清理(当月不清理)。0 = 不限制。
                vol.Optional(
                    CONF_TRIP_STORE_MB,
                    default=opts.get(CONF_TRIP_STORE_MB, DEFAULT_TRIP_STORE_MB),
                ): selector.NumberSelector(
                    selector.NumberSelectorConfig(
                        min=MIN_TRIP_STORE_MB, max=MAX_TRIP_STORE_MB, step=10,
                        mode=selector.NumberSelectorMode.BOX,
                        unit_of_measurement="MB",
                    )
                ),
                # ── 能源类型: 决定要不要建"剩余燃油/燃油续航/油电总续航/油耗"这几个实体 ──
                # auto = 按车端信号自动判定(燃油在给里程做贡献才按增程, 见 api.is_reev);
                # 实测有纯电车会报一个假的"油量"(无油箱) —— 这类车手动选"纯电"即可,
                # 增程车若被判成纯电(信号缺失)也可手动选"增程"。
                vol.Optional(
                    CONF_ENERGY_TYPE,
                    default=opts.get(CONF_ENERGY_TYPE, DEFAULT_ENERGY_TYPE),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=ENERGY_TYPES, mode=selector.SelectSelectorMode.DROPDOWN,
                        translation_key="energy_type",
                    )
                ),
                # ── 3D 车模(控制卡片的车辆区) ──
                # 车漆: 留空 = 跟云端实车色; 填车型色表里的色名(如"漫宇蓝")或
                # #RRGGBB 自定义色。素材按 VIN 懒装配(见 car3d.py), 选项只影响显示。
                vol.Optional(CONF_CAR3D_COLOR,
                             default=opts.get(CONF_CAR3D_COLOR, "")): str,
                vol.Optional(
                    CONF_CAR3D_BG,
                    default=opts.get(CONF_CAR3D_BG, DEFAULT_CAR3D_BG),
                ): selector.SelectSelector(
                    selector.SelectSelectorConfig(
                        options=CAR3D_BG_MODES, mode=selector.SelectSelectorMode.DROPDOWN,
                        translation_key="car3d_bg",
                    )
                ),
                # 自定义外观图: 填了就不用 3D(卡片直接显示这张图), 留空 = 用 3D 车模
                vol.Optional(CONF_CAR3D_IMAGE,
                             default=opts.get(CONF_CAR3D_IMAGE, "")): str,
            }),
        )
