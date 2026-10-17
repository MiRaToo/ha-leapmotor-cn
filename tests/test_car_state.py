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
    """续航 = 官方 App 主页那个大数字: 纯电取表显(2188); 增程取油电总续航(按工况)。"""
    assert state({"2188": 168, "3260": 170}).range_km == 168          # 纯电优先表显
    assert state({"3261": 512.5}).range_km == pytest.approx(512.5)     # 增程(WLTC 总续航)
    assert state({"3262": 0, "3258": 350, "3261": 999}).range_km == pytest.approx(350)  # CLTC
    assert state({"3260": 170}).range_km == 170                        # 只有纯电续航也认
    assert state({}).range_km is None


# ── 增程(REEV): 信号语义与工况选择 ──
def test_reev_ranges_picks_by_working_condition():
    """注意: `reev_ranges` 吃的是**翻译后的字段名**(不是信号号)。"""
    two_modes = {"range_fuel_cltc": 200, "range_ev_cltc": 150, "range_total_cltc": 350,
                 "range_fuel_wltc": 180, "range_ev_wltc": 130, "range_total_wltc": 310}
    r = api_client.reev_ranges({**two_modes, "range_mode_code": 1})
    assert (r["fuel_km"], r["ev_km"], r["total_km"], r["mode"]) == (180, 130, 310, "WLTC")
    r = api_client.reev_ranges({**two_modes, "range_mode_code": 0})
    assert (r["fuel_km"], r["ev_km"], r["total_km"], r["mode"]) == (200, 150, 350, "CLTC")
    # 工况缺失 → 按 WLTC(与 App 的分支默认一致); 车端只报一套时互相回退
    only_wltc = {"range_fuel_wltc": 180, "range_total_wltc": 310}
    r = api_client.reev_ranges(only_wltc)
    assert r["mode"] == "WLTC" and r["fuel_km"] == 180 and r["total_km"] == 310
    r = api_client.reev_ranges({"range_fuel_cltc": 200, "range_total_cltc": 350})
    assert r["fuel_km"] == 200 and r["total_km"] == 350, "只报 CLTC 时也要能取到"
    # 纯电车 → 全 None
    assert api_client.reev_ranges({"range_live": 131})["total_km"] is None


def test_is_reev_needs_fuel_contributing_range():
    """单帧判据: **燃油在给里程做贡献**才算增程(燃油续航 > 0, 或总续航 > 纯电续航)。"""
    assert api_client.is_reev({"range_live": 131, "soc": 56}) is False   # C10 纯电
    assert api_client.is_reev({"range_fuel_wltc": 180}) is True
    assert api_client.is_reev({"range_total_wltc": 700, "range_ev_wltc": 300}) is True
    assert api_client.is_reev({}) is False


def test_is_reev_ignores_bogus_fuel_level():
    """回归(车主反馈): 纯电车会报一个**假的油量**(没有油箱却报 80)。

    只凭 `fuel_level`(3235) 判增程会把它误判成增程 —— 燃油块、双续航胶囊、油耗请求
    一起冒出来。判据必须要求"燃油顶出了里程": 这辆车的续航算术是自洽的纯电
    (油电总续航 == 纯电续航), 所以新版判据把它正确判为纯电。
    """
    bevs = [
        {"fuel_level": 80, "range_total_cltc": 383, "range_ev_cltc": 383},   # 原样复现
        {"fuel_level": 55},
        {"fuel_level": 80, "fuel_ml": 40000},
        {"fuel_level": 0.5},
        {"fuel_ml": 12000, "range_total_wltc": 480, "range_ev_wltc": 480},
    ]
    for sig in bevs:
        assert api_client.is_reev(sig) is False, sig


