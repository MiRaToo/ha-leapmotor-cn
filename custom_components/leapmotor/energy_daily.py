"""官方逐日能耗(getEC)缓存 + 逐日序列组装。

背景: 里程/能耗卡的「耗电」线原先用云端 `mileage/energy/detail` 的
`accumulatedEnergyConsume` —— 实测该字段**不可靠**(逐日大量为 0、7 天求和 11 kWh vs
官方聚合 44.6; 老日子也不"沉淀"; kerniger 版把它标 `presumed_driving_only / confirmed:false`,
mate 干脆不用)。但官方 getEC(`getLastweekEC?begintime=&endtime=`)实测**支持任意窗口**
(单日也返回), 给的是驱动/空调/其它拆分 —— 与官方 App 周报同源、0.1 kWh、且口径明确
(**不含驻停/待机**)。本模块就把这张卡的数据源换到它上面。

做法(参照 leapmotor-mate 的账本思路, 不抄代码):
  * **已完结的日子**只拉一次, 存持久缓存 → 历史不变、月视图零请求;
  * 缺的日子按需补拉(`plan` 决定顺序与预算): 单次调用有上限, 没补完的报 `pending` 让卡片续拉;
  * **今天**还在进行中: 按 TTL 重取; 云端对"今天还没记到行驶"回 `未找到数据` —— 此时**不落
    缓存**、交给调用方回退本机自记(行程表), 免得把 0 当成"今天一度没花";
  * **过去某天** `未找到数据` = 官方认为那天没有行驶能耗 → 记 **0**(与 mate 一致);
  * 失败(超时/签名族/未知载荷) 不落任何东西, 下次调用自然重试。

本模块**不 import HA 的运行时**(Store 延迟导入, 与 trips.py 同一做法), 纯函数部分可离线单测。
"""
from __future__ import annotations

import logging
import math
import time
from datetime import date, datetime, time as datetime_time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

log = logging.getLogger(__name__)

STORE_VERSION = 1
ENERGY_FETCH_BUDGET_WS = 10      # 卡片按需补拉: 一次 WS 调用最多补几天(月视图分几轮补完)
ENERGY_FETCH_BUDGET_HEAVY = 3    # 轮询的重数据周期里最多补几天(首次升级后分几轮补齐; 平时 1 天/天)
ENERGY_TODAY_TTL_SECONDS = 1800  # "今天"的结果最多用 30 分钟, 之后重取(仅卡片按需路径)
ENERGY_MISS_RETRY_SECONDS = 3600 # 失败的(过去)日子 1 小时内不再重试 —— 免得死磕烂数据
ENERGY_KEEP_DAYS = 400           # 缓存保留天数(getEC 可回溯, 但我们只需卡片窗口那点历史)
V1_STORE_KEY = "daily_energy_v1"
V1_STORE_VERSION = 2
V1_TODAY_TTL_SECONDS = 1800
V1_MISS_RETRY_SECONDS = 3600


def parse_getec_day(resp: Any) -> dict[str, float] | str | None:
    """把一次 getEC 响应解析成三种结果:

      * `{"driver","ac","other","total"}` —— 有数据(kWh, float);
      * `"empty"`  —— 官方明确"这个窗口没有行驶能耗"(`code/result == 100` 或"未找到数据");
      * `None`     —— 其它异常(网络超时/签名族/未知载荷), **不落缓存**, 调用方稍后重试。

    注意 `code=2`(请求参数含非法字符)常见于"窗口终点晚于现在", 按异常处理(重试会自愈)。
    """
    if not isinstance(resp, dict):
        return None
    data = resp.get("data")
    if isinstance(data, dict) and any(
            k in data for k in ("driverEC", "acEC", "otherEC")):
        def _f(v: Any) -> float | None:
            try:
                return float(v)
            except (TypeError, ValueError):
                return None

        driver, ac, other = _f(data.get("driverEC")), _f(data.get("acEC")), _f(data.get("otherEC"))
        total = sum(v for v in (driver, ac, other) if v is not None)
        return {"driver": driver, "ac": ac, "other": other, "total": round(total, 2)}
    code = resp.get("code", resp.get("result"))
    msg = str(resp.get("message") or "")
    if code == 100 or "未找到数据" in msg or "no data" in msg.lower():
        return "empty"
    return None


