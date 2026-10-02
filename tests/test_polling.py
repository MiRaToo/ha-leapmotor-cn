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


# ── 四档轮询决策(行程记录引入): 行驶 6s / 出发提速 6s / 限流退避 / 停车 60s ──
def test_choose_poll_seconds_tiers():
    import api_client
    c = api_client.choose_poll_seconds
    assert c(parked=60, trip=6, driving=True, launch_boost=False) == 6      # 行驶 → 行程采样
    assert c(parked=60, trip=6, driving=False, launch_boost=False) == 60    # 停车 → 60
    assert c(parked=60, trip=6, driving=False, launch_boost=True) == 6      # 出发提速
    assert c(parked=120, trip=10, driving=True, launch_boost=False) == 10   # 用户自定义
    # 限流退避: 取"停车档 × 2"与 120 的较大者
    assert c(parked=60, trip=6, driving=True, launch_boost=False, rate_limited=True) == 120
    assert c(parked=120, trip=6, driving=True, launch_boost=False, rate_limited=True) == 240
    # 下限与钳制: 停车档不会低于 60, 行程档不会低于 floor(默认 6)
    assert c(parked=10, trip=6, driving=False, launch_boost=False) == 60
    assert c(parked=60, trip=1, driving=True, launch_boost=False) == 6


def test_is_rate_limited_detection():
    import api_client
    assert api_client.is_rate_limited({"code": 1023, "message": "环境被风控"})
    assert api_client.is_rate_limited({"code": 0, "message": "操作过于频繁, 请稍后再试"})
    assert not api_client.is_rate_limited({"code": 0, "message": "请求成功"})
    assert not api_client.is_rate_limited(None)



# ── 回归: 轮询间隔的最小值必须容许"行驶 6 秒"这一档(2026-10-02 真机踩到) ──
def test_coordinator_allows_a_six_second_poll_interval():
    """`coordinator.timedelta_seconds` 曾经写死 `max(60, seconds)`, 让 6 秒档从未生效。

    真机证据(修前): 用户行驶中(车辆状态 = driving)轮询仍是 60 秒/次
    (「状态更新时间」历史 306 次间隔都是 60 秒); 行程点间隔中位 86 秒;
    24 段里 8 段因采样太稀被整段漏掉、只能"补记"。

    这条测试**直接检查源码里那个下限常量**(不依赖 HA 运行时)。
    """
    import pathlib as _p
    import re as _re

    src = (_p.Path(__file__).resolve().parent.parent / "custom_components" / "leapmotor"
           / "coordinator.py").read_text(encoding="utf-8")
    # 找出 timedelta_seconds 里用的下限(可以是字面量, 也可以是常量名)
    m = _re.search(r"def timedelta_seconds[\s\S]{0,400}?max\(([^,]+), seconds\)", src)
    assert m, "找不到 timedelta_seconds 的下限写法(改了实现就要同步这条测试)"
    token = m.group(1).strip()
    if token.isdigit():
        floor = int(token)
    else:
        cm = _re.search(_re.escape(token) + r"\s*=\s*(\d+)", src)
        assert cm, "下限常量 %s 找不到定义" % token
        floor = int(cm.group(1))
    assert floor <= 10, (
        "轮询间隔下限被钳到 %s 秒 —— 这会吃掉『行驶 6 秒』档(实测会导致行程点稀疏 + 大量补记)"
        % floor)
    # 再验证: 6 秒这一档确实不会被抬升
    assert max(floor, 6) == 6
