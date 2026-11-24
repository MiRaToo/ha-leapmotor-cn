"""官方充电记录(1.23.05 充电记录)解析/匹配/合并的回归。无网络与 HA 运行时依赖。"""
import asyncio
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))
from official_charge import (  # noqa: E402
    MATCH_START_TOLERANCE_SECONDS,
    normalize_detail_response,
    normalize_record,
    normalize_year_stat,
    match_official_to_sessions,
    scale_intervals,
)
from charging import ChargeRecorder  # noqa: E402

ZONE = ZoneInfo("Asia/Hong_Kong")


def stamp(text):
    return datetime.strptime(text, "%Y-%m-%d %H:%M:%S").replace(tzinfo=ZONE).timestamp()


def raw_record(start="2026-11-01 22:00:08", end="2026-11-01 22:59:23", kind="SLOW", energy=56.11):
    start_ts = int(stamp(start) * 1000)
    end_ts = int(stamp(end) * 1000)
    return {
        "chargeGunStartTs": start_ts,
        "chargeGunEndTs": end_ts,
        "chargeEarliestTs": start_ts,
        "chargeLatestTs": end_ts,
        "chargeType": kind,
        "chargeInEnergy": energy,
        "chargeStartLongitude": "120.1",
        "chargeStartLatitude": "30.1",
        "zone": "UTC+8",
    }


def test_normalize_record_maps_cn_type_and_drops_location():
    rec = normalize_record(raw_record(kind="QUICK", energy=12.345))
    assert rec["charge_type"] == "dc"
    assert rec["energy_kwh"] == pytest.approx(12.345)
    assert rec["duration_seconds"] == int((stamp("2026-11-01 22:59:23") - stamp("2026-11-01 22:00:08")))
    assert "latitude" not in rec and "longitude" not in rec
    assert rec["key"].endswith("-" + str(int(stamp("2026-11-01 22:59:23") * 1000)))
    for kind, expected in (("SLOW", "ac"), ("QUICK", "dc"), ("1", "ac"), ("2", "dc"), ("", "unknown")):
        assert normalize_record(raw_record(kind=kind))["charge_type"] == expected


def test_normalize_record_rejects_broken_rows():
    assert normalize_record({}) is None
    assert normalize_record({"chargeGunStartTs": 1, "chargeGunEndTs": 2}) is None
    broken = raw_record()
    broken["chargeGunEndTs"] = broken["chargeGunStartTs"]
    assert normalize_record(broken) is None
    no_energy = raw_record()
    del no_energy["chargeInEnergy"]
    assert normalize_record(no_energy)["energy_kwh"] is None


def test_normalize_detail_response_dedupes_and_sorts():
    resp = {"data": {"total": 3, "list": [
        raw_record(start="2026-11-02 08:00:00", end="2026-11-02 09:00:00"),
        raw_record(start="2026-11-01 22:00:08", end="2026-11-01 22:59:23"),
        raw_record(start="2026-11-01 22:00:08", end="2026-11-01 22:59:23"),  # 重复
        {"broken": True},
    ]}}
    records = normalize_detail_response(resp)
    assert len(records) == 2
    assert records[0]["started_at"] < records[1]["started_at"]
    assert normalize_detail_response(None) == []
    assert normalize_detail_response({"data": {"list": None}}) == []


def test_normalize_year_stat_months_and_totals():
    stat = normalize_year_stat({"data": {
        "totalChargeCounts": 35, "totalChargeInEnergy": 1612.0, "fastChargePercent": 82.9,
        "chargeStatisList": [
            {"statisDay": "2026-11-01 00:00:00", "chargeInEnergy": 67.07},
            {"statisDay": "2026-10-01 00:00:00", "chargeInEnergy": 150.07},
            {"statisDay": None, "chargeInEnergy": 1},
        ],
    }})
    assert stat["total_count"] == 35
    assert stat["total_energy_kwh"] == pytest.approx(1612.0)
    assert stat["fast_charge_percent"] == pytest.approx(82.9)
    assert [m["month"] for m in stat["months"]] == ["2026-10", "2026-11"]
    assert normalize_year_stat({"data": {"totalChargeCounts": 0, "chargeStatisList": None}})[
        "months"] == []


