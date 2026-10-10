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
    choose_poll_seconds,
    command_failed,
    is_reev,
    is_auth_error,
    is_rate_limited,
    is_signature_error,
    LeapmotorClient,
    parse_lastweek_ec,
    previous_week_window_seconds,
    Session,
    StateOverrides,
    Vehicle,
)
from .const import (
    CONF_BATTERY_KWH,
    CONF_LAUNCH_BOOST,
    CONF_SHORT_STOP_SECONDS,
    DEFAULT_BATTERY_KWH,
    DEFAULT_LAUNCH_BOOST,
    DEFAULT_SHORT_STOP_SECONDS,
    HEAVY_REFRESH_SECONDS,
    LASTWEEK_EC_REFRESH_SECONDS,
    LAUNCH_BOOST_MAX_SECONDS,
    PHOTO_RETRY_EVERY_SECONDS,
    PHOTO_RETRY_STEPS,
    PHOTO_RETRY_WINDOW_SECONDS,
    RATE_LIMIT_COOLDOWN_SECONDS,
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
from .energy_daily import (
    compose_days,
    ENERGY_FETCH_BUDGET_HEAVY,
    ENERGY_FETCH_BUDGET_WS,
    EnergyDayStore,
    parse_getec_day,
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
        # ⚠️ `_apply_options()` 会读 `self.trips`(行程记录器的电池容量), 所以这些字段
        #    必须在它**之前**初始化 —— 这个顺序踩过坑: 曾经把它放在下面, 结果 `__init__`
        #    第 79 行一调用就 AttributeError, 整个集成 setup_error。
        self.trips = None                # 行程记录器(见 trips.py, 由 __init__.py 挂上)
        self.energy_days = None          # 官方逐日能耗缓存(见 energy_daily.py, 由 __init__.py 挂上)
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
        # 会话提醒: **只在真的续期失败、且已影响服务时**弹一次(见 _warn_expired);
        # 会话恢复健康后自动清掉残留通知并把此标记复位(见 _clear_stale_session_notices)。
        self._expiry_warned = False
        self._notices_cleared = False           # 本轮健康期是否已清过历史通知(避免每轮都调服务)
        self._plug_energy = {}                   # 增程车的电耗/油耗(见 _refresh_heavy)
        # ── 重数据快照(里程/能耗/配置/照片地址)──
        # 这些数据"变化慢、拉取重", 且**云端偶发取不到**。两处用它:
        #   1) 取不到时**保留上一份**(不要把好数据洗成 unknown);
        #   2) 落盘持久化 → HA 重启后先亮出上次的值, 不必等第二轮重数据周期(否则里程/能耗
        #      传感器在重启后有一段时间是 unknown —— 用户反馈的"重启后实体未知")。
        self._config: dict = {}
        self._charge_plan: dict = {}
        self._mileage: dict = {}
        self._energy: dict = {}
        self._heavy_store = None                 # 懒建 Store(见 async_load_heavy)
        self._heavy_loaded = False
        self._last_heavy = 0.0                  # 上次拉"不常变"数据(配置/里程/能耗)的时刻
        # ── 驻车照片(只在泊车时拍一次, 之后请求拿回同一张)──
        self._photo_upload_ms = 0               # 上次取到的照片上传时刻(判"有没有新照片")
        self._photo_odo = None                  # 上次取照片时的总里程(变了说明又动过车)
        self._photo_retry_until = 0.0           # 迟到重试窗口的截止时刻
        self._photo_last_try = 0.0              # 上次尝试取照片的时刻
        self._photo_pending = False             # True = 地址有了但还没换成新照片(上传中)
        self._photo_retry_count = 0             # 本轮"等上传"窗口里已重试几次(递增退避用)
        self._photo_upload_ms_acc = 0           # 最近一次拿到的 uploadTime(供传感器展示)
        self._photo_force = False               # 「刷新车况」按钮强制重取一次
        # ── 上周能耗拆分(驱动/空调/其它)──
        # 按需取(卡片打开/手动刷新时), **不占轮询**; 缓存在这里, 窗口翻篇或过 1 小时才重取。
        self._lastweek_ec: dict = {}
        self._lastweek_ec_ts = 0.0
        self._lastweek_ec_fetching = False
        # ── 轮询档位 ──
        self._rate_limited_until = 0.0          # 限流/风控冷却截止时刻
        self._launch_boost_until = 0.0          # 出发提速(解锁/上电/非P)的截止时刻
        self._short_stop_until = 0.0            # 短停快档的截止时刻(行程刚结束后的一段时间)
        self._launch_hint_prev = False
        self._prev_vehicle_state = None
        # 首轮刷新只拉车况帧(见 __init__.py 的 async_setup_entry):
        # 启动时别把里程/能耗/照片那 5~6 个请求也串起来 —— 网络慢的时候，每个请求最多等
        # 20 秒超时，实测把 HA 启动拖了 4 分钟(bootstrap 连续 4 条 "Waiting for integrations")。
        self.light_first_refresh = False
        # 上一轮轮询实际花了多久(诊断用: 请求本身只要 0.2 秒, 若这里显示几十秒,
        # 说明这一轮在**网络层/重试**上花了时间(实测：某个地址族被黑洞时, 标准库会逐个地址串行等超时)。
        self.last_cycle_seconds = 0.0
        # 命令后的临时状态: 车端上报新 collectTime 前, 实体以本地值为准
        self.overrides = StateOverrides()
        self._last_resp: dict | None = None     # 出问题那一次的原始响应(判会话失效)

        poll = int(entry.options.get(CONF_POLL_SECONDS) or DEFAULT_POLL_SECONDS)
        super().__init__(
            hass, log, name=f"{DOMAIN} {self.vin}", update_interval=timedelta_seconds(poll)
        )

    def _apply_options(self) -> None:
        # 行程记录: 电池可用容量会影响耗电/能耗的折算, 选项一改就跟着改。
        # 用 getattr 兜底 —— 这个函数在 __init__ 早期就会被调用, 属性顺序不该成为地雷。
        if getattr(self, "trips", None) is not None:
            self.trips.set_capacity(float(
                self.entry.options.get(CONF_BATTERY_KWH) or DEFAULT_BATTERY_KWH))
        self.session.operate_pwd = str(self.entry.options.get(CONF_OPERATE_PWD) or "")
        self.session.operate_pwd_mode = str(
            self.entry.options.get(CONF_OPERATE_PWD_MODE) or DEFAULT_PWD_MODE
        )

    # ── 重数据快照的持久化(重启后先亮上次的值, 免一段时间 unknown)──
    async def async_load_heavy(self) -> None:
        """载入上次的里程/能耗/配置/照片地址快照(在首轮刷新前调用)。失败静默。"""
        if self._heavy_loaded:
            return
        self._heavy_loaded = True
        try:
            from homeassistant.helpers.storage import Store
            if self._heavy_store is None:
                self._heavy_store = Store(self.hass, 1, f"leapmotor_{self.vin}_heavy")
            data = await self._heavy_store.async_load() or {}
            self._config = data.get("config") or self._config or {}
            self._charge_plan = data.get("charge_plan") or {}
            self._mileage = data.get("mileage") or {}
            self._energy = data.get("energy") or {}
            self._plug_energy = data.get("plug_energy") or {}
            self.parking_url = data.get("parking_url") or self.parking_url or ""
            self._photo_upload_ms_acc = data.get("photo_upload_ms") or 0
        except Exception as err:  # noqa: BLE001
            log.debug("载入重数据快照失败(忽略): %s", err)

    def _save_heavy(self) -> None:
        """把重数据快照延迟落盘(有变化才写; 失败静默 —— 它只是优化, 不影响主流程)。"""
        try:
            if self._heavy_store is None:
                from homeassistant.helpers.storage import Store
                self._heavy_store = Store(self.hass, 1, f"leapmotor_{self.vin}_heavy")
            self._heavy_store.async_delay_save(
                lambda: {
                    "config": self._config,
                    "charge_plan": self._charge_plan,
                    "mileage": self._mileage,
                    "energy": self._energy,
                    "plug_energy": self._plug_energy,
                    "parking_url": self.parking_url,
                    "photo_upload_ms": self._photo_upload_ms_acc,
                }, 30)
        except Exception as err:  # noqa: BLE001
            log.debug("保存重数据快照失败(忽略): %s", err)

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
        t0 = time.monotonic()
        try:
            try:
                result = await self._collect()
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
        finally:
            # 诊断用: 请求本身约 0.2 秒; 这里常年几十秒说明网络层在等超时/重试(不是 HA 线程池)
            self.last_cycle_seconds = time.monotonic() - t0
            if self.last_cycle_seconds > 60:
                log.warning("本轮轮询耗时 %.0f 秒(请求本身约 0.2 秒; 多半在等网络超时/重试)",
                            self.last_cycle_seconds)
        return result

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
                #   (实测 `getnewtoken` code=200; 哪怕 token 已过期也能救回)
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
        await self._refresh_car_data()      # 内部会重算轮询档位
        return self._build_result()

    async def _refresh_car_data(self) -> None:
        """拉车端数据。**车况帧是唯一每轮都拉的请求**, 其余按需。

        取数策略(依据: 官方 App 6 秒轮询的只有车况接口, 里程/能耗/车图都是"进页面才拉"):
          * **车况帧**: 行驶 6s / 停车 60s / 出发提速 6s(见 `_adapt_poll_interval`)——
            行程记录的唯一必需请求
          * **里程 / 能耗 / 配置**: 行驶中一律跳过; 停车时每 >= `HEAVY_REFRESH_SECONDS` 拉一次
          * **驻车照片**: 只在"启动首次 / 新泊车事件 / 总里程较上次取照片时已变化 / 手动刷新"时拉
            —— 照片只在泊车那一刻拍一次并异步上传, 重复请求只会拿回同一张;
            用响应里的 `uploadTime` 判断**是否真的换了新照片**(见 `client.chassis_info`),
            没换就在窗口期内重试几次, 仍没有则标记「待补」交给下一个重数据周期。

        注意: **不再有"账号会话快到期"的提前提醒** —— 账号 token 有免短信续期
        通道(refreshToken 不轮换、可无限续, 见 `_account_refresh_if_needed`), 提前吓唬用户
        纯属噪音; 现在只在**强制续期也失败、且车端被服务端拒收**时才提醒(见 `_warn_expired`)。
        """
        now = time.time()

        # ── 车况帧(每轮必拉)──
        #
        # 两个坑(深夜实测踩到):
        #   1. `get_car_state` 对"被服务端拒收/没有 signalMap"的响应**不抛异常**,
        #      而是回一个**空 CarState** —— 直接赋值会把好数据覆盖成一片 null
        #      (表现为: 电量/续航/位置全变 unknown, 日志里却什么都没有)。
        #   2. 服务端会**不定时把签名材料换掉**(连续观测定性: 每天约 40 次
        #      首拉被 `302010205` 拒签, 换一次车端 token 后重试**必成功**; 与 HA 重启
        #      无关 —— 09-29 零重启那天也有 59 次)。换 token 是签名族错误的唯一解药。
        # 所以: 空结果重试一次 —— **只有签名族错误才换 token**(`is_signature_error`),
        # 网络抖动/未知错误码原样重试即可: 换 token 对它们是白费请求, 还会让别处的
        # 会话失效(单账号单会话)。两次都拿不到就**沿用上一份**, 并把原因写进
        # `car_state_problem`(会出现在「会话状态」传感器上, 不再静默)。
        state = None
        why = "未知原因"
        for attempt in (1, 2):
            code = None
            try:
                state = await self.hass.async_add_executor_job(
                    self.client.get_car_state, self.vin)
            except Exception as err:  # noqa: BLE001
                state, why = None, f"{type(err).__name__}: {err}"
            else:
                if state is not None and state.raw:
                    break
                code = getattr(state, "resp_code", None)
                why = f"响应里没有 signalMap(code={code})"
                if is_rate_limited({"code": code}):
                    self._enter_rate_limit("车况接口返回风控/限流提示")
                    break
            if attempt == 1:
                if is_signature_error({"code": code}):
                    log.warning("车况拉取为空(%s), 换一次车端 token 后重试", why)
                    try:
                        if await self.hass.async_add_executor_job(
                                functools.partial(self._renew_if_needed, force=True)):
                            self._persist()
                    except Exception as err:  # noqa: BLE001
                        log.warning("重试前换 token 异常: %s", err)
                else:
                    log.warning("车况拉取为空(%s), 原样重试一次(不换 token)", why)
        if state is not None and state.raw:
            self.state = state
            self.car_state_problem = ""
            # 车况拉到了 = 会话是活的: 顺手清掉历史会话提醒(老版本留下的"快到期"通知,
            # 或已恢复后残留的"已过期"通知), 并把提醒标记复位。
            await self._clear_stale_session_notices()
        else:
            self.car_state_problem = f"车况未取到({why})"
            log.warning("本轮没取到车况, 沿用上一份数据: %s", why)

        # ── 新泊车事件 → 打开照片重试窗口(照片此刻刚拍, 可能还没上传完)──
        cur_state = self.state.vehicle_state if self.state else None
        if self._prev_vehicle_state == "driving" and cur_state == "parked":
            self._photo_retry_until = now + PHOTO_RETRY_WINDOW_SECONDS
            self._photo_pending = True
            # 短停快档: 行程刚结束的一段时间内继续用快档, 便于抓住"短停再出发"
            self._photo_retry_count = 0          # 新一轮"等上传": 退避从头开始
            short = int(self.entry.options.get(CONF_SHORT_STOP_SECONDS,
                                               DEFAULT_SHORT_STOP_SECONDS) or 0)
            self._short_stop_until = (now + short) if short > 0 else 0.0
            log.debug("检测到新泊车事件 -> 照片重试窗口 %ds; 短停快档 %s",
                      PHOTO_RETRY_WINDOW_SECONDS,
                      ("%ds" % short) if short else "已关闭")
        if cur_state:
            self._prev_vehicle_state = cur_state

        # ── 重数据(里程/能耗/配置): 行驶中跳过, 停车时每 >=600s ──
        #    (轻量首轮刷新期间一律跳过 —— 见 light_first_refresh 的说明)
        driving = bool(self.state and (
            self.state.vehicle_state == "driving" or (self.state.get("speed") or 0) > 0))
        if not self.light_first_refresh:
            # 重数据(里程/能耗/配置)有**自己的节奏**(`HEAVY_REFRESH_SECONDS`), 与轮询档位无关:
            # 短停快档/出发提速时轮询会到 6 秒, 但这些数据在 10 分钟内几乎不变 ——
            # 跟着高频拉纯属浪费(它们还会顺带触发 HA 的写库与前端刷新)。
            if self._last_heavy == 0.0 or (not driving
                                          and now - self._last_heavy >= HEAVY_REFRESH_SECONDS):
                self._last_heavy = now
                await self._refresh_heavy()

            # ── 驻车照片(按需 + 迟到兜底)──
            if self._photo_due(self.state, now):
                await self._refresh_photo(self.state, now)

        # ── 行程记录: 把这一帧喂给记录器(状态机/记账/轨迹都在里面)──
        if self.trips is not None and self.state is not None:
            try:
                self.trips.process(self.state, now=now)
            except Exception as err:  # noqa: BLE001
                log.warning("行程记录处理异常: %s", err)

        # ── 轮询档位: 每轮都要重算(以前只在首轮算, 导致"行驶中提速"从未生效)──
        self._adapt_poll_interval()

    async def _refresh_heavy(self) -> None:
        """里程 / 能耗 / 配置 —— 变化慢, 只按需拉(见 `_refresh_car_data` 的说明)。

        取数优化:
          * **三个请求并发**(原来串行 ~0.85s → 现在约等于最慢的一个 ~0.3s);
          * **去掉一个重复请求**: `mileage/energy/detail` 带时间窗口时会同时返回
            `totalmileage` / `deliveryDays`(与不带窗口的调用同一个端点), 所以
            原来那次额外的 `get_mileage_detail` 是多余的 —— 直接省掉。
        """
        import asyncio

        async def _call(fn, *args):
            try:
                r = await self.hass.async_add_executor_job(fn, *args)
                return (r.get("data") or {}) if isinstance(r, dict) else {}
            except Exception as err:  # noqa: BLE001
                log.debug("%s 失败: %s", getattr(fn, "__name__", fn), err)
                return {}

        jobs = [
            _call(self.client.get_car_config, self.vin),        # 充电计划/车辆配置
            _call(self.client.get_energy_rank, self.vin),       # 百公里能耗 + 排名 + 周明细
            _call(self.client.get_mileage_range, self.vin, 7),  # 近 7 天(含总里程/交付天数)
        ]
        if is_reev(self.state.signals if self.state is not None else {}):
            # 增程车才有意义(纯电车这接口没数据)
            jobs.append(_call(self.client.get_plug_energy, self.vin))
        results = await asyncio.gather(*jobs)
        config = results[0] or {}
        energy = results[1] or {}
        mileage_raw = results[2] or {}
        if len(results) > 3:
            plug = results[3] or {}
            if plug:
                self._plug_energy = plug

        # ⚠️ 只在**取到**时才覆盖: 每个 `_call` 在异常时返回 `{}` —— 无条件赋值会把上一次
        # 的好数据洗成空, 于是「百公里能耗/交付天数/总里程」等传感器在云端偶发抽风时变成
        # unknown(用户反馈的"某些时候实体未知")。保留上一份, 下一轮自然会补上。
        if config:
            self._config = config
            self._charge_plan = ((config.get("config") or {}) if isinstance(config, dict) else {}).get("3") or {}
        if mileage_raw:
            self._mileage = {**mileage_raw, "mileage7": mileage_raw}
        if energy:
            self._energy = energy
        self._save_heavy()          # 快照落盘(重启后能先亮出上次的值)

        # ── 官方逐日能耗(getEC): 缓慢补拉缺的日子 ──
        # 刚升级时缓存是空的, 卡片按需路径会补大头; 这里每轮重数据周期再补几天兜底,
        # 保证"不点卡片也能把历史补齐"。失败的日有 1 小时重试间隔, 不会死磕。
        if self.energy_days is not None:
            try:
                await self.ensure_energy_days(7, budget=ENERGY_FETCH_BUDGET_HEAVY)
            except Exception as err:  # noqa: BLE001
                log.debug("官方逐日能耗补拉失败(忽略): %s", err)

    def _photo_due(self, st, now: float) -> bool:
        """现在该不该去取驻车照片(按需, 不是每轮)。

        触发条件(与"不白问"的取舍):
          * 启动后还没拿到过地址;
          * 用户手动刷新;
          * **新泊车事件后的窗口内** —— 车端拍照是异步上传的, 所以停车后一段时间里
            按**递增退避**重试(15s→30s→60s→120s→300s): 头几次试得快(照片通常秒级到),
            之后越试越慢(车端迟迟不传时快速收敛, 不再浪费请求);
          * 总里程变了(说明车又动过, 可能拍了新照片)。

        速度上限由**车端**决定: 它什么时候传完我们才知道 —— 窗口给足 15 分钟是为了"不错过",
        退避是为了"不白问"; 拿到新的 uploadTime 会立即把窗口关掉(见 `_refresh_photo`)。
        """
        if self._photo_force:
            return True
        if not self.parking_url:
            return True                                   # 启动后还没拿到过
        if now < self._photo_retry_until:
            # 窗口内: 按递增退避决定这一轮要不要试
            idx = min(self._photo_retry_count, len(PHOTO_RETRY_STEPS) - 1)
            if now - self._photo_last_try >= PHOTO_RETRY_STEPS[idx]:
                return True
        odo = st.get("odometer") if st is not None else None
        if odo is not None and self._photo_odo is not None and odo != self._photo_odo:
            return True                                   # 车又动过 -> 可能拍了新照片
        return False

    async def _refresh_photo(self, st, now: float) -> None:
        """取驻车照片。以 `uploadTime` 判断是否换了新照片 —— 这是"迟到兜底"的核心。"""
        self._photo_last_try = now
        self._photo_force = False
        self._photo_retry_count += 1
        try:
            info = await self.hass.async_add_executor_job(self.client.chassis_info, self.vin)
        except Exception as err:  # noqa: BLE001
            log.debug("获取驻车照片失败: %s", err)
            return
        if is_rate_limited(info.get("raw") if isinstance(info, dict) else None):
            self._enter_rate_limit("驻车照片接口返回风控/限流提示")
            return
        url = str(info.get("url") or "")
        upload = int(info.get("upload_time_ms") or 0)
        if url:
            self.parking_url = url
            if upload > self._photo_upload_ms:
                if self._photo_upload_ms:
                    log.debug("驻车照片已更新(uploadTime %s -> %s)", self._photo_upload_ms, upload)
                self._photo_upload_ms = upload
                self._photo_pending = False
                self._photo_retry_until = 0.0
                self._photo_upload_ms_acc = upload
                self._photo_retry_count = 0
            else:
                # 地址有了, 但内容还是上一张 -> 车端可能还在上传
                self._photo_pending = True
                if now >= self._photo_retry_until:
                    self._photo_retry_until = now + PHOTO_RETRY_WINDOW_SECONDS
        else:
            log.debug("驻车照片地址为空(车端可能还没上传完)")
            self._photo_pending = True
            if now >= self._photo_retry_until:
                self._photo_retry_until = now + PHOTO_RETRY_WINDOW_SECONDS
        if st is not None:
            self._photo_odo = st.get("odometer")
        self._save_heavy()      # 照片地址/uploadTime 也进快照(重启后直接亮出上次的地址)

    def force_photo_refresh(self) -> None:
        """「刷新车况」按钮: 强制重取一次照片与重数据(不管节流)。"""
        self._photo_force = True
        self._last_heavy = 0.0

    def _enter_rate_limit(self, why: str) -> None:
        """命中限流/风控 -> 退避一段时间(期间用慢档), 并写在诊断属性里。"""
        now = time.time()
        if now < self._rate_limited_until:
            return
        self._rate_limited_until = now + RATE_LIMIT_COOLDOWN_SECONDS
        self.car_state_problem = (f"疑似被限流/风控, 已退避 "
                                  f"{RATE_LIMIT_COOLDOWN_SECONDS // 60} 分钟({why})")
        log.warning("疑似被限流/风控 -> 轮询退避 %d 秒: %s", RATE_LIMIT_COOLDOWN_SECONDS, why)

    def _build_result(self) -> dict[str, Any]:
        return {
            "vehicle": self.vehicle,
            "config": getattr(self, "_config", {}) or {},
            "charge_plan": getattr(self, "_charge_plan", {}) or {},
            "mileage": getattr(self, "_mileage", {}) or {},
            "energy": getattr(self, "_energy", {}) or {},
            "plug_energy": getattr(self, "_plug_energy", {}) or {},
            "state": self.state,
            "parking_url": self.parking_url,
            "last_result": self.last_result,
            "session_problem": self.session_problem,
            "car_state_problem": self.car_state_problem,
            # 诊断: 每轮实际耗时(请求本身约 0.2s; 常年几十秒说明在网络层等超时)
            "cycle_seconds": round(self.last_cycle_seconds, 1),
            "photo_upload_ms": self._photo_upload_ms_acc,
            "photo_pending": self._photo_pending,
        }

    def _adapt_poll_interval(self) -> None:
        """轮询档位: 行驶 6s / 出发提速 6s / 短停快档 6s / 限流退避 / 停车(可调, 默认 60s)。

        决策逻辑在 `api.choose_poll_seconds`(纯函数, 有单测)。这里只负责算两个输入:
          * `driving`: 车辆状态=driving 或车速>0
          * `launch_boost`: 停车但**解锁 / 上电(ready) / 挡位非 P** —— 说明可能要出发了;
            等价 EU 版 mate 的 PARKED_ALERT。为避免"解锁后一直不开车"长期高频, 提速最长
            `LAUNCH_BOOST_MAX_SECONDS`(10 分钟), 且只在**刚出现**这个迹象时重新计时。

        注意: 这个函数以前只在"首轮"被调用(被 `_collect` 的提前返回绕过), 导致"行驶中提速"
        实际从未生效 —— 现在它在每轮 `_refresh_car_data()` 末尾都会跑。
        """
        now = time.time()
        opts = self.entry.options
        parked = int(opts.get(CONF_POLL_SECONDS) or DEFAULT_POLL_SECONDS)
        trip = int(opts.get(CONF_DRIVING_POLL_SECONDS) or DEFAULT_DRIVING_POLL_SECONDS)
        boost_on = bool(opts.get(CONF_LAUNCH_BOOST, DEFAULT_LAUNCH_BOOST))
        st = self.state
        driving = bool(st and (st.vehicle_state == "driving" or (st.get("speed") or 0) > 0))

        launch_hint = False
        if boost_on and st is not None and not driving:
            gear = st.get("gear")
            gear_hint = gear is not None and gear not in (0, 2)
            launch_hint = bool(st.locked is False or st.flag("ready") or gear_hint)
        if launch_hint and not self._launch_hint_prev:
            self._launch_boost_until = now + LAUNCH_BOOST_MAX_SECONDS
            log.debug("可能要出发(解锁/上电/非 P) -> %d 秒内按行程采样间隔轮询",
                      LAUNCH_BOOST_MAX_SECONDS)
        if not boost_on:
            self._launch_boost_until = 0.0
        self._launch_hint_prev = launch_hint
        boost_active = launch_hint and now < self._launch_boost_until
        # 短停快档: 行程刚结束的一段时间内也用快档(充电时不启用 —— 充电是长时间驻留)
        short_stop = bool(not driving and self._short_stop_until and now < self._short_stop_until
                          and not (st is not None and st.charging))
        rate_limited = now < self._rate_limited_until

        target = choose_poll_seconds(parked=parked, trip=trip, driving=driving,
                                     launch_boost=boost_active, short_stop=short_stop,
                                     rate_limited=rate_limited)
        want = timedelta_seconds(target)
        if self.update_interval != want:
            self.update_interval = want
            why = ("限流退避" if rate_limited else "行驶中" if driving
                   else "出发提速" if boost_active else "短停快档" if short_stop
                   else "停车/充电")
            log.debug("轮询间隔 -> %s 秒(%s)", target, why)

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
        """**唯一**的会话提醒: 免短信续期也没救回来、且服务端已拒收时, 提醒用户重新认证。

        触发条件(见 `_collect` 的登录分支): 车端请求被服务端判为会话失效, 且
        `_account_refresh_if_needed(force=True)` 也没成功。此时车端 token 可能还活着
        (能再撑约 2 小时), 所以是"提醒"而不是立刻停摆。
        "快到期"之类的提前提醒已删除: 账号 token 平时会被静默续期,
        提前提醒纯属噪音; 提醒发出后若会话恢复健康, 本通知会被
        `_clear_stale_session_notices` 自动清掉。
        """
        if self._expiry_warned:
            return
        self._expiry_warned = True
        self._notices_cleared = False        # 发出提醒后, 等健康周期再清一遍(届时复位标记)
        try:
            await self.hass.services.async_call(
                "persistent_notification", "create",
                {
                    "title": "零跑汽车: 账号会话需要重新认证",
                    "message": (
                        "自动续期失败, 账号会话已被云端拒收"
                        "(车端 token 若仍有效, 数据还能再更新约两小时)。"
                        "请到 设置 → 设备与服务 → 零跑 点「重新认证」, 收一条短信填进去即可"
                        "(不需要删除集成)。"
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

    async def _clear_stale_session_notices(self) -> None:
        """会话健康时清掉历史会话提醒, 并把"已提醒"标记复位。

        两个用途:
          * 清掉**老版本**可能留下的「登录会话快到期」通知(该预提醒已删除, 但仍挂在
            用户的通知栏里)—— 这条一律清, 因为那个概念已不存在;
          * 「需要重新认证」通知: **只在会话已恢复健康时**才撤掉 —— 如果车端 token
            还活着(账号会话死了但车还能用), 车况帧照常能拉到, 此时**不能**把刚发出的
            提醒撤掉(否则等于没提醒)。

        每次"健康期"只清一次(`_notices_cleared` 节流), 不用每轮都调服务;
        对不存在的通知 dismiss 是无操作, 所以开机首轮也会顺手清一次老残留。
        """
        if self._notices_cleared:
            return
        self._notices_cleared = True
        try:
            await self.hass.services.async_call(
                "persistent_notification", "dismiss",
                {"notification_id": f"{DOMAIN}_session_expiry"},
                blocking=False,
            )
            if not self.session_problem:          # 会话真健康才撤"需重新认证"提醒
                await self.hass.services.async_call(
                    "persistent_notification", "dismiss",
                    {"notification_id": f"{DOMAIN}_session_expired"},
                    blocking=False,
                )
                if self._expiry_warned:
                    self._expiry_warned = False   # 会话已恢复: 将来真出问题时还能再提醒
                    log.info("会话已恢复健康: 已清理会话提醒, 后续失败仍会重新提醒")
        except Exception as err:  # noqa: BLE001
            log.debug("清理会话提醒失败: %s", err)

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
        实测 `code=200`;refreshToken 不轮换, 只要在它有效期内调用就能
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

    async def ensure_lastweek_ec(self, max_age: float = LASTWEEK_EC_REFRESH_SECONDS,
                                 *, force: bool = False) -> dict:
        """上周能耗拆分(驱动/空调/其它, kWh)—— 缓存读, 过期才去云端拉。

        取数策略(实测后定的): 这是**周汇总**(上周一~上周日, 周一零点才翻篇),
        所以只在"卡片打开 / 手动刷新"这类按需时刻取; 缓存失效条件(任一满足):
          * 超过 `max_age`(默认 1 小时);
          * "上周"窗口本身翻篇了(周一凌晨, 缓存里记的 begin 与当前算出的不一致)。
        失败时保留上一次的好数据 —— 数据自带它所属的周窗口, 卡片会如实标出是哪一周。
        """
        now = time.time()
        begin, end = previous_week_window_seconds()
        fresh = bool(self._lastweek_ec) and self._lastweek_ec.get("begin") == begin             and (now - self._lastweek_ec_ts) < max_age
        if fresh and not force:
            return self._lastweek_ec
        if self._lastweek_ec_fetching:
            return self._lastweek_ec or {}
        self._lastweek_ec_fetching = True
        try:
            resp = await self.hass.async_add_executor_job(
                self.client.get_lastweek_ec, self.vin, begin, end)
        except Exception as err:  # noqa: BLE001
            log.debug("上周能耗拆分获取异常: %s", err)
            return self._lastweek_ec or {}
        finally:
            self._lastweek_ec_fetching = False
        data = (resp.get("data") or {}) if isinstance(resp, dict) else {}
        if not isinstance(data, dict) or not any(
                k in data for k in ("driverEC", "acEC", "otherEC")):
            log.debug("上周能耗拆分响应异常(code=%s), 保留旧值",
                      resp.get("code") if isinstance(resp, dict) else None)
            return self._lastweek_ec or {}
        parsed = parse_lastweek_ec(data)
        self._lastweek_ec = {**parsed, "begin": begin, "end": end, "fetched_at": now}
        self._lastweek_ec_ts = now
        log.debug("上周能耗拆分已更新: %s", parsed)
        return self._lastweek_ec

    # ── 官方逐日能耗(getEC 任意窗口 + 持久缓存, 见 energy_daily.py) ──
    async def ensure_energy_days(self, days: int = 7, *, budget: int = 0) -> dict:
        """补齐最近 `days` 天的官方逐日能耗, 返回序列(卡片/传感器共用)。

        官方 getEC 一次只问一天(实测单日窗口可用), 所以:
          * **已完结的日子**拉一次就进持久缓存, 历史不再重问(月视图第二次打开零请求);
          * **今天**还在累积, 按 TTL(30 分钟)重取; 云端还没记到(=未找到数据)时**不落缓存**,
            调用方用本机自记兜底(不会把"今天 0 消耗"错画出来);
          * 单次调用最多补 `budget` 天(卡片按需 20 天、轮询重数据 3 天), 没补完由返回的
            `pending` 计数告知, 卡片会稍后自动续拉(分批到位, 首屏不等一长串请求)。
        """
        from .trips import recent_day_windows

        now = time.time()
        windows = recent_day_windows(int(days), now)
        store: EnergyDayStore | None = self.energy_days
        if store is None:
            return {"days": [], "source": "official", "pending": 0}
        if budget <= 0:
            budget = ENERGY_FETCH_BUDGET_WS
        todo = store.plan(windows, now, fetch_today=True, budget=int(budget))
        for day, begin, end in todo:
            is_today = day == windows[-1][0]
            try:
                resp = await self.hass.async_add_executor_job(
                    self.client.get_lastweek_ec, self.vin, begin, end)
            except Exception as err:  # noqa: BLE001
                log.debug("官方逐日能耗(%s)获取异常: %s", day, err)
                store.record_miss(day, now, is_today=is_today)
                continue
            if is_rate_limited(resp if isinstance(resp, dict) else None):
                self._enter_rate_limit("getEC 返回风控/限流提示")
                store.record_miss(day, now, is_today=is_today)
                break
            parsed = parse_getec_day(resp)
            if parsed == "empty":
                store.record_empty(day, now, is_today=is_today)
            elif isinstance(parsed, dict):
                store.record(day, parsed, now)
            else:
                store.record_miss(day, now, is_today=is_today)
        return self.energy_days_view(int(days), now=now, windows=windows)

    def energy_days_view(self, days: int = 7, *, now: float | None = None,
                         windows: list | None = None) -> dict:
        """从缓存组装逐日序列(不联网; 供 WS 命令与传感器读取)。

        - `km/eff` 的兜底序: 自记行程 → 「近7天里程」传感器(仅 7 天窗口);
        - `kwh` 优先官方 getEC, 官方没有的日子用自记(标 `kwh_src:"trip"` 供界面注明);
        - `pending` = 还差几天没官方数据 —— **不含今天**(今天本来就可能还没生成),
          卡片据此决定要不要过一会儿再拉一次。
        """
        from .trips import recent_day_windows

        now = now or time.time()
        win = windows if windows is not None else recent_day_windows(int(days), now)
        if not win:
            return {"days": [], "source": "official", "pending": 0, "coverage_from": None}
        # 里程: 优先自记(与行程卡同口径); 自记没有的那几天退回云端逐日里程(官方口径)
        trip = (self.trips.daily_series(len(win), now) if self.trips is not None
                else {"days": []})
        trip_by_day = {d["day"]: d for d in trip.get("days", [])}
        km_by_day: dict[str, float] = {}
        cloud_km = self._cloud_mileage_by_day()
        for day, _b, _e in win:
            t = trip_by_day.get(day) or {}
            if t.get("km") is not None:
                km_by_day[day] = float(t["km"])
            elif cloud_km.get(day) is not None:
                km_by_day[day] = float(cloud_km[day])
        store: EnergyDayStore | None = self.energy_days
        official = store.snapshot() if store is not None else {}
        out, source = compose_days(win, km_by_day, official, trip_by_day)
        pending = store.missing(win) if store is not None else 0
        cov = next((d["day"] for d in out
                    if d["km"] is not None or d["kwh"] is not None), None)
        return {"days": out, "source": source, "pending": pending,
                "coverage_from": cov}

    def _cloud_mileage_by_day(self) -> dict[str, float]:
        """「近7天里程」传感器那份逐日里程(day → km); 拿不到就空 dict。"""
        mileage = ((self.data or {}).get("mileage") or {})
        detail = ((mileage.get("mileage7") or {}).get("detail")
                  or mileage.get("detail") or [])
        out: dict[str, float] = {}
        for x in detail or []:
            if not isinstance(x, dict):
                continue
            day = str(x.get("day") or "")
            km = x.get("accumulatedMileage")
            if day and km is not None:
                try:
                    out[day] = float(km)
                except (TypeError, ValueError):
                    pass
        return out

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


# ⚠️ 轮询间隔的最小值: **6 秒**(与 `MIN_DRIVING_POLL_SECONDS` 对齐), 不是 60 秒。
# 这里曾经写死 `max(60, seconds)` —— 那是"两档轮询"(行驶 60/停车 300)时代留下的下限;
# 后来加了"行驶 6 秒"档, 决策函数算出了 6, 却在这个最后一步被悄悄钳成 60,
# 结果**"行驶中提速"从未真正生效**(实测: 用户在开车时轮询仍是 60 秒一次,
# 行程点间隔 60~136 秒、短途行程被整段漏掉而变成"补记")。
MIN_UPDATE_INTERVAL = 6


def timedelta_seconds(seconds: int):
    from datetime import timedelta

    return timedelta(seconds=max(MIN_UPDATE_INTERVAL, seconds))
