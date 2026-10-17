"""受理后的计划在延迟回报、确认和超时下的状态；不执行车控。"""
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "custom_components/leapmotor"))
from charge_plan import effective_plan


def test_stale_cloud_does_not_reset_accepted_switch_or_time():
    raw = {"isEnable": 0, "beginTime": "07:00", "percent": 80}
    pending = {"isEnable": (1, 190), "beginTime": ("23:00", 190)}
    assert effective_plan(raw, pending, 20) == {**raw, "isEnable": 1, "beginTime": "23:00"}
    assert raw["isEnable"] == 0
    assert len(pending) == 2


def test_confirmed_fields_release_independently_including_numeric_strings():
    pending = {"isEnable": (1, 190), "beginTime": ("23:00", 190)}
    assert effective_plan({"isEnable": "1", "beginTime": "07:00"}, pending, 30) == {"isEnable": "1", "beginTime": "23:00"}
    assert list(pending) == ["beginTime"]
    effective_plan({"beginTime": "23:00"}, pending, 40)
    assert pending == {}


def test_unconfirmed_values_expire_and_missing_signal_stays_missing():
    pending = {"isEnable": (1, 190)}
    assert effective_plan({}, pending, 189) == {"isEnable": 1}
    assert effective_plan({}, pending, 190) == {}
    assert pending == {}