def test_is_reev_ignores_zero_fuel_and_total_range():
    """零值不算增程; 只有综合续航也不算增程(策略约定)。

      * 值为 0 的燃油键是**歧义**的(可能没油, 也可能这车不配这套数据), 不能据此判增程;
      * `range_total_*`(综合续航)**所有车都有**(增程 = 燃油 + 纯电, 纯电 = 纯电续航),
        单看它不能判增程 —— 要"大于纯电续航"才是证据。
    """
    assert api_client.is_reev({"fuel_level": 0, "range_fuel_wltc": 0}) is False
    assert api_client.is_reev({"range_total_cltc": 520, "soc": 60}) is False   # 没有纯电续航可比
    assert api_client.is_reev({"fuel_ml": 0, "range_total_wltc": 480}) is False
    assert api_client.is_reev({"range_fuel_cltc": 12}) is True
    assert api_client.is_reev({"range_total_cltc": 520, "range_ev_cltc": 400}) is True


def test_resolve_reev_latches_and_survives_empty_tank():
    """带记忆的判定: 见过"燃油顶出里程"的帧后永久为真 —— 空油箱不再被判回纯电。

    为什么需要"记忆": 单帧判据要求燃油续航/总续航的证据(见上一条), 于是**油箱全空**的
    增程车单帧看起来与纯电一样; 而"是不是增程"是该 VIN 的固定硬件属性, 所以按 VIN 记住即可。
    没有这层记忆时, 直接拿"单帧证据"决定"建不建燃油实体", 会让空油箱的增程车
    那 4 个燃油实体永远建不出来(总续航/燃油块/双胶囊一起消失), 只能手动重载集成。
    """
    # 只有 0 / 假的油量 / 只有综合续航 → 永远升不上来
    assert api_client.resolve_reev({"fuel_level": 0, "range_total_cltc": 520}) is False
    assert api_client.resolve_reev({"fuel_level": 80, "range_total_cltc": 383,
                                    "range_ev_cltc": 383}) is False
    assert api_client.resolve_reev({}) is False
    # 报过"燃油续航 > 0" → 为真
    assert api_client.resolve_reev({"fuel_level": 62, "range_fuel_wltc": 180}) is True
    # 已经记住的车(known=True): 即使这一帧油箱全空/信号缺失, 仍是增程
    assert api_client.resolve_reev({"fuel_level": 0}, known=True) is True
    assert api_client.resolve_reev({}, known=True) is True
    # 只升不降: known=True 不会被"看起来像纯电的一帧"打回 False
    assert api_client.resolve_reev({"range_total_wltc": 480, "soc": 55}, known=True) is True


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
    """旧版按"电流绝对值"判充电 —— 已按官方 App 的 1149 语义改掉(见下一条测试)。

    保留这条是作为**反例**: 同样"有电流", 1149=2 现在不再算充电中, 只有 1149=1 才算。
    """
    assert state({"1149": 0, "1178": 0.0}).charging is False        # 没插枪
    assert state({"1149": 2, "1178": 0.0}).charging is False        # 插着但没进电流
    assert state({"1149": 1, "1178": -12.5}).charging is True       # 真在充(1149=1 且进电流)
    assert state({"1149": 2, "1178": -12.5}).charging is False      # 有电流但 1149 不是 1 -> 不算
    assert state({"1298": 1}).charging is None                      # 关键信号缺席


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


def test_gcj_to_wgs_matches_public_reference_vector():
    """黄金参考向量(eviltransform 公开样例), 防"经度用错多项式"类回归。

    修: 旧实现经度偏移也用了纬度多项式, 对外发布的 WGS-84 偏东 300~800 米
    (自家卡片因正反同错、误差相消看不出来; 第三方按标准换算就露馅)。
    这组向量能同时抓住"经度用错公式"与"迭代方向写反"两类错误。
    """
    w = api_client.wgs84_to_gcj02(31.1774276, 121.5272106)
    assert w[0] == pytest.approx(31.17530398364597, abs=1e-9)
    assert w[1] == pytest.approx(121.531541859215, abs=1e-9)
    back = api_client.gcj02_to_wgs84(*w)
    assert back[0] == pytest.approx(31.1774276, abs=1e-7)
    assert back[1] == pytest.approx(121.5272106, abs=1e-7)


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
    # 对外 WGS-84(修复后的正确值; 旧错误实现给的是 31.232364/121.475968)
    assert st.latitude_wgs == pytest.approx(31.232345, abs=1e-4)
    assert st.longitude_wgs == pytest.approx(121.469163, abs=1e-4)
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


