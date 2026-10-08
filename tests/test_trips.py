"""行程记录: 状态机 / 记账 / 轨迹 / 漏采补记 —— 纯逻辑离线测试。

真车行为里最要紧的几条(见 custom_components/leapmotor/trips.py 的模块说明):
挡位判行程、停车要连续确认、重复帧不算、里程优先总里程差分、短行程丢弃、
失联后按里程跳变补记。这些都在这里钉住。
"""
from __future__ import annotations

import asyncio
import pathlib
import sys

import pytest

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "custom_components" / "leapmotor"))
sys.path.insert(0, str(ROOT / "poller"))

import api_client  # noqa: E402
from trips import (  # noqa: E402
    Trip, TripRecorder, downsample, haversine_km, pick_distance_km,
    reconstruction_duration_min, track_length_km,
)

LAT, LON = 31.230416, 121.473701          # 示例坐标(GCJ-02, 与其它测试一致)
T0 = 1_790_000_000.0                      # 固定时间基准, 便于断言


class FakeStore:
    """替身: 记下最后一次 dump, 便于断言"持久化了什么"。"""

    def __init__(self, data=None):
        self.data = data
        self.saved = []

    async def async_load(self):
        return self.data

    def async_delay_save(self, fn, delay):
        self.saved.append(fn())


def frame(ts: float, *, odo=1000.0, soc=80.0, gear=1, speed=30.0,
          lat=LAT, lon=LON, sts=None, plug=0):
    """造一帧车况(走真实解析器, 与线上同一条路径)。"""
    return api_client.parse_car_state({
        "code": 0,
        "data": {
            "vin": "TESTVIN", "collectTime": int(ts * 1000),
            "signalMap": {
                "sts": int(sts if sts is not None else ts * 1000),
                "1318": odo, "100003": soc, "1010": gear, "1319": speed,
                "2": lon, "3": lat, "1149": plug,
            },
        },
    })


def recorder(**kw):
    return TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                        poll_seconds_getter=lambda: 6, store=FakeStore(), **kw)


# ── 纯函数 ──
def test_pick_distance_prefers_odometer_but_trusts_gps_on_kilometre_crossing():
    assert pick_distance_km(1, 0.3) == 0.3          # 跨公里边界的挪车 → 信 GPS
    assert pick_distance_km(1, 2.0) == 1.0          # Δodo=1 但 GPS 说真有 2km → 信总里程
    assert pick_distance_km(7, 6.2) == 7.0          # Δodo >= 2 → 信总里程
    assert pick_distance_km(None, 3.4) == 3.4       # 总里程不可用 → 信 GPS
    assert pick_distance_km(0, 0.42) == 0.42        # 整数里程没跳, 但 GPS 有位移
    assert pick_distance_km(None, None) is None


def test_track_length_and_downsample():
    pts = [[31.2304, 121.4737], [31.2304, 121.4747]]     # 经度差 0.001° ≈ 95 m
    km = track_length_km(pts)
    assert 0.05 < km < 0.15
    assert track_length_km([[1, 1]]) is None
    many = [[30 + i / 1000, 120 + i / 1000] for i in range(500)]
    out = downsample(many, 100)
    assert len(out) == 100 and out[0] == many[0] and out[-1] == many[-1]


def test_haversine_sanity():
    assert haversine_km(31.2304, 121.4737, 31.2304, 121.4737) == 0.0
    assert 1.0 < haversine_km(31.0, 121.0, 31.01, 121.0) < 1.2   # 0.01° 纬度 ≈ 1.11 km


# ── 状态机 ──
def test_full_trip_lifecycle():
    rec = recorder()
    rec.process(frame(T0, odo=1000, soc=80, gear=1, speed=30), now=T0)
    assert rec.active is not None, "挡位 D 应开始行程"

    # 行驶 10 分钟: 位置前进、里程 +3、电量 -4%
    for i in range(1, 11):
        rec.process(frame(T0 + i * 60, odo=1000 + i * 0.3, soc=80 - i * 0.4,
                          lat=LAT + i * 0.002, lon=LON + i * 0.002),
                    now=T0 + i * 60)

    # 停车: 挡位回 P, 连续 60 秒没动才收尾
    t_end = T0 + 600
    for i in range(1, 12):
        rec.process(frame(t_end + i * 6, odo=1003, soc=76, gear=0, speed=0),
                    now=t_end + i * 6)
        if i <= 9:
            assert rec.active is not None, "停车确认窗口内不该收尾(红灯/临时停车)"
    assert rec.active is None, "停车满 60 秒应收尾"

    trip = rec.trips[-1]
    assert trip.distance_km == pytest.approx(3.0)                   # Δodo 为主
    assert trip.energy_kwh == pytest.approx(0.04 * 70, abs=0.01)    # 4% × 70 kWh
    assert trip.efficiency == pytest.approx(2.8 / 3.0 * 100, abs=0.5)
    assert trip.duration_min == pytest.approx(10.0, abs=0.3)
    assert len(trip.points) >= 5
    assert trip.start_lat and trip.end_lat
    assert trip.summary()["point_count"] == len(trip.points)