def session(session_id, start, end, intervals=None, charge_types=None):
    begin, finish = stamp(start), stamp(end)
    return {
        "id": session_id,
        "started_at": begin,
        "ended_at": finish,
        "last_at": finish,
        "intervals": intervals if intervals is not None else [[begin, finish, (finish - begin) / 3600 * 7.0, "power"]],
        "charge_types": charge_types or ["ac"],
        "partial": False,
    }


def test_match_uses_overlap_and_tolerates_gun_start_lag():
    records = [normalize_record(raw_record())]
    # 本地首次采样比充电枪开始晚 10 分钟, 结束一致 → 仍应匹配。
    local = session("charge-1", "2026-11-01 22:10:08", "2026-11-01 22:59:23")
    matches = match_official_to_sessions(records, [local])
    assert "charge-1" in matches
    # 完全不同时段 → 不匹配。
    other = session("charge-2", "2026-11-05 10:00:00", "2026-11-05 11:00:00")
    assert match_official_to_sessions(records, [other]) == {}
    # 开始偏差超过容差且没有重叠 → 不匹配。
    off = session("charge-3", "2026-11-01 23:30:00", "2026-11-01 23:40:00")
    assert match_official_to_sessions(records, [off]) == {}


def test_match_is_one_to_one_and_uses_last_at_when_ended_missing():
    records = [normalize_record(raw_record())]
    local_a = session("charge-a", "2026-11-01 22:05:00", "2026-11-01 22:59:23")
    local_b = session("charge-b", "2026-11-01 22:06:00", "2026-11-01 22:59:23")
    matches = match_official_to_sessions(records, [local_a, local_b])
    assert len(matches) == 1
    active_like = {"id": "charge-c", "started_at": stamp("2026-11-01 22:00:08"),
                   "last_at": stamp("2026-11-01 22:59:23")}
    assert "charge-c" in match_official_to_sessions(records, [active_like])


def test_scale_intervals_to_official_total():
    intervals = [[0, 3600, 10.0, "power"], [3600, 7200, 5.0, "soc"]]
    scaled, total = scale_intervals(intervals, 12.0)
    assert total == pytest.approx(12.0)
    assert sum(row[2] for row in scaled) == pytest.approx(12.0)
    assert scaled[0][0] == 0 and scaled[1][1] == 7200
    assert scaled[0][3] == "power" and scaled[1][3] == "soc"
    # 估算总量为 0 / 官方缺失时不缩放, 也不声称官方口径。
    assert scale_intervals([], 12.0) == ([], 12.0)
    assert scale_intervals(intervals, None)[1] is None
    assert scale_intervals([[0, 1, 0.0, "power"]], 5.0)[1] is None


class MemoryStore:
    def __init__(self):
        self.data = {}

    async def async_load(self):
        return self.data

    async def async_save(self, data):
        self.data = data

    def async_delay_save(self, fn, _delay):
        self.data = fn()


def recorder_with_session():
    rec = ChargeRecorder(None, "TESTVIN", 70, store=MemoryStore(), timezone=ZONE)
    rec.sessions = [session("charge-1", "2026-11-01 22:10:08", "2026-11-01 22:59:23",
                            intervals=[[stamp("2026-11-01 22:10:08"),
                                        stamp("2026-11-01 22:30:00"), 7.0, "power"],
                                       [stamp("2026-11-01 22:30:00"),
                                        stamp("2026-11-01 22:59:23"), 9.0, "power"]])]
    return rec


