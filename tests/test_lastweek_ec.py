"""上周能耗拆分: 窗口算法与响应解析(纯函数, 离线)。

背景(真车只读实测): `getLastweekEC` 传**整周窗口**(上周一 00:00:00 ~
上周日 23:59:59)返回 `{"driverEC":"86.9","acEC":"8.6","otherEC":"6.2"}`(字符串 kWh);
传小窗口(15 分钟)会回 `code=100 未找到数据!` —— 它不是任意区间接口, 窗口必须由
`previous_week_window_seconds()` 统一算。这里把窗口与解析钉住。
"""
from __future__ import annotations

import datetime
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "poller"))

import api_client  # noqa: E402


# ── 窗口: 上周一 00:00 ~ 上周日 23:59:59 ──
def test_prev_week_window_on_sunday_night():
    # 固定时间点是周日 → "上周" = 其前一周(周一~周日)
    b, e = api_client.previous_week_window_seconds(datetime.datetime(2026, 10, 4, 23, 1))
    assert datetime.datetime.fromtimestamp(b) == datetime.datetime(2026, 9, 21, 0, 0, 0)
    assert datetime.datetime.fromtimestamp(e) == datetime.datetime(2026, 9, 27, 23, 59, 59)
    assert datetime.datetime.fromtimestamp(b).weekday() == 0     # 周一
    assert datetime.datetime.fromtimestamp(e).weekday() == 6     # 周日


def test_prev_week_window_flips_at_monday_midnight():
    """周一零点一过, "上周"就翻成刚结束的那一周。"""
    b, e = api_client.previous_week_window_seconds(datetime.datetime(2026, 10, 5, 0, 30))
    assert datetime.datetime.fromtimestamp(b) == datetime.datetime(2026, 9, 28, 0, 0, 0)
    assert datetime.datetime.fromtimestamp(e).weekday() == 6
    assert datetime.datetime.fromtimestamp(e).date() == datetime.date(2026, 10, 4)
    # 周一 23:59 与 00:30 是同一周窗口
    b2, e2 = api_client.previous_week_window_seconds(datetime.datetime(2026, 10, 5, 23, 59))
    assert (b, e) == (b2, e2)


def test_prev_week_window_is_exactly_seven_days():
    """窗口头尾都在同一周内: 时长 = 7 天差 1 秒, 且尾=周一零点前 1 秒。"""
    import time as _t
    b, e = api_client.previous_week_window_seconds(datetime.datetime(2026, 10, 4, 12, 0))
    assert e - b == 7 * 86400 - 1
    # 周一零点(本地) 恰是 end + 1
    mon0 = datetime.datetime(2026, 9, 28, 0, 0, 0)
    assert int(mon0.timestamp()) == e + 1
    assert _t.strftime("%H:%M:%S", _t.localtime(b)) == "00:00:00"
    assert _t.strftime("%H:%M:%S", _t.localtime(e)) == "23:59:59"


# ── 解析 ──
def test_parse_lastweek_ec_strings_to_floats():
    got = api_client.parse_lastweek_ec(
        {"driverEC": "86.9", "acEC": "8.6", "otherEC": "6.2"})
    assert got == {"driver": 86.9, "ac": 8.6, "other": 6.2}
    # 数值型也接受(服务端版本差异)
    got2 = api_client.parse_lastweek_ec({"driverEC": 12, "acEC": 0, "otherEC": 3.5})
    assert got2 == {"driver": 12.0, "ac": 0.0, "other": 3.5}


def test_parse_lastweek_ec_missing_is_none_not_zero():
    """缺字段必须是 None —— 卡片靠它区分"没数据"(显示 —) 和"真的一点都没用"(显示 0)。"""
    got = api_client.parse_lastweek_ec({"driverEC": "5"})
    assert got["driver"] == 5.0 and got["ac"] is None and got["other"] is None
    assert api_client.parse_lastweek_ec({}) == {"driver": None, "ac": None, "other": None}
    assert api_client.parse_lastweek_ec(None) == {"driver": None, "ac": None, "other": None}
    assert api_client.parse_lastweek_ec({"driverEC": "abc"})["driver"] is None


def test_lastweek_endpoint_constant_is_registered():
    assert api_client.EP_LASTWEEK_EC == "v3/api/drivingrecord/getLastweekEC"