def test_short_trip_is_dropped():
    rec = recorder()
    rec.process(frame(T0, odo=1000, soc=80, gear=1), now=T0)
    for i in range(1, 6):                       # 只挪了 0.1 km
        rec.process(frame(T0 + i * 6, odo=1000.1, soc=80, gear=1,
                          lat=LAT + i * 0.00005), now=T0 + i * 6)
    for i in range(1, 12):
        rec.process(frame(T0 + 40 + i * 6, odo=1000.1, soc=80, gear=0, speed=0),
                    now=T0 + 40 + i * 6)
    assert rec.trips == [], "0.1 km 的挪车不该记成行程"


def test_stale_frames_do_not_add_points_but_still_end_trip():
    """车端休眠时云端反复回同一帧(sts 不变): 不写轨迹点, 但仍要能收尾。"""
    rec = recorder()
    rec.process(frame(T0, odo=1000, soc=80, gear=1), now=T0)
    for i in range(1, 6):
        rec.process(frame(T0 + i * 6, odo=1000.5, soc=79, gear=1,
                          lat=LAT + 0.001, lon=LON + 0.001, sts=T0 * 1000),
                    now=T0 + i * 6)             # 帧时间戳一直是 T0
    assert len(rec._points) <= 1, "重复帧不该写轨迹点"
    for i in range(1, 12):
        rec.process(frame(T0 + 60 + i * 6, odo=1000.5, soc=79, gear=0, speed=0,
                          sts=T0 * 1000), now=T0 + 60 + i * 6)
    assert rec.active is None, "重复帧仍要喂状态机 → 能收尾"


def test_frozen_watchdog_ends_trip_and_rewinds_end_time():
    rec = recorder()
    rec.process(frame(T0, odo=2000, soc=60, gear=1, speed=40), now=T0)
    rec.process(frame(T0 + 60, odo=2001, soc=59, gear=1, speed=40,
                      lat=LAT + 0.01), now=T0 + 60)
    # 之后车端再没上报新帧(时间戳停在 T0+60), 但轮询还在跑
    for i in range(1, 20):
        rec.process(frame(T0 + 60 + i * 120, odo=2001, soc=59, gear=1, speed=40,
                          sts=(T0 + 60) * 1000), now=T0 + 60 + i * 120)
    trip = rec.trips[-1]
    assert trip.frozen is True
    assert trip.ended_at == pytest.approx(T0 + 60, abs=1), "结束时刻应回拨到最后一次真实帧"
    assert trip.duration_min == pytest.approx(1.0, abs=0.1)


def test_reconstruct_when_odometer_jumps_while_parked():
    rec = recorder()
    rec.process(frame(T0, odo=3000, soc=50, gear=0, speed=0), now=T0)          # 基线
    rec.process(frame(T0 + 60, odo=3004.0, soc=46, gear=0, speed=0), now=T0 + 60)
    assert rec.trips, "里程跳变应补记一条行程"
    trip = rec.trips[-1]
    assert trip.reconstructed is True and trip.points == []
    assert trip.distance_km == pytest.approx(4.0)
    assert trip.energy_kwh == pytest.approx(0.04 * 70, abs=0.01)


def test_odometer_jump_with_soc_rise_goes_to_gaps_not_trip():
    rec = recorder()
    rec.process(frame(T0, odo=4000, soc=40, gear=0, speed=0), now=T0)
    rec.process(frame(T0 + 60, odo=4003, soc=45, gear=0, speed=0), now=T0 + 60)
    assert rec.trips == [], "期间电量上升 → 不该当成行程"
    assert len(rec.gaps) == 1 and rec.gaps[0]["distance_km"] == pytest.approx(3.0)