def test_resp_code_is_exposed_for_rate_limit_detection():
    """解析失败时不能抛异常, 但要把业务码带出来 —— 限流/风控判定要用它。"""
    from api_client import parse_car_state
    ok = parse_car_state({"code": 0, "data": {"vin": "V", "collectTime": 1, "signalMap": {"1318": 5}}})
    assert ok.resp_code == 0
    rl = parse_car_state({"code": 1023, "message": "环境被风控", "data": None})
    assert rl.resp_code == 1023
    assert rl.raw == {}
    assert api_client.is_rate_limited({"code": rl.resp_code})


def test_seat_rows_gates_on_abilities_with_third_row_signal_fallback():
    """后排座椅门控: **能力位**为主(信号值会假阳性), 三排用信号是否存在兜底。

    实测教训: 纯电 C10 照样上报 1879/1880/3727/3728 = 0 —— 只看"信号有值"会让它平白
    长出后排实体; 它的 abilities 里没有 22/67/85/93, 所以用能力位判定才对。
    """
    c10_signals = {"seat_heat_rear_left": 0, "seat_vent_rear_left": 0}   # 有值但是 0
    r = api_client.seat_rows(c10_signals, ["1", "20", "21", "32", "42", "43"])
    assert r == {"rear_heat": False, "rear_vent": False,
                 "third_heat_left": False, "third_heat_right": False}, "纯电 C10 不该有后排实体"
    # C16 这类: 能力位给 22(二排)/67(二排通风)/85·93(三排左·右)
    r = api_client.seat_rows({}, ["22", "67", "85", "93"])
    assert r == {"rear_heat": True, "rear_vent": True,
                 "third_heat_left": True, "third_heat_right": True}
    # 能力位缺失(老数据)时, 三排还能靠 12276/12277 是否存在兜底(纯电车这两个信号缺席)
    r = api_client.seat_rows({"seat_heat_third_left": 3})
    assert r["third_heat_left"] is True and r["third_heat_right"] is False
    assert api_client.seat_rows({})["rear_heat"] is False


# ── 充电判定: 按官方 App 的 1149 语义(修"行驶中误报充电") ──
def test_charging_only_when_code_is_1():
    """只有 1149 == 1 才是充电中; 5 = 非连接(既不是充电中, 也不是"插枪待机")。

    旧代码按"电流绝对值>1"判充电, 行驶/能量回收时电流非零 → 误报"充电中"。
    """
    assert state({"1149": 1}).charging is True
    assert state({"1149": 5}).charging is False
    assert state({"1149": 0}).charging is False
    assert state({"1149": 2}).charging is False          # 已插枪待机也不是充电中
    assert state({}).charging is None
    # 行驶中: 电流非零 + 1149=5 -> 仍然不是充电
    assert state({"1149": 5, "1178": 12.0, "1319": 40, "1010": 1}).charging is False


