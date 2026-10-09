"""官方逐日能耗(getEC)缓存与组装(`energy_daily.py`)的测试。

背景:  「里程/能耗」卡的耗电线从云端逐日字段 `accumulatedEnergyConsume`
(实测不可靠) 换成**官方 getEC 任意窗口**(单日窗口就能查, 0.1 kWh, 驱动/空调/其它拆分)。
这里钉住四件关键性质:
  * 三种解析结果: 有数据 / 官方明确"没有"(`code=100`) / 异常(不落缓存);
  * 落缓存的规则: 过去的日子"没有"=真实的 0; **今天"没有"不落值**(回退自记更诚实);
  * 补拉计划: 过去的缺日子要补、失败有重试间隔; 今天按 TTL 重取;
  * 组装: 官方优先、自记兜底(并标出来)、eff 按"当日耗电 ÷ 当日里程"。
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))

import pytest  # noqa: E402

from energy_daily import (  # noqa: E402
    compose_days,
    ENERGY_TODAY_TTL_SECONDS,
    EnergyDayStore,
    parse_getec_day,
)


class FakeStore:
    def __init__(self, data=None):
        self.data = data
        self.saved = 0

    async def async_load(self):
        return self.data

    def async_delay_save(self, fn, delay):
        self.saved += 1


def make(**kw):
    return EnergyDayStore(hass=None, vin="TESTVIN", store=FakeStore())


# ── 解析: 三种结果 ──
def test_parse_getec_day_ok():
    resp = {"code": 0, "result": 0, "data": {"driverEC": "7.0", "acEC": "0.5", "otherEC": "0.9"}}
    out = parse_getec_day(resp)
    assert out == {"driver": 7.0, "ac": 0.5, "other": 0.9, "total": 8.4}


def test_parse_getec_day_empty_is_marker_not_zero():
    """官方明确"没有数据" —— 交给调用方按上下文处理(过去=0, 今天=回退自记)。"""
    assert parse_getec_day({"code": 100, "message": "未找到数据！"}) == "empty"
    assert parse_getec_day({"result": 2, "code": 2, "message": "请求参数含非法字符"}) is None
    assert parse_getec_day(None) is None
    assert parse_getec_day({}) is None
    # 有 data 但三个字段全缺 -> 按异常(不可信), 不是 0
    assert parse_getec_day({"code": 0, "data": {}}) is None


def test_parse_getec_day_partial_fields_count_as_data():
    out = parse_getec_day({"code": 0, "data": {"driverEC": "3.5"}})
    assert out is not None and out["driver"] == 3.5 and out["total"] == 3.5
    assert out["ac"] is None and out["other"] is None


# ── 落缓存: 过去 vs今天 ──
def test_record_past_and_today_semantics():
    st = make()
    # 过去的日子: 官方"没有" = 真实的 0
    st.record_empty("2026-10-01", is_today=False)
    assert st.get("2026-10-01")["total"] == 0.0
    assert st.get("2026-10-01")["empty"] is True
    # 今天: "没有" = 不落值(那个 0 只是还没记到)
    st.record_empty("2026-10-08", is_today=True)
    assert st.get("2026-10-08") is None
    # 有数据就落
    st.record("2026-10-02", {"driver": 4.0, "ac": 0.5, "other": 0.2, "total": 4.7})
    assert st.get("2026-10-02")["total"] == 4.7


# ── 补拉计划 ──
def test_plan_backfills_past_and_respects_budget_and_retry():
    st = make()
    win = [("2026-10-05", 1, 2), ("2026-10-06", 3, 4), ("2026-10-07", 5, 6),
           ("2026-10-08", 7, 8)]
    # 全缺: 从旧到新补, 预算 2 -> 只补头两天
    todo = st.plan(win, now=1000.0, fetch_today=True, budget=2)
    assert [d for d, _b, _e in todo] == ["2026-10-05", "2026-10-06"]
    # 补上一天后, 下次从缺的继续
    st.record("2026-10-05", {"total": 1.0})
    todo = st.plan(win, now=1000.0, fetch_today=True, budget=2)
    assert [d for d, _b, _e in todo] == ["2026-10-06", "2026-10-07"]
    # 失败的日子在重试间隔内不再补
    st.record_miss("2026-10-06", now=1000.0)
    todo = st.plan(win, now=1000.0 + 60, fetch_today=True, budget=10)
    assert "2026-10-06" not in [d for d, _b, _e in todo]
    # 过了间隔又补
    todo = st.plan(win, now=1000.0 + 3600 + 1, fetch_today=True, budget=10)
    assert "2026-10-06" in [d for d, _b, _e in todo]


def test_plan_today_ttl_and_no_fetch_flag():
    st = make()
    win = [("2026-10-07", 1, 2), ("2026-10-08", 3, 4)]
    # fetch_today=False: 只补过去
    todo = st.plan(win, now=1000.0, fetch_today=False, budget=10)
    assert [d for d, _b, _e in todo] == ["2026-10-07"]
    # 今天刚试过(失败) -> TTL 内不再试
    st.record_miss("2026-10-08", now=1000.0)
    todo = st.plan(win, now=1000.0 + 60, fetch_today=True, budget=10)
    assert "2026-10-08" not in [d for d, _b, _e in todo]
    # 过了 TTL 再试
    todo = st.plan(win, now=1000.0 + ENERGY_TODAY_TTL_SECONDS + 1, fetch_today=True, budget=10)
    assert "2026-10-08" in [d for d, _b, _e in todo]


def test_missing_counts_past_days_only_and_skips_cooldown():
    st = make()
    st.record("2026-10-06", {"total": 1.0})
    win = [("2026-10-05", 1, 2), ("2026-10-06", 3, 4), ("2026-10-07", 5, 6),
           ("2026-10-08", 7, 8)]
    # 缺 10-05 与 10-07; 今天(10-08)不算
    assert st.missing(win, now=1_000_000.0) == 2
    # 失败冷却期内的日子不算 pending(否则卡片 8 秒重拉会无限循环)
    st.record_miss("2026-10-05", now=1_000_000.0)
    assert st.missing(win, now=1_000_000.0 + 60) == 1
    # 冷却(默认 1 小时)过后重新计入
    assert st.missing(win, now=1_000_000.0 + 3600 + 1) == 2


# ── 组装 ──
def test_compose_official_preferred_and_trip_fallback():
    win = [("2026-10-06", 1, 2), ("2026-10-07", 3, 4), ("2026-10-08", 5, 6)]
    official = {"2026-10-06": {"driver": 4.0, "ac": 0.5, "other": 0.2, "total": 4.7}}
    km = {"2026-10-06": 30.0, "2026-10-07": 20.0}
    trip = {"2026-10-07": {"km": 20.0, "kwh": 3.0}, "2026-10-08": {"km": 5.0, "kwh": None}}
    days, source = compose_days(win, km, official, trip)
    assert source == "mixed"
    d6, d7, d8 = days
    assert d6["kwh"] == 4.7 and d6["kwh_src"] == "official" and d6["km"] == 30.0
    assert d6["eff"] == pytest.approx(15.7), "4.7 / 30 * 100"
    assert d6["drv"] == 4.0 and d6["ac"] == 0.5 and d6["oth"] == 0.2
    assert d7["kwh"] == 3.0 and d7["kwh_src"] == "trip"
    assert d7["eff"] == pytest.approx(15.0)
    assert d8["kwh"] is None and d8["km"] == 5.0, "自记没有耗电样本时不编数"


def test_compose_all_official_and_all_trip():
    win = [("2026-10-06", 1, 2), ("2026-10-07", 3, 4)]
    official = {"2026-10-06": {"total": 4.7}, "2026-10-07": {"total": 0.0}}
    days, source = compose_days(win, {"2026-10-06": 30.0}, official, {})
    assert source == "official"
    assert days[1]["kwh"] == 0.0 and days[1]["eff"] is None, "0 耗电不给效率"
    days2, source2 = compose_days(win, {}, {},
                                  {"2026-10-06": {"km": 10.0, "kwh": 1.5},
                                   "2026-10-07": {"km": 5.0, "kwh": 0.0}})
    assert source2 == "trip" and days2[0]["kwh_src"] == "trip"


def test_compose_short_distance_no_eff():
    win = [("2026-10-06", 1, 2)]
    days, _ = compose_days(win, {"2026-10-06": 0.3},
                           {"2026-10-06": {"total": 0.6}}, {})
    assert days[0]["eff"] is None, "里程 < 0.5 km 不给百公里能耗"


# ── 持久化往返 ──
def test_load_roundtrip_and_prune_tried():
    st = make()
    st._days = {"2026-10-06": {"driver": 1.0, "ac": None, "other": None,
                               "total": 1.0, "empty": False, "at": 1.0}}
    st._tried = {"2026-10-08": 2.0}
    dump = st._dump()
    st2 = EnergyDayStore(hass=None, vin="TESTVIN",
                         store=FakeStore({"days": dump["days"], "tried": dump["tried"]}))
    asyncio.run(st2.async_load())
    assert st2.get("2026-10-06")["total"] == 1.0
    # 脏数据(缺 total)不进缓存
    st3 = EnergyDayStore(hass=None, vin="TESTVIN",
                         store=FakeStore({"days": {"x": {"driver": 1.0}}, "tried": {}}))
    asyncio.run(st3.async_load())
    assert st3.get("x") is None