def test_plugging_in_ends_trip_immediately():
    rec = recorder()
    rec.process(frame(T0, odo=2500, soc=30, gear=1, speed=20), now=T0)
    rec.process(frame(T0 + 120, odo=2501, soc=29, gear=0, speed=0, plug=2), now=T0 + 120)
    assert rec.active is None, "插枪应立即结束行程(不用等 60 秒确认)"


def test_code_5_is_not_plugged_and_does_not_cut_the_trip():
    """1149=5 是**非连接**(2026-10-06 真机: 没插枪时 0↔5 交替)—— 不能当成"插枪"。

    旧写法 `bool(st.get("charge_connection"))` 会在驻车等红灯、车端报 5 的那一帧
    立刻收尾行程(把一段行程切成两段)。插枪判据必须走 `charge_plugged` 的白名单。
    """
    rec = recorder()
    rec.process(frame(T0, odo=2500, soc=30, gear=1, speed=20), now=T0)
    # 车停住(挡位 D, 没插枪), 车端报 1149=5
    rec.process(frame(T0 + 20, odo=2500.3, soc=30, gear=1, speed=0, plug=5), now=T0 + 20)
    assert rec.active is not None, "1149=5 不是插枪, 不该提前收尾"
    # 再往前开一点, 行程应继续
    rec.process(frame(T0 + 60, odo=2501, soc=29, gear=1, speed=25,
                      lat=LAT + 0.01), now=T0 + 60)
    assert rec.active is not None and len(rec._points) >= 2, "行程应正常继续并记轨迹"


# ── 持久化与查询 ──
def test_persistence_and_resume_after_restart():
    store = FakeStore()
    rec = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                       poll_seconds_getter=lambda: 6, store=store)
    rec.process(frame(T0, odo=5000, soc=70, gear=1, speed=25), now=T0)
    rec.process(frame(T0 + 60, odo=5001, soc=69, gear=1, speed=25,
                      lat=LAT + 0.01), now=T0 + 60)
    dumped = rec._dump()
    assert dumped["active"] is not None and dumped["active"]["points"], "进行中的行程要落盘"

    rec2 = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                        poll_seconds_getter=lambda: 6, store=FakeStore(dumped))
    asyncio.run(rec2.async_load())
    assert rec2.active is not None, "重启后应接续未完成的行程"
    assert rec2.active.id == rec.active.id
    # 进行中的轨迹点存在记录器的 _points 里(dump 时一并落盘), 恢复后应完整回来
    assert rec2.active.points == rec._points and len(rec2.active.points) >= 2


def test_stats_buckets_and_prune():
    rec = recorder()
    day = 86400.0
    for k, (offset, km, kwh) in enumerate(((0, 10, 1.5), (day, 20, 3.0), (5 * day, 30, 4.5))):
        rec.trips.append(Trip(id=f"t{k}", started_at=T0 - offset - 1800,
                              ended_at=T0 - offset, distance_km=km, energy_kwh=kwh))
    st = rec.stats(now=T0)
    assert st["today"]["count"] == 1 and st["today"]["km"] == 10
    assert st["days7"]["count"] == 3 and st["days7"]["km"] == 60      # 含今天
    assert st["days30"]["count"] == 3
    assert st["today"]["kwh_per_100km"] == pytest.approx(15.0)

    # 保留策略: 超过 KEEP_WITH_TRACK 段后, 老段只留摘要(轨迹被清空)
    import trips as trips_mod
    for i in range(trips_mod.KEEP_WITH_TRACK + 5):
        rec.trips.append(Trip(id=f"x{i}", started_at=T0, ended_at=T0 + 60,
                              distance_km=1.0, points=[[LAT, LON], [LAT + 0.01, LON]]))
    rec._prune()
    older = [t for t in rec.trips if t.id.startswith("x")][0]
    assert older.points == [], "超出保留条数的老行程应只留摘要"
    assert rec.trips[-1].points, "最新的行程要保留轨迹"


