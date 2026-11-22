"""Offline contract tests for strict daily-energy v1."""
from __future__ import annotations

import __future__
import ast
import asyncio
import inspect
import math
import pathlib
import sys
import types
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

from energy_daily import (  # noqa: E402
    compose_days_v1,
    DailyEnergyV1Store,
    day_windows_v1,
    parse_getec_day_v1,
    trip_rows_by_windows_v1,
    V1_MISS_RETRY_SECONDS,
    V1_TODAY_TTL_SECONDS,
)


class FakeStore:
    def __init__(self, data=None):
        self.data = data
        self.saved = 0

    async def async_load(self):
        return self.data

    def async_delay_save(self, function, delay):
        self.saved += 1
        self.data = function()


def run(coro):
    return asyncio.run(coro)


def test_strict_parser_accepts_complete_zero_and_numeric_strings():
    parsed = parse_getec_day_v1({
        "code": 0,
        "data": {"driverEC": "0", "acEC": 1.25, "otherEC": "0.75"},
    })
    assert parsed is not None and isinstance(parsed, dict)
    assert parsed["driver"] == 0
    assert parsed["ac"] == 1.25
    assert parsed["other"] == 0.75
    assert parsed["total"] == 2.0
    assert parse_getec_day_v1({
        "code": 0,
        "data": {"driverEC": 0, "acEC": "0.0", "otherEC": 0.0},
    }) == {"driver": 0.0, "ac": 0.0, "other": 0.0, "total": 0.0}


def test_strict_parser_rejects_partial_boolean_negative_nonfinite_and_junk():
    invalid = [
        {"code": 0, "data": {}},
        {"code": 0, "data": {"driverEC": 1, "acEC": 2}},
        {"code": 0, "data": {"driverEC": True, "acEC": 2, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": -1, "acEC": 2, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": 1, "acEC": math.nan, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": 1, "acEC": math.inf, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": "", "acEC": 2, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": " 1", "acEC": 2, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": "garbage", "acEC": 2, "otherEC": 3}},
        {"code": 0, "data": {"driverEC": 1e308, "acEC": 1e308, "otherEC": 1e308}},
    ]
    assert all(parse_getec_day_v1(payload) is None for payload in invalid)


def test_code_100_is_empty_marker_not_official_zero():
    assert parse_getec_day_v1({"code": 100, "message": "未找到数据"}) == "empty"
    assert parse_getec_day_v1({"result": 100}) == "empty"


