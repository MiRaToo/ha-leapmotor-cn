"""Exercise the charging records v1 WebSocket handler without Home Assistant."""
from __future__ import annotations

import __future__
import ast
import asyncio
import pathlib
import sys
from datetime import datetime
from types import SimpleNamespace
from zoneinfo import ZoneInfo

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

from charge_history import ChargeHistoryIndex  # noqa: E402

WS_PATH = ROOT / "custom_components" / "leapmotor" / "ws_api.py"
ZONE = ZoneInfo("Asia/Hong_Kong")


class MemoryStore:
    def __init__(self):
        self.data = None

    async def async_load(self):
        return self.data

    async def async_save(self, data):
        self.data = data

    def async_delay_save(self, function, delay):
        self.data = function()


class Connection:
    def __init__(self):
        self.results = []
        self.errors = []

    def send_result(self, *args):
        self.results.append(args)

    def send_error(self, *args):
        self.errors.append(args)


def run(coro):
    try:
        coro.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("unexpected suspension")


def extract(names, extra=None):
    tree = ast.parse(WS_PATH.read_text(encoding="utf-8-sig"))
    functions = []
    for node in tree.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name in names:
            node.decorator_list = []
            functions.append(node)
    namespace = {"__name__": "charge_history_ws_extract"}
    namespace.update(extra or {})
    module = ast.Module(body=functions, type_ignores=[])
    exec(compile(module, str(WS_PATH), "exec",
                 flags=__future__.annotations.compiler_flag), namespace)
    return namespace


def stamp(value):
    return datetime.fromisoformat(value).replace(tzinfo=ZONE).timestamp()


def test_charging_records_handler_returns_scoped_snapshot_and_existing_history_contract():
    now = stamp("2026-10-31T12:00:00")
    index = ChargeHistoryIndex(None, "VIN-A", store=MemoryStore(), now=lambda: now)
    index.reconcile_sessions([{
        "id": "charge-1", "started_at": stamp("2026-10-30T10:00:00"),
        "ended_at": stamp("2026-10-30T11:00:00"), "last_at": stamp("2026-10-30T11:00:00"),
        "soc_start": 30, "soc_end": 50, "kwh": 8, "grid_kwh": 8.8, "cost": 4,
        "sources": ["power"], "active": False, "partial": False,
        "charge_type": "dc", "peak_kw": 80, "average_kw": 70,
    }], observed_at_ms=int(now * 1000))
    coordinator = SimpleNamespace(
        charge_history_index=index, charges=SimpleNamespace(timezone=ZONE),
        entry=SimpleNamespace(entry_id="entry-a"),
    )

    async def identity(hass, coord, vin):
        assert coord is coordinator and vin == "VIN-A"
        return {"source_id": "source-a", "dataset_id": "dataset-a",
                "vehicle_id": "vehicle-a", "vin": "VIN-A"}

    namespace = extract({"ws_charging_records_v1"}, {
        "_coordinator": lambda hass, msg: coordinator,
        "_send_vehicle_error": lambda hass, connection, msg: None,
        "_charging_archive_identity": identity,
        "log": SimpleNamespace(warning=lambda *args, **kwargs: None),
    })
    connection = Connection()
    msg = {"id": 1, "vin": "VIN-A", "from_ms": 0,
           "to_ms": int(now * 1000), "limit": 100}
    run(namespace["ws_charging_records_v1"](object(), connection, msg))
    assert not connection.errors
    result = connection.results[0][1]
    assert result["protocol_version"] == 1
    assert result["source_id"] == "source-a" and result["dataset_id"] == "dataset-a"
    assert result["vehicle_id"] == "vehicle-a" and result["vin"] == "VIN-A"
    assert result["entry_id"] == "entry-a" and result["timezone"] == "Asia/Hong_Kong"
    assert result["coverage"] == "partial"
    assert result["record_count"] == 1
    assert result["rows"][0]["record_id"] == "charge-1"
    assert result["rows"][0]["energy"]["kwh"] == 8
    assert result["rows"][0]["money"]["basis"] == "ha_current_tariff_estimate"


def test_capability_requires_every_coordinator_and_charging_command_is_admin_only():
    ready = SimpleNamespace(charge_history_v1_available=lambda: True)
    not_ready = SimpleNamespace(charge_history_v1_available=lambda: False)
    state = {"values": {"a": ready}}
    namespace = extract({"_charging_history_capability"}, {
        "coordinators": lambda hass: state["values"],
    })
    capability = namespace["_charging_history_capability"]
    assert capability(object()) == {
        "contract_version": 1, "command": "leapmotor/charging/records/v1",
    }
    state["values"]["b"] = not_ready
    assert capability(object()) is None
    tree = ast.parse(WS_PATH.read_text(encoding="utf-8-sig"))
    command = next(node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                   and node.name == "ws_charging_records_v1")
    assert any(isinstance(decorator, ast.Attribute) and decorator.attr == "require_admin"
               for decorator in command.decorator_list)


def test_charging_identity_uses_complete_archive_vehicle_list_and_coordinator_scope():
    class Archive:
        ready = True

        @staticmethod
        def run(method, *args):
            if method == "info":
                return {"ready": True, "source_id": "source-a", "dataset_id": "dataset-a"}
            if method == "vehicles":
                return [
                    {"vehicle_id": "vehicle-a", "vin": " VIN-A ", "entry_id": "entry-a"},
                    {"vehicle_id": "vehicle-b", "vin": "VIN-B", "entry_id": "entry-b"},
                ]
            raise AssertionError(method)

    coordinator = SimpleNamespace(
        vin="VIN-A", sync_vehicle_id="vehicle-a", sync_archive=Archive(),
        entry=SimpleNamespace(entry_id="entry-a"),
        charge_history_v1_available=lambda: True,
    )

    async def executor(function, *args):
        return function(*args)

    namespace = extract(
        {"_charging_archive_identity", "_resolve_daily_archive_identity"},
        {"_configured_sync_vehicles": lambda hass: []},
    )
    result = run(namespace["_charging_archive_identity"](
        SimpleNamespace(async_add_executor_job=executor),
        coordinator,
        "vin-a",
    ))
    assert result == {
        "source_id": "source-a", "dataset_id": "dataset-a",
        "vehicle_id": "vehicle-a", "vin": "VIN-A",
    }
    try:
        run(namespace["_charging_archive_identity"](
            SimpleNamespace(async_add_executor_job=executor),
            coordinator,
            "VIN-B",
        ))
    except ValueError as err:
        assert str(err) == "vehicle_conflict"
    else:
        raise AssertionError("cross-VIN request was accepted")
