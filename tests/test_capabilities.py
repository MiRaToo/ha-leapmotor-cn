import sys,time
from pathlib import Path
from types import SimpleNamespace
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"custom_components/leapmotor"))
from capabilities import capability_view,pending_commands


def test_partial_closed_signals_cannot_confirm_windows_or_mirrors():
    from api_client import CarState
    from capabilities import control_values
    values = control_values(CarState(signals={"window_state_1": 0, "mirror_heat_left": 0}))
    assert values["windows"] is None
    assert values["mirror_heat"] is None
    values = control_values(CarState(signals={"window_state_1": 2, "mirror_heat_right": 1}))
    assert values["windows"] is True
    assert values["mirror_heat"] is True

def states(signals,**kwargs):
    st=SimpleNamespace(collect_time=time.time()*1000,signals=signals)
    return {c["key"]:c["status"] for c in capability_view(st,**kwargs)}

def test_missing_signal_is_not_unsupported():
    assert states({})["trunk"]=="signal_missing"
    assert states({"trunk_open":0})["trunk"]=="available"

def test_known_capabilities_and_energy_type():
    s=states({"seat_heat_rear_left":0,"seat_heat_rear_right":0},abilities=["1"],energy_type="bev")
    assert s["rear_heat"]=="unsupported" and s["fuel"]=="unsupported"
    assert states({},abilities=["22"])["rear_heat"]=="signal_missing"

def test_stale_and_accepted_command_are_distinct():
    assert states({"trunk_open":0},pending=["trunk"])["trunk"]=="pending"
    assert states({"trunk_open":0},pending=["trunk"],unavailable=True)["trunk"]=="unavailable"
    assert all(c["status"]=="unavailable" for c in capability_view(None))

def test_partial_window_percent_is_missing():
    assert states({"window_percent_left_front":0})["window_percent"]=="signal_missing"

def test_confirmation_uses_actual_signal_not_optimistic_hold():
    from api_client import CarState
    st=CarState(collect_time=int(time.time()*1000),signals={"lock_status":1,"trunk_open":0,"window_state_1":0,"window_state_2":0,"window_state_3":0,"window_state_4":0})
    recall=lambda key:{"lock":True,"trunk":True,"windows":False}.get(key)
    assert pending_commands(st,recall)==["trunk"]


def test_command_confirmation_survives_expired_optimistic_override():
    from api_client import CarState,StateOverrides
    baseline=int(time.time()*1000)
    sample=baseline+121_000
    st=CarState(collect_time=sample,signals={"lock_status":0,"trunk_open":0,
        "window_state_1":2,"window_state_2":2,"window_state_3":2,"window_state_4":2,
        "window_percent_left_front":10})
    overrides=StateOverrides(grace_seconds=120)
    overrides.remember("windows",False,collect_time=baseline)
    # Display is already back to real car data after grace, but no closing confirmation arrived.
    assert overrides.recall("windows",sample) is None
    pending=pending_commands(st,overrides.recall,overrides.confirmation_pending)
    assert "windows" in pending
    # A sufficiently late sample matching the expected result confirms and clears it.
    confirmed=CarState(collect_time=baseline+240_000,signals={"lock_status":0,"trunk_open":0,
        "window_state_1":0,"window_state_2":0,"window_state_3":0,"window_state_4":0})
    assert "windows" not in pending_commands(confirmed,overrides.recall,overrides.confirmation_pending)
