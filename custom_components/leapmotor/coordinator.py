"""数据协调器: 轮询车辆信息, 并在 token 快过期时自动续期。"""

from __future__ import annotations

import base64
import functools
import json
import logging
import time
from dataclasses import asdict
from typing import Any

from homeassistant.config_entries import ConfigEntry
from homeassistant.core import HomeAssistant
from homeassistant.exceptions import ConfigEntryAuthFailed, HomeAssistantError
from homeassistant.helpers.update_coordinator import DataUpdateCoordinator, UpdateFailed

from .api import (
    CarState,
    EP_VEHICLE_LIST,
    command_failed,
    is_auth_error,
    is_signature_error,
    LeapmotorClient,
    pick_poll_seconds,
    Session,
    StateOverrides,
    Vehicle,
)
from .const import (
    CONF_DRIVING_POLL_SECONDS,
    DEFAULT_DRIVING_POLL_SECONDS,
    MIN_DRIVING_POLL_SECONDS,
    CONF_OPERATE_PWD,
    CONF_OPERATE_PWD_MODE,
    DEFAULT_PWD_MODE,
    CONF_POLL_SECONDS,
    DEFAULT_POLL_SECONDS,
    DOMAIN,
    RENEW_SKEW_SECONDS,
)

# 账号 token 续期窗口: 到期前 30 分钟就用 refreshToken 免短信续一次(实测可用)
ACCOUNT_RENEW_SKEW_SECONDS = 1800

log = logging.getLogger(__name__)


def token_expiry(token: str) -> int:
    """解出 JWT 的 exp(秒);解不出返回 0。"""
    try:
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return int(json.loads(base64.urlsafe_b64decode(p)).get("exp") or 0)
    except Exception:  # noqa: BLE001
        return 0


