"""T03 的发布版兼容边界：不联网，执行真实解析、签名、选路和协调器重试。"""
import ast
import functools
import hashlib
import hmac
import logging
import sys
import types
from datetime import datetime, timedelta, timezone
from pathlib import Path
from types import SimpleNamespace

import pytest

import api_client as api

VIN = "LFZT03TEST0000001"
REGION = "https://appgateway-region.leapmotor.com"
FRAME = {"code": 0, "data": {"vin": VIN, "collectTimeMs": 1_800_000_000_000,
                                "signalMap": {"soc": 62, "totalMileage": 73489}}}


def run_immediate(coro):
    """All I/O in these offline coordinator tests completes in the executor stub."""
    try:
        coro.send(None)
    except StopIteration as result:
        return result.value
    raise AssertionError("unexpected asynchronous suspension")


def client(car_type="T03", answer=None, route=None):
    instance = api.LeapmotorClient(api.Session(car_type=car_type, car_vin=VIN,
                                             hkdf_key_hex="ab" * 32, car_token="test"))
    instance.calls = []

    def http(method, url, headers, body=None, form=False):
        instance.calls.append((method, url, body, form, headers))
        return answer(method, url, body, form) if answer else FRAME

    def global_call(path, fields):
        instance.calls.append(("route", path, fields, None, {}))
        return route if route is not None else {"code": 0, "data": {"vin": VIN, "appRegion": REGION}}

    instance._http, instance.global_call = http, global_call
    return instance


@pytest.mark.parametrize("car_type", ["C10", "C01", "C11", "C16", "B05", "B10", "S01", "", None])
def test_other_models_keep_original_request_and_never_probe(car_type):
    response = {"code": 0, "data": {"vin": VIN, "collectTime": 123,
                                      "signalMap": {"1204": 62, "1318": 73489}}}
    cli = client(car_type, lambda *_: response)
    state = cli.get_car_state(VIN)
    assert state == api.parse_car_state(response)
    assert cli.try_t03_car_state(VIN, 302010205) is None
    assert len(cli.calls) == 1
    assert cli.calls[0][:4] == ("POST", api.BASE_URL + api.EP_SIGNAL_QUERY, {"vin": VIN}, True)
    assert cli.last_state_meta == {}


def test_request_signs_the_exact_headers_sent_even_when_clock_advances(monkeypatch):
    clock = iter([1_800_000_000.001, 1_800_000_000.003, 1_800_000_000.007])
    monkeypatch.setattr(api.time, "time", lambda: next(clock))
    cli = client("C10")
    headers = cli.build_headers({"vin": VIN})
    signed = {key: headers[key] for key in (
        "acceptLanguage", "channel", "deviceType", "source", "timestamp", "version", "deviceId")}
    expected = hmac.new(cli.session.hkdf_key,
                        api.sort_and_concat({"vin": VIN, **signed}).encode(), hashlib.sha256).hexdigest()
    assert headers["sign"] == headers["digest"] == expected
    assert headers["timestamp"] == "1800000000001"


@pytest.mark.parametrize("shape", ["signalMap", "signal", "data"])
def test_named_frames_keep_real_zero_false_units_and_missing_values(shape):
    fields = {"soc": 0, "totalMileage": "73489", "speed": 0, "gearStatus": 0,
              "driverDoorLockStatus": False, "acSwitch": "false", "bbcmBackDoorStatus": True,
              "batteryCurrent": "-3.5", "leftFrontTirePressure": "253",
              "rightFrontWindowPercent": 20, "longitude": -3.25, "latitude": 40.5}
    data = {"vin": VIN, "collectTimeMs": 1_800_000_000_000}
    data.update(fields if shape == "data" else {shape: fields})
    state = api.parse_t03_car_state({"result": 0, "data": data}, VIN)
    assert state.soc == 0 and state.get("speed") == 0
    assert state.get("odometer") == 73489
    assert state.flag("lock_status") is False and state.flag("climate_on") is False
    assert state.flag("trunk_open") is True
    assert state.get("charging_current") == -3.5 and state.get("tire_fl") == 253
    assert state.get("window_percent_right_front") == 20
    assert state.get("seat_vent_rear_left") is None
    assert state.longitude == -3.25 and state.latitude == 40.5
    assert state.get("interior_temp") is None and state.get("tire_rr") is None
    assert state.collect_time == 1_800_000_000_000 and state.raw["sts"] == state.collect_time


