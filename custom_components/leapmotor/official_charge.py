"""官方充电记录同步(App 1.23.05 充电中心「充电记录」)。

数据来源(CN 车云, 2026-11-21 实测):
  POST /carownerservice/charge/daily/detail/page  逐笔充电明细(仅近三个月)
  POST /carownerservice/charge/statistic/year     年度统计(累计充入电量/次数/快充占比/逐月电量)

设计原则(见 docs/PRIVATE-CHARGE-CENTER-1.23.05.md 的「账本接入设计」):
* 只读、低频同步; 不进入实时轮询观测关联路径, 不会把当前采样帧归入新出现的账本尾记录。
* 官方「充入电量」优先, 本地估算兜底; 匹配不到本地记录的官方明细只留在官方缓存,
  不凭空写进本地账本(避免重复、也避免破坏已有电价/分时曲线)。
* 时间匹配以「充电枪开始/结束时间」与本地会话起止的重叠为准, 唯一匹配才采用;
  充电枪开始时间可能早于本地首次采样(插枪到开始充电有时间差), 所以允许起止容差。
* 云端只给总量时, 分时分布与费用仍是估算: 本地区间电量按比例缩放到官方总量再按电价分配。
* 子账号实测看不到车主充电记录(接口返回空), 此时静默保留本地估算, 不报错。
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
import hashlib
import logging
from typing import Any

log = logging.getLogger(__name__)

# 官方明细只保留近三个月左右; 多取几天让边界完整(服务端会自行截断)。
DETAIL_WINDOW_DAYS = 92
# 同一账号年度统计只取「当年 + 上一年」, 避免每次同步多次请求。
YEAR_STAT_COUNT = 2
# 两次同步的最小间隔(秒)。充电明细有云端延迟, 高频拉取没有意义。
SYNC_MIN_INTERVAL_SECONDS = 6 * 3600
# 本地会话与官方记录允许的「开始时间」最大偏差(秒)。插枪→开始充电的间隔。
MATCH_START_TOLERANCE_SECONDS = 1800
# 时间重叠的硬性下限(秒)。
MATCH_MIN_OVERLAP_SECONDS = 1800

CHARGE_TYPE_MAP = {
    "SLOW": "ac", "AC": "ac", "1": "ac", "0": "ac",
    "QUICK": "dc", "DC": "dc", "2": "dc", "FAST": "dc",
}


def _number(value: Any) -> float | None:
    try:
        n = float(value)
    except (TypeError, ValueError):
        return None
    if n != n or n in (float("inf"), float("-inf")):  # NaN / inf
        return None
    return n


def _int_ts(value: Any) -> int | None:
    n = _number(value)
    if n is None or n <= 0:
        return None
    return int(n)


def normalize_record(raw: dict[str, Any]) -> dict[str, Any] | None:
    """把云端逐笔明细归一化为稳定结构(不含位置, 避免把车主的停车点带进 HA)。"""
    if not isinstance(raw, dict):
        return None
    start_ms = _int_ts(raw.get("chargeGunStartTs"))
    end_ms = _int_ts(raw.get("chargeGunEndTs"))
    # 官方时间戳是 epoch 毫秒; 小于 2001 年的值视为脏数据(秒级/占位值)。
    if start_ms is None or end_ms is None or end_ms <= start_ms or start_ms < 1_000_000_000_000:
        return None
    energy = _number(raw.get("chargeInEnergy"))
    charge_type = CHARGE_TYPE_MAP.get(str(raw.get("chargeType") or "").strip().upper(), "unknown")
    zone = str(raw.get("zone") or "").strip() or None
    return {
        "key": f"{start_ms}-{end_ms}",
        "started_at": start_ms / 1000.0,
        "ended_at": end_ms / 1000.0,
        "duration_seconds": int((end_ms - start_ms) // 1000),
        "energy_kwh": round(energy, 3) if energy is not None else None,
        "charge_type": charge_type,
        "zone": zone,
    }


def normalize_detail_response(response: dict[str, Any] | None) -> list[dict[str, Any]]:
    """解析 charge/daily/detail/page 响应 → 去重后的官方记录列表。"""
    if not isinstance(response, dict):
        return []
    data = response.get("data")
    if not isinstance(data, dict):
        return []
    out: list[dict[str, Any]] = []
    seen: set[str] = set()
    for raw in data.get("list") or []:
        record = normalize_record(raw)
        if record is None or record["key"] in seen:
            continue
        seen.add(record["key"])
        out.append(record)
    out.sort(key=lambda r: r["started_at"])
    return out


def normalize_year_stat(response: dict[str, Any] | None) -> dict[str, Any] | None:
    """解析 charge/statistic/year 响应 → 年度统计结构(无数据时返回 0 值结构)。"""
    if not isinstance(response, dict):
        return None
    data = response.get("data")
    if not isinstance(data, dict):
        return None
    months: list[dict[str, Any]] = []
    for raw in data.get("chargeStatisList") or []:
        if not isinstance(raw, dict):
            continue
        day = str(raw.get("statisDay") or "")
        month = day[:7] if len(day) >= 7 else None
        energy = _number(raw.get("chargeInEnergy"))
        if month is None or energy is None:
            continue
        months.append({"month": month, "energy_kwh": round(energy, 3)})
    months.sort(key=lambda m: m["month"])
    total_energy = _number(data.get("totalChargeInEnergy")) or 0.0
    count = _number(data.get("totalChargeCounts"))
    percent = _number(data.get("fastChargePercent"))
    return {
        "total_energy_kwh": round(total_energy, 3),
        "total_count": int(count) if count is not None else 0,
        "fast_charge_percent": round(percent, 1) if percent is not None else None,
        "months": months,
    }


def match_official_to_sessions(
    records: list[dict[str, Any]],
    sessions: list[dict[str, Any]],
    *,
    start_tolerance: float = MATCH_START_TOLERANCE_SECONDS,
) -> dict[str, dict[str, Any]]:
    """官方记录 → 本地已结束充电会话的 1:1 匹配。

    sessions 为 ChargeRecorder.sessions(已完成会话), 需要 `id` / `started_at` /
    `ended_at`(缺失时用 `last_at`)。返回 {session_id: official_record}。
    只有重叠足够(或开始时间足够接近且有重叠)才算匹配; 每条官方记录最多用一次。
    """
    candidates: list[tuple[float, int, int]] = []  # (score, session_idx, record_idx)
    for si, session in enumerate(sessions):
        if not isinstance(session, dict):
            continue
        local_start = _number(session.get("started_at"))
        local_end = _number(session.get("ended_at")) or _number(session.get("last_at"))
        if local_start is None or local_end is None or local_end <= local_start:
            continue
        for ri, record in enumerate(records):
            r_start = float(record["started_at"])
            r_end = float(record["ended_at"])
            overlap = min(local_end, r_end) - max(local_start, r_start)
            if overlap <= 0:
                continue
            start_gap = abs(local_start - r_start)
            duration = max(1.0, min(r_end - r_start, local_end - local_start))
            needed = min(float(MATCH_MIN_OVERLAP_SECONDS), 0.5 * duration)
            if overlap < needed and start_gap > start_tolerance:
                continue
            # 重叠比例越高、开始时间越接近越可信; 完全包含关系给更高分。
            score = overlap / duration - min(start_gap, start_tolerance) / (4 * start_tolerance)
            candidates.append((score, si, ri))
    candidates.sort(reverse=True)
    used_sessions: set[int] = set()
    used_records: set[int] = set()
    matches: dict[str, dict[str, Any]] = {}
    for _score, si, ri in candidates:
        if si in used_sessions or ri in used_records:
            continue
        session = sessions[si]
        session_key = session.get("id")
        if not isinstance(session_key, str):
            continue
        used_sessions.add(si)
        used_records.add(ri)
        matches[session_key] = dict(records[ri])
    return matches


def scale_intervals(intervals: list, official_kwh: float | None) -> tuple[list, float | None]:
    """把本地估算区间按比例缩放到官方充入电量。

    返回 (缩放后的区间副本, 官方电量或 None)。估算总量为 0 时不缩放、也不声称官方口径。
    """
    if not intervals:
        return [], official_kwh if official_kwh else None
    if official_kwh is None or official_kwh <= 0:
        return list(intervals), None
    total = 0.0
    for item in intervals:
        if isinstance(item, (list, tuple)) and len(item) >= 3:
            value = _number(item[2])
            if value is not None and value > 0:
                total += value
    if total <= 0:
        return list(intervals), None
    ratio = official_kwh / total
    scaled = []
    for item in intervals:
        if not isinstance(item, (list, tuple)) or len(item) < 4:
            continue
        a, b, kwh, source = item[0], item[1], item[2], item[3]
        value = _number(kwh)
        scaled.append([a, b, (value if value is not None else 0.0) * ratio, source])
    return scaled, official_kwh


def snapshot_is_invisible(snapshot: dict[str, Any] | None) -> bool:
    """同步结果是否"空但成功"(当前账号看不到车主充电记录)。"""
    if not isinstance(snapshot, dict) or snapshot.get("error"):
        return False
    if snapshot.get("records"):
        return False
    stats = snapshot.get("year_stats")
    if isinstance(stats, dict):
        for value in stats.values():
            if not isinstance(value, dict):
                continue
            if (value.get("total_count") or 0) > 0 or (value.get("total_energy_kwh") or 0) > 0:
                return False
    return True


def official_cache_scope(account_id: str, vin: str) -> str:
    """Bind persisted evidence to the signed-in account without storing its identifier."""
    if not account_id:
        return ""
    return hashlib.sha256(f"{vin.strip().upper()}:{account_id}".encode()).hexdigest()


class OfficialChargeStore:
    """官方充电记录的持久缓存(逐笔明细 + 年度统计)。

    `records` 只保留近三个月明细; `year_stats` 按年份保留。二者都是「官方口径」,
    本地账本只有匹配成功时才会引用其中一笔记录的能量。
    """

    STORAGE_VERSION = 1

    def __init__(self, hass: Any, vin: str, *, account_scope: str, store: Any = None) -> None:
        if store is None:
            from homeassistant.helpers.storage import Store
            store = Store(hass, self.STORAGE_VERSION, f"leapmotor_{vin}_official_charges")

        self.hass = hass
        self.vin = vin
        self.account_scope = account_scope
        self._store = store
        self.records: list[dict[str, Any]] = []
        self.year_stats: dict[int, dict[str, Any]] = {}
        self.fetched_at: float | None = None
        self.window: dict[str, str] | None = None
        self.last_error: str | None = None
        self.available: bool | None = None  # None=未知(未同步过), True/False=是否有官方数据

    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        if not self.account_scope or data.get("account_scope") != self.account_scope:
            return
        records = data.get("records")
        self.records = [r for r in records if isinstance(r, dict) and r.get("key")] if isinstance(records, list) else []
        stats = data.get("year_stats")
        if isinstance(stats, dict):
            for key, value in stats.items():
                try:
                    year = int(key)
                except (TypeError, ValueError):
                    continue
                if isinstance(value, dict):
                    self.year_stats[year] = value
        self.fetched_at = _number(data.get("fetched_at"))
        self.window = data.get("window") if isinstance(data.get("window"), dict) else None
        self.last_error = data.get("last_error") if isinstance(data.get("last_error"), str) else None
        available = data.get("available")
        self.available = bool(available) if isinstance(available, bool) else None

    def _dump(self) -> dict[str, Any]:
        return {
            "account_scope": self.account_scope,
            "records": self.records,
            "year_stats": {str(year): stat for year, stat in self.year_stats.items()},
            "fetched_at": self.fetched_at,
            "window": self.window,
            "last_error": self.last_error,
            "available": self.available,
        }

    def _save(self) -> None:
        self._store.async_delay_save(self._dump, 5)

    # ---- 同步 ----
    def due(self, now: float | None = None) -> bool:
        import time as _time

        now = _time.time() if now is None else now
        return self.fetched_at is None or (now - self.fetched_at) >= SYNC_MIN_INTERVAL_SECONDS

    @staticmethod
    def window_for(today: date, days: int = DETAIL_WINDOW_DAYS) -> dict[str, str]:
        start = today - timedelta(days=max(1, days))
        return {"start": start.isoformat(), "end": today.isoformat()}

    def apply_snapshot(self, snapshot: dict[str, Any]) -> list[dict[str, Any]]:
        """写入一次同步结果, 返回当前(可能是保留的)官方逐笔记录列表。

        账号看不到车主充电记录时(子账号/权限不足), 接口会返回"空但成功"的响应;
        这种响应不能覆盖已经拿到的官方数据, 只把 `available` 置 False 并保留缓存。
        """
        records = snapshot.get("records")
        records = [r for r in records if isinstance(r, dict) and r.get("key")] if isinstance(records, list) else []
        stats_in = snapshot.get("year_stats") if isinstance(snapshot.get("year_stats"), dict) else {}
        invisible = not records and not any(
            (v.get("total_count") or 0) > 0 or (v.get("total_energy_kwh") or 0) > 0
            for v in stats_in.values() if isinstance(v, dict)
        )
        has_cache = bool(self.records) or any(
            (v.get("total_count") or 0) > 0 or (v.get("total_energy_kwh") or 0) > 0
            for v in self.year_stats.values() if isinstance(v, dict)
        )
        self.fetched_at = float(snapshot.get("fetched_at") or 0) or None
        self.window = snapshot.get("window") if isinstance(snapshot.get("window"), dict) else self.window
        self.last_error = snapshot.get("error") if isinstance(snapshot.get("error"), str) else None
        if not self.account_scope or (invisible and has_cache):
            # 无权限/不可见: 保留上次的官方缓存, 不把"看不见"当成"没有充电"。
            self.available = False
            self._save()
            return []
        if self.available is False:
            self.year_stats.clear()
        self.records = records
        for year, value in stats_in.items():
            try:
                year = int(year)
            except (TypeError, ValueError):
                continue
            if isinstance(value, dict):
                self.year_stats[year] = value
        self.available = bool(self.records) or any(
            (stat.get("total_count") or 0) > 0 for stat in self.year_stats.values()
        )
        self._save()
        return list(self.records)

    # ---- 对外视图 ----
    def match(self, sessions: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
        return match_official_to_sessions(self.records, sessions) if self.available else {}

    def year_view(self, year: int | None = None) -> dict[str, Any] | None:
        if not self.available or not self.year_stats:
            return None
        if year is None:
            year = max(self.year_stats)
        stat = self.year_stats.get(int(year))
        if stat is None:
            return None
        return {"year": int(year), **stat}

    def view(self) -> dict[str, Any]:
        """给 websocket/诊断用的官方数据视图(不含账号/位置等敏感信息)。"""
        return {
            "vin": self.vin,
            "available": self.available,
            "fetched_at": self.fetched_at,
            "window": self.window,
            "last_error": self.last_error,
            "record_count": len(self.records) if self.available else 0,
            "records": list(self.records) if self.available else [],
            "years": {str(year): stat for year, stat in sorted(self.year_stats.items())} if self.available else {},
        }


def fetch_snapshot(client: Any, vin: str, *, today: date | None = None,
                   years: int = YEAR_STAT_COUNT, timezone: str = "UTC+8") -> dict[str, Any]:
    """同步拉取一次官方数据(同步阻塞函数, 由调用方放进 executor)。

    失败时返回 {"error": ...} 并尽量保留能拿到的部分, 不抛异常(低频同步不应影响轮询)。
    """
    import time as _time

    today = today or datetime.now().date()
    window = OfficialChargeStore.window_for(today)
    snapshot: dict[str, Any] = {"window": window, "fetched_at": _time.time()}
    try:
        detail = client.get_charge_records(vin, start_time=window["start"],
                                          end_time=window["end"], timezone=timezone)
        if not isinstance(detail, dict) or detail.get("code") not in (0, None):
            message = ""
            if isinstance(detail, dict):
                message = str(detail.get("message") or detail.get("description") or "")
            snapshot["error"] = f"充电明细不可用: {message[:120]}"
        else:
            snapshot["records"] = normalize_detail_response(detail)
    except Exception as err:  # noqa: BLE001
        snapshot["error"] = f"充电明细请求失败: {type(err).__name__}"
    stats: dict[int, dict[str, Any]] = {}
    for offset in range(max(1, years)):
        year = today.year - offset
        try:
            response = client.get_charge_year_stat(vin, year=year, timezone=timezone)
        except Exception as err:  # noqa: BLE001
            if "error" not in snapshot:
                snapshot["error"] = f"{year} 年统计请求失败: {type(err).__name__}"
            continue
        if not isinstance(response, dict) or response.get("code") not in (0, None):
            continue
        stat = normalize_year_stat(response)
        if stat is not None:
            stats[year] = stat
    snapshot["year_stats"] = stats
    return snapshot
