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


def test_is_reev_only_true_when_fuel_signals_present():
    assert api_client.is_reev({"range_live": 131, "soc": 56}) is False   # C10 纯电
    assert api_client.is_reev({"fuel_level": 55}) is True
    assert api_client.is_reev({"range_fuel_wltc": 180}) is True
    assert api_client.is_reev({}) is False


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
    """旧版按"电流绝对值"判充电 —— 2026-10-02 已按官方 App 的 1149 语义改掉(见下一条测试)。

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


# ── 充电判定: 按官方 App 的 1149 语义(2026-10-02 修"行驶中误报充电") ──
def test_charging_only_when_code_is_1():
    """只有 1149 == 1 才是充电中; 5 = 插枪未充电; 0 = 未插枪。

    真机证据(历史): 车在行驶、且刚没充过电时, 1149 的值是 **5**(插枪待机态),
    旧代码只排除 0 就把它当"插着枪", 再叠加"电流绝对值>1"(行驶时非零)→ 误报"充电中"。
    """
    assert state({"1149": 1}).charging is True
    assert state({"1149": 5}).charging is False          # 关键: 插枪待机不是充电中
    assert state({"1149": 0}).charging is False
    assert state({"1149": 2}).charging is False          # 其它待机态一律保守处理
    assert state({}).charging is None
    # 行驶中: 电流非零 + 1149=5 -> 仍然不是充电
    assert state({"1149": 5, "1178": 12.0, "1319": 40, "1010": 1}).charging is False


def test_charge_plugged_semantics():
    assert state({"1149": 5}).charge_plugged is True
    assert state({"1149": 1}).charge_plugged is True
    assert state({"1149": 0}).charge_plugged is False
    assert state({}).charge_plugged is None


# ── 拨号策略: IPv4 优先(2026-10-02 修"每轮被 IPv6 黑洞拖 40 秒") ──
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
