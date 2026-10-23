"""Raw parser, live grouping and fail-open collection contracts without HA/network."""
import ast
import logging
from datetime import timedelta
from pathlib import Path
from types import MethodType, SimpleNamespace

import pytest
import api_client as api

from test_t03_compat import client, coordinator_runtime
from test_sync_ws_contract import archive_module, run

ROOT = Path(__file__).resolve().parents[1]


def bind_group_helpers(coordinator):
    path = ROOT / "custom_components/leapmotor/coordinator.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and n.name == "LeapmotorCoordinator")
    nodes = [n for n in cls.body if getattr(n, "name", "") in
             ("_sync_group_marker", "_sync_associate_live_record")]
    namespace = {"log": logging.getLogger(__name__)}
    exec(compile(ast.Module(body=nodes, type_ignores=[]), str(path), "exec"), namespace)
    for node in nodes:
        setattr(coordinator, node.name, MethodType(namespace[node.name], coordinator))


@pytest.fixture
def collector(tmp_path):
    archive = archive_module.SyncArchive(tmp_path / "collector.sqlite")
    archive.run("open")
    vehicle = archive.run("ensure_vehicle", "LFZT03TEST0000001")
    coordinator = coordinator_runtime(client("C10", lambda *_: {
        "code": 0, "data": {"vin": "LFZT03TEST0000001", "collectTime": 100,
                             "signalMap": {"1204": 62, "2": "120.123456789", "sts": 101}}}))
    coordinator.sync_archive = archive
    coordinator.sync_vehicle_id = vehicle
    coordinator._auth_revision = 0
    coordinator.update_interval = timedelta(seconds=6)
    bind_group_helpers(coordinator)
    yield coordinator, archive, vehicle
    archive.run("close")
    archive.shutdown()


def test_native_parser_keeps_types_both_times_and_excludes_credentials():
    state = api.parse_car_state({"code": 0, "data": {"vin": "VIN", "collectTime": 111,
        "token": "secret", "signalMap": {"sts": "222", "1204": 0,
        "1258": False, "2": "120.123456789", "1178": "-2.50", "token": "secret"}}})
    assert state.native_raw == {"sts": "222", "1204": 0, "1258": False,
                                "2": "120.123456789", "1178": "-2.50"}
    assert state.source_timestamps == {"collectTime": 111, "signalMap.sts": "222"}
    assert state.coordinate_system == "gcj02"


@pytest.mark.parametrize("shape,layout", [("signal", "named_signal"), ("data", "named_data")])
def test_t03_keeps_native_names_and_times_before_normalization(shape, layout):
    native = {"soc": "62.5", "speed": "0", "bcmKeyPositionOn3": False,
              "batteryCurrent": "-2.50", "sts": "2026-10-22T12:00:00Z", "token": "secret"}
    data = {"vin": "VIN", "collectTimeMs": "1792670400000"}
    data.update(native) if shape == "data" else data.update({shape: native})
    state = api.parse_t03_car_state({"code": 0, "data": data}, "VIN")
    assert state.raw_layout == layout
    assert state.native_raw["bcmKeyPositionOn3"] is False
    assert state.native_raw["soc"] == "62.5"
    assert "token" not in state.native_raw
    assert state.source_timestamps["data.collectTimeMs"] == "1792670400000"
    assert state.source_timestamps["source.sts"] == native["sts"]


def test_successful_collection_archives_original_frame(collector):
    coordinator, archive, vehicle = collector
    run(coordinator._refresh_car_data())
    point = archive.run("observations", vehicle)["points"][0]
    assert point["signals_raw"]["1204"] == 62
    assert point["signals_raw"]["2"] == "120.123456789"
    assert point["source_timestamps"] == {"collectTime": 100, "signalMap.sts": 101}
    assert coordinator.state.soc == 62
    events = archive.run("bootstrap", vehicle)["items"]
    event = next(item["data"] for item in events if item["entity_type"] == "capture_event")
    assert event["sampling_interval_seconds"] == 6


def test_storage_failure_preserves_existing_ha_state_collection(collector, monkeypatch):
    coordinator, archive, vehicle = collector

    def failed(*args):
        raise OSError("storage unavailable")

    monkeypatch.setattr(archive, "ingest", failed)
    run(coordinator._refresh_car_data())
    assert coordinator.state.soc == 62
    assert coordinator.car_state_problem == ""
    assert not archive.ready
    assert archive.error == "OSError"


def test_vehicle_conflict_does_not_enter_either_vehicle_archive(collector):
    coordinator, archive, vehicle = collector
    coordinator.client.get_car_state = lambda *_: api.parse_car_state({"code": 0,
        "data": {"vin": "ANOTHER", "signalMap": {"1204": 99}}})
    previous = coordinator.state
    run(coordinator._refresh_car_data())
    assert coordinator.state is previous
    assert archive.run("observations", vehicle)["points"] == []
    assert archive.ready
    assert coordinator._sync_last_observation_id == ""


@pytest.mark.parametrize("envelope,nested", [("LFZT03TEST0000001","ANOTHER"), ("ANOTHER","LFZT03TEST0000001"), ("","ANOTHER")])
def test_conflicting_nested_vin_is_also_rejected(collector,envelope,nested):
    coordinator,archive,vehicle = collector
    frame={"code":0,"data":{"vin":envelope,"signalMap":{"vin":nested,"1204":90}}}
    coordinator.client.get_car_state=lambda *_:api.parse_car_state(frame)
    previous=coordinator.state
    run(coordinator._refresh_car_data())
    assert coordinator.state is previous
    assert archive.run("observations",vehicle)["points"]==[]
    assert not api.parse_t03_car_state(frame,"LFZT03TEST0000001").raw