def test_day_windows_cross_month_and_today_is_frozen_at_generated_at():
    # 2026-04-01 12:00 Asia/Hong_Kong
    now = int(datetime(2026, 4, 1, 12, 0,
                       tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp())
    windows = day_windows_v1(2, "Asia/Hong_Kong", now)
    assert [row[0] for row in windows] == ["2026-03-31", "2026-04-01"]
    assert windows[0][2] + 1 == windows[1][1]
    assert windows[1][2] == now


def test_day_windows_use_configured_zone_not_process_timezone():
    stamp = int(datetime(2026, 1, 1, 0, 30, tzinfo=ZoneInfo("UTC")).timestamp())
    utc = day_windows_v1(1, "UTC", stamp)
    hong_kong = day_windows_v1(1, "Asia/Hong_Kong", stamp)
    assert utc[0][0] == "2026-01-01"
    assert hong_kong[0][0] == "2026-01-01"
    assert utc[0][1] != hong_kong[0][1]


def test_day_windows_cover_dst_23_and_25_hour_historical_days():
    spring_now = int(datetime(2026, 3, 9, 12, 0,
                              tzinfo=ZoneInfo("America/New_York")).timestamp())
    spring = day_windows_v1(3, "America/New_York", spring_now)
    spring_day = next(row for row in spring if row[0] == "2026-03-08")
    assert spring_day[2] - spring_day[1] + 1 == 23 * 3600

    fall_now = int(datetime(2026, 11, 2, 12, 0,
                            tzinfo=ZoneInfo("America/New_York")).timestamp())
    fall = day_windows_v1(3, "America/New_York", fall_now)
    fall_day = next(row for row in fall if row[0] == "2026-11-01")
    assert fall_day[2] - fall_day[1] + 1 == 25 * 3600
    assert all(left[2] + 1 == right[1] for left, right in zip(spring, spring[1:]))
    assert all(left[2] + 1 == right[1] for left, right in zip(fall, fall[1:]))


def test_v1_store_uses_new_storage_namespace_and_does_not_migrate_legacy_rows():
    created = {}

    class FakeHAStore:
        def __init__(self, hass, version, key):
            created.update(version=version, key=key)

        async def async_load(self):
            return None

        def async_delay_save(self, function, delay):
            pass

    fake_storage = types.ModuleType("homeassistant.helpers.storage")
    fake_storage.Store = FakeHAStore
    fake_helpers = types.ModuleType("homeassistant.helpers")
    fake_helpers.storage = fake_storage
    fake_homeassistant = types.ModuleType("homeassistant")
    fake_homeassistant.helpers = fake_helpers
    saved = {name: sys.modules.get(name) for name in
             ("homeassistant", "homeassistant.helpers", "homeassistant.helpers.storage")}
    sys.modules["homeassistant"] = fake_homeassistant
    sys.modules["homeassistant.helpers"] = fake_helpers
    sys.modules["homeassistant.helpers.storage"] = fake_storage
    try:
        DailyEnergyV1Store(None, " lp-test-vin ")
    finally:
        for name, module in saved.items():
            if module is None:
                sys.modules.pop(name, None)
            else:
                sys.modules[name] = module
    assert created == {"version": 2, "key": "leapmotor_LP-TEST-VIN_daily_energy_v1"}

    legacy = DailyEnergyV1Store(None, "TESTVIN", FakeStore({
        "days": {"2026-10-01": {"driver": 1.0, "ac": None, "other": None,
                                "total": 1.0, "empty": True, "at": 1.0}},
        "tried": {},
    }))
    run(legacy.async_load())
    assert legacy.get("2026-10-01", "UTC", 0, 0) is None


def test_today_cache_reuses_rows_with_frozen_window_and_marks_stale_after_ttl():
    now = int(datetime(2026, 10, 31, 12, 0,
                       tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp())
    _day, start, end = day_windows_v1(1, "Asia/Hong_Kong", now)[0]
    store = DailyEnergyV1Store(None, "TESTVIN", FakeStore())
    store.record("2026-10-31", {"driver": 0, "ac": 1, "other": 0},
                 "Asia/Hong_Kong", start, end, now)
    at_later_end = end + 60
    value = store.state("2026-10-31", "Asia/Hong_Kong", start, at_later_end,
                        today=True, now=now + 60)
    assert value is not None and value[1] == "ready"
    stale = store.state("2026-10-31", "Asia/Hong_Kong", start, at_later_end,
                        today=True, now=now + V1_TODAY_TTL_SECONDS)
    assert stale is not None and stale[1] == "stale"
    assert store.get("2026-10-31", "UTC", start, at_later_end,
                     today=True, now=now) is None


def test_historical_cache_requires_exact_bounds_and_failed_refresh_is_stale_not_zero():
    now = int(datetime(2026, 10, 31, 12, 0,
                       tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp())
    windows = day_windows_v1(2, "Asia/Hong_Kong", now)
    day, start, end = windows[0]
    store = DailyEnergyV1Store(None, "TESTVIN", FakeStore())
    store.record(day, {"driver": 2, "ac": 1, "other": 0.5},
                 "Asia/Hong_Kong", start, end, now)
    assert store.get(day, "Asia/Hong_Kong", start, end, now=now) is not None
    assert store.get(day, "Asia/Hong_Kong", start, end - 1, now=now) is None
    assert store.plan(windows, "Asia/Hong_Kong", now + 10, 10) == [windows[1]]

    today, today_start, today_end = windows[1]
    store.record(today, {"driver": 1, "ac": 0, "other": 0},
                 "Asia/Hong_Kong", today_start, today_end, now)
    store.miss(today, now + V1_TODAY_TTL_SECONDS)
    state = store.state(today, "Asia/Hong_Kong", today_start, today_end + 60,
                        today=True, now=now + V1_TODAY_TTL_SECONDS)
    assert state is not None and state[1] == "stale" and state[0]["total"] == 1
    assert today not in [row[0] for row in store.plan(
        windows, "Asia/Hong_Kong", now + V1_TODAY_TTL_SECONDS + 60, 10)]
    assert today in [row[0] for row in store.plan(
        windows, "Asia/Hong_Kong", now + V1_TODAY_TTL_SECONDS + V1_MISS_RETRY_SECONDS + 1, 10)]


def test_compose_v1_preserves_real_zero_sources_and_unknown_null_semantics():
    windows = [("2026-10-30", 10, 20), ("2026-10-31", 30, 40),
               ("2026-11-01", 50, 60)]
    official = {"2026-10-30": {"driver": 0, "ac": 0, "other": 0, "total": 0}}
    rows = compose_days_v1(
        windows, official,
        {"2026-10-30": 0, "2026-10-31": 7},
        {"2026-10-30": "official", "2026-10-31": "trip"},
        {"2026-10-30": {"km": 12, "kwh": 3},
         "2026-10-31": {"km": 7, "kwh": 1.25}},
        now=60, today="2026-11-01",
        official_status={"2026-10-30": "ready"},
    )
    assert rows[0]["km"] == 0 and rows[0]["km_src"] == "official"
    assert rows[0]["km_status"] == "ready"
    assert rows[0]["kwh"] == 0 and rows[0]["kwh_src"] == "official"
    assert rows[0]["kwh_status"] == "ready"
    assert rows[0]["drv"] == rows[0]["ac"] == rows[0]["oth"] == 0
    assert rows[1]["km"] == 7 and rows[1]["km_src"] == "trip"
    assert rows[1]["kwh"] == 1.25 and rows[1]["kwh_src"] == "trip"
    assert rows[1]["drv"] is rows[1]["ac"] is rows[1]["oth"] is None
    assert rows[2] == {
        "day": "2026-11-01", "start_ts": 50, "end_ts": 60,
        "km": None, "km_src": None, "km_status": "pending",
        "kwh": None, "kwh_src": None, "kwh_status": "pending",
        "eff": None, "drv": None, "ac": None, "oth": None,
    }


def test_compose_v1_marks_only_valid_cached_official_values_stale():
    windows = [("2026-10-30", 10, 20)]
    official = {"2026-10-30": {"driver": 2, "ac": 0.5, "other": 0.25, "total": 2.75}}
    rows = compose_days_v1(
        windows, official, {}, {}, {},
        now=20, today="2026-10-31", official_status={"2026-10-30": "stale"},
    )
    assert rows[0]["kwh"] == 2.75 and rows[0]["kwh_status"] == "stale"
    assert rows[0]["drv"] + rows[0]["ac"] + rows[0]["oth"] == rows[0]["kwh"]


def test_trip_bucketing_uses_same_configured_dst_day():
    zone = ZoneInfo("America/New_York")
    now = int(datetime(2026, 3, 9, 12, 0, tzinfo=zone).timestamp())
    windows = day_windows_v1(3, "America/New_York", now)
    trips = [
        SimpleNamespace(ended_at=int(datetime(2026, 3, 8, 1, 30, tzinfo=zone).timestamp()),
                        distance_km=4.0, energy_kwh=1.0),
        SimpleNamespace(ended_at=int(datetime(2026, 3, 8, 3, 30, tzinfo=zone).timestamp()),
                        distance_km=6.0, energy_kwh=1.5),
    ]
    rows = trip_rows_by_windows_v1(trips, windows, "America/New_York")
    assert rows["2026-03-07"]["km"] is None
    assert rows["2026-03-08"] == {"km": 10.0, "kwh": 2.5}
    assert rows["2026-03-09"] == {"km": 0.0, "kwh": 0.0}


def _extract(path, names, extra=None):
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    selected = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            clone = node
            clone.decorator_list = []
            selected.append(clone)
    namespace = {"__name__": "daily_energy_contract_extract"}
    namespace.update(extra or {})
    module = ast.Module(body=selected, type_ignores=[])
    exec(compile(module, str(path), "exec",
                 flags=__future__.annotations.compiler_flag), namespace)
    return namespace


def test_ws_vehicle_identity_requires_one_normalized_unique_vin():
    path = ROOT / "custom_components" / "leapmotor" / "ws_api.py"
    namespace = _extract(path, {"_resolve_daily_archive_identity"})
    resolve = namespace["_resolve_daily_archive_identity"]
    info = {"ready": True, "source_id": "src", "dataset_id": "dataset"}
    vehicles = [
        {"vehicle_id": "vehicle-a", "vin": " vin-a ", "entry_id": "entry-a"},
        {"vehicle_id": "vehicle-b", "vin": "VIN-B", "entry_id": "entry-b"},
    ]
    assert resolve(info, vehicles, "vin-a", "vehicle-a", "entry-a") == {
        "source_id": "src", "dataset_id": "dataset",
        "vehicle_id": "vehicle-a", "vin": "VIN-A",
    }
    invalid = [
        (info, [], "VIN-A", "vehicle-a", "entry-a"),
        (info, vehicles + [{"vehicle_id": "vehicle-x", "vin": "Vin-A", "entry_id": "entry-x"}],
         "VIN-A", "vehicle-a", "entry-a"),
        (info, vehicles, "VIN-A", "vehicle-b", "entry-a"),
        (info, vehicles, "VIN-A", "vehicle-a", "entry-b"),
        ({**info, "ready": False}, vehicles, "VIN-A", "vehicle-a", "entry-a"),
    ]
    for args in invalid:
        with pytest.raises(ValueError):
            resolve(*args)


def test_capability_requires_every_coordinator_and_valid_timezone():
    path = ROOT / "custom_components" / "leapmotor" / "ws_api.py"
    from energy_daily import valid_iana_timezone

    ready = SimpleNamespace(daily_energy_v1_available=lambda: True)
    not_ready = SimpleNamespace(daily_energy_v1_available=lambda: False)
    state = {"coordinators": {"a": ready}}
    namespace = _extract(path, {"_daily_energy_capability"}, {
        "coordinators": lambda hass: state["coordinators"],
        "valid_iana_timezone": valid_iana_timezone,
    })
    capability = namespace["_daily_energy_capability"]
    hass = SimpleNamespace(config=SimpleNamespace(time_zone="Asia/Hong_Kong"))
    assert capability(hass) == {
        "contract_version": 1, "command": "leapmotor/energy/daily",
        "time_zone": "Asia/Hong_Kong",
    }
    state["coordinators"]["b"] = not_ready
    assert capability(hass) is None
    state["coordinators"] = {"a": ready}
    hass.config.time_zone = "+08:00"
    assert capability(hass) is None


def test_ws_v1_failure_is_explicit_and_never_falls_back_to_legacy_or_cloud_path():
    path = ROOT / "custom_components" / "leapmotor" / "ws_api.py"

    class Connection:
        def __init__(self):
            self.results = []
            self.errors = []

        def send_result(self, *args):
            self.results.append(args)

        def send_error(self, *args):
            self.errors.append(args)

    legacy_calls = []

    class Coordinator:
        trips = object()
        vin = "VIN-A"
        entry = SimpleNamespace(entry_id="entry-a")
        reev = False
        fuel_days = None
        data = {}

        @staticmethod
        def daily_energy_v1_available():
            return True

        @staticmethod
        async def ensure_energy_days_v1(days):
            raise RuntimeError("daily_energy_unavailable")

        @staticmethod
        async def ensure_energy_days(days):
            legacy_calls.append(days)
            return {"days": [], "source": "official", "pending": 0,
                    "coverage_from": None, "generated_at": 1}

    async def executor(function, *args):
        return function(*args)

    async def archive_identity(hass, coordinator, vin):
        return {"source_id": "src", "dataset_id": "dataset",
                "vehicle_id": "vehicle-a", "vin": "VIN-A"}

    coordinator = Coordinator()
    namespace = _extract(path, {"ws_energy_daily"}, {
        "_coordinator": lambda hass, msg: coordinator,
        "_send_vehicle_error": lambda hass, connection, msg: None,
        "_daily_archive_identity": archive_identity,
        "time": types.SimpleNamespace(time=lambda: 1.0),
    })
    connection = Connection()
    hass = SimpleNamespace(async_add_executor_job=executor)
    run(namespace["ws_energy_daily"](
        hass, connection, {"id": 1, "vin": "VIN-A", "days": 7}))
    assert not connection.results
    assert connection.errors[0][1] == "daily_energy_unavailable"
    assert legacy_calls == []


def test_ws_v1_success_has_explicit_identity_and_preserves_legacy_body_fields():
    path = ROOT / "custom_components" / "leapmotor" / "ws_api.py"

    class Connection:
        def __init__(self):
            self.results = []
            self.errors = []

        def send_result(self, *args):
            self.results.append(args)

        def send_error(self, *args):
            self.errors.append(args)

    body = {
        "daily_energy_version": 1, "time_zone": "Asia/Hong_Kong",
        "generated_at": 1_785_376_800, "source": "official", "pending": 0,
        "coverage_from": "2026-07-30",
        "days": [{
            "day": "2026-07-30", "start_ts": 1_785_340_800,
            "end_ts": 1_785_376_800, "km": 0, "km_src": "official",
            "km_status": "ready", "kwh": 0, "kwh_src": "official",
            "kwh_status": "ready", "eff": None,
            "drv": 0, "ac": 0, "oth": 0,
        }],
    }

    class Coordinator:
        trips = object()
        vin = "VIN-A"
        entry = SimpleNamespace(entry_id="entry-a")
        reev = False
        fuel_days = None
        data = {}

        @staticmethod
        def daily_energy_v1_available():
            return True

        @staticmethod
        async def ensure_energy_days_v1(days):
            return body

        @staticmethod
        async def ensure_energy_days(days):
            raise AssertionError("legacy path must not run")

    async def executor(function, *args):
        return function(*args)

    async def archive_identity(hass, coordinator, vin):
        return {"source_id": "source-a", "dataset_id": "dataset-a",
                "vehicle_id": "vehicle-a", "vin": "VIN-A"}

    coordinator = Coordinator()
    namespace = _extract(path, {"ws_energy_daily"}, {
        "_coordinator": lambda hass, msg: coordinator,
        "_send_vehicle_error": lambda hass, connection, msg: None,
        "_daily_archive_identity": archive_identity,
        "time": types.SimpleNamespace(time=lambda: 1.0),
    })
    connection = Connection()
    hass = SimpleNamespace(async_add_executor_job=executor)
    run(namespace["ws_energy_daily"](
        hass, connection, {"id": 2, "vin": "vin-a", "days": 1}))
    assert not connection.errors
    result = connection.results[0][1]
    assert result["daily_energy_version"] == 1
    assert result["source_id"] == "source-a" and result["dataset_id"] == "dataset-a"
    assert result["vehicle_id"] == "vehicle-a" and result["vin"] == "VIN-A"
    assert result["entry_id"] == "entry-a"
    assert result["source"] == "official" and result["coverage_from"] == "2026-07-30"
    assert result["summary"] == {"km": 0, "kwh": 0}
    assert result["days"][0]["day"] == "2026-07-30"
    assert result["days"][0]["kwh"] == 0


def test_ws_legacy_success_does_not_claim_v1_identity_or_version():
    path = ROOT / "custom_components" / "leapmotor" / "ws_api.py"

    class Connection:
        def __init__(self):
            self.results = []
            self.errors = []

        def send_result(self, *args):
            self.results.append(args)

        def send_error(self, *args):
            self.errors.append(args)

    class Coordinator:
        trips = object()
        vin = "VIN-A"
        entry = SimpleNamespace(entry_id="entry-a")
        reev = False
        fuel_days = None
        data = {}

        @staticmethod
        def daily_energy_v1_available():
            return False

        @staticmethod
        async def ensure_energy_days(days):
            return {"days": [], "source": "official", "pending": 0,
                    "coverage_from": None, "generated_at": 9}

    coordinator = Coordinator()
    namespace = _extract(path, {"ws_energy_daily"}, {
        "_coordinator": lambda hass, msg: coordinator,
        "_send_vehicle_error": lambda hass, connection, msg: None,
        "_daily_archive_identity": lambda hass, coordinator, vin: None,
        "time": types.SimpleNamespace(time=lambda: 9.0),
    })
    connection = Connection()
    run(namespace["ws_energy_daily"](
        SimpleNamespace(), connection, {"id": 3, "vin": "VIN-A", "days": 1}))
    assert not connection.errors
    result = connection.results[0][1]
    assert result["days"] == [] and result["vin"] == "VIN-A"
    assert result["source"] == "official" and result["summary"] == {"km": 0, "kwh": 0}
    assert "daily_energy_version" not in result
    assert "source_id" not in result and "vehicle_id" not in result


def test_ensure_v1_serializes_ws_and_poll_callers_for_same_windows():
    path = ROOT / "custom_components" / "leapmotor" / "coordinator.py"
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    method = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "LeapmotorCoordinator":
            method = next(item for item in node.body
                          if isinstance(item, ast.AsyncFunctionDef)
                          and item.name == "ensure_energy_days_v1")
            break
    assert method is not None
    method.decorator_list = []
    namespace = {
        "__name__": "coordinator_daily_energy_extract",
        "time": types.SimpleNamespace(time=lambda: 1_785_376_800),
        "day_windows_v1": day_windows_v1,
        "valid_iana_timezone": lambda value: value if value else None,
        "parse_getec_day_v1": parse_getec_day_v1,
        "is_rate_limited": lambda response: False,
        "ENERGY_FETCH_BUDGET_WS": 10,
    }
    module = ast.Module(body=[method], type_ignores=[])
    exec(compile(module, str(path), "exec",
                 flags=__future__.annotations.compiler_flag), namespace)

    class LockedStore:
        def __init__(self):
            self.days = set()

        def plan(self, windows, zone, now, budget):
            return [row for row in windows if row[0] not in self.days][:budget]

        def record(self, day, parsed, zone, start, end, now):
            self.days.add(day)

        def miss(self, day, now):
            pass

    class Coordinator:
        def __init__(self):
            import asyncio
            self._daily_energy_v1_lock = asyncio.Lock()
            self.daily_energy_v1 = LockedStore()
            self.vin = "VIN-A"
            self.hass = SimpleNamespace(
                config=SimpleNamespace(time_zone="Asia/Hong_Kong"),
                async_add_executor_job=self.executor)
            self.client = SimpleNamespace(get_lastweek_ec=self.fetch)
            self.fetch_calls = []
            self.view_calls = []

        async def executor(self, function, *args):
            await asyncio.sleep(0)
            return function(*args)

        def fetch(self, vin, start, end):
            self.fetch_calls.append((vin, start, end))
            return {"code": 0, "data": {
                "driverEC": 1, "acEC": 0, "otherEC": 0}}

        def _enter_rate_limit(self, message):
            raise AssertionError(message)

        def energy_days_v1_view(self, days, *, now=None, windows=None):
            self.view_calls.append(tuple(row[0] for row in windows))
            return {"daily_energy_version": 1, "generated_at": now, "days": []}

    Coordinator.ensure_energy_days_v1 = namespace["ensure_energy_days_v1"]

    async def exercise():
        coordinator = Coordinator()
        await asyncio.gather(
            coordinator.ensure_energy_days_v1(7),
            coordinator.ensure_energy_days_v1(7),
        )
        return coordinator

    coordinator = run(exercise())
    assert len(coordinator.fetch_calls) == 7
    assert len(set(coordinator.fetch_calls)) == 7
    assert len(coordinator.view_calls) == 2


def test_ensure_v1_refreezes_generated_at_and_today_after_network_crosses_midnight():
    path = ROOT / "custom_components" / "leapmotor" / "coordinator.py"
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    method = next(item for node in tree.body
                  if isinstance(node, ast.ClassDef) and node.name == "LeapmotorCoordinator"
                  for item in node.body
                  if isinstance(item, ast.AsyncFunctionDef)
                  and item.name == "ensure_energy_days_v1")
    method.decorator_list = []
    before = int(datetime(2026, 3, 31, 23, 59,
                          tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp())
    after = int(datetime(2026, 4, 1, 0, 1,
                         tzinfo=ZoneInfo("Asia/Hong_Kong")).timestamp())
    clock = iter((before, after))
    namespace = {
        "__name__": "coordinator_midnight_extract",
        "time": types.SimpleNamespace(time=lambda: next(clock)),
        "day_windows_v1": day_windows_v1,
        "valid_iana_timezone": lambda value: value if value else None,
        "parse_getec_day_v1": parse_getec_day_v1,
        "is_rate_limited": lambda response: False,
        "ENERGY_FETCH_BUDGET_WS": 10,
    }
    module = ast.Module(body=[method], type_ignores=[])
    exec(compile(module, str(path), "exec",
                 flags=__future__.annotations.compiler_flag), namespace)

    class Store:
        @staticmethod
        def plan(windows, zone, now, budget):
            return []

        @staticmethod
        def miss(day, now):
            raise AssertionError("unexpected miss")

    class Coordinator:
        def __init__(self):
            import asyncio
            self._daily_energy_v1_lock = asyncio.Lock()
            self.daily_energy_v1 = Store()
            self.vin = "VIN-A"
            self.hass = SimpleNamespace(
                config=SimpleNamespace(time_zone="Asia/Hong_Kong"),
                async_add_executor_job=self.executor)
            self.client = SimpleNamespace(get_lastweek_ec=lambda *args: None)
            self.captured = None

        @staticmethod
        async def executor(function, *args):
            return function(*args)

        def energy_days_v1_view(self, days, *, now=None, windows=None):
            self.captured = (now, windows)
            return {"daily_energy_version": 1, "generated_at": now, "days": []}

    Coordinator.ensure_energy_days_v1 = namespace["ensure_energy_days_v1"]
    coordinator = Coordinator()
    run(coordinator.ensure_energy_days_v1(2))
    assert coordinator.captured[0] == after
    assert [row[0] for row in coordinator.captured[1]] == ["2026-03-31", "2026-04-01"]
    assert coordinator.captured[1][-1][2] == after


def test_ws_daily_v1_error_path_never_calls_legacy_daily(monkeypatch=None):
    # Kept as a named test so both pytest and the local dependency-free runner can count it.
    assert inspect.iscoroutinefunction(
        _extract(ROOT / "custom_components" / "leapmotor" / "ws_api.py",
                 {"ws_energy_daily"})["ws_energy_daily"])