def test_apply_official_marks_energy_basis_and_keeps_estimate():
    rec = recorder_with_session()
    official = normalize_record(raw_record(energy=56.11))
    changed = rec.apply_official({"charge-1": official})
    assert changed == 1
    record = rec.session_record(rec.sessions[0])
    assert record["energy_basis"] == "official"
    assert record["kwh"] == pytest.approx(56.11)
    assert record["kwh_estimate"] == pytest.approx(16.0)
    assert record["official"]["charge_type"] == "ac"
    assert record["grid_kwh"] == pytest.approx(56.11 / rec.tariff["efficiency"], abs=0.01)
    # 重复绑定同一笔官方记录不产生额外变更。
    assert rec.apply_official({"charge-1": official}) == 0


def test_official_energy_flows_into_daily_view():
    rec = recorder_with_session()
    rec.apply_official({"charge-1": normalize_record(raw_record(energy=56.11))})
    view = rec.view(days=30, now=stamp("2026-11-21 12:00:00"))
    day = next(d for d in view["days"] if d["day"] == "2026-11-01")
    assert day["kwh"] == pytest.approx(56.11, abs=0.01)
    assert view["summary"]["kwh"] == pytest.approx(56.11, abs=0.01)
    assert view["sessions"][0]["energy_basis"] == "official"


# ---------------------------------------------------------------------------
# API 客户端: 分页/请求形状(用假 car_call, 不发网络请求)
# ---------------------------------------------------------------------------
from api_client import LeapmotorClient, Session  # noqa: E402
from official_charge import fetch_snapshot, snapshot_is_invisible  # noqa: E402


class FakeClient(LeapmotorClient):
    def __init__(self, pages, year_stats=None):
        super().__init__(Session())
        self.pages = pages
        self.year_stats = year_stats or {}
        self.calls = []

    def car_call(self, path, params=None, method="GET", form=False):
        self.calls.append((path, dict(params or {}), method))
        if path.endswith("statistic/year"):
            year = int((params or {}).get("year") or 0)
            return self.year_stats.get(year, {"code": 0, "result": 0, "data": None})
        page = int((params or {}).get("pageNum") or 1)
        return self.pages.get(page, {"code": 0, "result": 0, "data": {"list": [], "total": 0}})


def detail_page(rows, total):
    return {"code": 0, "result": 0, "data": {"pageNum": 1, "pageSize": len(rows),
                                             "total": total, "list": rows}}


def test_client_detail_paginates_until_total():
    client = FakeClient({
        1: detail_page([raw_record(start="2026-11-01 22:00:00", end="2026-11-01 23:00:00"),
                        raw_record(start="2026-10-01 22:00:00", end="2026-10-01 23:00:00")], total=3),
        2: detail_page([raw_record(start="2026-09-01 22:00:00", end="2026-09-01 23:00:00")], total=3),
    })
    resp = client.get_charge_records("TESTVIN", start_time="2026-09-01", end_time="2026-11-21",
                                     page_size=2)
    starts = [r["chargeGunStartTs"] for r in resp["data"]["list"]]
    assert len(starts) == len(set(starts))
    assert len(resp["data"]["list"]) == 3
    assert resp["data"]["total"] == 3
    methods = {(path, method) for path, _params, method in client.calls}
    assert methods == {("charge/daily/detail/page", "POST")}
    assert [params["pageNum"] for _p, params, _m in client.calls] == [1, 2]


def test_client_year_stat_payload():
    client = FakeClient({}, year_stats={2026: {"code": 0, "data": {"totalChargeCounts": 1}}})
    client.get_charge_year_stat("TESTVIN", year=2026)
    assert client.calls[-1][0] == "charge/statistic/year"
    assert client.calls[-1][2] == "POST"
    assert client.calls[-1][1] == {"vin": "TESTVIN", "year": 2026}