def test_named_t03_ignores_numbered_placeholders_and_does_not_confuse_windows_with_seats():
    state = api.parse_t03_car_state({"code": 0, "data": {"signalMap": {
        "soc": 56, "expectedMileage": 160, "2188": 0, "1879": 80,
        "leftRearWindowPercent": 35, "indoorTemp": "0", "minSingleTemp": 19,
        "collectTime": "2026-10-20 08:09:10"}}}, VIN)
    assert state.soc == 56 and state.range_km == 160
    assert state.get("window_percent_left_rear") == 35
    assert state.get("seat_heat_rear_left") is None
    assert state.get("interior_temp") == 0 and state.get("battery_min_temp") == 19
    expected = datetime(2026, 10, 20, 8, 9, 10, tzinfo=timezone(timedelta(hours=8))).timestamp()
    assert state.collect_time == int(expected * 1000)


def test_t03_numbered_frames_and_numeric_strings_remain_usable():
    state = api.parse_t03_car_state({"code": "0", "data": {"vin": VIN,
        "collectTime": 1_800_000_000_000, "signalMap": {"1204": "62", "1298": True,
                                                        "1178": "-3.5", "1319": "0"}}}, VIN)
    assert state.soc == 62 and state.flag("lock_status") is True
    assert state.get("charging_current") == -3.5 and state.get("speed") == 0


def test_numbered_t03_keeps_existing_coordinate_fallbacks():
    state = api.parse_t03_car_state({"code": 0, "data": {"signalMap": {
        "1204": 62, "3724": 120.5, "3725": 30.25}}}, VIN)
    assert state.soc == 62 and (state.latitude, state.longitude) == (30.25, 120.5)


def test_t03_request_metadata_never_contains_named_location_values():
    cli = client(answer=lambda *_: {"code": 0, "data": {"soc": 62,
        "longitude": 121.987654, "latitude": 31.123456, "bluetoothAddr": "secret-address"}})
    assert cli.get_car_state(VIN).soc == 62
    for secret in (VIN, "121.987654", "31.123456", "secret-address"):
        assert secret not in repr(cli.last_state_meta)


def test_legacy_named_data_can_have_an_empty_map_placeholder():
    state = api.parse_t03_car_state({"code": 0, "data": {"signalMap": None, "soc": 62}}, VIN)
    assert state.soc == 62


@pytest.mark.parametrize("payload", [None, [], {"code": 0, "data": None},
    {"code": 0, "data": {"vin": "OTHER", "soc": 62}},
    {"code": 39, "data": {"soc": 62}}, {"code": 40, "data": {"soc": 62}},
    {"code": 0, "data": {"signalMap": {"soc": "nan", "speed": "inf", "totalMileage": "bad"}}},
    {"code": 0, "data": {"signalMap": {"sts": 1_800_000_000_000}}},
    {"code": 0, "data": {"signalMap": {"unknown": 1}}},
    {"code": 0, "data": {"soc": False}},
])
def test_bad_or_refused_frame_cannot_become_valid_vehicle_data(payload):
    state = api.parse_t03_car_state(payload, VIN)
    assert not state.raw and state.soc is None


def test_working_t03_does_not_switch_after_a_temporary_empty_frame():
    cli = client()
    assert cli.get_car_state(VIN).soc == 62
    cli._http = lambda *_args, **_kwargs: {"code": 0, "data": {}}
    assert not cli.get_car_state(VIN).raw
    before = len(cli.calls)
    assert cli.try_t03_car_state(VIN, 0) is None
    assert len(cli.calls) == before


def test_failed_primary_then_successful_region_is_reused_without_reprobing():
    def answer(_method, url, _body, form):
        return FRAME if url.startswith(REGION) and not form else {"code": 302010205}
    cli = client(answer=answer)
    assert not cli.get_car_state(VIN).raw
    assert not cli.get_car_state(VIN).raw
    assert cli.try_t03_car_state(VIN, 302010205).soc == 62
    assert [call[0] for call in cli.calls] == ["POST", "POST", "route", "POST"]
    assert cli.get_car_state(VIN).soc == 62
    assert cli.calls[-1][1] == REGION + api.EP_SIGNAL_QUERY and cli.calls[-1][3] is False
    assert len([call for call in cli.calls if call[0] == "route"]) == 1
    assert cli.calls[-1][4]["cartype"] == "T03" and cli.calls[-1][4]["carvin"] == VIN
    assert VIN not in repr(cli.last_state_meta) and "test" not in repr(cli.last_state_meta)
    assert cli.last_state_meta["strategy"] == "t03-route"