# ── 插枪判定: 1149 白名单 {1,2,3,4}(修"没插枪却显示已插枪") ──
def test_charge_plugged_whitelist_excludes_5():
    """真机事故: 车没插枪时 1149 在 0 与 5 之间每 6~12 秒交替, 旧判据"非 0 即插枪"
    把 5 当成"已插枪" → 控制卡凭空多出一颗「已插枪未充电」胶囊。

    证据: ①当晚实测(0↔5 交替, 同期 1197 直流枪恒 0); ②官方 App `OooOo00` 把
    `chargeState == 0 || == 5` **并列**当作"未插枪"; ③EU 版同名项目注释
    "state 5 is observed while driving and is not a connection", 其插枪集合 = {1,2,3,4}。
    """
    assert state({"1149": 0}).charge_plugged is False
    assert state({"1149": 5}).charge_plugged is False    # ★ 本次修的: 5 不是插枪
    assert state({"1149": 1}).charge_plugged is True     # 充电中必然插着
    assert state({"1149": 2}).charge_plugged is True     # 实测出现过
    assert state({"1149": 3}).charge_plugged is True
    assert state({"1149": 4}).charge_plugged is True
    assert state({"1149": 9}).charge_plugged is False    # 未知值宁可漏报, 不误报
    assert state({}).charge_plugged is None


# ── 行驶护栏: 行驶中一律不算充电/插枪(C16 反馈"行驶中踩电门显示充电中") ──
def test_driving_never_charging_even_if_code_says_1():
    """某些车型在行驶中踩电门时车端会把 1149 瞬时报成 1/2 —— 物理上行驶中不可能充电,
    所以只要车辆在行驶(D/R 挡或车速 > 0), charging / charge_plugged 都必须为 False。"""
    # 档位在 D(1010=1) → 行驶中
    assert state({"1149": 1, "1010": 1}).charging is False
    assert state({"1149": 1, "1010": 1}).charge_plugged is False
    # 车速 > 0 (没档位) → 行驶中
    assert state({"1149": 1, "1319": 45}).charging is False
    assert state({"1149": 2, "1319": 45}).charge_plugged is False
    # R 挡(1010=3) 同样算行驶
    assert state({"1149": 1, "1010": 3, "1319": 5}).charging is False
    # 对照: 停在 P(1010=0)、真插着枪充电 → 仍判为充电中(护栏不误伤正常充电)
    assert state({"1149": 1, "1010": 0, "1319": 0}).charging is True
    assert state({"1149": 1, "1010": 0, "1319": 0}).charge_plugged is True


def test_charging_state_maps_codes_to_three_states():
    """三态映射(传感器用): 1→charging / {2,3,4}→plugged / {0,5}→unplugged。"""
    for code, want in ((1, "charging"), (2, "plugged"), (3, "plugged"), (4, "plugged"),
                       (0, "unplugged"), (5, "unplugged")):
        st = state({"1149": code})
        got = "charging" if st.charging else ("plugged" if st.charge_plugged else "unplugged")
        assert got == want, "1149=%s -> %s(期望 %s)" % (code, got, want)


# ── 拨号策略: IPv4 优先(修"每轮被 IPv6 黑洞拖 40 秒") ──
def test_order_addresses_prefers_ipv4():
    """DNS 把 AAAA 排在前面时, 我们要把 IPv4 提到前面 —— 但不是禁用 v6。

    背景: 本机 IPv6 出口变成黑洞时, 标准库会顺着地址表逐个串行等超时;
    2 条 AAAA × 20 秒 = 每轮白等 40 秒(HA 里 351 个慢样本全是 40.2 的整数倍)。
    """
    v6a = (10, 1, 6, "", ("240e::1", 443, 0, 0))
    v6b = (10, 1, 6, "", ("240e::2", 443, 0, 0))
    v4 = (2, 1, 6, "", ("1.2.3.4", 443))
    out = api_client.order_addresses_by_family([v6a, v6b, v4])
    assert out[0] == v4, "IPv4 必须排第一"
    assert out[1:] == [v6a, v6b], "v6 仍保留且保持原顺序(不是禁用)"
    # 只有 v6 时不该丢
    assert api_client.order_addresses_by_family([v6a]) == [v6a]
    # 空/异常输入
    assert api_client.order_addresses_by_family([]) == []
    assert api_client.order_addresses_by_family([(99, 0, 0, "", "x")]) == [(99, 0, 0, "", "x")]


