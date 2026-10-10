"""行程记录: 状态机 + 记账 + 轨迹 + 持久化。

数据**全部来自轮询到的车况帧**(见 `coordinator._refresh_car_data`), 不依赖任何云端行程接口
—— 实测: 云端的逐条行程 `drivingRecordList` **恒为空数组**(官方 App 里也写着
"因相关法规规定, 不再提供查看里程详情功能"), 所以行程只能自己记录。

设计取舍(对照 EU 版 mate 的实测结论与官方 App 的行为):

* **用挡位判行程**, 不靠点火信号: D/R/N 挡或车速 >1 视为行驶; 回 P 挡要**连续确认**才结束
  (红灯时挡位仍是 D, 不会把一段路切成好几段)。
* **确认窗口按采样间隔换算**: 保证"停车确认"至少 `PARKED_CONFIRM_SECONDS`(60 秒);
  6 秒采样下约 10 帧, 300 秒采样下 2 帧。
* **重复帧(车端时间戳 `sts` 未变)只喂状态机, 不写轨迹点、不计能耗** —— 车端休眠时云端会
  反复回同一帧, 不排除会把停车时间算进行程、把同一段路画成重复点。
* **里程优先用总里程差分**(整数 km, 不受采样密度影响), GPS 轨迹只作兜底;
  跨公里边界的挪车歧义(Δodo=1 且轨迹 <0.5 km)信 GPS。
* **短行程(<0.2 km)丢弃** —— mate 在真车上踩出来的阈值(0.5 km 曾把"去便利店"的车丢掉)。
* **漏采兜底**: 停车期间总里程跳变 >=1 km 且没有进行中的行程 → 记一条"重建行程"
  (只有里程/耗电, **没有轨迹**, 标 `reconstructed`); 若是充电造成的跳变, 记进 `offline_gaps`。
* **补记护栏**(对照 mate 的 `_RECONSTRUCT_MAX_TRIP_KM`): 单帧总里程跳变超过
  ±1500 km 判为毛刺(本帧里程按缺失处理, 也不立成下一帧的基线); 补记出的时长若隐含均速
  不在 8~160 km/h 区间(观测区间里混着停车/失联), 时长留空 —— 里程照记, 不写不可信的数字。
* 轨迹: 行驶中每帧 1 点(WGS-84), 跳过 (0,0) 与重复坐标; 单段上限 `MAX_TRACK_POINTS`。

存储: HA 的 `Store`(`.storage/leapmotor_<vin>_trips.json`), 防抖落盘; 重启能接续未完成行程。
"""

from __future__ import annotations

import logging
import math
import time
import uuid
from dataclasses import asdict, dataclass, field
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:                      # 只用于类型标注 —— 让本模块能脱离 HA 运行时被导入
    from homeassistant.core import HomeAssistant   # (tests/ 就是这么直接测它的)

log = logging.getLogger(__name__)

STORE_VERSION = 1
# 存储里"坐标的空间版本"标记(独立于 STORE_VERSION, 只是 dump 里的一个键):
#   1(或缺失)= 旧坐标空间 —— GCJ↔WGS 换算的经度多项式写错(已修复),
#              当时对外发布的 WGS-84 偏东 300~800 米;
#   2        = 修复后的正确 WGS-84。加载到 1 时自动迁移(见 _migrate_point)。
COORDS_VERSION = 2

MIN_TRIP_KM = 0.2                # 短于这个距离的行程丢弃(挪车)
MIN_EFFICIENCY_KM = 0.5          # 里程太短时不给"百公里能耗"(除出来的数没有意义)
PARKED_CONFIRM_SECONDS = 60      # 停车确认窗口(至少这么久没动才算行程结束)
FROZEN_LIMIT_SECONDS = 1800      # 30 分钟收不到新帧 → 强制收尾(并把结束时刻回拨)
MAX_TRACK_POINTS = 3000          # 单段轨迹点存储上限(6 秒采样 ≈ 5 小时; 超出等距抽稀)
# 单帧总里程跳变超过这个值判为毛刺(信号异常/云端串帧), 不记账也不立基线。
# 依据: 对照 mate 的 `_RECONSTRUCT_MAX_TRIP_KM`(1500 km) —— 一次未观测区间再长,
# 也不该长到 1500 km; 真跳这么大只能是脏数据。
MAX_ODO_JUMP_KM = 1500
# 补记行程的"隐含均速"合理区间(km/h)。落在区间外说明观测区间里混着停车(太慢)或者
# 里程是一段以上行程凑出来的(太快), 时长都不代表任何真实行程 → 留空而不是写个骗人的数字。
RECON_MIN_SPEED_KMH = 8.0
RECON_MAX_SPEED_KMH = 160.0
KEEP_WITH_TRACK = 100            # 保留轨迹的行程条数
KEEP_SUMMARY = 1000              # 只保留摘要的行程条数
PERSIST_HEARTBEAT_SECONDS = 600  # 帧基准(_last_frame_ts/_last_fresh_wall)的落盘心跳间隔
DEFAULT_CAPACITY_KWH = 67.0      # C10 纯电 RWD **可用**容量(仅用于 ΔSOC → kWh 折算; 可在配置里改)


# ── 坐标空间迁移(换算公式修复的配套) ──────────────────────────
# 背景: GCJ↔WGS 换算的原实现把**经度**也用了纬度多项式(见 api_client._transform_lon 的
# 说明), 于是"对外发布的 WGS-84"一直偏东 300~800 米。轨迹里存的正是这些错误坐标。
# 好消息: 错公式的**正反变换自洽**(往返误差 <1 mm), 所以旧值可以被确定性还原:
#     旧存储值 --(旧错误正向)--> 车端原始 GCJ-02 --(修复后的正确逆向)--> 正确的 WGS-84
# 本段代码**冻结旧公式**(只服务迁移, 永不用于新数据), 并借用 api 里修好的逆向函数。
_A_GCJ_LEGACY = 6378245.0
_EE_GCJ_LEGACY = 0.00669342162296594323


