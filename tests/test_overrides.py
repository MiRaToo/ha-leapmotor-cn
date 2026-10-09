"""命令后的"乐观状态"覆盖: 车端上报新数据后必须让位给真实值。

背景(实测): 空调能开不能关 —— 命令发出后实体立刻回读车端信号(还是旧值),
HomeKit/Siri 读到状态没变就认为失败。

    python -m pytest tests/test_overrides.py -q
"""
import time

import api_client


def test_remembers_until_car_reports_newer_state():
    """宽限期设为 0 时就是旧行为: 任何更新的帧都让位给真实值。"""
    ov = api_client.StateOverrides(grace_seconds=0)
    ov.remember("ac_on", False, collect_time=1000)
    assert ov.recall("ac_on", collect_time=1000) is False     # 车端还是旧帧 → 用本地值
    assert ov.recall("ac_on", collect_time=999) is False      # 更旧的帧也算旧
    assert ov.recall("ac_on", collect_time=1001) is None      # 车端更新了 → 让位给真实值
    assert ov.recall("ac_on", collect_time=1001) is None      # 已失效, 不会复活


def test_override_survives_frames_collected_just_after_the_command():
    """真机回弹事故:  命令后 1 秒到达的"新帧"里车还没执行, 不能用它改写状态。

    遮阳帘: 17:43:35 下发开, 17:43:36 云端给了一帧只比命令晚 1 秒的采集(信号仍是 0),
    旧逻辑当场清掉乐观状态 → 界面从"开"弹回"关", 60 秒后才由真实上报改回来。
    """
    ov = api_client.StateOverrides(grace_seconds=120)
    ov.remember("sunshade", True, collect_time=1000)
    assert ov.recall("sunshade", collect_time=1001) is True          # +1 秒: 车来不及执行
    assert ov.recall("sunshade", collect_time=1000 + 119_999) is True  # 宽限期内仍以覆盖值为准
    assert ov.recall("sunshade", collect_time=1000 + 120_000) is None  # 宽限期满 → 真实值接管


def test_override_grace_default_is_long_enough_for_the_car():
    """默认宽限期要给足"车端执行 + 下一次上报"的时间(真机实测约 60 秒才回填)。"""
    assert api_client.OVERRIDE_GRACE_SECONDS >= 60
    ov = api_client.StateOverrides()
    assert ov.grace_ms == int(api_client.OVERRIDE_GRACE_SECONDS * 1000)


def test_unknown_key_and_forget():
    ov = api_client.StateOverrides()
    assert ov.recall("nothing", collect_time=1) is None
    ov.remember("k", 1, collect_time=5)
    ov.forget("k")
    assert ov.recall("k", collect_time=5) is None


def test_expires_by_ttl_even_if_car_never_updates():
    ov = api_client.StateOverrides(ttl_seconds=0.05)
    ov.remember("k", "v", collect_time=7)
    assert ov.recall("k", collect_time=7) == "v"
    time.sleep(0.08)
    assert ov.recall("k", collect_time=7) is None


def test_zero_collect_time_still_works():
    """车端还没给过 collectTime(刚启动)时, 覆盖也要生效。"""
    ov = api_client.StateOverrides()
    ov.remember("k", 1, collect_time=0)
    assert ov.recall("k", collect_time=0) == 1