def test_build_opener_uses_ipv4_first_connections():
    """构造出来的 opener 必须用我们自己的连接类(而不是标准 HTTPConnection)。"""
    import ssl as _ssl
    hc = api_client._build_opener(_ssl.create_default_context())
    handlers = [h for h in getattr(hc, "handlers", [])]
    names = " ".join(type(h).__name__ for h in handlers)
    assert "_HTTPSHandler" in names or "HTTPSHandler" in names
    # 连接类存在且是 http.client 的子类
    import http.client as _hc
    assert issubclass(api_client._IPv4FirstHTTPSConnection, _hc.HTTPSConnection)
    assert issubclass(api_client._IPv4FirstHTTPConnection, _hc.HTTPConnection)


def test_connect_timeout_is_short_but_read_timeout_kept():
    """连接超时要短(对付黑洞地址), 但读响应的超时不能被改短。"""
    assert api_client.CONNECT_TIMEOUT <= 8, "连接超时太长就失去意义"
    cli = api_client.LeapmotorClient(api_client.Session(car_vin="VIN"))
    assert cli.timeout >= 15, "读响应的大超时(默认 20s)要保持"


def test_connection_dials_ipv4_first_and_uses_short_connect_timeout(monkeypatch):
    """用伪造 socket 验证拨号行为(不依赖网络环境):

    * 先试 IPv4(即使 DNS 把 AAAA 放在前面) —— 这是"IPv6 黑洞拖 40 秒"的根治点;
    * 建连阶段用短超时(CONNECT_TIMEOUT=5), 避免坏地址等满 20 秒;
    * 建连成功后把超时换回调用方的值(读响应可能慢);
    * 第一个地址失败时继续试下一个(不是直接放弃)。
    """
    import socket as _socket

    v6 = (10, 1, 6, "", ("2001:db8::1", 80, 0, 0))
    v4 = (2, 1, 6, "", ("192.0.2.5", 80))
    v4b = (2, 1, 6, "", ("192.0.2.6", 80))
    calls = []

    class FakeSock:
        def __init__(self, fam, typ, proto):
            self.fam = fam
            self.timeouts = []

        def settimeout(self, v):
            self.timeouts.append(v)

        def connect(self, addr):
            calls.append((self.fam, addr))
            if addr[0] == "192.0.2.5":
                raise OSError("第一个 v4 不通(模拟)")   # 验证会继续试下一个

        def close(self):
            pass

    monkeypatch.setattr(_socket, "socket", lambda f, t, p: FakeSock(f, t, p))
    monkeypatch.setattr(_socket, "getaddrinfo",
                        lambda *a, **k: [v6, v6, v4, v4b])     # AAAA 在最前
    conn = api_client._IPv4FirstHTTPConnection("example.com", 80, timeout=20)
    conn.connect()

    assert [c[0] for c in calls] == [2, 2], "应当先试 IPv4(且失败后继续试下一个)"
    assert calls[0][1][0] == "192.0.2.5" and calls[1][1][0] == "192.0.2.6"
    assert conn.sock.timeouts[0] == api_client.CONNECT_TIMEOUT, "建连用短超时"
    assert conn.sock.timeouts[-1] == 20, "建连后换回调用方的超时(读响应)"

    # 两个 v6 排在前面时, 也不该被跳过(只是排后面)
    monkeypatch.setattr(_socket, "getaddrinfo", lambda *a, **k: [v6])
    calls.clear()
    conn2 = api_client._IPv4FirstHTTPConnection("example.com", 80, timeout=20)
    conn2.connect()
    assert calls and calls[0][0] == 10, "只有 v6 时仍然要用它"