def parse_getec_day_v1(resp: Any) -> dict[str, float] | str | None:
    """Strict official three-component parser for daily-energy v1.

    All three components must be finite non-negative JSON numbers or decimal numeric
    strings. Partial sums, booleans and code100 zero promotion are rejected.
    """
    if not isinstance(resp, dict):
        return None
    data = resp.get("data")
    code = resp.get("code", resp.get("result"))
    message = str(resp.get("message") or "")
    if code == 100 or "未找到数据" in message or "no data" in message.lower():
        return "empty"
    if not isinstance(data, dict) or set(("driverEC", "acEC", "otherEC")) - set(data):
        return None

    def component(value: Any) -> float | None:
        if isinstance(value, bool):
            return None
        if isinstance(value, str):
            if not value or value.strip() != value:
                return None
            try:
                value = float(value)
            except ValueError:
                return None
        if not isinstance(value, (int, float)):
            return None
        number = float(value)
        return number if math.isfinite(number) and number >= 0 else None

    driver, ac, other = (component(data[key]) for key in ("driverEC", "acEC", "otherEC"))
    if driver is None or ac is None or other is None:
        return None
    total = driver + ac + other
    if not math.isfinite(total):
        return None
    return {"driver": driver, "ac": ac, "other": other, "total": total}


def day_windows_v1(days: int, zone: ZoneInfo, now: float | None = None) -> list[tuple[str, int, int]]:
    """HA-configured local calendar windows as closed integer-second ranges."""
    if not isinstance(days, int) or days < 1 or days > 31:
        raise ValueError("invalid_format")
    generated = int(time.time() if now is None else now)
    today = datetime.fromtimestamp(generated, zone).date()
    out: list[tuple[str, int, int]] = []
    for offset in range(days - 1, -1, -1):
        current = today - timedelta(days=offset)
        start_local = datetime.combine(current, datetime_time.min, zone)
        next_local = datetime.combine(current + timedelta(days=1), datetime_time.min, zone)
        start = int(start_local.timestamp())
        natural_end = int(next_local.timestamp()) - 1
        end = generated if offset == 0 else natural_end
        out.append((current.isoformat(), start, min(end, natural_end)))
    return out


