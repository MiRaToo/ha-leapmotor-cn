"""车况信号解析(signal/info/query → CarState)的回归测试。

信号号→含义的对照表来自 EU 版 HA 集成在真实 C10/B10 上校验过的结果,
并与国内 App 的 `ServerCarInfoBean` 字段一一对应;这里锁住的是
**解析逻辑**(优先级/回落/单位换算), 避免以后换实现时把语义搞错。

    python -m pytest tests/test_car_state.py -q
"""
import pytest

import api_client


def state(signals: dict, collect_time: int = 1790456795283, vin: str = "LFZTEST") -> api_client.CarState:
    return api_client.parse_car_state({
        "code": 0,
        "data": {"vin": vin, "collectTime": collect_time, "signalMap": signals},
    })


# ── 经纬度 ──
def test_gps_prefers_signed_signals():
    st = state({"2": 121.473701, "3": 31.230416,
                "3724": 121.469002, "3725": 31.233512,
                "2190": 31.233515, "2191": 121.469001})
    assert st.latitude == pytest.approx(31.230416)
    assert st.longitude == pytest.approx(121.473701)


def test_gps_falls_back_to_unsigned_then_legacy():
    assert state({"3725": 31.233512, "3724": 121.469002}).latitude == pytest.approx(31.233512)
    st = state({"2190": 31.233515, "2191": 121.469001})
    assert (st.latitude, st.longitude) == (pytest.approx(31.233515), pytest.approx(121.469001))


def test_gps_keeps_southern_hemisphere_sign():
    """绝对值那套会丢负号, 所以带符号的信号优先 —— 南半球不能被翻到北边。"""
    st = state({"2": 151.2, "3": -33.86, "3724": 151.2, "3725": 33.86})
    assert st.latitude == pytest.approx(-33.86)


def test_gps_rejects_out_of_range():
    assert state({"3": 120.0, "2": 27.0}).latitude is None      # 纬度 >90 视为无效
    assert state({"2": 200.0, "3": 27.0}).longitude is None


# ── 电量 / 续航 ──
def test_soc_prefers_precise_value_and_accepts_zero():
    assert state({"100003": 36.9, "1204": 37}).soc == pytest.approx(36.9)
    assert state({"1204": 37}).soc == pytest.approx(37)
    assert state({"100003": 0.0, "1204": 0}).soc == 0        # 0 是有效值, 不能当缺失
    assert state({}).soc is None


def test_range_fallback_chain():
    assert state({"3260": 170, "2188": 168}).range_km == 170
    assert state({"2188": 168}).range_km == 168
    assert state({"3261": 512.5}).range_km == pytest.approx(512.5)
    assert state({}).range_km is None


# ── 胎压 ──
def test_tire_pressure_kpa_to_bar():
    st = state({"2646": 247, "2653": 247, "2660": 247, "2667": 250})
    assert [st.tire_bar(c) for c in ("fl", "fr", "rl", "rr")] == [2.47, 2.47, 2.47, 2.5]
    assert st.tire_bar("fl") == pytest.approx(2.47)


def test_tire_pressure_missing_is_none():
    st = state({"2646": 247})
    assert st.tire_bar("fl") == pytest.approx(2.47)
    assert st.tire_bar("rr") is None


# ── 锁 / 充电 / 行驶状态 ──
def test_lock_status_semantics():
    assert state({"1298": 1}).locked is True
    assert state({"1298": 0}).locked is False
    assert state({}).locked is None


def test_charging_requires_cable_and_current():
    assert state({"1149": 0, "1178": 0.0}).charging is False        # 没插枪
    assert state({"1149": 2, "1178": 0.0}).charging is False        # 插着但没进电流
    assert state({"1149": 2, "1178": -12.5}).charging is True       # 真在充
    assert state({"1298": 1}).charging is None                      # 两个关键信号都缺


def test_vehicle_state_from_gear_then_speed():
    assert state({"1010": 0, "1319": 0}).vehicle_state == "parked"
    assert state({"1010": 3, "1319": 60}).vehicle_state == "driving"
    assert state({"1319": 12.0}).vehicle_state == "driving"        # 没档位就看车速
    assert state({"1319": 0.0}).vehicle_state == "parked"
    assert state({}).vehicle_state is None


# ── 开关位 / 时间 ──
def test_flags_and_collect_time():
    st = state({"48": 1, "3636": 0, "1938": 1})
    assert st.flag("healthy_charging") is True
    assert st.flag("sentry_mode") is False
    assert st.flag("climate_on") is True
    assert st.flag("mirror_heat_left") is None
    assert st.collect_time == 1790456795283
    assert st.vin == "LFZTEST"


def test_raw_map_is_preserved_for_unmapped_signals():
    st = state({"2646": 247, "99999": 42})
    assert st.raw["99999"] == 42          # 表里没有的信号也留着, 便于以后补映射
    assert "99999" not in st.signals


