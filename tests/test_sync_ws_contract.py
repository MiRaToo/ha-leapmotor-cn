"""Exercise sync WebSocket responses offline, without importing Home Assistant."""
import ast
import importlib.util
import logging
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[1]
WS_PATH = ROOT / "custom_components/leapmotor/ws_api.py"
spec = importlib.util.spec_from_file_location(
    "_sync_ws_archive", ROOT / "custom_components/leapmotor/sync_archive.py"
)
archive_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(archive_module)


def run(coro):
    """The executor stub completes immediately; no platform event loop is needed."""
    try:
        coro.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("unexpected suspension")


class Connection:
    def __init__(self):
        self.results = []
        self.errors = []

    def send_result(self, *args):
        self.results.append(args)

    def send_error(self, *args):
        self.errors.append(args)


@pytest.fixture
def context(tmp_path):
    archive = archive_module.SyncArchive(tmp_path / "ws.sqlite")
    archive.run("open")
    va = archive.run("ensure_vehicle", "VIN-A")
    vb = archive.run("ensure_vehicle", "VIN-B")

    async def executor(func, *args):
        return func(*args)

    hass = SimpleNamespace(async_add_executor_job=executor)
    tree = ast.parse(WS_PATH.read_text(encoding="utf-8-sig"))
    functions = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                 and node.name == "_sync_call"]
    namespace = {"_sync_archive": lambda _: archive, "log": logging.getLogger(__name__)}
    exec(compile(ast.Module(body=functions, type_ignores=[]), str(WS_PATH), "exec"), namespace)
    yield archive, va, vb, hass, namespace["_sync_call"]
    archive.run("close")
    archive.shutdown()


def test_every_public_sync_command_requires_admin():
    tree = ast.parse(WS_PATH.read_text(encoding="utf-8-sig"))
    commands = [node for node in tree.body if isinstance(node, ast.AsyncFunctionDef)
                and node.name.startswith("ws_sync_")]
    assert len(commands) == 6
    for node in commands:
        assert any(isinstance(decorator, ast.Attribute)
                   and decorator.attr == "require_admin"
                   for decorator in node.decorator_list), node.name


def test_scoped_response_identifies_vehicle_and_complete_raw_point(context):
    archive, va, vb, hass, call = context
    archive.run("ingest", va, "signal_map", {"2": "120.123456789", "1204": 50},
                {"collectTime": 1}, 2, "gcj02")
    archive.run("ingest", vb, "signal_map", {"2": "110.987654321", "1204": 80},
                {"collectTime": 1}, 2, "gcj02")
    connection = Connection()
    run(call(hass, connection, {"id": 8, "vehicle_id": va}, "observations", va))
    assert not connection.errors
    request_id, result = connection.results[0]
    assert request_id == 8
    assert result["vehicle_id"] == va
    assert result["source_id"] and result["dataset_id"]
    assert result["protocol_version"] == 1
    assert [p["signals_raw"]["2"] for p in result["points"]] == ["120.123456789"]


def test_cross_vehicle_cursor_returns_error_not_empty_success(context):
    archive, va, vb, hass, call = context
    cursor = archive.run("bootstrap", va)["cursor"]
    connection = Connection()
    run(call(hass, connection, {"id": 9, "vehicle_id": vb}, "pull", vb, cursor))
    assert not connection.results
    assert connection.errors[0][1] == "invalid_cursor"


def test_unavailable_archive_returns_error_without_fabricating_empty_data(context):
    archive, va, _, hass, call = context
    archive.ready = False
    connection = Connection()
    run(call(hass, connection, {"id": 10, "vehicle_id": va}, "observations", va))
    assert not connection.results
    assert connection.errors[0][1] == "archive_unavailable"


def test_unknown_vehicle_returns_explicit_error(context):
    _, _, _, hass, call = context
    connection = Connection()
    run(call(hass, connection, {"id": 11, "vehicle_id": "absent"},
             "observations", "absent"))
    assert not connection.results
    assert connection.errors[0][1] == "vehicle_unavailable"
