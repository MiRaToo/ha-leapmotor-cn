"""逐日里程/能耗序列(`TripRecorder.daily_series`)等相关纯函数的测试。

背景: 新卡片「零跑·里程能耗」要按"天"画折线 —— 里程/能耗只在天的粒度上有意义。
数据源几经更迭(见 docs/DEVLOG.md):
  * 周视图曾优先用云端 `mileage/energy/detail` 的逐日明细, 月视图只用自记;
  * 云端那个逐日字段实测不可靠(`accumulatedEnergyConsume` 逐日为 0、
    求和远小于官方聚合), 耗电改用**官方 getEC 任意窗口**(见 tests/test_energy_daily_official.py),
    这里只保留仍被使用的纯函数(自记按天聚合 + 带 epoch 窗口的一天序列)。
"""
from __future__ import annotations

import pathlib
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

import pytest

from trips import Trip, TripRecorder, day_start_of, recent_day_starts, recent_day_windows  # noqa: E402

T0 = 1_790_000_000.0


class FakeStore:
    def __init__(self, data=None):
        self.data = data

    async def async_load(self):
        return self.data

    def async_delay_save(self, fn, delay):
        pass


def recorder():
    return TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                        poll_seconds_getter=lambda: 6, store=FakeStore())


def add(rec, days_ago, hour, km, kwh, dur_min=30):
    day0 = day_start_of(T0)
    end = day0 - days_ago * 86400 + hour * 3600
    rec.trips.append(Trip(id=f"t{days_ago}_{hour}", started_at=end - dur_min * 60,
                          ended_at=end, distance_km=km, energy_kwh=kwh))


# ── 日期轴 ──
def test_recent_day_starts_is_old_to_new_ending_today():
    today = time.strftime("%Y-%m-%d", time.localtime(T0))
    seq = recent_day_starts(7, now=T0)
    assert len(seq) == 7
    assert seq[-1][0] == today, "最后一个必须是今天"
    assert [s for s, _ in seq] == sorted(s for s, _ in seq), "必须旧→新"
    # 相邻两项差一天(±DST 一小时以内)
    for (_, a), (_, b) in zip(seq, seq[1:]):
        assert 86000 <= b - a <= 90000


def test_recent_day_windows_cover_each_day_and_cap_today_at_now():
    """带 epoch 窗口的一天序列: 昨天是 [0点, 23:59:59], 今天是 [0点, 现在]。

    云端 getEC 对"窗口终点晚于现在"会回 code=2, 所以今天必须收在 now。
    """
    seq = recent_day_windows(3, now=T0)
    assert len(seq) == 3
    for i, (day, begin, end) in enumerate(seq):
        assert day == recent_day_starts(3, now=T0)[i][0]
        assert end >= begin
        assert end - begin <= 86400 - 1
    # 昨天的 end 严格早于今天的 begin(跨天不重叠)
    for (_, b1, e1), (_, b2, _e2) in zip(seq, seq[1:]):
        assert e1 < b2
    # 今天: end 收在 now
    _day, today_begin, today_end = seq[-1]
    assert today_begin <= T0 and today_end == T0


# ── 分桶 ──
def test_daily_series_buckets_by_end_day_and_marks_unrecorded_as_none():
    rec = recorder()
    add(rec, 0, 10, 20.0, 3.0)     # 今天
    add(rec, 1, 9, 10.0, 1.5)      # 昨天
    add(rec, 4, 8, 5.0, 1.0)       # 4 天前(覆盖期内)
    out = rec.daily_series(7, now=T0)
    days = out["days"]
    assert len(days) == 7
    by_day = {d["day"]: d for d in days}
    # 4 天前那天有数、之后的"没行程"是真实的 0(因为已在记录期内)
    target4 = time.strftime("%Y-%m-%d", time.localtime(day_start_of(T0) - 4 * 86400))
    target0 = time.strftime("%Y-%m-%d", time.localtime(T0))
    target1 = time.strftime("%Y-%m-%d", time.localtime(day_start_of(T0) - 86400))
    assert by_day[target4]["km"] == 5.0 and by_day[target4]["kwh"] == 1.0
    assert by_day[target1]["km"] == 10.0 and by_day[target1]["kwh"] == 1.5
    assert by_day[target0]["km"] == 20.0 and by_day[target0]["kwh"] == 3.0
    # 覆盖期起点之前的 >4 天前的日子: None(没被记录过)
    first_day = min(d["day"] for d in days)
    assert by_day[first_day]["km"] is None and by_day[first_day]["kwh"] is None
    assert out["coverage_from"] == target4