def test_bad_payload_does_not_raise():
    assert api_client.parse_car_state({}).vin == ""
    assert api_client.parse_car_state({"data": None}).latitude is None
    assert api_client.parse_car_state(None).soc is None


# ── 车型相关信号(部分车才有, 表里先备好) ──
def test_model_specific_signals_are_mapped():
    st = state({"1724": 30, "2189": 1, "6048": 80, "12054": 1})
    assert st.get("sunshade_percent") == 30       # 1724 实为遮阳帘开度(真车实测)
    assert st.flag("park_assist_enabled") is True
    assert st.get("speed_limit_kmh") == 80
    assert st.flag("speed_limit_enabled") is True


def test_missing_model_specific_signals_stay_none():
    st = state({"100003": 50})
    assert st.get("sunshade_percent") is None
    assert st.flag("speed_limit_enabled") is None


# ── 方向盘加热: 开关位 1816 才是"开关", 1624 是剩余分钟 ──
def test_steering_wheel_heat_uses_switch_flag_not_minutes():
    """真车实测: 1624 常驻 15(App 里从未开过方向盘加热), 必须用 1816 判开关。"""
    off = state({"1624": 15, "1816": 0})
    assert off.flag("steering_wheel_heating") is False   # ← 实体据此显示"关"
    assert off.get("steering_heat_minutes") == 15       # 仅作为属性参考

    on = state({"1624": 15, "1816": 1})
    assert on.flag("steering_wheel_heating") is True


# ── 坐标系换算: 车端 GCJ-02 → 对外 WGS-84 ──
def test_gcj_to_wgs_roundtrip_is_millimetre_accurate():
    glat, glon = 31.230416, 121.473701          # 示例坐标(公开用, 非车主位置)
    wlat, wlon = api_client.gcj02_to_wgs84(glat, glon)
    back = api_client.wgs84_to_gcj02(wlat, wlon)
    assert abs(back[0] - glat) * 111000 < 0.01   # 往返误差 < 1 cm
    assert abs(back[1] - glon) * 98000 < 0.01


def test_gcj_to_wgs_offset_is_a_few_hundred_metres_in_china():
    glat, glon = 31.230416, 121.473701
    wlat, wlon = api_client.gcj02_to_wgs84(glat, glon)
    assert 200 < abs(wlat - glat) * 111000 < 600   # 国内 GCJ-02 偏移量级
    assert 200 < abs(wlon - glon) * 98000 < 600


def test_coordinate_conversion_is_identity_outside_china():
    # 阿姆斯特丹(HA 默认 home 的位置)不该被偏移
    assert api_client.wgs84_to_gcj02(52.3731, 4.8903) == (52.3731, 4.8903)
    assert api_client.gcj02_to_wgs84(52.3731, 4.8903) == (52.3731, 4.8903)


def test_car_state_exposes_wgs_coordinates_for_ha():
    st = state({"2": 121.473701, "3": 31.230416})
    assert st.latitude == pytest.approx(31.230416)          # 原始 GCJ-02
    assert st.longitude == pytest.approx(121.473701)
    assert st.latitude_wgs == pytest.approx(31.232364, abs=1e-4)   # 对外 WGS-84
    assert st.longitude_wgs == pytest.approx(121.475968, abs=1e-4)
    # 没定位时不能瞎编
    assert state({}).latitude_wgs is None


# ── 车窗: 本车用 1693~1696(0=关/2=开), 不是 EU 表的百分比 ──
def test_window_state_signals():
    closed = state({"1693": 0, "1694": 0, "1695": 0, "1696": 0})
    assert [closed.get(f"window_state_{i}") for i in (1, 2, 3, 4)] == [0, 0, 0, 0]
    opened = state({"1693": 2, "1694": 2, "1695": 2, "1696": 2})
    assert [opened.get(f"window_state_{i}") for i in (1, 2, 3, 4)] == [2, 2, 2, 2]


# ── 车窗开合判定: 全关必须是 False, 不能因为"没数据"的写法被吞成 None ──
def test_windows_open_flag():
    assert state({"1693": 0, "1694": 0, "1695": 0, "1696": 0}).windows_open is False
    assert state({"1693": 2, "1694": 0, "1695": 0, "1696": 0}).windows_open is True
    assert state({"1693": 2, "1694": 2, "1695": 2, "1696": 2}).windows_open is True
    # 一条信号都没有(车端没上报)→ None(未知), 不是 False
    assert state({}).windows_open is None


def test_sunshade_percent_and_flag():
    # 1724 = 遮阳帘开度(实测跟随指令 240): 0=全关, 100=全开, 中间值是运动中的采样
    assert state({"1724": 0}).sunshade_open is False
    assert state({"1724": 100}).sunshade_open is True
    assert state({"1724": 46}).sunshade_open is True
    assert state({}).sunshade_open is None