def _legacy_transform_lat(x: float, y: float) -> float:
    """旧实现的纬度多项式(注释说它是"纬度" — 用于迁移还原)。"""
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _legacy_buggy_wgs_to_gcj(lat: float, lon: float) -> tuple[float, float]:
    """**旧版(错误)**的 WGS-84 → GCJ-02 正向变换: 经度偏移也用了纬度多项式。

    ⚠️ 只用于把旧存储里的坐标还原回车端原始值, 绝不用于新数据(新数据用 api 的正确实现)。
    """
    if not (73.66 < lon < 135.05 and 3.86 < lat < 53.55):
        return lat, lon
    x, y = lon - 105.0, lat - 35.0
    d_lat = _legacy_transform_lat(x, y)
    d_lon = _legacy_transform_lat(x, y)          # ← 就是当年那个 bug
    rad_lat = lat / 180.0 * math.pi
    magic = 1 - _EE_GCJ_LEGACY * math.sin(rad_lat) ** 2
    sqrt_magic = math.sqrt(magic)
    d_lat = (d_lat * 180.0) / ((_A_GCJ_LEGACY * (1 - _EE_GCJ_LEGACY)) / (magic * sqrt_magic) * math.pi)
    d_lon = (d_lon * 180.0) / (_A_GCJ_LEGACY / sqrt_magic * math.cos(rad_lat) * math.pi)
    return lat + d_lat, lon + d_lon


def _migrate_point(lat: float, lon: float) -> tuple[float, float]:
    """旧坐标空间的一点 → 修复后的 WGS-84(迁移用, 幂等性由版本标记保证, 不重复调用)。"""
    try:
        from .api import gcj02_to_wgs84       # HA 运行时
    except ImportError:                        # 单测: trips 以裸模块名被导入
        from api import gcj02_to_wgs84         # type: ignore[no-redef]
    glat, glon = _legacy_buggy_wgs_to_gcj(float(lat), float(lon))
    return gcj02_to_wgs84(glat, glon)


def _migrate_trip_coords(tr: "Trip") -> int:
    """把一个 Trip 的起终点与轨迹点从旧坐标空间迁到正确 WGS-84; 返回迁移的点数。"""
    n = 0
    for lat_attr in ("start_lat", "end_lat"):
        lat = getattr(tr, lat_attr, None)
        lon_attr = lat_attr[:-3] + "lon"       # start_lat → start_lon
        lon = getattr(tr, lon_attr, None)
        if isinstance(lat, (int, float)) and isinstance(lon, (int, float)):
            wlat, wlon = _migrate_point(lat, lon)
            setattr(tr, lat_attr, wlat)
            setattr(tr, lon_attr, wlon)
            n += 1
    for p in getattr(tr, "points", None) or []:
        if (isinstance(p, (list, tuple)) and len(p) >= 2
                and isinstance(p[0], (int, float)) and isinstance(p[1], (int, float))):
            p[0], p[1] = _migrate_point(p[0], p[1])
            n += 1
    return n


def pick_distance_with_source(odo_delta: float | None,
                             gps_km: float | None) -> tuple[float | None, str]:
    """同 `pick_distance_km`, 但**同时告诉调用方这个值是按哪个口径算的**。

    为什么要在意口径(实测, C10):
      * 车端**只有整数公里的总里程**(信号 1318), 云端每日里程也是整数 ——
        所以按总里程算出来的行程里程天然是整数(17.0 而不是 17.4), 误差上界 ±1 km;
      * GPS 轨迹看着更"细", 但实测**更不准**: 采样稀疏时折线会抄近道 ——
        同一辆车 53 个点的 17 km 行程 GPS 只量到 16.63 km(−2.2%),
        10 个点的 5 km 行程只量到 4.15 km(−17%)。
    所以: 以总里程为主, 只在"整数里程跨了 1 km 但轨迹明显不足 0.5 km"(典型挪车)
    这种歧义场景才信 GPS。`source` 会写进行程, 便于在卡片/属性里区分。

    返回 (距离 km, source):source 取 "odo" / "gps" / ""(都没有)。
    """
    odo_valid = odo_delta is not None and odo_delta >= 0
    has_gps = gps_km is not None and gps_km > 0
    if odo_valid and odo_delta == 1 and has_gps and gps_km < 0.5:
        return float(gps_km), "gps"
    if odo_valid and odo_delta >= 1:
        return float(odo_delta), "odo"
    if has_gps:
        return float(gps_km), "gps"
    if odo_valid:
        return float(odo_delta), "odo"
    return None, ""


def pick_distance_km(odo_delta: float | None, gps_km: float | None) -> float | None:
    """总里程差分 vs GPS 轨迹 —— 谁更可信(纯函数, 有单测)。

    总里程是**整数公里**, 采样再密也只有一个格子; GPS 轨迹连续但会切弯道、且采样稀疏时
    抄近道更严重(实测少 2%~17%)。规则(移植 mate 的决策表, 并加了口径标注):

    * Δodo == 1 且 GPS 轨迹 < 0.5 km → 信 GPS(典型的"跨过一个公里边界"的挪车)
    * Δodo >= 1 → 信总里程
    * 总里程不可用 → 信 GPS
    * 都不行 → None(行程仍保留, 只是没有里程)
    """
    return pick_distance_with_source(odo_delta, gps_km)[0]