def test_fetch_snapshot_normalizes_and_reports_error():
    client = FakeClient({1: detail_page([raw_record()], total=1)},
                        year_stats={2026: {"code": 0, "data": {
                            "totalChargeCounts": 2, "totalChargeInEnergy": 12.5,
                            "fastChargePercent": 50.0, "chargeStatisList": []}}})
    snap = fetch_snapshot(client, "TESTVIN", today=date(2026, 11, 21))
    assert snap["window"] == {"start": "2026-08-21", "end": "2026-11-21"}
    assert len(snap["records"]) == 1
    assert snap["year_stats"][2026]["total_count"] == 2
    assert snap.get("error") is None

    class Broken(FakeClient):
        def car_call(self, *args, **kwargs):
            raise RuntimeError("boom")

    snap2 = fetch_snapshot(Broken({}), "TESTVIN", today=date(2026, 11, 21), years=1)
    assert "充电明细请求失败" in snap2["error"]
    assert snap2.get("records") in (None, [])


def test_invisible_account_keeps_cached_official_data():
    from official_charge import OfficialChargeStore

    disk = MemoryStore()
    store = OfficialChargeStore(None, "TESTVIN", account_scope="account-a", store=disk)
    visible = {
        "records": [normalize_record(raw_record())],
        "year_stats": {2026: {"total_energy_kwh": 1612.0, "total_count": 35,
                              "fast_charge_percent": 82.9, "months": []}},
        "window": {"start": "2026-08-21", "end": "2026-11-21"},
        "fetched_at": 1000.0,
    }
    assert len(store.apply_snapshot(visible)) == 1
    assert store.available is True
    assert store.year_stats[2026]["total_count"] == 35
    for scope, expected in (("account-a", True), ("account-b", False), ("", False)):
        restored = OfficialChargeStore(None, "TESTVIN", account_scope=scope, store=disk)
        asyncio.run(restored.async_load())
        assert bool(restored.view()["records"]) == expected
        assert bool(restored.year_view()) == expected
    disk.data.pop("account_scope")
    legacy = OfficialChargeStore(None, "TESTVIN", account_scope="account-a", store=disk)
    asyncio.run(legacy.async_load())
    assert legacy.view()["records"] == [] and legacy.year_view() is None
    invisible = {"records": [], "year_stats": {2026: {"total_energy_kwh": 0.0, "total_count": 0,
                                                     "fast_charge_percent": 0.0, "months": []}},
                 "fetched_at": 2000.0}
    kept = store.apply_snapshot(invisible)
    assert kept == []
    assert store.view()["records"] == [] and store.view()["years"] == {}
    assert store.year_view() is None and store.match([]) == {}
    assert store.available is False            # 但标记为当前账号不可见
    assert store.year_stats[2026]["total_count"] == 35
    assert store.fetched_at == 2000.0


# ---------------------------------------------------------------------------
def test_snapshot_is_invisible_detection():
    assert snapshot_is_invisible({"records": [], "year_stats": {2026: {"total_count": 0,
                                                                     "total_energy_kwh": 0.0}}}) is True
    assert snapshot_is_invisible({"records": [], "year_stats": {}}) is True
    assert snapshot_is_invisible({"records": [{"key": "x"}], "year_stats": {}}) is False
    assert snapshot_is_invisible({"records": [], "year_stats": {2026: {"total_count": 3}}}) is False
    assert snapshot_is_invisible({"records": [], "error": "boom"}) is False
    assert snapshot_is_invisible(None) is False


def test_clear_official_removes_bindings_and_marks_estimate():
    rec = recorder_with_session()
    rec.apply_official({"charge-1": normalize_record(raw_record(energy=56.11))})
    assert rec.session_record(rec.sessions[0])["energy_basis"] == "official"
    assert rec.clear_official() == 1
    record = rec.session_record(rec.sessions[0])
    assert record["energy_basis"] == "estimated"
    assert record["official"] is None and record["official_energy_kwh"] is None
    assert record["kwh"] == pytest.approx(16.0)          # 回到本地估算总量
    assert rec.clear_official() == 0                     # 幂等