@pytest.mark.parametrize("code", [None, -1, 40, 401, 1023, 302002004, 302010219])
def test_network_auth_permission_and_rate_errors_do_not_trigger_probing(code):
    cli = client()
    assert cli.try_t03_car_state(VIN, code) is None and cli.calls == []


@pytest.mark.parametrize("host", ["http://appgateway.leapmotor.com", "https://evil.example",
    "https://appgateway.leapmotor.com.evil.example", "https://appgateway.leapmotor.com:8443",
    "https://appgateway.leapmotor.com/path", "https://appgateway.leapmotor.com?q=x",
    "https://user:secret@appgateway.leapmotor.com", "https://appgateway.leapmotor.com:bad", ""])
def test_invalid_route_never_receives_a_vehicle_request(host):
    cli = client(route={"code": 0, "data": {"appRegion": host}})
    assert cli.try_t03_car_state(VIN, 100) is None
    assert len(cli.calls) == 1 and cli.calls[0][0] == "route"
    assert "secret" not in repr(cli.last_state_meta)


def test_failed_probe_has_a_cooldown_and_does_not_replace_primary_path(monkeypatch):
    clock = [10_000]
    monkeypatch.setattr(api.time, "monotonic", lambda: clock[0])
    cli = client(answer=lambda *_: {"code": 100})
    assert not cli.try_t03_car_state(VIN, 100).raw
    assert len(cli.calls) == 3  # 路由 + 区域 JSON + 区域 form，随后停止。
    assert cli.try_t03_car_state(VIN, 100) is None
    assert len(cli.calls) == 3 and cli._t03_state_paths == {}
    cli.get_car_state(VIN)
    assert cli.calls[-1][1] == api.BASE_URL + api.EP_SIGNAL_QUERY
    clock[0] += api.T03_COMPAT_COOLDOWN_SECONDS + 1
    cli.try_t03_car_state(VIN, 100)
    assert len(cli.calls) == 7


@pytest.mark.parametrize("response,expected_code", [({"code": 39}, 39),
    ({"code": 1023}, 1023), ({"code": 0, "message": "操作过于频繁"}, 1023)])
def test_probe_stops_immediately_on_signature_or_rate_refusal(response, expected_code):
    cli = client(answer=lambda *_: response)
    state = cli.try_t03_car_state(VIN, 100)
    assert not state.raw and state.resp_code == expected_code
    assert len(cli.calls) == 2


def test_same_gateway_does_not_repeat_the_form_request():
    cli = client(answer=lambda *_: {"code": 100}, route={"code": 0, "data": {"appRegion": api.BASE_URL}})
    cli.try_t03_car_state(VIN, 100)
    assert len(cli.calls) == 2 and cli.calls[-1][3] is False


def test_new_region_form_is_selected_only_after_json_returns_no_data():
    cli = client(answer=lambda _m, _u, _b, form: FRAME if form else {"code": 100})
    assert cli.try_t03_car_state(VIN, 100).soc == 62
    assert [call[3] for call in cli.calls] == [None, False, True]
    assert cli.get_car_state(VIN).soc == 62 and cli.calls[-1][3] is True


def test_route_cache_expires_and_can_recover_to_original_path(monkeypatch):
    clock = [10_000]
    monkeypatch.setattr(api.time, "monotonic", lambda: clock[0])
    cli = client()
    assert cli.try_t03_car_state(VIN, 100).soc == 62
    assert cli.get_car_state(VIN).soc == 62 and cli.calls[-1][1].startswith(REGION)
    clock[0] += api.T03_COMPAT_COOLDOWN_SECONDS + 1
    assert cli.get_car_state(VIN).soc == 62
    assert cli.calls[-1][1] == api.BASE_URL + api.EP_SIGNAL_QUERY
    assert cli.try_t03_car_state(VIN, 100) is None


def test_route_for_another_vehicle_is_never_used():
    cli = client(route={"code": 0, "data": {"vin": "ANOTHER", "appRegion": REGION}})
    assert not cli.try_t03_car_state(VIN, 100).raw
    assert len(cli.calls) == 1