def test_daily_series_mid_period_no_trip_day_is_zero_not_none():
    rec = recorder()
    add(rec, 0, 10, 1.0, 0.5)
    add(rec, 3, 10, 1.0, 0.5)
    out = rec.daily_series(4, now=T0)
    mid = out["days"][-2]              # 昨天: 记录期内、没有行程
    assert mid["km"] == 0 and mid["kwh"] == 0, "记录期内没行程是 0, 不是 None"


def test_daily_series_cross_midnight_trip_goes_to_end_day():
    """跨天行程归'结束那天' —— 与 stats() 的口径一致。"""
    rec = recorder()
    day0 = day_start_of(T0)
    rec.trips.append(Trip(id="x", started_at=day0 - 25 * 60, ended_at=day0 + 25 * 60,
                          distance_km=7.0, energy_kwh=1.0))
    days = rec.daily_series(2, now=T0)["days"]
    assert days[0]["km"] is None or days[0]["km"] == 0     # 昨天: 没数
    assert days[1]["km"] == 7.0                            # 今天: 有


def test_daily_series_empty_recorder_all_none():
    rec = recorder()
    days = rec.daily_series(7, now=T0)["days"]
    assert len(days) == 7
    assert all(d["km"] is None and d["kwh"] is None for d in days)
    assert rec.daily_series(7, now=T0)["coverage_from"] is None


def test_daily_series_ignores_old_trips_outside_window():
    rec = recorder()
    add(rec, 0, 10, 2.0, 1.0)
    add(rec, 20, 10, 50.0, 9.0)        # 20 天前: 不在 7 天窗口
    days = rec.daily_series(7, now=T0)["days"]
    assert sum((d["km"] or 0) for d in days) == 2.0


def test_daily_series_clamps_days():
    rec = recorder()
    assert len(rec.daily_series(99, now=T0)["days"]) == 31
    assert len(rec.daily_series(0, now=T0)["days"]) == 1


def test_daily_series_eff_per_day_matches_stats_style():
    """百公里能耗要按天给(与 stats() 同口径: ΔSOC 折算耗电 / 里程; 里程 < 0.5 km 不给)。"""
    rec = recorder()
    add(rec, 0, 10, 20.0, 3.0)      # 今天: 20 km / 3 kWh → 15 kWh/100km
    add(rec, 1, 9, 10.0, 2.0)       # 昨天: 10 km / 2 kWh → 20 kWh/100km
    add(rec, 2, 8, 0.3, 1.0)        # 前天: 只挪了 0.3 km → 不给效率(None)
    days = rec.daily_series(3, now=T0)["days"]
    assert days[2]["eff"] == pytest.approx(15.0)
    assert days[1]["eff"] == pytest.approx(20.0)
    assert days[0]["eff"] is None, "里程太短的日不给百公里能耗"
    # 再往前一天(首条行程之前): 没被记录过 → km 是 None 而不是 0, eff 也没有
    days4 = rec.daily_series(4, now=T0)["days"]
    assert days4[0]["km"] is None and days4[0]["eff"] is None


def test_daily_series_eff_none_on_known_day_without_trips():
    """记录期内、但没有行程的那天: km/kwh 是真实的 0, eff 不能除以零(给 None)。"""
    rec = recorder()
    add(rec, 0, 10, 5.0, 1.0)       # 今天有行程
    add(rec, 2, 10, 5.0, 1.0)       # 两天前也有行程; 昨天没开车
    days = rec.daily_series(3, now=T0)["days"]
    assert days[1]["km"] == 0 and days[1]["kwh"] == 0
    assert days[1]["eff"] is None