def test_recent_list_and_delete():
    rec = recorder()
    rec.trips.append(Trip(id="abc", started_at=T0, ended_at=T0 + 600, distance_km=5.0))
    rec.trips.append(Trip(id="def", started_at=T0 + 700, ended_at=T0 + 1300, distance_km=2.0))
    recent = rec.recent(10)
    assert recent[0]["id"] == "def" and "points" not in recent[0]
    assert rec.last_trip is not None and rec.last_trip.id == "def"
    assert rec.delete("abc") is True and rec.delete("abc") is False
    assert rec.get("def") is not None


# ── 补记行程的时间戳(2026-09-30 真机暴露的问题) ──
def test_reconstructed_trip_time_is_observation_window_not_backwards():
    """补记的时间只能是"两次观测之间", 不能出现"结束早于开始"。

    真机上曾出现 09-30 15:15 → 15:14(起止颠倒), 因为当时拿"当前帧时间"当起点;
    车端时钟比墙钟快时就会出现倒流。现在起点用**上一帧**的时间, 并标 approx_time。
    """
    rec = recorder()
    # 第一次看到: 停车, odo=9648
    rec.process(frame(T0, odo=9648, soc=80.2, gear=0, speed=0), now=T0)
    # 100 秒后回来, 里程涨了 4 km(中间车动过, 但我们只看到旧帧)
    rec.process(frame(T0 + 100, odo=9652, soc=79.1, gear=0, speed=0), now=T0 + 100)
    trip = rec.trips[-1]
    assert trip.reconstructed is True
    assert trip.approx_time is True, "补记的时间是观测区间, 要标出来"
    assert trip.ended_at >= trip.started_at, "不能出现结束早于开始"
    assert trip.started_at == pytest.approx(T0, abs=1), "起点应为上一帧时间"
    assert trip.ended_at == pytest.approx(T0 + 100, abs=1)
    assert trip.gap_seconds == pytest.approx(100, abs=1)
    assert trip.start_lat and trip.end_lat, "有定位时要记下起终点坐标"


def test_pretrip_gap_is_accounted_before_the_trip_starts():
    """起飞时如果里程已经跳过(云端在开车期间给旧帧), 那段漏采要先记账, 不能吞掉。"""
    rec = recorder()
    rec.process(frame(T0, odo=9706, soc=66.1, gear=0, speed=0), now=T0)      # 上次看到: 9706
    # 20 分钟后车已经在开了, 而且里程已经涨到 9723(中间那段我们没看见)
    rec.process(frame(T0 + 1200, odo=9723, soc=62.0, gear=1, speed=40), now=T0 + 1200)
    assert len(rec.trips) == 1, "起飞前那段漏采应先补记一条"
    gap_trip = rec.trips[0]
    assert gap_trip.reconstructed is True and gap_trip.distance_km == pytest.approx(17.0)
    assert rec.active is not None, "同时正常行程应该已经开始"
    assert rec.active.start_odo == pytest.approx(9723.0)


def test_stats_counts_reconstructed():
    rec = recorder()
    rec.process(frame(T0, odo=100, soc=50, gear=0, speed=0), now=T0)
    rec.process(frame(T0 + 60, odo=105, soc=45, gear=0, speed=0), now=T0 + 60)
    st = rec.stats(now=T0 + 60)
    assert st["reconstructed"] == 1


def test_old_store_data_with_reversed_reconstructed_time_is_normalized():
    """旧版本写下的补记行程(时间倒流、没有 approx_time)在载入时应被规整。

    真机证据: 存储里那段 09-30 15:15:12 → 15:14:32 的补记, 就是修复前写的。
    """
    old = {
        "trips": [{"id": "old1", "started_at": T0 + 40, "ended_at": T0,
                   "distance_km": 15.0, "reconstructed": True, "points": []}],
        "gaps": [], "last_odo": 1.0, "last_soc": 50.0, "active": None,
    }
    rec = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                       poll_seconds_getter=lambda: 6, store=FakeStore(old))
    asyncio.run(rec.async_load())
    t = rec.trips[0]
    assert t.started_at <= t.ended_at, "载入时应把倒流的时间摆正"
    assert t.approx_time is True, "老的补记行程应补上'时间近似'标记"


def test_distance_source_is_recorded():
    """里程口径要写清楚: 总里程差分(整数) 还是 GPS 轨迹。"""
    from trips import pick_distance_with_source
    assert pick_distance_with_source(17.0, 16.63) == (17.0, "odo")   # 绝大多数行程: 信总里程
    assert pick_distance_with_source(1.0, 0.3) == (0.3, "gps")       # 跨公里边界的挪车: 信 GPS
    assert pick_distance_with_source(None, 4.15) == (4.15, "gps")
    assert pick_distance_with_source(0, 0.42) == (0.42, "gps")
    assert pick_distance_with_source(None, None) == (None, "")