# ── 空调快捷预设状态: 只认"专属状态位"(1945 除霜) 与 3713=4(除味); 要求空调真的开着 ──
def test_ac_preset_from_signals():
    assert state({"1938": 1, "1945": 1}).ac_preset == "风挡除霜"
    # 3713=4(换气) = App 的"快速除味": 实测点它会置 4, 且与 App 同步
    assert state({"1938": 1, "3713": 4}).ac_preset == "快速除味"
    # 3713=1/3 是**普通**"制冷/制热"模式, 绝不能当预设 —— 否则点制热会显示成"极速升温"(HI)
    assert state({"1938": 1, "3713": 1}).ac_preset is None
    assert state({"1938": 1, "3713": 3}).ac_preset is None
    # 2669/2681(rapidCooling/rapidHeating) 只在功能期间置位, 不作"当前预设"
    assert state({"1938": 1, "2669": 1}).ac_preset is None
    assert state({"1938": 1, "2681": 1}).ac_preset is None
    # 空调没开 / 状态未知 → 一律 None
    assert state({"1945": 1}).ac_preset is None
    assert state({"1938": 0, "1945": 1}).ac_preset is None
    assert state({"1938": 0, "3713": 4}).ac_preset is None
    assert state({}).ac_preset is None
    # 除霜优先
    assert state({"1938": 1, "1945": 1, "3713": 4}).ac_preset == "风挡除霜"


# ── 素材包响应元数据(诊断: "file is not a zip" 这类只能靠车型/网络特定信息定位) ──
def _client_for_asset_test() -> api_client.LeapmotorClient:
    s = api_client.Session(token="A" * 64, refresh_token="B" * 64, phone="13800138000",
                           user_id="890000000000000001",
                           device_id="0123456789abcdef0123456789abcdef", version="1.22.98")
    s.hkdf_key_hex = "00" * 32          # build_headers 需要一个密钥(值本身无关)
    return api_client.LeapmotorClient(s)


class _FakeResp:
    def __init__(self, blob: bytes, ctype: str = "text/html; charset=utf-8") -> None:
        self.status = 200
        self.headers = {"Content-Type": ctype, "Content-Length": str(len(blob))}
        self._blob = blob

    def read(self, n=None):
        return self._blob if not n else self._blob[:n]

    def geturl(self) -> str:
        return ("https://example.invalid/v3/api/carpicture/key/package"
                "?vin=LSECRETVIN0000001&key=SECRETKEY")

    def __enter__(self):
        return self

    def __exit__(self, *exc) -> bool:
        return False


class _FakeOpener:
    def __init__(self, resp: _FakeResp) -> None:
        self._resp = resp

    def open(self, req, timeout=None):
        return self._resp


def test_fetch_asset_zip_records_response_shape(monkeypatch):
    """响应形状要留下(状态/类型/字节/头部), 且**不泄漏** query 里的 vin 与 key。"""
    client = _client_for_asset_test()
    body = b"<!DOCTYPE html><html>502 Bad Gateway</html>"
    monkeypatch.setattr(api_client, "_build_opener", lambda _ctx: _FakeOpener(_FakeResp(body)))

    out = client.fetch_asset_zip("LSECRETVIN0000001", "SECRETKEY")
    assert out == body
    meta = client.last_asset_meta
    assert meta["status"] == 200 and meta["content_type"].startswith("text/html")
    assert meta["bytes"] == len(body) and meta["looks_zip"] is False
    assert "DOCTYPE" in meta["head"]
    assert meta["host"] == "example.invalid" and meta["path"].endswith("/package")
    blob = str(meta)
    assert "LSECRETVIN" not in blob and "SECRETKEY" not in blob


def test_fetch_asset_zip_prefix_read_for_probe(monkeypatch):
    """探针的浅读: max_bytes 只取前一段(不必下整包), 元数据照旧记录。"""
    client = _client_for_asset_test()
    body = b"PK\x03\x04" + b"x" * 5000
    monkeypatch.setattr(api_client, "_build_opener", lambda _ctx: _FakeOpener(_FakeResp(body)))

    out = client.fetch_asset_zip("V", "K", max_bytes=64)
    assert len(out) == 64 and client.last_asset_meta["looks_zip"] is True