class LeapmotorCoordinator(DataUpdateCoordinator[dict[str, Any]]):
    """一个 coordinator 管一辆车(当前只支持账号下第一辆)。"""

    def __init__(self, hass: HomeAssistant, entry: ConfigEntry) -> None:
        self.entry = entry
        self.session = Session(**{
            k: v for k, v in entry.data.items() if k in Session.__dataclass_fields__
        })
        self.session.seal_key()          # 老条目也能补出密钥
        self._apply_options()
        self.client = LeapmotorClient(self.session)
        self.vin: str = entry.data.get("vin") or self.session.car_vin
        self.vehicle: Vehicle | None = None
        self.parking_url: str = ""
        self.state: CarState | None = None      # 最近一帧车况(见 api.CarState)
        self.last_result: str = ""
        # 会话/轮询出的问题(空 = 正常)。账号 token 只有约 6 小时, 过期后需要重新认证
        self.session_problem: str = ""
        # 车况这一路的问题(空 = 正常)。它和会话是两回事: token 有效也可能拉不到车况
        self.car_state_problem: str = ""
        self._last_renew = 0.0
        self._expiry_warned = False             # 只提醒一次(重新登录后复位)
        self._last_heavy = 0.0                  # 上次拉"不常变"数据(配置/里程/能耗/照片)的时刻
        # 命令后的临时状态: 车端上报新 collectTime 前, 实体以本地值为准
        self.overrides = StateOverrides()
        self._last_resp: dict | None = None     # 出问题那一次的原始响应(判会话失效)

        poll = int(entry.options.get(CONF_POLL_SECONDS) or DEFAULT_POLL_SECONDS)
        super().__init__(
            hass, log, name=f"{DOMAIN} {self.vin}", update_interval=timedelta_seconds(poll)
        )

    def _apply_options(self) -> None:
        self.session.operate_pwd = str(self.entry.options.get(CONF_OPERATE_PWD) or "")
        self.session.operate_pwd_mode = str(
            self.entry.options.get(CONF_OPERATE_PWD_MODE) or DEFAULT_PWD_MODE
        )

    # ── 数据刷新 ──
    async def _async_update_data(self) -> dict[str, Any]:
        """一轮轮询。分三种结局:

        * 正常 → 返回新数据
        * **服务端说会话失效** → 抛 `ConfigEntryAuthFailed`, HA 会弹出「重新认证」
          (用户只需再收一次短信验证码, 不用删集成重装)
        * 其它失败(网络抖动/接口临时 5xx) → **保留上一份数据**, 只把原因记在
          `session_problem` 里 —— 实体不该因为一次轮询失败就全部变 unavailable
        """
        self._apply_options()
        try:
            return await self._collect()
        except ConfigEntryAuthFailed:
            raise
        except Exception as err:  # noqa: BLE001
            if is_auth_error(getattr(self, "_last_resp", None)):
                self.session_problem = "账号会话已过期, 需要重新登录(发送短信验证码即可)"
                raise ConfigEntryAuthFailed(self.session_problem) from err
            self.session_problem = f"本轮刷新失败: {str(err)[:160]}"
            if self.data:
                log.warning("轮询失败, 沿用上一份数据: %s", err)
                return {**self.data, "session_problem": self.session_problem}
            raise UpdateFailed(str(err)) from err

    async def _collect(self, account_retried: bool = False) -> dict[str, Any]:
        self._last_resp = None
        if await self.hass.async_add_executor_job(self._renew_if_needed):
            self._persist()          # 必须在事件循环线程里写
        # 车辆信息(VIN/授权指令/能力)是**静态的**, 存一次就够 —— 没必要每轮都去拉,
        # 而拉列表用的是账号 token(6 小时就过期)。少依赖它 = 会话过期后还能多干活。
        if self.vehicle is not None:
            await self._refresh_car_data()
            return self._build_result()
        try:
            vehicles = await self.hass.async_add_executor_job(self.client.get_vehicle_list)
        except Exception as err:  # noqa: BLE001
            # 车端 token 赶在续期节流窗口里过期 → 立刻强制续期一次再重试, 避免"失明"十几分钟
            expired = token_expiry(self.session.car_token) < time.time() + 60
            if expired:
                log.warning("车端 token 已过期, 立即强制续期(跳过节流)")
                self._last_renew = 0.0
                if await self.hass.async_add_executor_job(self._renew_if_needed):
                    self._persist()
                    vehicles = await self.hass.async_add_executor_job(self.client.get_vehicle_list)
                else:
                    raise
            else:
                raise
        for v in vehicles:
            if not self.vin or v.vin == self.vin:
                self.vehicle = v
                break
        if self.vehicle is None and vehicles:
            self.vehicle = vehicles[0]
            self.vin = self.vehicle.vin
        if self.vehicle is None:
            # 列表为空时**回原接口看一次原因** —— 账号会话失效就是在这里暴露的
            # (get_vehicle_list 只返回列表, 把错误码吞掉了)
            raw = await self.hass.async_add_executor_job(
                self.client.global_call, EP_VEHICLE_LIST)
            self._last_resp = raw
            if is_auth_error(raw):
                # ★ 账号 token 过期**不再等于必须短信重登**: 先用 refreshToken 免短信续期
                #   (2026-09-27 实测 `getnewtoken` code=200; 哪怕 token 已过期也能救回)
                if not account_retried and self._account_refresh_if_needed(force=True):
                    self._persist()
                    return await self._collect(account_retried=True)
                if self._car_token_alive():
                    # 账号会话死了, 但**车端 token 还能用** —— 车况/控车都走车端接口,
                    # 所以照常干活, 只提醒用户尽快重新认证(实测能多撑约 2 小时)。
                    log.warning("账号会话已过期, 但车端 token 仍有效, 继续提供服务")
                    self.session_problem = (
                        "账号会话已过期(车端 token 仍有效, 还能用约 "
                        f"{int(self._car_token_left() / 60)} 分钟) —— "
                        "请尽快在集成里点「重新认证」")
                    await self._warn_expired()
                    return await self._refresh_car_data_and_return()
                self.session_problem = "账号会话已过期, 需要重新登录(发送短信验证码即可)"
                raise ConfigEntryAuthFailed(self.session_problem)
            raise RuntimeError(
                f"账号下没有可用车辆: {str(raw.get('message') or raw)[:120]}"
                if isinstance(raw, dict) else "账号下没有可用车辆")
        self.session_problem = ""
        self.car_state_problem = ""
        self._last_renew = 0.0
        await self._refresh_car_data()
        self._adapt_poll_interval()
        return self._build_result()

    async def _refresh_car_data(self) -> None:
        """拉车端数据(配置/里程/能耗/照片/车况)。全部走**车端 token**, 与账号会话无关。"""
        await self._warn_before_expiry()
        config: dict[str, Any] = {}
        charge_plan: dict[str, Any] = {}
        try:
            r = await self.hass.async_add_executor_job(self.client.get_car_config, self.vin)
            config = (r.get("data") or {}) if isinstance(r, dict) else {}
            charge_plan = ((config.get("config") or {}) if isinstance(config, dict) else {}).get("3") or {}
        except Exception as err:  # noqa: BLE001
            log.debug("获取车辆配置失败: %s", err)
        self._config = config
        self._charge_plan = charge_plan
        mileage: dict[str, Any] = {}
        energy: dict[str, Any] = {}
        try:
            r = await self.hass.async_add_executor_job(self.client.get_mileage_detail, self.vin)
            mileage = (r.get("data") or {}) if isinstance(r, dict) else {}
        except Exception as err:  # noqa: BLE001
            log.debug("获取里程失败: %s", err)
        try:
            r = await self.hass.async_add_executor_job(self.client.get_energy_rank, self.vin)
            energy = (r.get("data") or {}) if isinstance(r, dict) else {}
        except Exception as err:  # noqa: BLE001
            log.debug("获取能耗失败: %s", err)
        try:
            r = await self.hass.async_add_executor_job(self.client.get_mileage_range, self.vin, 7)
            mileage = {**(r.get("data") or {}), "mileage7": (r.get("data") or {})}
        except Exception as err:  # noqa: BLE001
            log.debug("获取近 7 天里程失败: %s", err)
        self._mileage = mileage
        self._energy = energy
        try:
            r = await self.hass.async_add_executor_job(self.client.get_chassis_picture, self.vin)
            self.parking_url = ((r.get("data") or {}) if isinstance(r, dict) else {}).get("fileUrl") or ""
        except Exception as err:  # noqa: BLE001
            log.debug("获取驻车照片失败: %s", err)
        # 车况: GPS / 电量 / 续航 / 四轮胎压 / 门窗 / 充电 / 空调 —— 见 api.SIGNAL_IDS
        #
        # ⚠️ 两个坑(2026-09-27 深夜实测踩到):
        #   1. `get_car_state` 对"被服务端拒收/没有 signalMap"的响应**不抛异常**,
        #      而是回一个**空 CarState** —— 直接赋值会把好数据覆盖成一片 null
        #      (表现为: 电量/续航/位置全变 unknown, 日志里却什么都没有)。
        #   2. 刚重新交换过车端 token 的头一次请求最容易被拒(`302010205` 一族)。
        # 所以: 空结果要重试一次(必要时换 token), 两次都拿不到就**沿用上一份**, 并把
        # 原因写进 `car_state_problem`(会出现在「会话状态」传感器上, 不再静默)。
        state = None
        why = "未知原因"
        for attempt in (1, 2):
            try:
                state = await self.hass.async_add_executor_job(
                    self.client.get_car_state, self.vin)
            except Exception as err:  # noqa: BLE001
                state, why = None, f"{type(err).__name__}: {err}"
            else:
                if state is not None and state.raw:
                    break
                why = "响应里没有 signalMap(车端 token 刚轮换时常被拒)"
            if attempt == 1:
                log.warning("车况拉取为空(%s), 换一次车端 token 后重试", why)
                try:
                    if await self.hass.async_add_executor_job(
                            functools.partial(self._renew_if_needed, force=True)):
                        self._persist()
                except Exception as err:  # noqa: BLE001
                    log.warning("重试前换 token 异常: %s", err)
        if state is not None and state.raw:
            self.state = state
            self.car_state_problem = ""
        else:
            self.car_state_problem = f"车况未取到({why})"
            log.warning("本轮没取到车况, 沿用上一份数据: %s", why)

    def _build_result(self) -> dict[str, Any]:
        return {
            "vehicle": self.vehicle,
            "config": getattr(self, "_config", {}) or {},
            "charge_plan": getattr(self, "_charge_plan", {}) or {},
            "mileage": getattr(self, "_mileage", {}) or {},
            "energy": getattr(self, "_energy", {}) or {},
            "state": self.state,
            "parking_url": self.parking_url,
            "last_result": self.last_result,
            "session_problem": self.session_problem,
            "car_state_problem": self.car_state_problem,
        }

    def _adapt_poll_interval(self) -> None:
        """按车辆状态切换轮询间隔: **行驶中快、停车慢**。

        参考 EU 版的双档轮询(它按"已锁+已驻车+未充电"判定安静后放慢)。这里:
          * 行驶中(车辆状态=driving 或车速>0) → `driving_poll_seconds`(默认 60s)
          * 其它(停车/充电/未锁) → `poll_seconds`(用户配置, 默认 300s)

        停车时**不停止轮询**: 车端休眠时本来就不上报, 停轮询只会让"车又动了"发现不了。
        """
        poll = int(self.entry.options.get(CONF_POLL_SECONDS) or DEFAULT_POLL_SECONDS)
        fast = int(self.entry.options.get(CONF_DRIVING_POLL_SECONDS)
                   or DEFAULT_DRIVING_POLL_SECONDS)
        st = self.state
        driving = bool(st and (st.vehicle_state == "driving" or (st.get("speed") or 0) > 0))
        target = pick_poll_seconds(poll, fast, driving)
        want = timedelta_seconds(target)
        if self.update_interval != want:
            self.update_interval = want
            log.debug("轮询间隔 → %s 秒(%s)", target, "行驶中" if driving else "停车/其它")

    def remember(self, key: str, value: Any) -> None:
        """命令成功后记下"我认为它现在是什么状态"(车端一上报新数据就自动失效)。"""
        self.overrides.remember(key, value, self.state.collect_time if self.state else 0)

    def recall(self, key: str) -> Any:
        """取命令后的临时状态; 无覆盖(或车端已更新)时返回 None。"""
        return self.overrides.recall(key, self.state.collect_time if self.state else 0)

    def _car_token_left(self) -> float:
        exp = token_expiry(self.session.car_token)
        return max(0.0, exp - time.time()) if exp else 0.0

    def _car_token_alive(self) -> bool:
        return self._car_token_left() > 120

    async def _warn_expired(self) -> None:
        """账号会话已过期时提醒一次(车端还能顶一会儿)。"""
        if self._expiry_warned:
            return
        self._expiry_warned = True
        try:
            await self.hass.services.async_call(
                "persistent_notification", "create",
                {
                    "title": "零跑汽车: 账号会话已过期",
                    "message": (
                        "账号会话已过期, 车端 token 还能撑一会儿(数据仍在更新)。"
                        "请在 设置 → 设备与服务 → 零跑 里点「重新认证」, 收一条短信填进去即可。"
                    ),
                    "notification_id": f"{DOMAIN}_session_expired",
                },
                blocking=False,
            )
        except Exception as err:  # noqa: BLE001
            log.debug("发送过期提醒失败: %s", err)

    async def _refresh_car_data_and_return(self) -> dict[str, Any]:
        await self._refresh_car_data()
        return self._build_result()

    async def _warn_before_expiry(self) -> None:
        """账号会话快到期时提前弹一条通知。

        零跑云的账号 token 实测只有约 6 小时, 而且**没有静默续期通道**(App 也没有,
        只能短信重登 —— 见 docs/PROTOCOL.md §3)。所以提前 30 分钟提醒, 免得用户
        在自动化跑到一半时突然发现实体不可用。
        """
        exp = self.session.account_token_expires_at
        if not exp:
            return
        left = exp - time.time()
        if left <= 0:
            return
        if left > 1800 or self._expiry_warned:
            return
        self._expiry_warned = True
        try:
            await self.hass.services.async_call(
                "persistent_notification", "create",
                {
                    "title": "零跑汽车: 登录会话快到期",
                    "message": (
                        f"账号会话大约还有 {int(left / 60)} 分钟到期。到期后车辆实体"
                        "会暂时不可用, 请在 设置 → 设备与服务 → 零跑 里点「重新认证」,"
                        "收一条短信填进去即可(不需要删除集成)。"
                    ),
                    "notification_id": f"{DOMAIN}_session_expiry",
                },
                blocking=False,
            )
            log.info("已提醒用户账号会话即将到期(剩 %.0f 分钟)", left / 60)
        except Exception as err:  # noqa: BLE001
            log.debug("发送到期提醒失败: %s", err)

    # ── token 续期 ──
    def _renew_if_needed(self, *, force: bool = False) -> bool:
        """车端 token 只有 2 小时; 账号 token 约 6 小时, 用它自动续期。

        ⚠️ 本函数跑在**执行器线程**里, 所以不能碰 hass.config_entries
        (实测: 在工作线程里调 async_update_entry 会抛 RuntimeError 并把整个更新搞挂)。
        需要持久化时返回 True, 由事件循环侧调用 _persist()。
        """
        exp = token_expiry(self.session.car_token)
        if force:
            # 已经被服务端以签名类错误拒收了 —— 不管本地怎么算到期时间都得换一份
            log.info("签名被服务端拒收, 强制重新交换车端 token")
        else:
            if not exp or exp - time.time() > RENEW_SKEW_SECONDS:
                return False
            if time.time() - self._last_renew < 900:  # 15 分钟硬性节流
                return False
        acct_exp = self.session.account_token_expires_at
        if acct_exp and time.time() > acct_exp - 60:
            # 本地估算的到期时间**不作为判死依据** —— 之前就是因为这里硬抛异常,
            # 导致会话其实还能用时整个设备被标成不可用。真正失效由服务端响应决定
            # (见 _collect 里的 is_auth_error), 届时 HA 会弹「重新认证」。
            log.info("账号 token 本地估算已到期, 仍尝试续期(以服务端返回为准)")
        self._account_refresh_if_needed()
        self._last_renew = time.time()
        log.info("车端 token 即将过期, 自动重新交换(不需要短信)")
        r = self.client.car_login()
        if not self.session.car_token or not self.session.sign_param:
            if is_auth_error(r):
                raise ConfigEntryAuthFailed(
                    "账号会话已过期, 需要重新登录(发送短信验证码即可)")
            raise UpdateFailed(f"车端 token 续期失败: {str(r)[:120]}")
        if self.session.hkdf_key_hex:
            self.state = None          # 换了密钥, 旧车况作废
        log.info("车端 token 已续期")
        return True

    def _account_refresh_if_needed(self, *, force: bool = False) -> bool:
        """账号 token(6 小时)**免短信续期** —— 车端 token 续期前顺手做掉。

        形状与实测来源见 `api_client.refresh_account_token()` 的 docstring:
        实测 2026-09-27 `code=200`;refreshToken 不轮换, 只要在它有效期内调用就能
        一直续(6 小时 → 长期无需短信重登)。失败**不致命**: 交给 car_login()/
        服务端响应给出真实结论, 避免把还能用的会话误判成失效。
        """
        exp = self.session.account_token_expires_at
        if not self.session.refresh_token:
            return False
        if not force and exp and exp - time.time() > ACCOUNT_RENEW_SKEW_SECONDS:
            return False
        try:
            r = self.client.refresh_account_token()
        except Exception as err:  # noqa: BLE001 — 续期失败不影响主流程
            log.warning("账号 token 免短信续期异常(忽略): %s", err)
            return False
        if r.get("code") in (0, 200):
            log.info("账号 token 已免短信续期, 剩余 %s 秒",
                     (r.get("data") or {}).get("tokenExpired"))
            return True
        log.info("账号 token 续期未成功(code=%s msg=%s), 继续走交换",
                 r.get("code"), r.get("msg") or r.get("message"))
        return False

    @property
    def car_state(self) -> CarState | None:
        """最近一帧车况;优先取 data 里的那一份, 保证实体与轮询结果同源。"""
        return (self.data or {}).get("state") or self.state

    def set_charge_plan_cache(self, key: str, value) -> None:
        """本地先记下刚写成功的值, 让界面立刻反映(下次轮询会用车端真实值覆盖)。"""
        plan = dict((self.data or {}).get("charge_plan") or {})
        plan[key] = value
        self.async_set_updated_data({**(self.data or {}), "charge_plan": plan})

    def _persist(self) -> None:
        """把刷新后的会话写回 config entry(HA 会持久化)。"""
        data = asdict(self.session)
        data["vin"] = self.vin
        data["car_type"] = self.entry.data.get("car_type", "")
        data["car_nickname"] = self.entry.data.get("car_nickname", "")
        data["phone"] = self.entry.data.get("phone", "")
        self.hass.config_entries.async_update_entry(self.entry, data=data)

    # ── 指令 ──
    async def async_call(self, method: str, **kwargs) -> dict:
        """调用客户端上的某个指令方法(lock/unlock/find_car/ac_on/...)。

        每个方法内部都会: 先校验操作密码 → 再带 oppwd 下发(state 内容随指令而异)。
        """
        fn = getattr(self.client, method)
        try:
            resp = await self.hass.async_add_executor_job(functools.partial(fn, **kwargs))
        except Exception as err:  # noqa: BLE001
            self.last_result = f"{method} 异常: {err}"
            self.async_set_updated_data(self.data or {})
            raise
        if is_signature_error(resp):
            # 车端 JWT 是**轮换**的: 别处(本集成的续期/官方 App)换过一份之后, 旧密钥
            # 签出来的请求会被 302010205 直接拒收。换新 token 再原样发一次即可,
            # 绝不能当成会话失效去弹"重新认证"(那样用户会被反复打扰)。
            log.warning("指令 %s 被签名校验拒收(%s), 换新 token 重试一次",
                        method, resp.get("code"))
            renewed = False
            try:
                if await self.hass.async_add_executor_job(
                        functools.partial(self._renew_if_needed, force=True)):
                    self._persist()
                    renewed = True
            except Exception as err:  # noqa: BLE001
                log.warning("重试前换 token 异常: %s", err)
            if not renewed:
                # 没换成新 token, 重试也只会被同样拒收 —— 如实报失败
                log.warning("车端 token 未能更换, 不再重试")
                self._remember(resp, method)
                self._raise_unless_accepted(method, resp)
                return resp
            try:
                resp = await self.hass.async_add_executor_job(
                    functools.partial(fn, **kwargs))
            except Exception as err:  # noqa: BLE001
                self.last_result = f"{method} 重试异常: {err}"
                self.async_set_updated_data(self.data or {})
                raise
        self._remember(resp, method)
        self._raise_unless_accepted(method, resp)
        return resp

    def _raise_unless_accepted(self, method: str, resp: dict) -> None:
        """指令没被云端受理时抛出去 —— 让界面上**看得见失败**, 而不是静默"成功"。

        实体侧拿到异常就不会再记乐观状态(否则界面会显示一个根本没发生的动作)。
        `last_result`(最近指令回执)在抛之前已经记好, 诊断信息不丢。
        """
        why = command_failed(resp)
        if why:
            raise HomeAssistantError(f"{method} 指令未受理: {why}；{self.last_result}")

    def _remember(self, resp: dict, label: str) -> None:
        self.last_result = json.dumps(resp, ensure_ascii=False)[:500]
        if isinstance(resp, dict) and resp.get("code") not in (0, None):
            code = resp.get("code")
            if not self.session.operate_pwd:
                hint = "（很可能缺少【操作密码】: 设置 → 设备与服务 → 本集成 → 配置, 填 4 位数字）"
            elif code == 4:
                hint = "（操作密码不正确 —— 请在集成「配置」里核对）"
            elif code == 70:
                hint = "（操作密码连错 3 次, 已锁定 5 分钟）"
            elif code == 40:
                hint = ("（云端回「无此权限」—— 这条指令没被授权给当前账号。"
                        "子账号的授权清单由主账号设定, 空调快捷模式实测子账号常被拒）")
            else:
                hint = ""
            if hint:
                self.last_result = f"{self.last_result} {hint}"
        log.info("指令 %s → %s", label, self.last_result[:200])
        self.async_set_updated_data({**(self.data or {}), "last_result": self.last_result})


def timedelta_seconds(seconds: int):
    from datetime import timedelta

    return timedelta(seconds=max(60, seconds))
