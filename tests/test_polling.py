"""轮询间隔策略: 行驶中快、停车慢(参考 EU 版双档轮询思路)。"""
import pytest

import api_client


def test_parked_uses_the_configured_interval():
    assert api_client.pick_poll_seconds(300, 60, driving=False) == 300
    assert api_client.pick_poll_seconds(600, 60, driving=False) == 600


def test_driving_uses_the_faster_interval():
    assert api_client.pick_poll_seconds(300, 60, driving=True) == 60
    assert api_client.pick_poll_seconds(1800, 120, driving=True) == 120


def test_driving_never_slower_than_parked_setting():
    # 用户把停车间隔调到 60 时, 行驶间隔不能反而更慢
    assert api_client.pick_poll_seconds(60, 300, driving=True) == 60


def test_interval_has_a_60_second_floor():
    assert api_client.pick_poll_seconds(10, 10, driving=False) == 60
    assert api_client.pick_poll_seconds(10, 10, driving=True) == 60