class DailyEnergyV1Store:
    """Isolated strict cache; old EnergyDayStore values are never promoted."""

    def __init__(self, hass: Any, vin: str, store: Any = None, *, time_zone: str) -> None:
        self.time_zone = time_zone
        self.vin = str(vin or "").strip().upper()
        if store is not None:
            self._store = store
        else:
            from homeassistant.helpers.storage import Store
            self._store = Store(hass, V1_STORE_VERSION, f"leapmotor_{self.vin}_{V1_STORE_KEY}")
        self._days: dict[str, dict] = {}
        self._tried: dict[str, float] = {}

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        raw_days = data.get("days") if isinstance(data, dict) else {}
        self._days = {}
        for day, value in (raw_days or {}).items():
            if self._valid_record(day, value):
                self._days[str(day)] = value
        raw_tried = data.get("tried") if isinstance(data, dict) else {}
        now = time.time()
        self._tried = {str(day): float(at) for day, at in (raw_tried or {}).items()
                       if self._valid_day(day) and self._number(at)
                       and float(at) <= now + 300 and now - float(at) < 86400 * 2}

    @staticmethod
    def _number(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and float(value) >= 0

    @staticmethod
    def _integer(value: Any) -> bool:
        return isinstance(value, int) and not isinstance(value, bool) and value >= 0

    @staticmethod
    def _valid_day(value: Any) -> bool:
        if not isinstance(value, str):
            return False
        try:
            return date.fromisoformat(value).isoformat() == value
        except ValueError:
            return False

    def _valid_record(self, day: Any, value: Any) -> bool:
        if not self._valid_day(day) or not isinstance(value, dict):
            return False
        time_zone = value.get("time_zone")
        if (str(value.get("vin") or "").strip().upper() != self.vin
                or value.get("day") != day or not isinstance(time_zone, str) or not time_zone
                or not all(self._number(value.get(key))
                           for key in ("driver", "ac", "other", "total"))
                or not all(self._integer(value.get(key))
                           for key in ("start_ts", "end_ts", "at"))
                or value["end_ts"] < value["start_ts"]):
            return False
        total = float(value["driver"]) + float(value["ac"]) + float(value["other"])
        return math.isclose(float(value["total"]), total, rel_tol=1e-12, abs_tol=1e-12)

    def _dump(self) -> dict[str, Any]:
        if len(self._days) > ENERGY_KEEP_DAYS:
            for day in sorted(self._days)[:-ENERGY_KEEP_DAYS]:
                self._days.pop(day, None)
        return {"contract_version": 1, "vin": self.vin,
                "days": self._days, "tried": self._tried}

    def _save_soon(self) -> None:
        self._store.async_delay_save(self._dump, 5)

    def record(self, day: str, parsed: dict[str, float], time_zone: str, start: int, end: int,
               now: float | None = None) -> None:
        if (not self._valid_day(day) or time_zone != self.time_zone
                or not isinstance(parsed, dict)):
            raise ValueError("invalid_format")
        components = [parsed.get(key) for key in ("driver", "ac", "other")]
        if not all(self._number(value) for value in components):
            raise ValueError("invalid_format")
        bounds = (start, end)
        if not all(self._integer(value) for value in bounds) or end < start:
            raise ValueError("invalid_format")
        stamp = int(time.time() if now is None else now)
        if stamp < 0:
            raise ValueError("invalid_format")
        driver, ac, other = (float(value) for value in components)
        total = driver + ac + other
        if not math.isfinite(total):
            raise ValueError("invalid_format")
        self._days[day] = {"vin": self.vin, "day": day, "time_zone": time_zone,
                           "start_ts": int(start), "end_ts": int(end),
                           "driver": driver, "ac": ac,
                           "other": other, "total": total, "at": stamp}
        self._tried.pop(day, None)
        self._save_soon()

    def miss(self, day: str, now: float | None = None) -> None:
        if not self._valid_day(day):
            raise ValueError("invalid_format")
        self._tried[day] = float(time.time() if now is None else now)
        self._save_soon()

    def _cached(self, day: str, time_zone: str, start: int, end: int,
                *, today: bool) -> dict | None:
        value = self._days.get(day)
        if (time_zone != self.time_zone or not value or not self._valid_record(day, value)
                or value.get("time_zone") != time_zone or value.get("start_ts") != start):
            return None
        if today:
            if value.get("end_ts") < start or value.get("end_ts") > end:
                return None
        elif value.get("end_ts") != end:
            return None
        return value

    def state(self, day: str, time_zone: str, start: int, end: int,
              *, today: bool, now: float) -> tuple[dict, str] | None:
        value = self._cached(day, time_zone, start, end, today=today)
        if value is None:
            return None
        if not today:
            return value, "ready"
        failed_at = float(self._tried.get(day, 0.0))
        if failed_at > float(value["at"]) or now - float(value["at"]) >= V1_TODAY_TTL_SECONDS:
            return value, "stale"
        return value, "ready"

    def get(self, day: str, time_zone: str, start: int, end: int,
            *, today: bool = False, now: float | None = None) -> dict | None:
        state = self.state(day, time_zone, start, end, today=today,
                           now=float(time.time() if now is None else now))
        return state[0] if state else None

    def plan(self, windows: list[tuple[str, int, int]], time_zone: str, now: float, budget: int) -> list[tuple[str, int, int]]:
        todo = []
        today = windows[-1][0] if windows else ""
        for item in windows:
            day, start, end = item
            is_today = day == today
            state = self.state(day, time_zone, start, end, today=is_today, now=now)
            if not is_today and state is not None:
                continue
            if is_today and state is not None and state[1] == "ready":
                continue
            failed_at = float(self._tried.get(day, 0.0))
            if failed_at and now - failed_at < V1_MISS_RETRY_SECONDS:
                continue
            todo.append(item)
            if len(todo) >= max(1, int(budget)): break
        return todo


def compose_days_v1(windows: list[tuple[str, int, int]], parsed_days: dict[str, dict],
                    km_by_day: dict[str, float], km_sources: dict[str, str],
                    trip_by_day: dict[str, dict],
                    *, now: float, today: str,
                    official_status: dict[str, str] | None = None) -> list[dict]:
    """Compose source-aware v1 rows without filling unknown values with zero."""
    statuses = official_status or {}

    def metric(value: Any) -> float | None:
        if isinstance(value, bool):
            return None
        try:
            number = float(value)
        except (TypeError, ValueError, OverflowError):
            return None
        return number if math.isfinite(number) and number >= 0 else None

    out = []
    for day, start, end in windows:
        official = parsed_days.get(day)
        trip = trip_by_day.get(day) or {}
        km = metric(km_by_day.get(day))
        km_src = km_sources.get(day) if km is not None else None
        if km_src not in ("official", "trip"):
            km = km_src = None
        if km is None:
            km = metric(trip.get("km"))
            km_src = "trip" if km is not None else None
        if km is None:
            km_status = "pending" if day == today else "unavailable"
        else:
            km_status = "ready"
        drv = metric(official.get("driver")) if official else None
        ac = metric(official.get("ac")) if official else None
        oth = metric(official.get("other")) if official else None
        official_valid = False
        if drv is not None and ac is not None and oth is not None:
            official_total = drv + ac + oth
            recorded_total = metric(official.get("total")) if official else None
            if (recorded_total is not None and math.isfinite(official_total)
                    and math.isclose(recorded_total, official_total, rel_tol=1e-12, abs_tol=1e-12)):
                kwh, kwh_src = official_total, "official"
                kwh_status = statuses.get(day, "ready")
                if kwh_status not in ("ready", "stale"):
                    kwh_status = "stale"
                official_valid = True
        if not official_valid and (trip_kwh := metric(trip.get("kwh"))) is not None:
            kwh, kwh_src, kwh_status = trip_kwh, "trip", "ready"
            drv = ac = oth = None
        elif not official_valid:
            kwh = kwh_src = drv = ac = oth = None
            kwh_status = "pending" if day == today else "unavailable"
        eff = round(kwh / float(km) * 100.0, 1) if km is not None and float(km) > 0.5 and kwh is not None and kwh > 0 else None
        out.append({"day": day, "start_ts": int(start), "end_ts": int(end),
                    "km": round(float(km), 1) if km is not None else None, "km_src": km_src,
                    "km_status": km_status, "kwh": kwh,
                    "kwh_src": kwh_src, "kwh_status": kwh_status, "eff": eff,
                    "drv": drv, "ac": ac, "oth": oth})
    return out


def trip_rows_by_windows_v1(trips: list[Any], windows: list[tuple[str, int, int]],
                            zone: ZoneInfo) -> dict[str, dict[str, float | None]]:
    """Bucket completed trips by HA-configured local day, with same-zone windows."""
    ended: list[tuple[Any, int]] = []
    for trip in trips:
        value = getattr(trip, "ended_at", None)
        if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(float(value)) and value > 0:
            ended.append((trip, int(value)))
    first_day = (datetime.fromtimestamp(min(value for _trip, value in ended), zone).date().isoformat()
                 if ended else None)
    rows: dict[str, dict[str, float | None]] = {}
    for day, begin, end in windows:
        known = first_day is not None and day >= first_day
        km = 0.0 if known else None
        kwh = 0.0 if known else None
        for trip, stamp in ended:
            if stamp < begin or stamp > end:
                continue
            if datetime.fromtimestamp(stamp, zone).date().isoformat() != day:
                continue
            distance = getattr(trip, "distance_km", None)
            energy = getattr(trip, "energy_kwh", None)
            if (isinstance(distance, (int, float)) and not isinstance(distance, bool)
                    and math.isfinite(float(distance)) and float(distance) >= 0):
                km = float(km or 0.0) + float(distance)
            if (isinstance(energy, (int, float)) and not isinstance(energy, bool)
                    and math.isfinite(float(energy)) and float(energy) >= 0):
                kwh = float(kwh or 0.0) + float(energy)
        rows[day] = {"km": round(km, 1) if km is not None else None,
                     "kwh": round(kwh, 2) if kwh is not None else None}
    return rows


class EnergyDayStore:
    """逐日官方能耗的持久缓存(一天一条; 纯内存 + 延迟落盘)。

    数据结构:
        days:  {"<日期>": {"driver":…, "ac":…, "other":…, "total":…, "empty": bool, "at": ts}}
        tried: {"<日期>": ts}   # "今天"的拉取尝试记录(空结果/失败也节流, 免得反复问)
    """

    def __init__(self, hass: Any, vin: str, store: Any = None) -> None:
        self.vin = vin
        if store is not None:
            self._store = store
        else:
            from homeassistant.helpers.storage import Store
            self._store = Store(hass, STORE_VERSION, f"leapmotor_{vin}_energy_days")
        self._days: dict[str, dict] = {}
        self._tried: dict[str, float] = {}

    # ── 持久化 ──
    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        days = data.get("days") if isinstance(data, dict) else {}
        self._days = {str(k): v for k, v in (days or {}).items()
                      if isinstance(v, dict) and isinstance(v.get("total"), (int, float))}
        tried = data.get("tried") if isinstance(data, dict) else {}
        now = time.time()
        self._tried = {str(k): float(v) for k, v in (tried or {}).items()
                       if isinstance(v, (int, float)) and now - float(v) < 86400 * 2}
        log.debug("官方逐日能耗缓存: 已载入 %d 天", len(self._days))

    def _dump(self) -> dict[str, Any]:
        self._prune()
        return {"days": self._days, "tried": self._tried}

    def _save_soon(self, delay: int = 5) -> None:
        self._store.async_delay_save(self._dump, delay)

    def _prune(self) -> None:
        if len(self._days) > ENERGY_KEEP_DAYS:
            for day in sorted(self._days)[:len(self._days) - ENERGY_KEEP_DAYS]:
                self._days.pop(day, None)
        if len(self._tried) > 3:
            for day in sorted(self._tried)[:-3]:
                self._tried.pop(day, None)

    # ── 读 ──
    def snapshot(self) -> dict[str, dict]:
        return self._days

    def get(self, day: str) -> dict | None:
        return self._days.get(day)

    def totals(self, days: list[str]) -> dict[str, Any]:
        """给传感器用: 求和 + 覆盖情况(缺的天不算进去, 由 covered 如实报出)。"""
        vals = [self._days[d]["total"] for d in days if d in self._days]
        return {"total": round(sum(vals), 2) if vals else None,
                "covered": len(vals), "missing": len(days) - len(vals)}

    # ── 写 ──
    def record(self, day: str, parsed: dict, now: float | None = None) -> None:
        self._days[day] = {"driver": parsed.get("driver"), "ac": parsed.get("ac"),
                           "other": parsed.get("other"), "total": parsed.get("total"),
                           "empty": False, "at": now or time.time()}
        self._tried.pop(day, None)
        self._save_soon()

    def record_empty(self, day: str, now: float | None = None,
                     *, is_today: bool = False) -> None:
        """官方明确"没有数据"。过去的日子 = 真实的 0(记下来); 今天 = **不落值**,
        只记一次尝试(那个 0 只是"还没记到", 回退自记更诚实)。"""
        now = now or time.time()
        if is_today:
            self._tried[day] = now
        else:
            self._days[day] = {"driver": 0.0, "ac": 0.0, "other": 0.0, "total": 0.0,
                               "empty": True, "at": now}
        self._save_soon()

    def record_miss(self, day: str, now: float | None = None, *, is_today: bool = False) -> None:
        """拉取失败/未知载荷: 不写值, 只记一次尝试时刻(过去的日子 1 小时内不再重试)。"""
        self._tried[day] = now or time.time()
        self._save_soon()

    # ── 补拉计划 ──
    def plan(self, windows: list[tuple[str, float, float]], now: float,
             *, fetch_today: bool, budget: int,
             today_ttl: float = ENERGY_TODAY_TTL_SECONDS,
             retry_after: float = ENERGY_MISS_RETRY_SECONDS) -> list[tuple[str, int, int]]:
        """决定这次该去云端补哪几天, 旧→新最多 `budget` 天。

        windows: `[(day, begin_epoch, end_epoch)]`(见 `trips.recent_day_windows`)。
        规则:
          * 过去的日子: 没缓存、且上次尝试不在 `retry_after` 内就补(失败不许死磕);
          * 今天(最后一项): 只有 `fetch_today` 时补; 已有值/刚试过且未过 TTL 就跳过。
        """
        today = windows[-1][0] if windows else ""
        todo: list[tuple[str, int, int]] = []
        for day, begin, end in windows:
            last = self._tried.get(day, 0.0)
            if day == today:
                if not fetch_today:
                    continue
                entry = self._days.get(day)
                last = max(float(entry["at"]) if entry else 0.0, last)
                if now - last < today_ttl:
                    continue
            else:
                if day in self._days:
                    continue
                if last > 0 and now - last < retry_after:   # 试过且还在冷却期才跳过
                    continue
            todo.append((day, int(begin), int(end)))
            if len(todo) >= budget:
                break
        return todo

    def missing(self, windows: list[tuple[str, float, float]],
                now: float | None = None) -> int:
        """还差几天没有官方数据(不含今天 —— 今天的数据本来就可能还没生成)。

        处在失败冷却期(1 小时)里的日子**不算 pending** —— 否则卡片会"pending>0 → 8 秒后
        重拉"无限循环(后端计划看到冷却会跳过, 白白打 WS)。冷却过后下一次自然加载/重数据周期
        会再试。
        """
        now = now or time.time()
        today = windows[-1][0] if windows else ""
        return sum(1 for day, _b, _e in windows
                   if day != today and day not in self._days
                   and now - self._tried.get(day, 0.0) >= ENERGY_MISS_RETRY_SECONDS)


def compose_days(windows: list[tuple[str, float, float]],
                 km_by_day: dict[str, float],
                 official: dict[str, dict],
                 trip_by_day: dict[str, dict],
                 min_eff_km: float = 0.5) -> tuple[list[dict], str]:
    """把三个来源拼成卡片要的逐日序列(纯函数)。

    优先级: 官方 getEC > 本机自记(仅当官方没有时兜底)。
    返回 `(days, source)`, source ∈ {"official","mixed","trip"}(总体标注; 每天还带
    `kwh_src` 供气泡标注"自记")。
    """
    out: list[dict] = []
    n_off = n_trip = 0
    for day, _begin, _end in windows:
        entry = official.get(day)
        t = trip_by_day.get(day) or {}
        km = km_by_day.get(day)
        if km is None and t.get("km") is not None:
            km = t.get("km")
        if entry is not None and entry.get("total") is not None:
            kwh = float(entry["total"])
            kwh_src = "official"
            n_off += 1
        elif t.get("kwh") is not None:
            kwh = float(t["kwh"])
            kwh_src = "trip"
            n_trip += 1
        else:
            kwh, kwh_src = None, None
        eff = None
        if km is not None and kwh is not None and float(km) > min_eff_km and kwh > 0:
            eff = round(kwh / float(km) * 100.0, 1)
        out.append({
            "day": day,
            "km": (round(float(km), 1) if km is not None else None),
            "kwh": (round(kwh, 2) if kwh is not None else None),
            "eff": eff,
            "kwh_src": kwh_src,
            "drv": entry.get("driver") if entry else None,
            "ac": entry.get("ac") if entry else None,
            "oth": entry.get("other") if entry else None,
        })
    if n_off and n_trip:
        source = "mixed"
    elif n_off:
        source = "official"
    elif n_trip:
        source = "trip"
    else:
        source = "official"
    return out, source