def test_reconstruction_after_stale_period_uses_last_fresh_boundaries():
    """真机场景(2026-09-30 报告里的偏差 5): 云端反复给旧帧, 补记要能给出观测区间与起点坐标。

    起点取"最后一次**非重复帧**的墙钟", 位置取最后已知坐标 —— 重复帧的数据是旧的,
    不能拿来当观测边界; 但它的坐标仍然是"最后已知位置", 可以用来标起点。
    """
    rec = recorder()
    f0 = frame(T0, odo=9738, soc=57.8, gear=0, speed=0, lat=LAT, lon=LON)
    rec.process(f0, now=T0)          # 记录的是 WGS-84, 拿它自己比
    # 之后 9 分钟, 云端一直回同一帧(sts 不变 → 重复帧)
    for i in range(1, 10):
        rec.process(frame(T0 + i * 60, odo=9738, soc=57.8, gear=0, speed=0,
                          lat=LAT, lon=LON, sts=T0 * 1000),
                    now=T0 + i * 60)
    # 车端终于上报: 车已经在开, 里程涨了 7 km
    rec.process(frame(T0 + 600, odo=9745, soc=56.0, gear=1, speed=40,
                      lat=LAT + 0.05, lon=LON), now=T0 + 600)
    gap = rec.trips[0]
    assert gap.reconstructed is True and gap.distance_km == pytest.approx(7.0)
    assert gap.started_at == pytest.approx(T0, abs=1), "起点应是最后一次非重复帧(T0)"
    assert gap.gap_seconds == pytest.approx(600, abs=2), "未观测区间 = 从那次观测到现在"
    assert gap.start_lat == pytest.approx(f0.latitude_wgs, abs=1e-5), "起点坐标取最后已知位置"
    assert gap.end_lat > f0.latitude_wgs, "终点应更北(车往北开了)"
    assert rec.active is not None, "同时正常行程应已开始"


# ── 补记护栏(2026-10-02, 对照 mate 的 _RECONSTRUCT_MAX_TRIP_KM) ──
def test_odometer_glitch_frame_is_ignored_without_rebasing():
    """单帧总里程毛刺(信号异常/串帧)按"缺失"处理: 不记账, 也不能改基线。

    若照单全收, 下一帧"跳回来"就会被补记逻辑记成一条横跨十几万公里的假行程。
    """
    rec = recorder()
    rec.process(frame(T0, odo=1000, soc=80, gear=0, speed=0), now=T0)
    rec.process(frame(T0 + 60, odo=158_000, soc=80, gear=0, speed=0), now=T0 + 60)   # 坏帧
    assert rec.trips == [], "单帧里程毛刺不该补记成行程"
    assert rec._last_odo == pytest.approx(1000.0), "坏帧不能改基线"
    # 下一帧恢复正常: 只补记真实的 3 km(而不是 157000)
    rec.process(frame(T0 + 120, odo=1003, soc=79, gear=0, speed=0), now=T0 + 120)
    assert len(rec.trips) == 1
    assert rec.trips[-1].distance_km == pytest.approx(3.0)


def test_reconstruction_jump_over_1500_km_is_discarded_as_dirty_data():
    """二级护栏: 基线本身被污染过时差值仍可能巨大 —— 超过 ±1500 km 直接不记账。"""
    rec = recorder()
    rec.process(frame(T0, odo=1000, soc=80, gear=0, speed=0), now=T0)
    rec._add_gap_or_reconstruct(1000, 1000 + 1600, 80, 70, T0, T0 + 3600, frame(T0))
    assert rec.trips == [] and rec.gaps == [], "上千公里的'补记'只能是脏数据"


def test_reconstruction_duration_guard_blank_vs_keep():
    """补记时长要过"隐含均速"护栏: 不合理宁可留空, 也不写骗人的数字。"""
    assert reconstruction_duration_min(10.0, 900) == pytest.approx(15.0)   # 40 km/h → 留
    assert reconstruction_duration_min(4.0, 60) is None                    # 240 km/h → 空
    assert reconstruction_duration_min(1.0, 3600) is None                  # 1 km/h(区间里全是停车) → 空
    assert reconstruction_duration_min(10.0, None) is None