def coordinator_runtime(cli):
    source = Path(__file__).resolve().parents[1] / "custom_components/leapmotor/coordinator.py"
    tree = ast.parse(source.read_text(encoding="utf-8"))
    original = next(node for node in tree.body if isinstance(node, ast.ClassDef)
                    and node.name == "LeapmotorCoordinator")
    method = next(node for node in original.body if getattr(node, "name", "") == "_refresh_car_data")
    cls = ast.ClassDef(name="Runtime", bases=[], keywords=[], decorator_list=[], body=[method])
    module = ast.fix_missing_locations(ast.Module(body=[cls], type_ignores=[]))
    namespace = {"time": api.time, "functools": functools, "log": logging.getLogger(__name__),
                 "is_rate_limited": api.is_rate_limited, "is_signature_error": api.is_signature_error,
                 "__package__": "_t03_coordinator_test"}
    runtime = types.ModuleType("_t03_coordinator_test.account_runtime")
    async def renew(coordinator, **kwargs):
        renewed = coordinator._renew_if_needed(force=kwargs.get("force", False))
        if renewed:
            coordinator._persist()
        return renewed
    runtime.async_renew = renew
    sys.modules[runtime.__name__] = runtime
    exec(compile(module, str(source), "exec"), namespace)
    coord = namespace["Runtime"]()
    async def execute(fn, *args):
        return fn(*args)
    async def clear():
        pass
    coord.hass = SimpleNamespace(async_add_executor_job=execute)
    coord.client, coord.session, coord.vin = cli, cli.session, VIN
    coord._auth_revision = 0
    coord.state = api.parse_car_state({"code": 0, "data": {"signalMap": {"1204": 51}}})
    coord.light_first_refresh, coord.trips, coord._prev_vehicle_state = True, None, None
    coord.events = []
    coord._renew_if_needed = lambda **_: coord.events.append("renew") or True
    coord._persist = lambda: coord.events.append("persist")
    coord._note_reev = lambda: None
    coord._clear_stale_session_notices = clear
    coord._adapt_poll_interval = lambda: None
    coord._enter_rate_limit = lambda _: coord.events.append("limited")
    return coord


def test_coordinator_completes_original_signature_recovery_before_t03_probe():
    cli = client(answer=lambda _m, url, _b, _f: FRAME if url.startswith(REGION) else {"code": 302010205})
    coord = coordinator_runtime(cli)
    run_immediate(coord._refresh_car_data())
    assert coord.events == ["renew", "persist"]
    assert [call[0] for call in cli.calls] == ["POST", "POST", "route", "POST"]
    assert coord.state.soc == 62 and coord.car_state_problem == ""


@pytest.mark.parametrize("model", ["C10", "B10", "B05", "C16"])
def test_other_models_keep_retry_count_and_previous_frame(model):
    cli = client(model, answer=lambda *_: {"code": 302010205})
    coord = coordinator_runtime(cli)
    run_immediate(coord._refresh_car_data())
    assert coord.events == ["renew", "persist"]
    assert len(cli.calls) == 2 and coord.state.soc == 51
    assert "302010205" in coord.car_state_problem


def test_t03_probe_failure_preserves_previous_frame_and_rate_backoff():
    cli = client(answer=lambda _m, url, _b, _f: {"code": 1023} if url.startswith(REGION) else {"code": 100})
    coord = coordinator_runtime(cli)
    coord.light_first_refresh = False
    async def heavy():
        coord.events.append("heavy")
    coord._refresh_heavy = heavy
    coord._photo_due = lambda *_: coord.events.append("photo") or False
    run_immediate(coord._refresh_car_data())
    assert coord.state.soc == 51 and coord.events == ["limited"]
    assert len(cli.calls) == 4


def test_t03_probe_transport_failure_does_not_interrupt_polling():
    cli = client(answer=lambda *_: {"code": 100})
    def failed_route(*_):
        raise TimeoutError("unavailable")
    cli.global_call = failed_route
    coord = coordinator_runtime(cli)
    run_immediate(coord._refresh_car_data())
    assert coord.state.soc == 51 and "车况未取到" in coord.car_state_problem
    assert cli.try_t03_car_state(VIN, 100) is None