@pytest.mark.parametrize("kind", ["trip", "charge"])
def test_parked_samples_are_not_appended_to_recent_completed_group(collector, kind):
    coordinator, archive, vehicle = collector
    if kind == "trip":
        item = SimpleNamespace(id="group", started_at=10, ended_at=0, frozen=False, approx_time=False)
        recorder = SimpleNamespace(_active=item, trips=[])
        coordinator.trips = recorder
    else:
        item = {"id": "group", "started_at": 10}
        recorder = SimpleNamespace(active=item, sessions=[])
        coordinator.charges = recorder
    coordinator._sync_last_observation_id = archive.run("ingest", vehicle, "signal_map", {"1204": 50}, {"sts": 1}, 1)
    run(coordinator._sync_associate_live_record(kind, 10, (None, None)))
    before = coordinator._sync_group_marker(kind)
    if kind == "trip":
        item.ended_at = 11
        recorder._active = None
        recorder.trips.append(item)
    else:
        item["ended_at"] = 11
        recorder.active = None
        recorder.sessions.append(item)
    coordinator._sync_last_observation_id = archive.run("ingest", vehicle, "signal_map", {"1204": 50}, {"sts": 2}, 2)
    run(coordinator._sync_associate_live_record(kind, 11, before))
    before = coordinator._sync_group_marker(kind)
    coordinator._sync_last_observation_id = archive.run("ingest", vehicle, "signal_map", {"1204": 50}, {"sts": 3}, 3)
    run(coordinator._sync_associate_live_record(kind, 12, before))
    page = archive.run("observations", vehicle, None, 100, "group", kind)
    assert len(page["points"]) == 2
    assert archive.run("records_page", vehicle)["records"][0]["phase"] == "completed"


def test_failed_poll_does_not_reuse_previous_observation(collector):
    coordinator, archive, vehicle = collector
    run(coordinator._refresh_car_data())
    previous = coordinator.state
    coordinator.client.get_car_state = lambda *_: api.CarState(resp_code=123456)
    run(coordinator._refresh_car_data())
    assert coordinator.state is previous
    assert coordinator._sync_last_observation_id == ""
    assert len(archive.run("observations", vehicle)["points"]) == 1


def test_account_vehicle_lookup_ignores_archive_and_runtime_markers():
    path = ROOT / "custom_components/leapmotor/config_flow.py"
    tree = ast.parse(path.read_text(encoding="utf-8-sig"))
    method = next(n for cls in tree.body if isinstance(cls, ast.ClassDef)
                  for n in cls.body if getattr(n, "name", "") == "_saved_account_vehicles")
    # Strip annotations only; execute the actual flow method against mixed domain data.
    method.returns = None
    for arg in method.args.args:
        arg.annotation = None
    ns = {"DOMAIN": "leapmotor", "context_key": lambda data, _: data["account"],
          "log": logging.getLogger(__name__)}
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), "exec"), ns)
    entry = SimpleNamespace(entry_id="one", data={"account": "account-a"})
    session = api.Session()
    client = SimpleNamespace(get_vehicle_list=lambda: ["vehicle-a", "vehicle-b"])
    runtime = SimpleNamespace(entry=entry, session=session, client=client)

    async def executor(fn, *args):
        return fn(*args)

    flow = SimpleNamespace(hass=SimpleNamespace(data={"leapmotor": {
        "_frontend_registered": True, "_sync_archive_v1": object(), "one": runtime}},
        async_add_executor_job=executor))
    result = run(ns["_saved_account_vehicles"](flow, entry, api.Session(), None))
    assert result == (session, client, ["vehicle-a", "vehicle-b"])


def test_unloading_one_vehicle_keeps_shared_archive_available(collector, monkeypatch):
    import sys
    import types
    coordinator, archive, vehicle = collector
    other = archive.run("ensure_vehicle", "ANOTHER")
    path = ROOT / "custom_components/leapmotor/__init__.py"
    tree = ast.parse(path.read_text(encoding="utf-8"))
    method = next(n for n in tree.body if isinstance(n, ast.AsyncFunctionDef) and n.name == "async_unload_entry")
    method.returns = None
    for arg in method.args.args:
        arg.annotation = None
    detached = []
    module = types.ModuleType("_sync_unload_test.account_runtime")
    module.detach = lambda item: detached.append(item)
    monkeypatch.setitem(sys.modules, module.__name__, module)
    ns = {"DOMAIN":"leapmotor", "PLATFORMS":[], "__package__":"_sync_unload_test",
          "time":api.time, "log":logging.getLogger(__name__)}
    exec(compile(ast.Module(body=[method], type_ignores=[]), str(path), "exec"), ns)

    async def unload(*args):
        return True

    coordinator.hass.config_entries = SimpleNamespace(async_unload_platforms=unload)
    coordinator.hass.data = {"leapmotor":{"one":coordinator,"two":object(),"_sync_archive_v1":archive}}
    assert run(ns["async_unload_entry"](coordinator.hass, SimpleNamespace(entry_id="one")))
    assert detached == [coordinator]
    assert archive.ready
    archive.run("ingest", other, "signal_map", {"1204":99}, {"sts":1}, 1)
    assert archive.run("observations", other)["points"][0]["signals_raw"]["1204"] == 99