def haversine_km(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """两点球面距离(km)。"""
    r = 6371.0088
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = p2 - p1
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(min(1.0, math.sqrt(a)))


def track_length_km(points: list[list[float]]) -> float | None:
    """轨迹点序列的总长度(km); 少于 2 点返回 None。

    点可以是 [lat, lon] 或 [lat, lon, speed] —— 只用前两维, 按**下标**取而不是解包
    (解包成两个变量会在遇到带 speed 的三元点时抛 ValueError)。
    """
    if not points or len(points) < 2:
        return None
    total = 0.0
    for p1, p2 in zip(points, points[1:]):
        total += haversine_km(float(p1[0]), float(p1[1]), float(p2[0]), float(p2[1]))
    return total or None


def downsample(points: list, max_points: int) -> list:
    """等距抽稀(保留首尾点)。给"展示用"的轨迹属性用, 别让实体属性撑爆 recorder。
    支持 [lat, lon] 与 [lat, lon, speed](整点保留, 不做维度裁剪)。
    """
    if len(points) <= max_points or max_points < 3:
        return list(points)
    step = (len(points) - 1) / (max_points - 1)
    out = [points[round(i * step)] for i in range(max_points)]
    out[0], out[-1] = points[0], points[-1]
    return out


def reconstruction_duration_min(distance_km: float | None,
                                seconds: float | None) -> float | None:
    """补记行程的时长: 观测区间秒数 → 分钟; **隐含均速不合理时返回 None**。

    补记的时间窗只是"两次观测之间"—— 窗口里车可能停了半个小时、也可能中间回过家;
    只有隐含均速落在 RECON_MIN/MAX_SPEED_KMH 内时, 这个窗口才大致等于"一段连续行驶"。
    否则宁缺毋滥: 里程/耗电照记, 时长留空(卡片显示"—")。
    """
    if not seconds or seconds <= 0 or distance_km is None or distance_km <= 0:
        return None
    speed = float(distance_km) / (float(seconds) / 3600.0)
    if not (RECON_MIN_SPEED_KMH <= speed <= RECON_MAX_SPEED_KMH):
        return None
    return round(float(seconds) / 60.0, 1) or None


def recent_day_starts(days: int = 7, now: float | None = None) -> list[tuple[str, float]]:
    """最近 N 个自然日(含今天): [(YYYY-MM-DD, 当天0点 epoch 秒), …], 旧 → 新。

    时区 = HA 宿主的本地时区(与 stats() 的日界一致)。逐日回退用 "减一天再加 12 小时
    归一" 实现, **不用裸 86400 直接取整** —— 跨 DST 那天 +86400 会落在 23 点或 1 点,
    加 12 小时后取当天 0 点才是稳妥的(12 小时偏移不会越过两个午夜)。
    """
    now = now or time.time()
    days = max(1, min(int(days), 31))
    day0 = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
    starts: list[float] = []
    cursor = day0
    for _ in range(days):
        starts.append(cursor)
        cursor = time.mktime(time.localtime(cursor - 86400 + 43200)[:3]
                             + (0, 0, 0, 0, 0, -1))
    starts.reverse()                              # 收集是"今天→更早", 反转为 旧→新
    return [(time.strftime("%Y-%m-%d", time.localtime(s)), s) for s in starts]


def recent_day_windows(days: int = 7, now: float | None = None) -> list[tuple[str, float, float]]:
    """同 `recent_day_starts`, 但每天附上**闭区间** [0点, 当天最后1秒]。

    给"按天查询云端 getEC"用(实测: 传任意窗口都返回, 单日也行; end 取
    23:59:59 而不是次日 0 点, 跨 DST 的 23/25 小时日也安全)。今天那天的 end 收在
    `now` —— 云端对"窗口终点晚于现在"会回 `code=2 请求参数含非法字符`。
    """
    now = now or time.time()
    seq = recent_day_starts(days, now)
    starts = [s for _d, s in seq]
    out: list[tuple[str, float, float]] = []
    for i, (day, start) in enumerate(seq):
        if i + 1 < len(starts):
            stop = min(starts[i + 1] - 1, start + 86400 - 1)
        else:
            stop = min(now, start + 86400 - 1)    # 今天: 到"现在"为止
        out.append((day, float(start), float(stop)))
    return out


def day_start_of(ts: float) -> float:
    """某个 epoch 秒所在自然日的 0 点(宿主本地时区)。"""
    return time.mktime(time.localtime(ts)[:3] + (0, 0, 0, 0, 0, -1))


@dataclass
class Trip:
    """一段行程。时间为 epoch 秒; 坐标对外一律 WGS-84。"""

    id: str = ""
    started_at: float = 0.0
    ended_at: float = 0.0
    distance_km: float | None = None
    duration_min: float | None = None
    start_soc: float | None = None
    end_soc: float | None = None
    start_odo: float | None = None
    end_odo: float | None = None
    energy_kwh: float | None = None
    efficiency: float | None = None          # kWh/100km
    avg_speed_kmh: float | None = None
    start_lat: float | None = None
    start_lon: float | None = None
    end_lat: float | None = None
    end_lon: float | None = None
    distance_source: str = ""                # 里程口径: "odo"=总里程差分(整数, ±1km) / "gps"=轨迹长度
    reconstructed: bool = False              # True = 靠里程跳变补记, 没有轨迹
    frozen: bool = False                     # True = 收尾时是"车端不再上报"的兜底
    approx_time: bool = False                # True = 时间只是"两次观测之间", 不是精确行程时刻
    gap_seconds: float | None = None         # 补记时: 里程是在多长的未观测区间里涨起来的
    points: list = field(default_factory=list)   # [[lat, lon], ...]

    @property
    def valid_time(self) -> bool:
        return bool(self.started_at and self.ended_at and self.ended_at >= self.started_at)

    def summary(self) -> dict[str, Any]:
        """不含轨迹点的摘要(给列表/属性用)。"""
        d = {k: v for k, v in asdict(self).items() if k != "points"}
        d["point_count"] = len(self.points)
        return d


class TripRecorder:
    """行程记录器: 每帧调用 `process()`, 自己维护状态机与账本。"""

    def __init__(self, hass: HomeAssistant | None, vin: str,
                 capacity_kwh: float = DEFAULT_CAPACITY_KWH,
                 poll_seconds_getter=None, store: Any = None) -> None:
        self.hass = hass
        self.vin = vin
        self.capacity_kwh = float(capacity_kwh or DEFAULT_CAPACITY_KWH)
        self._poll_getter = poll_seconds_getter
        # `store` 可注入, 便于离线单测(不依赖 HA 运行时); HA 里则用自带的 Store
        if store is not None:
            self._store = store
        else:
            from homeassistant.helpers.storage import Store
            self._store = Store(hass, STORE_VERSION, f"leapmotor_{vin}_trips")
        self.trips: list[Trip] = []
        self.gaps: list[dict[str, Any]] = []          # 无法归属的里程(期间充过电)
        self._active: Trip | None = None
        self._points: list[list[float]] = []
        self._last_frame_ts: float | None = None      # 车端时间戳(sts), 判重复帧
        self._last_moving_ts: float = 0.0             # 最后一次"确实在动"的帧时刻
        self._last_frame_wall: float = 0.0            # 最近一次收到帧的墙钟时间
        self._last_fresh_wall: float = 0.0            # 最近一次收到**非重复帧**的墙钟时间(冻结兜底基准)
        self._parked_since: float | None = None
        self._last_odo: float | None = None
        self._last_soc: float | None = None
        self._prev_frame_time: float | None = None   # 上一帧的时间(补记时当起点用)
        self._prev_pos: tuple[float, float] | None = None  # 最后已知的 WGS 坐标
        self._last_seen_wall: float = 0.0            # 上次"看到车"的墙钟时刻(补记的起点边界)
        self._started_wall: float = 0.0
        self._last_saved_frame_ts: float | None = None   # 上次落盘的帧基准(心跳节流用)
        self._last_persist_wall: float = 0.0             # 上次因心跳而落盘的墙钟
        self._odo_glitch_count: int = 0                  # 连续多少个**新帧**的总里程跳变超限
        self._last_odo_glitch_log: float = 0.0           # 里程毛刺日志节流(毛刺持续时别刷屏)

    # ── 持久化 ──
    async def async_load(self) -> None:
        data = await self._store.async_load() or {}
        self.trips = [Trip(**{k: v for k, v in d.items() if k in Trip.__dataclass_fields__})
                      for d in (data.get("trips") or []) if isinstance(d, dict)]
        # 旧版本写下的补记行程: 时间可能倒流、且没有 approx_time 标记 —— 顺手规整一下
        fixed = 0
        for tr in self.trips:
            if not tr.reconstructed:
                continue
            if not tr.approx_time:
                tr.approx_time = True
                fixed += 1
            if tr.ended_at and tr.started_at and tr.ended_at < tr.started_at:
                tr.started_at, tr.ended_at = tr.ended_at, tr.started_at
        if fixed:
            log.warning("行程记录: 规整了 %d 段历史补记行程(标注时间近似)", fixed)
            self._save_soon(delay=1)      # 立刻回写, 免得每次启动都重做一遍
        self.gaps = list(data.get("gaps") or [])
        self._last_odo = data.get("last_odo")
        self._last_soc = data.get("last_soc")
        # 帧基准也要接回来: 重启后云端常把**同一帧**再回一遍 —— 没有旧基准就会把
        # 重复帧误当新帧(基准前移), 补记的起点被推到重启时刻; 接回来才能认出
        # "这不是新观测", 补记区间也才是真正的观测区间。旧存储里没有这两个键 → None/0。
        self._last_frame_ts = data.get("last_frame_ts")
        self._last_fresh_wall = float(data.get("last_fresh_wall") or 0.0)
        self._last_moving_ts = float(data.get("last_moving_ts") or 0.0)
        self._last_saved_frame_ts = self._last_frame_ts
        active = data.get("active")
        if isinstance(active, dict):
            self._active = Trip(**{k: v for k, v in active.items()
                                   if k in Trip.__dataclass_fields__})
            self._points = list(active.get("points") or [])
            log.info("行程记录: 接续上次未完成的行程(起点 %s)", self._dt(self._active.started_at))
        # ── 坐标空间迁移(换算公式修复): 旧数据版本缺失/为 1 → 就地校正并回写 ──
        coords_v = int(data.get("coords_version") or 1) if data else COORDS_VERSION
        if coords_v < COORDS_VERSION:
            try:
                total = sum(_migrate_trip_coords(t) for t in self.trips)
                if self._active is not None:
                    total += _migrate_trip_coords(self._active)
                    self._points = list(self._active.points or [])   # 同批点对象, 重挂引用
                log.warning("行程记录: 坐标空间迁移 —— %d 个历史坐标已从旧空间(偏东数百米)"
                            "校正到修复后的 WGS-84", total)
            except Exception as err:  # noqa: BLE001 — 迁移失败也不能拖垮加载
                log.warning("行程记录: 坐标空间迁移失败(保留旧值): %s", err)
            self._save_soon(delay=1)      # 回写(含版本标记), 免得每次启动都重做
        log.info("行程记录: 已载入 %d 段历史行程, %d 条漏采记录", len(self.trips), len(self.gaps))

    def _dump(self) -> dict[str, Any]:
        self._last_saved_frame_ts = self._last_frame_ts   # 落盘即"基准已保存"(心跳节流)
        return {
            "trips": [asdict(t) for t in self.trips],
            "gaps": self.gaps,
            "last_odo": self._last_odo,
            "last_soc": self._last_soc,
            "last_frame_ts": self._last_frame_ts,
            "last_fresh_wall": self._last_fresh_wall or None,
            # 用"最后确实在动"的帧时刻: 重启后又遇冻结收尾时, 结束时刻要能回拨到它
            "last_moving_ts": self._last_moving_ts or None,
            # 坐标空间版本(见 COORDS_VERSION): 下次加载据此判断要不要迁移
            "coords_version": COORDS_VERSION,
            "active": (lambda t: {**asdict(t), "points": self._points})(self._active)
            if self._active is not None else None,
        }

    def _save_soon(self, delay: int = 5) -> None:
        self._store.async_delay_save(self._dump, delay)

    # ── 主入口: 每帧调用 ──
    def process(self, st, now: float | None = None) -> None:
        """处理一帧车况(速度/挡位/里程/SOC/位置)。异常不该影响轮询, 由调用方兜底。"""
        now = now or time.time()
        # 补记的起点=最后一次**非重复帧**的墙钟(重复帧的数据是旧的, 不能当观测边界)
        prev_seen_wall = self._last_fresh_wall or None
        self._last_seen_wall = now
        self._last_frame_wall = now
        prev_pos = self._prev_pos                  # 更新前先留下"上一帧的位置"
        lat_now, lon_now = st.latitude_wgs, st.longitude_wgs
        if lat_now is not None and lon_now is not None:
            self._prev_pos = (lat_now, lon_now)    # 含重复帧: 它就是"最后已知位置"
        frame_ts = st.get("signal_time")                     # sts(车端上报时刻, ms)
        stale = frame_ts is not None and frame_ts == self._last_frame_ts
        if frame_ts is not None:
            self._last_frame_ts = frame_ts
            # 帧基准落盘心跳: 重启后云端常先把**同一帧**再回一遍, 落过盘才认得出它是重复帧
            # (详见 async_load 与 PERSIST_HEARTBEAT_SECONDS)。限频: 10 分钟最多多写一次。
            if (frame_ts != self._last_saved_frame_ts
                    and (now - self._last_persist_wall) >= PERSIST_HEARTBEAT_SECONDS):
                self._last_persist_wall = now
                self._save_soon(delay=10)
        if not stale:
            self._last_fresh_wall = now
        frame_time = (frame_ts / 1000.0) if frame_ts else now
        driving = bool(st.vehicle_state == "driving" or (st.get("speed") or 0) > 1)
        soc = st.soc
        odo = self._guard_odometer(st.get("odometer"), fresh=not stale, now=now)
        # 注意: `_last_soc` / `_last_odo` 是"**上一帧**的值", 漏采补记要拿它做对比,
        # 所以只能在函数末尾更新 —— 之前把它提前更新, 导致能耗算成 0、"期间充过电"判不出来。
        prev_soc, prev_odo = self._last_soc, self._last_odo
        prev_time = self._prev_frame_time

        if self._active is None:
            if driving:
                # 起飞前如果里程已经跳过(云端在开车期间给的是旧帧), 先把那段漏采记上,
                # 否则它会跟着这趟行程的 start_odo 一起被"吃掉", 里程就少算了。
                if not stale:
                    self._add_gap_or_reconstruct(
                        prev_odo, odo, prev_soc, soc, (prev_seen_wall or prev_time), now, st,
                        reason="行程开始前观测到里程跳变", prev_pos=prev_pos)
                self._start(st, frame_time, now, odo)
                if not stale:
                    self._add_point(st)
                self._last_moving_ts = frame_time
            else:
                self._maybe_reconstruct(st, now, odo, prev_odo, prev_soc,
                                        (prev_seen_wall or prev_time))
            self._last_odo = odo if odo is not None else prev_odo
            if soc is not None:
                self._last_soc = soc
            self._remember_frame(frame_time, st)
            return

        # ── 行程进行中 ──
        if not stale:
            self._remember_frame(frame_time, st)
        if driving:
            self._parked_since = None
            if not stale:
                self._add_point(st)
                self._last_moving_ts = frame_time
            else:
                self._last_moving_ts = max(self._last_moving_ts, frame_time)
        else:
            if self._parked_since is None:
                self._parked_since = now
                log.debug("车已停下, %d 秒内不再动就收尾这段行程", self._confirm_seconds())
            # 插枪 = 立即收尾(不用等 60 秒确认)。⚠️ 必须用 `charge_plugged` 的白名单判据:
            # 直接 `bool(charge_connection)` 会把 1149=5 当成"插着枪", 而 5 其实是**非连接**
            # (真机: 没插枪时 0↔5 交替) —— 那样会把正常停车当成插枪、行程被提前切断。
            plugged = bool(st.charge_plugged) or bool(st.charging)
            if plugged or (now - self._parked_since) >= self._confirm_seconds():
                self._finish(st, now, frozen=False, odo=odo)
                self._last_odo = odo if odo is not None else prev_odo
                if soc is not None:
                    self._last_soc = soc
                return

        # ── 车端不再上报(冻结)兜底: 超过 FROZEN_LIMIT_SECONDS 没有新帧就强制收尾 ──
        #    收尾时把结束时刻回拨到"最后一次确实在动"的那一帧, 免得把失联时间算进时长
        if self._active is not None and self._last_fresh_wall \
                and (now - self._last_fresh_wall) > FROZEN_LIMIT_SECONDS:
            log.info("行程记录: %d 秒收不到新车端帧 -> 强制收尾(结束时刻回拨)",
                     int(now - self._last_fresh_wall))
            self._finish(st, now, frozen=True, odo=odo)
        self._last_odo = odo if odo is not None else prev_odo
        if soc is not None:
            self._last_soc = soc

    def _remember_frame(self, frame_time: float, st) -> None:
        """记住这一帧的时间与位置 —— 补记行程时要用它当"起点观测"。

        只在**非重复帧**上调用: 重复帧的时间戳是旧的, 拿它当起点会把补记的时间算错
        (踩过: 补记出来的行程出现"结束早于开始")。
        """
        self._prev_frame_time = frame_time
        lat, lon = st.latitude_wgs, st.longitude_wgs
        self._prev_pos = (lat, lon) if lat is not None and lon is not None else None

    # ── 状态机 ──
    def _guard_odometer(self, odo: float | None, *, fresh: bool, now: float) -> float | None:
        """总里程毛刺护栏: 单个**新帧**比上一帧跳变超过 ±MAX_ODO_JUMP_KM → 按缺失处理。

        真车场景: 云端偶发给一帧错里程(信号异常/串帧), 若照单全收, 下一帧"跳回来"就会
        被补记逻辑记成一条横跨上千公里的假行程。判废后**不更新基线**(返回值 None 时调用方
        保留 prev_odo), 所以本帧既不记账也不污染下一帧的对比。

        连续多帧同向超限(一直读到坏值)先不判废 —— 真换了车/读错表盘这类极端情形宁可
        如实记录, 也不能把真的跳变永远吞掉。
        """
        if odo is None:
            return None
        prev = self._last_odo
        if prev is not None and abs(float(odo) - float(prev)) > MAX_ODO_JUMP_KM:
            if fresh:
                self._odo_glitch_count += 1
            if self._odo_glitch_count < 3:
                if now - self._last_odo_glitch_log >= 3600:
                    self._last_odo_glitch_log = now
                    log.warning("总里程毛刺: 单帧跳变 %.0f → %.0f km(超 ±%d), 本帧按缺失处理",
                                prev, odo, MAX_ODO_JUMP_KM)
                return None
            self._odo_glitch_count = 0        # 三帧同向 → 接受新值, 计数归零(规则对新基线重新生效)
        elif fresh:
            self._odo_glitch_count = 0
        return float(odo)

    def _confirm_seconds(self) -> float:
        """停车确认窗口: 至少 60 秒, 且不少于 3 个采样周期(采样 300s 时也要能判)。"""
        poll = 0
        if callable(self._poll_getter):
            try:
                poll = int(self._poll_getter() or 0)
            except Exception:  # noqa: BLE001
                poll = 0
        return max(float(PARKED_CONFIRM_SECONDS), poll * 3.0)

    def _start(self, st, frame_time: float, now: float, odo: float | None = None) -> None:
        self._active = Trip(
            id=uuid.uuid4().hex[:12],
            started_at=frame_time,
            start_soc=st.soc,
            start_odo=odo if odo is not None else self._last_odo,
            start_lat=st.latitude_wgs,
            start_lon=st.longitude_wgs,
        )
        self._points = []
        self._started_wall = now
        self._last_moving_ts = frame_time
        self._last_fresh_wall = now
        log.info("行程开始(%s @ %s, SOC %s%%)", self._active.id,
                 self._dt(frame_time), self._active.start_soc)

    def _add_point(self, st) -> None:
        lat, lon = st.latitude_wgs, st.longitude_wgs
        if lat is None or lon is None or (lat == 0 and lon == 0):
            return                                        # 没有定位/占位 (0,0) 不写
        if self._points and self._points[-1][0] == lat and self._points[-1][1] == lon:
            return                                        # 与上一点完全相同(堵车/静止)不重复写
        # 带上实时车速(km/h) → 卡片的速度热力图按它给轨迹着色。旧存储里的点是 [lat, lon]
        # 两元组(没有 speed), 卡片会据此回落到单色, 不受影响。
        speed = round(float(st.get("speed") or 0.0), 1)
        self._points.append([round(lat, 6), round(lon, 6), speed])
        if len(self._points) > MAX_TRACK_POINTS:
            self._points = downsample(self._points, MAX_TRACK_POINTS)

    def _finish(self, st, now: float, frozen: bool, odo: float | None = None) -> None:
        trip, self._active = self._active, None
        self._parked_since = None
        if trip is None:
            return
        trip.ended_at = max(trip.started_at, self._last_moving_ts or now)
        trip.end_soc = st.soc if st.soc is not None else self._last_soc
        trip.end_odo = odo if odo is not None else self._last_odo   # 毛刺帧被过滤时用最后可信值, 不碰原始信号
        trip.end_lat = st.latitude_wgs
        trip.end_lon = st.longitude_wgs
        trip.frozen = frozen
        trip.points = self._points
        self._points = []

        odo_delta = None
        if trip.start_odo is not None and trip.end_odo is not None:
            odo_delta = trip.end_odo - trip.start_odo
        trip.distance_km, trip.distance_source = pick_distance_with_source(
            odo_delta, track_length_km(trip.points))
        trip.duration_min = (trip.ended_at - trip.started_at) / 60.0
        if trip.start_soc is not None and trip.end_soc is not None:
            energy = (trip.start_soc - trip.end_soc) / 100.0 * self.capacity_kwh
            trip.energy_kwh = energy if energy > 0 else None     # 负值(充电/异常)不给
        if trip.distance_km and trip.duration_min:
            hours = max(trip.duration_min / 60.0, 1e-6)
            trip.avg_speed_kmh = trip.distance_km / hours
        if (trip.distance_km and trip.distance_km >= MIN_EFFICIENCY_KM and trip.energy_kwh):
            trip.efficiency = trip.energy_kwh / trip.distance_km * 100.0

        if trip.distance_km is not None and trip.distance_km < MIN_TRIP_KM:
            log.info("行程 %s 只有 %.2f km(< %.1f km), 丢弃(挪车)", trip.id,
                     trip.distance_km, MIN_TRIP_KM)
            self._save_soon()
            return
        self.trips.append(trip)
        self._prune()
        self._save_soon()
        log.info("行程结束(%s): %s → %s, %.1f km, %.1f 分钟, 耗电 %s kWh, 能耗 %s kWh/100km%s",
                 trip.id, self._dt(trip.started_at), self._dt(trip.ended_at),
                 trip.distance_km or 0.0, trip.duration_min or 0.0,
                 f"{trip.energy_kwh:.2f}" if trip.energy_kwh else "?",
                 f"{trip.efficiency:.1f}" if trip.efficiency else "?",
                 "(车端失联后补记, 无轨迹)" if frozen else "")

    def _maybe_reconstruct(self, st, now: float, odo: float | None,
                           prev_odo: float | None, prev_soc: float | None,
                           prev_time: float | None) -> None:
        """停车期间发现里程跳变 → 补一条"重建行程"或记入 offline_gaps。"""
        if odo is None or prev_odo is None:
            return
        if odo - prev_odo < 1:
            return
        self._add_gap_or_reconstruct(prev_odo, odo, prev_soc, st.soc,
                                     prev_time, now, st,
                                     reason="停车期间观测到里程跳变",
                                     prev_pos=self._prev_pos)

    def _add_gap_or_reconstruct(self, prev_odo: float | None, odo: float | None,
                               prev_soc: float | None, soc: float | None,
                               started: float | None, ended: float | None, st,
                               reason: str = "", prev_pos=None) -> None:
        """把"一段没观测到的里程"记账: 期间充过电 → offline_gaps; 否则 → 一条补记行程。

        ⚠️ 这类行程**没有轨迹**, 时间也只是"两次观测之间"(`approx_time=True`) ——
        因为那段时间云端给的是旧帧, 我们并不知道车到底什么时候动的、走了哪条路。
        宁可如实标注"补记 + 时间近似 + 无轨迹", 也不要编出一个看起来精确的值。
        (踩过的坑: 早先拿"当前帧时间"当起点, 结果出现"结束早于开始"的时间段。)
        """
        if prev_odo is None or odo is None:
            return
        delta = float(odo - prev_odo)
        if delta < 1:
            return
        if delta > MAX_ODO_JUMP_KM:
            # 二级护栏(一级在 _guard_odometer): 基线本身曾经被坏帧改小过时, 差值可能仍然巨大 ——
            # 补记一条上千公里的"行程"毫无意义, 丢给日志留痕即可。
            log.warning("漏采里程 %.0f km 超过 ±%d km 上限, 判为脏数据不记账(%s)",
                        delta, MAX_ODO_JUMP_KM, reason)
            return
        gap_s = None
        if started and ended and ended > started:
            gap_s = float(ended - started)
        charged = bool(soc is not None and prev_soc is not None and soc > prev_soc + 0.5)
        if charged or getattr(st, "charging", False):
            self.gaps.append({"at": ended or time.time(), "distance_km": delta,
                              "soc_from": prev_soc, "soc_to": soc,
                              "gap_seconds": gap_s, "reason": reason})
            log.warning("漏采里程 %.0f km 且期间电量上升(充过电) -> 记入 offline_gaps(%s)",
                        delta, reason)
            self._save_soon()
            return
        energy = None
        if soc is not None and prev_soc is not None:
            e = (prev_soc - soc) / 100.0 * self.capacity_kwh
            energy = e if e > 0 else None
        lat0, lon0 = (prev_pos or (None, None))   # 上一帧的坐标(起飞前的位置)
        lat1, lon1 = getattr(st, "latitude_wgs", None), getattr(st, "longitude_wgs", None)
        t_end = float(ended or time.time())
        t_start = float(started) if started else t_end
        if t_start > t_end:                     # 车端时钟比墙钟快时会这样 —— 别写出倒流的时间
            t_start, t_end = t_end, t_start
        trip = Trip(id=uuid.uuid4().hex[:12], started_at=t_start, ended_at=t_end,
                    distance_km=delta, energy_kwh=energy,
                    start_soc=prev_soc, end_soc=soc,
                    start_odo=float(prev_odo), end_odo=float(odo),
                    start_lat=lat0, start_lon=lon0, end_lat=lat1, end_lon=lon1,
                    reconstructed=True, approx_time=True, gap_seconds=gap_s)
        # 时长要过"隐含均速"护栏: 观测区间里混着停车/失联时, 写一个 40 小时 3 公里的
        # duration 不如留空(里程/耗电照记, 卡片显示 "—")。见 reconstruction_duration_min。
        trip.duration_min = reconstruction_duration_min(delta, gap_s)
        if delta >= MIN_EFFICIENCY_KM and energy:
            trip.efficiency = energy / delta * 100.0
        self.trips.append(trip)
        self._prune()
        self._save_soon()
        log.warning("漏采里程 %.0f km -> 补记一条无轨迹的行程 %s(%s; 未观测区间约 %s 秒)",
                    delta, trip.id, reason, int(gap_s) if gap_s else "?")

    def _prune(self) -> None:
        """保留策略: 带轨迹的最近 KEEP_WITH_TRACK 段, 再往前只留摘要。"""
        if len(self.trips) <= KEEP_WITH_TRACK:
            return
        for t in self.trips[:-KEEP_WITH_TRACK]:
            if t.points:
                t.points = []
        if len(self.trips) > KEEP_SUMMARY:
            drop = len(self.trips) - KEEP_SUMMARY
            self.trips = self.trips[drop:]

    # ── 查询(实体与卡片用)──
    @property
    def last_trip(self) -> Trip | None:
        for t in reversed(self.trips):
            if not t.reconstructed and t.distance_km:
                return t
        return self.trips[-1] if self.trips else None

    @property
    def active(self) -> Trip | None:
        return self._active

    def recent(self, n: int = 10) -> list[dict[str, Any]]:
        return [t.summary() for t in self.trips[-n:][::-1]]

    def stats(self, now: float | None = None) -> dict[str, Any]:
        """今日 / 近 7 天 / 近 30 天 的次数、里程、耗电、平均能耗。

        分档都是"**含今天的** N 个自然日": 今日 = 今天 0 点起; 近 7 天 = 今天 0 点往前 6 天起。
        """
        now = now or time.time()
        day0 = time.mktime(time.localtime(now)[:3] + (0, 0, 0, 0, 0, -1))
        out: dict[str, Any] = {}
        for key, span in (("today", 1), ("days7", 7), ("days30", 30)):
            since = day0 - (span - 1) * 86400
            sel = [t for t in self.trips if t.ended_at >= since]
            km = sum(t.distance_km or 0 for t in sel)
            kwh = sum(t.energy_kwh or 0 for t in sel)
            out[key] = {"count": len(sel), "km": round(km, 1), "kwh": round(kwh, 2),
                        "kwh_per_100km": round(kwh / km * 100, 1) if km > 0.5 else None}
        out["reconstructed"] = sum(1 for x in self.trips if x.reconstructed)
        out["total"] = {"count": len(self.trips),
                        "km": round(sum(t.distance_km or 0 for t in self.trips), 1)}
        out["gaps"] = len(self.gaps)
        return out

    def list_trips(self, limit: int = 200) -> list[dict[str, Any]]:
        return [t.summary() for t in self.trips[-limit:][::-1]]

    def daily_series(self, days: int = 7, now: float | None = None) -> dict[str, Any]:
        """最近 N 个自然日(含今天)的逐日里程/耗电/百公里能耗 —— 给"里程/耗电"卡片画图用。

        口径与 `stats()` 完全一致(同按 `ended_at` 归属日期、同样不计 offline_gaps),
        所以卡片上的日柱加起来应该等于「行程统计」里近 7 天/近 30 天的数。

        两个刻意的区分(图上语义不同):
          * `None` = 那天**还没被记录过**(早于第一条行程;集成刚装上/停机很久) —— 图上断开;
          * `0`    = 那天**确实没有行程**(记录期内) —— 图上是一个真实的 0。
        充电造成的里程跳变在 gaps 里(不进行程), 与 stats 一致地不计入。

        `eff`(百公里能耗)按"当日 ΔSOC 折算耗电 / 当日里程"算, 与 `stats()` 的
        `kwh_per_100km` 同口径;里程 < MIN_EFFICIENCY_KM 或没有耗电样本时给 None。
        """
        now = now or time.time()
        seq = recent_day_starts(days, now)
        first_ts = min((t.ended_at for t in self.trips if t.ended_at), default=None)
        # 记录期的起点 = 第一条行程结束那天 0 点; 早于它的日子是"没被记录过"(None)
        first_day0 = day_start_of(first_ts) if first_ts else None
        idx_by_day = {day: i for i, (day, _start) in enumerate(seq)}
        km_sum = [0.0] * len(seq)
        kwh_sum = [0.0] * len(seq)
        # 行程归桶: 按"结束时刻那天"(与 stats() 同口径)
        for t in self.trips:
            if not t.ended_at:
                continue
            idx = idx_by_day.get(time.strftime("%Y-%m-%d", time.localtime(t.ended_at)))
            if idx is None:
                continue
            km_sum[idx] += t.distance_km or 0
            kwh_sum[idx] += t.energy_kwh or 0
        out_days: list[dict[str, Any]] = []
        cover: list[str] = []
        for (day, start), km, kwh in zip(seq, km_sum, kwh_sum):
            known = first_day0 is not None and start >= first_day0
            if known:
                cover.append(day)
            # 当日的百公里能耗(与 stats() 的 kwh_per_100km 同一口径与阈值);
            # 里程太短(挪车)或没有耗电样本时不给 —— 除出来没意义, 图上断开。
            eff = (round(kwh / km * 100, 1)
                   if known and km > MIN_EFFICIENCY_KM and kwh > 0 else None)
            out_days.append({"day": day,
                             "km": round(km, 1) if km else (0 if known else None),
                             "kwh": round(kwh, 2) if kwh else (0 if known else None),
                             "eff": eff})
        return {"days": out_days,
                "coverage_from": cover[0] if cover else None,
                "first_trip_ts": first_ts}

    def get(self, trip_id: str) -> Trip | None:
        for t in self.trips:
            if t.id == trip_id:
                return t
        return None

    def delete(self, trip_id: str) -> bool:
        before = len(self.trips)
        self.trips = [t for t in self.trips if t.id != trip_id]
        if len(self.trips) != before:
            self._save_soon(delay=1)
            return True
        return False

    def track(self, trip_id: str, max_points: int = 0) -> list[list[float]]:
        t = self.get(trip_id)
        if t is None:
            return []
        pts = t.points or []
        return downsample(pts, max_points) if max_points else pts

    # ── 杂项 ──
    def set_capacity(self, kwh: float) -> None:
        self.capacity_kwh = float(kwh or DEFAULT_CAPACITY_KWH)

    @staticmethod
    def _dt(ts: float) -> str:
        try:
            return time.strftime("%m-%d %H:%M", time.localtime(ts))
        except Exception:  # noqa: BLE001
            return str(ts)