def test_reconstructed_trip_keeps_mileage_but_blanks_absurd_duration():
    """4 km / 60 秒(隐含 240 km/h)在现实中不可能 —— 里程/耗电照记, 时长留空。"""
    rec = recorder()
    rec.process(frame(T0, odo=3000, soc=50, gear=0, speed=0), now=T0)
    rec.process(frame(T0 + 60, odo=3004, soc=46, gear=0, speed=0), now=T0 + 60)
    trip = rec.trips[-1]
    assert trip.distance_km == pytest.approx(4.0) and trip.energy_kwh
    assert trip.duration_min is None, "不可信的时长不该写进行程"
    assert trip.approx_time is True and trip.reconstructed is True


def test_restart_recognizes_reserved_frame_as_stale_via_persisted_baseline():
    """HA 重启后云端常把**同一帧**再回一遍 —— 帧基准要落盘, 才认得出这是旧观测。

    真机现象: 不持久化时, 重启后第一帧(旧的)会被当成新观测, 补记的起点被推到重启时刻,
    观测区间凭空缩水, 甚至把早已发生的里程跳变记到错误的窗口里。
    """
    store = FakeStore()
    rec = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                       poll_seconds_getter=lambda: 6, store=store)
    rec.process(frame(T0, odo=1000, soc=80, gear=0, speed=0), now=T0)
    dumped = rec._dump()
    assert dumped["last_frame_ts"] == int(T0 * 1000), "帧基准要落盘"
    assert dumped["last_fresh_wall"] == pytest.approx(T0)

    # 模拟重启: 4 分钟后云端先把同一帧再回一遍
    rec2 = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                        poll_seconds_getter=lambda: 6, store=FakeStore(dumped))
    asyncio.run(rec2.async_load())
    assert rec2._last_frame_ts == int(T0 * 1000)
    rec2.process(frame(T0 + 240, odo=1000, soc=80, gear=0, speed=0, sts=T0 * 1000),
                 now=T0 + 240)
    assert rec2.trips == [], "重启后重发的旧帧不该被当成新观测"
    assert rec2._last_fresh_wall == pytest.approx(T0), "重复帧不该把观测边界推到重启时刻"

    # 云端终于给出新帧(车出去跑了一圈, 里程 +9): 补记区间应是 T0 → 现在(5 分钟)
    rec2.process(frame(T0 + 300, odo=1009, soc=72, gear=0, speed=0), now=T0 + 300)
    trip = rec2.trips[-1]
    assert trip.reconstructed is True and trip.distance_km == pytest.approx(9.0)
    assert trip.gap_seconds == pytest.approx(300, abs=2), "起点要回到重启前最后一次真实观测"


def test_frozen_finish_after_restart_rewinds_to_persisted_moving_time():
    """重启后又遇"车端不再上报": 结束时刻要回拨到重启前最后一次确实在动的帧, 不算进失联时间。"""
    store = FakeStore()
    rec = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                       poll_seconds_getter=lambda: 6, store=store)
    rec.process(frame(T0, odo=2000, soc=60, gear=1, speed=40), now=T0)
    rec.process(frame(T0 + 120, odo=2002, soc=59, gear=1, speed=40,
                      lat=LAT + 0.01), now=T0 + 120)
    dumped = rec._dump()
    assert dumped["last_moving_ts"] == pytest.approx(T0 + 120), "最后在动的帧时刻要落盘"

    rec2 = TripRecorder(hass=None, vin="TESTVIN", capacity_kwh=70.0,
                        poll_seconds_getter=lambda: 6, store=FakeStore(dumped))
    asyncio.run(rec2.async_load())
    # 重启后云端一直回同一帧(时间戳停在 T0+120), 轮询转了一小时
    for i in range(1, 11):
        rec2.process(frame(T0 + 120 + i * 360, odo=2002, soc=59, gear=1, speed=40,
                           sts=(T0 + 120) * 1000), now=T0 + 120 + i * 360)
    trip = rec2.trips[-1]
    assert trip.frozen is True
    assert trip.ended_at == pytest.approx(T0 + 120, abs=1), "结束时刻应回拨, 不算进失联的一小时"
    assert trip.duration_min == pytest.approx(2.0, abs=0.1)
