/*
 * 零跑行程浏览 —— 行程卡片 + 轨迹地图的 Lovelace 卡片。
 *
 * 数据来源(集成的 WebSocket 命令, 见 custom_components/leapmotor/ws_api.py):
 *   * `leapmotor/trips/list`   —— 行程摘要列表 + 今日/近7天/近30天统计 + 正在记录的那段
 *   * `leapmotor/trips/track`  —— 单段行程的轨迹点(max_points: 0 = 全量, 坐标 WGS-84)
 *   * `leapmotor/trips/delete` —— 删除一段行程(需要管理员)
 *
 * 版式(v1.1.0, 对齐零跑官方 App)
 * --------------------------------
 *   * 列表 = 主视图。按天分组(今天/昨天/9月12日…), 标题右边是当天总里程;
 *     每段行程是**一张白色小卡**: 左边一张小地图缩略图(瓦片 + 红色轨迹),
 *     右上大号里程 + 时间段, 底部三列小指标(耗时 / 耗电 kWh / 平均能耗)。
 *   * 点卡片 → 进详情: 上方一张大图(完整轨迹 + 起点黑钉/终点红钉),
 *     下方信息卡(日期时间标题、起终点两行、3×2 指标网格)。
 *   * **不显示电量百分比, 也不显示电费** —— 我们没有可靠的电费数据;
 *     耗电一律给 kWh。
 *
 * 缩略图怎么来的(别把首屏拖垮)
 * ----------------------------
 *   首屏只画卡片骨架(缩略图是浅灰占位), 然后异步去拉轨迹:
 *   `leapmotor/trips/track` 每段只取 **80 个点**(降采样够画小图了),
 *   结果缓存在实例里(按 trip_id), 第二次渲染直接命中缓存。
 *   最多只补前 THUMB_LIMIT(30)段的图, 并发 4, 拉失败的段保持占位, 绝不阻塞列表。
 *
 * 断档怎么画
 * ----------
 * 轨迹点里**没有时间戳**, 没法直接按"时间差 > 采样间隔"判断丢采样, 所以退化成用
 * 距离判断: 相邻两点距离 > 2 km 就当作断档(正常 6 秒采样下相邻点通常只有几十米,
 * 高速也远小于 2 km), 断档处用**虚线**连过去, 实线部分是连续采到的路段。
 *
 * 底图与坐标系
 * ------------
 * 与 `leapmotor-map.js` 完全同一套做法: 底图取高德瓦片(GCJ-02 火星坐标), 集成给的
 * 轨迹是 WGS-84, 画之前用 wgs84ToGcj02() 换算 —— 不换算会偏 300~500 米。
 * 缩略图与大图共用 project()/unproject() 与同一份瓦片模板。
 *
 * 用法
 * ----
 *   type: custom:leapmotor-trips
 *   # 可选
 *   height: 340          # 详情页大图高度 px
 *   map_style: auto      # 底图: auto 随 HA 主题(浅色=路网/深色=夜色) / vector / satellite / dark
 *   heatmap: true        # 速度热力图(按实时车速给轨迹上色; 需轨迹点带 speed)
 *   flow: true           # 轨迹流动光效(独立于热力图)
 *   overlay: 0           # 打开时默认叠加最近 N 段(0=关; 手填 1~50; 别名 overlay_count)
 *   list_height: 520     # 行程列表最大高度 px
 *   group: true          # 每日包一层可收起卡片 + 当日叠加缩略图(false = 旧版平铺)
 *
 * 详情页工具条上还有同名开关(底图样式下拉 / 叠加段数输入框 / 热力图 / 光效), 可临时切换,
 * 不必改 yaml。旧写法 `satellite: true` 仍兼容(等价于 map_style: satellite)。
 * 详情页头部有导出按钮(CSV / XML / JSON)。
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 */

const TILE = 256;

const CARD_VERSION = "1.4.5";

/* 断档阈值(km): 相邻轨迹点距离超过它 → 视为中间丢过采样, 用虚线连 */
const TRACK_GAP_KM = 2;

/* 列表缩略图: 固定尺寸 + 最多补前 N 段(防止一次拉几十条轨迹/瓦片) */
const THUMB_W = 96;
const THUMB_H = 72;
const THUMB_LIMIT = 30;
const THUMB_FETCH_POINTS = 80;      // 缩略图只要这么多点, 详情大图才是全量
const THUMB_CONCURRENCY = 4;
const OVERLAY_MAX = 50;             // 「叠加最近」手填上限(拉太多轨迹会拖慢首屏)
/* 每日卡片头部的"当天叠加轨迹"缩略图: 比单段缩略图大一点(看得清当天都跑了哪些路) */
const DAY_THUMB_W = 120;
const DAY_THUMB_H = 88;
const DAY_THUMB_LIMIT = 12;         // 最多补前 N 天, 后面的保持占位(省瓦片请求)

/* 叠加模式的配色(相邻两段尽量不同色) */
const OVERLAY_COLORS = [
  "#1e88e5", "#e53935", "#00897b", "#8e24aa", "#f4511e",
  "#3949ab", "#7cb342", "#d81b60", "#00acc1", "#6d4c41",
  "#5e35b1", "#c0ca33", "#039be5", "#ad1457", "#43a047",
  "#8d6e63", "#3f51b5", "#ef6c00", "#0097a7", "#f06292",
];

/* ── WGS-84 → GCJ-02(国测局偏移公式; 国境外原样返回), 与 leapmotor-map.js 同源 ── */
const A_GCJ = 6378245.0;
const EE_GCJ = 0.00669342162296594323;

function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

/* GCJ-02 的**经度**多项式(与 transformLat 是两个不同公式)。
   ⚠️ 坑: 这里曾错误地复用 transformLat —— 与 leapmotor-map.js /
   poller/api_client.py 同源, 三处一起改。 */
function transformLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcj02ToWgs84(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE_GCJ * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A_GCJ / sqrtMagic) * Math.cos(radLat) * Math.PI);
  // 再迭代一次, 把误差压到亚米级
  const wLat = lat - dLat;
  const wLon = lon - dLon;
  let dLat2 = transformLat(wLon - 105.0, wLat - 35.0);
  let dLon2 = transformLon(wLon - 105.0, wLat - 35.0);
  const radLat2 = (wLat / 180.0) * Math.PI;
  let magic2 = Math.sin(radLat2);
  magic2 = 1 - EE_GCJ * magic2 * magic2;
  const sqrtMagic2 = Math.sqrt(magic2);
  dLat2 = (dLat2 * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic2 * sqrtMagic2)) * Math.PI);
  dLon2 = (dLon2 * 180.0) / ((A_GCJ / sqrtMagic2) * Math.cos(radLat2) * Math.PI);
  return [lat - dLat2, lon - dLon2];
}

function wgs84ToGcj02(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE_GCJ * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A_GCJ / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lon + dLon];
}

/* 高德瓦片模板。{s} 是 1~4 的负载均衡序号。 */
const TILE_SOURCES = {
  vector:
    "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  satellite: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
};
/* 高德连不上时回落到 OSM(海外用户/高德故障时至少还能看图) */
const TILE_FALLBACK = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** 经纬度 → 世界像素坐标(标准 Web 墨卡托, 与高德/OSM 一致)。 */
function project(lat, lon, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function unproject(x, y, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lon];
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 两点球面距离(km) —— 用于判断轨迹是否断档。 */
function haversineKm(a, b) {
  const r = 6371.0088;
  const p1 = (a[0] * Math.PI) / 180;
  const p2 = (b[0] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const s = Math.sin(dp / 2) * Math.sin(dp / 2) +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 车速 → 热力图颜色(0~120+ km/h 分段色板)。 */
function getSpeedColor(speed) {
  const s = Math.max(0, Math.min(120, Number(speed) || 0));
  if (s < 15) return "#2196f3";   // 蓝 (起步/拥堵)
  if (s < 40) return "#4caf50";   // 绿 (市区低速)
  if (s < 80) return "#ffeb3b";   // 黄 (快速路)
  if (s < 100) return "#ff9800";  // 橙 (高速)
  return "#f44336";               // 红 (极速)
}

/* ── 小工具(不引入任何依赖) ── */
function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

function fmtTime(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function fmtDayTime(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 详情页标题用的"9月13日 20:11"。 */
function fmtStamp(ts) {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function dayKey(ts) {
  const d = new Date(Number(ts) * 1000);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

function dayLabel(ts) {
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today - day) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const wk = "日一二三四五六"[d.getDay()];
  const y = d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "";
  return y + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + wk;
}

function fmtDuration(min) {
  const n = Number(min);
  if (min == null || !Number.isFinite(n)) return "—";
  const m = Math.max(0, Math.round(n));
  if (m < 60) return m + " 分钟";
  const hh = Math.floor(m / 60);
  const mm = m % 60;
  return mm ? hh + " 小时 " + mm + " 分" : hh + " 小时";
}

/**
 * 紧凑时长(对齐官方 App): 44'55" / 1h37' / 40"。
 * duration_min 是分钟(带小数), 先换算成秒再拼。
 */
function fmtDurShort(min) {
  const n = Number(min);
  if (min == null || !Number.isFinite(n)) return "—";
  const s = Math.max(0, Math.round(n * 60));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return h + "h" + pad2(m) + "'";
  if (m > 0) return m + "'" + pad2(sec) + '"';
  return sec + '"';
}

function fmtNum(v, digits, unit) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits) + (unit ? " " + unit : "");
}

/** 里程: 一位小数(官方 App 就是 19.0 km)。 */
function fmtKm(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

/** 耗电 kWh: 一位小数, 不到 1 kWh 的小段给两位(免得 0.40 显示成 0.4)。 */
function fmtKwh(v) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(1);
}

/** 坐标文本(没有地点名, 就老实给坐标 —— 不编地名)。 */
function fmtCoord(lat, lon) {
  const la = Number(lat);
  const lo = Number(lon);
  if (lat == null || lon == null || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return Math.abs(la).toFixed(4) + "°" + (la >= 0 ? "N" : "S") + "  " +
    Math.abs(lo).toFixed(4) + "°" + (lo >= 0 ? "E" : "W");
}

/** 等距抽稀(保留首尾), 给缩略图/叠加模式减负。 */
function simplify(points, maxN) {
  if (!points || points.length <= maxN || maxN < 3) return points || [];
  const step = (points.length - 1) / (maxN - 1);
  const out = [];
  for (let i = 0; i < maxN; i++) out.push(points[Math.round(i * step)]);
  out[0] = points[0];
  out[out.length - 1] = points[points.length - 1];
  return out;
}

class LeapmotorTripsCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._zoom = 16;
    this._center = null;        // [lat, lon](显示坐标系 = GCJ-02)
    this._built = false;
    this._loaded = false;       // 只自动拉一次; 之后靠刷新按钮
    this._loading = false;
    this._err = "";
    this._trips = [];
    this._stats = null;
    this._active = null;
    this._selectedId = "";
    this._selTrip = null;
    this._sel = null;           // 选中行程的 {runs, breaks}(显示坐标)
    this._trackCache = {};      // trip_id → 全量轨迹点(WGS-84), 详情大图用
    this._thumbCache = {};      // trip_id → 降采样轨迹点(WGS-84), 缩略图用
    this._thumbPrep = {};       // trip_id → 缩略图用的 {runs, breaks}(null = 没轨迹)
    this._thumbSeq = 0;
    this._dayPrep = {};         // dayKey → {runs, breaks}(当天所有轨迹叠加, 给每日缩略图用)
    this._daySeq = 0;
    this._collapsed = {};       // dayKey → false = 该天**展开**; 未设置 = 默认收起(点标题切换)
    this._view = "list";        // list | detail
    this._overlayN = 0;
    this._overlayTracks = [];
    this._overlaySeq = 0;
    this._tiles = new Map();
    this._needFit = true;
    this._dragging = false;
    // 详情图的可视化开关(可在 yaml 里设默认值, 也能在卡片上临时切换)
    this._heatmap = true;       // 速度热力图(按实时车速给轨迹上色)
    this._flow = true;          // 流动光效(顺着行驶方向的动画)
    this._mapStyle = "auto";    // auto 随 HA 主题 | vector | satellite | dark
  }

  /** 从卡片选择器添加时不需要填任何东西(数据走本集成的 WS 命令)。 */
  static getStubConfig() {
    return { height: 340, map_style: "auto", heatmap: true, flow: true,
             overlay: 0, list_height: 520 };
  }

  setConfig(config) {
    const raw = config || {};
    this._config = {
      height: 340,
      map_style: "auto",
      heatmap: true,
      flow: true,
      overlay: 0,
      list_height: 520,
      group: true,           // 每日包一层可收起的卡片 + 当日叠加缩略图
      ...raw,
    };
    // satellite 是 map_style 的旧别名(向后兼容: 之前只有这一个布尔开关)
    if (raw.map_style == null && raw.satellite != null) {
      this._config.map_style = raw.satellite ? "satellite" : "vector";
    }
    // overlay_count 是 overlay 的别名(两版卡片都有人这么写)
    if (this._config.overlay == null && this._config.overlay_count != null) {
      this._config.overlay = this._config.overlay_count;
    }
    this._config.height = clamp(Number(this._config.height) || 340, 200, 900);
    this._config.list_height = clamp(Number(this._config.list_height) || 520, 160, 1600);
    this._mapStyle = this._normMapStyle(this._config.map_style);
    this._heatmap = this._config.heatmap !== false;
    this._flow = this._config.flow !== false;
    this._group = this._config.group !== false;
    const ov = Number(this._config.overlay) || 0;
    this._overlayN = ov > 0 ? clamp(Math.round(ov), 1, OVERLAY_MAX) : 0;
    this._overlayTracks = [];
    this._overlaySeq++;
    this._tiles.forEach((img) => img.remove());
    this._tiles.clear();
    this._built = false;
    this._center = null;
    this._view = "list";
    this._needFit = true;
    this._render();
    if (this._overlayN > 0 && this._trips.length && this._hass) this._loadOverlay();
  }

  /** 归一化底图样式名(容忍大小写/空格; 未知值回落到路网图)。auto = 随 HA 主题。 */
  _normMapStyle(v) {
    const s = String(v == null ? "" : v).trim().toLowerCase();
    if (s === "auto" || s === "自动") return "auto";
    if (s === "satellite" || s === "sat" || s === "卫星") return "satellite";
    if (s === "dark" || s === "深色" || s === "night" || s === "暗黑") return "dark";
    return "vector";
  }

  /** 实际生效的底图: auto → HA 深色主题时用深色, 否则路网。 */
  _effMapStyle() {
    const s = this._mapStyle || "vector";
    if (s !== "auto") return s;
    const dark = !!(this._hass && this._hass.themes && this._hass.themes.darkMode);
    return dark ? "dark" : "vector";
  }

  set hass(hass) {
    this._hass = hass;
    // "自动"底图随 HA 主题: 主题从浅切深时重画一次瓦片/缩略图(否则要等下次交互才变)
    const dark = !!(hass && hass.themes && hass.themes.darkMode);
    if (this._themeDark !== undefined && this._themeDark !== dark && this._mapStyle === "auto") {
      this._themeDark = dark;
      this._tiles.forEach((img) => img.remove());
      this._tiles.clear();
      this._applyMapStyle();
      this._renderMap();
      this._paintThumbs();
      this._paintDayThumbs();
    }
    this._themeDark = dark;
    // 行程是低频数据(每段结束时才变), 不必跟着 hass 的每次状态更新重拉
    if (!this._loaded) {
      this._loaded = true;
      this._load();
    }
  }

  getCardSize() {
    const h = (this._config && this._config.height) || 340;
    return Math.ceil(h / 50) + 3;
  }

  // ── 数据 ──
  _errText(err) {
    const code = String((err && err.code) || "");
    const msg = String((err && err.message) || err || "");
    if (code === "unknown_command" || /unknown command/i.test(msg)) {
      return "需要 beta 版集成(行程记录)";
    }
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(msg)) return "需要管理员权限";
    return "读取失败: " + msg.slice(0, 80);
  }

  _find(id) {
    for (const t of this._trips) {
      if (t && String(t.id) === String(id)) return t;
    }
    return null;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    if (!this._hass.callWS) {
      this._err = "需要 beta 版集成(行程记录)";
      this._render();
      return;
    }
    this._loading = true;
    this._err = "";
    this._render();
    try {
      const res = await this._hass.callWS({ type: "leapmotor/trips/list", limit: 200 });
      this._trips = (res && res.trips) || [];
      this._stats = (res && res.stats) || null;
      this._active = (res && res.active) || null;
      this._trackCache = {};
      this._thumbCache = {};
      this._thumbPrep = {};
      this._thumbSeq++;
      this._dayPrep = {};
      this._daySeq++;
      this._overlayTracks = [];
      this._overlaySeq++;
      this._loading = false;
      this._pickDefault();
      this._render();
      if (this._view === "detail" && this._selectedId) await this._openDetail(this._selectedId, true);
      if (this._overlayN > 0) await this._loadOverlay();
    } catch (err) {
      this._loading = false;
      this._err = this._errText(err);
      this._render();
    }
  }

  /** 默认选中"最近一段有轨迹的行程"(没有就选最新一段) —— 只决定高亮, 不自动进详情。 */
  _pickDefault() {
    if (this._selectedId && !this._find(this._selectedId)) this._selectedId = "";
    if (!this._selectedId) {
      let pick = null;
      for (const t of this._trips) {
        if (t && t.point_count > 0) {
          pick = t;
          break;
        }
      }
      if (!pick) pick = this._trips[0] || null;
      this._selectedId = pick ? pick.id : "";
    }
    this._selTrip = this._find(this._selectedId);
    this._needFit = true;
  }

  /** 取一段行程的**全量**轨迹(详情大图用), 带缓存。 */
  async _ensureTrack(id) {
    if (this._trackCache[id]) return this._trackCache[id];
    let pts = [];
    try {
      const res = await this._hass.callWS({
        type: "leapmotor/trips/track",
        trip_id: id,
        max_points: 0,
      });
      pts = (res && res.points) || [];
    } catch (err) {
      pts = [];
      if (!this._err) this._err = this._errText(err);
    }
    this._trackCache[id] = pts;
    return pts;
  }

  /** 取一段行程的**降采样**轨迹(缩略图用, 只 80 点), 带缓存; 失败返回空数组。 */
  async _ensureThumbTrack(id) {
    if (this._thumbCache[id]) return this._thumbCache[id];
    let pts = [];
    try {
      const res = await this._hass.callWS({
        type: "leapmotor/trips/track",
        trip_id: id,
        max_points: THUMB_FETCH_POINTS,
      });
      pts = (res && res.points) || [];
    } catch (err) {
      pts = [];
    }
    this._thumbCache[id] = pts;
    return pts;
  }

  /** 原始轨迹(WGS-84)→ 显示坐标, 并按距离切成 runs(实线)/ breaks(虚线)。
   *  保留可选的第三维车速(p[2]), 供速度热力图着色用。 */
  _prepare(raw, maxN) {
    const src = simplify(raw || [], maxN);
    const disp = [];
    for (const p of src) {
      if (!p || p.length < 2) continue;
      const la = Number(p[0]);
      const lo = Number(p[1]);
      const speed = p.length >= 3 ? Number(p[2]) || 0 : null;
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (la === 0 && lo === 0) continue;
      const gcj = wgs84ToGcj02(la, lo);
      disp.push([gcj[0], gcj[1], speed]);
    }
    const runs = [];
    const breaks = [];
    let cur = [];
    for (let i = 0; i < disp.length; i++) {
      if (i > 0) {
        if (haversineKm(disp[i - 1], disp[i]) > TRACK_GAP_KM) {
          if (cur.length) runs.push(cur);
          breaks.push([disp[i - 1], disp[i]]);
          cur = [];
        }
      }
      cur.push(disp[i]);
    }
    if (cur.length) runs.push(cur);
    return { runs: runs, breaks: breaks };
  }

  async _openDetail(id, keepView) {
    const t = this._find(id);
    this._selectedId = id;
    this._selTrip = t;
    this._view = "detail";
    this._render();
    if (!t) return;
    if (t.point_count > 0) {
      const pts = await this._ensureTrack(id);
      if (String(this._selectedId) !== String(id) || this._view !== "detail") return;
      this._sel = this._prepare(pts, 4000);
    } else {
      this._sel = null;
    }
    if (keepView === true && this._overlayN > 0) return;   // 刷新场景, 叠加单独加载
    this._needFit = true;
    this._renderMap();
    this._renderDetailInfo();
  }

  _backToList() {
    this._view = "list";
    if (this._expMenuEl) this._expMenuEl.classList.remove("on");   // 离开详情就收起导出气泡
    this._render();          // 走一次整体渲染, 顺便把列表视图重新显示出来
  }

  async _loadOverlay() {
    if (!this._hass || !this._hass.callWS) return;
    const n = this._overlayN;
    if (!n) return;
    const seq = ++this._overlaySeq;
    const cands = this._trips.filter((t) => t && t.point_count > 0).slice(0, n);
    for (const t of cands) await this._ensureTrack(t.id);
    if (seq !== this._overlaySeq || this._overlayN !== n) return;   // 期间开关/刷新过
    const out = [];
    for (const t of cands) {
      const prep = this._prepare(this._trackCache[t.id] || [], 400);
      if (!prep.runs.length) continue;
      out.push({
        id: t.id,
        runs: prep.runs,
        breaks: prep.breaks,
        color: OVERLAY_COLORS[out.length % OVERLAY_COLORS.length],
        label: fmtTime(t.started_at) + " → " + fmtTime(t.ended_at),
      });
    }
    this._overlayTracks = out;
    this._needFit = true;
    this._renderLegend();
    this._renderMap();
  }

  _toggleOverlay(on) {
    if (!on) {
      this._overlayN = 0;
      this._overlayTracks = [];
      this._overlaySeq++;
      this._renderToolbar();
      this._renderLegend();
      this._renderMap();
      return;
    }
    const n = clamp(Math.round(Number(this._ovlN.value) || 5), 1, OVERLAY_MAX);
    this._overlayN = n;
    this._renderToolbar();
    if (!this._trips.length) {
      this._overlayTracks = [];
      this._renderLegend();
      return;
    }
    this._loadOverlay();
  }

  // ── 渲染 ──
  _render() {
    if (!this._config) return;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    this._renderHead();
    this._renderActive();
    this._renderToolbar();
    if (this._view === "detail") {
      this._listView.hidden = true;
      this._detailView.hidden = false;
      this._renderMap();
      this._renderDetailInfo();
    } else {
      this._detailView.hidden = true;
      this._listView.hidden = false;
      this._renderList();
    }
    this._renderLegend();
  }

  _renderHead() {
    if (!this._sumEl) return;
    const st = this._stats;
    const parts = [];
    if (st && st.today) {
      parts.push(`今日 ${st.today.count || 0} 段 · ${fmtKm(st.today.km)} km`);
      if (st.days7) parts.push(`近7天 ${fmtKm(st.days7.km)} km`);
    }
    if (st && st.gaps) parts.push(`漏采 ${st.gaps} 次`);
    this._sumEl.textContent = parts.join(" · ");
    if (this._refreshBtn) this._refreshBtn.classList.toggle("spin", this._loading);
    this._syncCollapseBtn();
  }

  /** 列表里出现过的所有日期(天)。 */
  _allDays() {
    const days = [];
    for (const t of this._trips) {
      if (!t || !t.started_at) continue;
      const k = dayKey(t.started_at);
      if (!days.includes(k)) days.push(k);
    }
    return days;
  }

  /** 一键全收起/全展开: 若当前"所有天都收起" → 全部展开, 否则全部收起。 */
  _toggleAllDays() {
    const days = this._allDays();
    if (!days.length) return;
    const allCollapsed = days.every((k) => this._collapsed[k] !== false);
    const next = !allCollapsed;
    for (const k of days) this._collapsed[k] = next;
    this._render();
  }

  _syncCollapseBtn() {
    if (!this._collapseBtn) return;
    const days = this._allDays();
    const allCollapsed = days.length > 0 && days.every((k) => this._collapsed[k] !== false);
    const icon = allCollapsed ? "mdi:unfold-more-horizontal" : "mdi:unfold-less-horizontal";
    this._collapseBtn.innerHTML = '<ha-icon icon="' + icon + '"></ha-icon>';
    this._collapseBtn.title = allCollapsed ? "全部展开" : "全部收起";
  }

  _renderActive() {
    if (!this._activeEl) return;
    if (!this._active || !this._active.started_at) {
      this._activeEl.classList.remove("on");
      return;
    }
    const mins = Math.max(0, (Date.now() / 1000 - Number(this._active.started_at)) / 60);
    this._activeEl.classList.add("on");
    this._activeText.textContent =
      `记录中: 起于 ${fmtTime(this._active.started_at)}(已 ${fmtDuration(mins)})`;
  }

  _renderToolbar() {
    if (!this._ovlBox) return;
    this._ovlBox.checked = this._overlayN > 0;
    this._ovlN.value = String(this._overlayN || 5);
    if (this._mstyleSel) this._mstyleSel.value = this._mapStyle || "vector";
    if (this._hmBox) this._hmBox.checked = !!this._heatmap;
    if (this._flowBox) this._flowBox.checked = !!this._flow;
    this._applyMapStyle();
  }

  /** 把当前的底图/热力图/光效开关落到 DOM(class + 图例显隐)。 */
  _applyMapStyle() {
    if (this._mapEl) this._mapEl.classList.toggle("dark", this._effMapStyle() === "dark");
    if (this._speedBar) this._speedBar.classList.toggle("on", !!this._heatmap);
  }

  // ── 列表视图 ──
  _renderList() {
    if (!this._listEl) return;
    if (this._err) {
      this._listEl.innerHTML = "";
      this._lmsgEl.textContent = this._err;
      this._lmsgEl.className = "lmsg err";
      return;
    }
    this._lmsgEl.className = "lmsg";
    if (!this._loaded || (this._loading && !this._trips.length)) {
      this._listEl.innerHTML = "";
      this._lmsgEl.textContent = "读取中…";
      return;
    }
    if (!this._trips.length) {
      this._listEl.innerHTML = "";
      this._lmsgEl.textContent = "还没有行程记录";
      return;
    }
    this._lmsgEl.textContent = "";
    let html = "";
    let curDay = "";
    let group = [];
    const flush = () => {
      if (!group.length) return;
      let km = 0;
      for (const t of group) km += Number(t.distance_km) || 0;
      const key = dayKey(group[0].started_at);
      if (this._group === false) {
        // 关掉分组卡片(旧版式): 只给一行日期小标题
        html += '<div class="grp" data-day="' + key + '">' +
          '<span class="dn">' + dayLabel(group[0].started_at) + "</span>" +
          '<span class="dc">' + group.length + " 段</span>" +
          '<span class="dk">' + km.toFixed(1) + " km</span></div>";
        for (const t of group) html += this._rowHtml(t);
        group = [];
        return;
      }
      const closed = this._collapsed[key] !== false;   // 默认收起
      // 当天汇总(与单段行程同一套 .mets 排版): 收起时显示"耗时/耗电/百公里能耗"
      let dur = 0, kwh = 0, hasDur = false, hasKwh = false;
      for (const t of group) {
        if (t.duration_min != null) { dur += Number(t.duration_min) || 0; hasDur = true; }
        if (t.energy_kwh != null) { kwh += Number(t.energy_kwh) || 0; hasKwh = true; }
      }
      const dayEff = (hasKwh && km > 0.5 && kwh > 0) ? kwh / km * 100 : null;
      const sumMets = [
        ["耗时", hasDur ? fmtDurShort(dur) : "—", "", "当天累计耗时"],
        ["耗电", hasKwh ? fmtKwh(kwh) : "—", hasKwh ? "kWh" : "", "当天累计耗电"],
        ["平均能耗", dayEff == null ? "—" : fmtNum(dayEff, 1),
         dayEff == null ? "" : "kWh/100km", "当天百公里能耗", 1],
      ];
      const sumHtml = sumMets.map((m) =>
        '<div class="met" title="' + m[3] + '"><span class="k">' + m[0] + '</span><span class="v">' +
        m[1] + (m[2] ? '<i' + (m[4] ? ' class="fit"' : "") + ">" + m[2] + "</i>" : "") +
        "</span></div>").join("");
      // 每日包一层卡片: 收起态 = 左侧当天叠加缩略图 + 右侧汇总(耗时/耗电/能耗);
      // 展开态 = 隐藏缩略图与汇总, 改看当日各段明细。
      html += '<div class="daycard' + (closed ? " collapsed" : "") + '" data-day="' + key + '">' +
        '<div class="daytop">' +
        '<div class="dthumb" title="当天轨迹叠加"></div>' +
        '<div class="dayinfo">' +
        '<div class="dayhead">' +
        '<span class="dn">' + dayLabel(group[0].started_at) + "</span>" +
        '<span class="dmeta">' + group.length + " 段 · " + km.toFixed(1) + " km</span>" +
        '<ha-icon class="chev" icon="mdi:chevron-down"></ha-icon>' +
        "</div>" +
        '<div class="daysum mets">' + sumHtml + "</div>" +
        "</div>" +
        "</div>" +
        '<div class="dayrows">';
      for (const t of group) html += this._rowHtml(t);
      html += "</div></div>";
      group = [];
    };
    for (const t of this._trips) {
      if (!t || !t.started_at) continue;
      const key = dayKey(t.started_at);
      if (key !== curDay) {
        flush();
        curDay = key;
      }
      group.push(t);
    }
    flush();
    const keepTop = this._listEl.scrollTop;
    this._listEl.innerHTML = html;
    this._listEl.scrollTop = keepTop;
    this._fitUnits();                             // 长单位随列宽自适应(见 _fitUnits)
    this._paintThumbs();
    this._paintDayThumbs();
  }

  /** 一段行程 = 一张白卡: 缩略图 + 大号里程 + 时间段 + 三列小指标。 */
  _rowHtml(t) {
    const sel = String(t.id) === String(this._selectedId);
    const sameDay = dayKey(t.started_at) === dayKey(t.ended_at || t.started_at);
    const tm = sameDay
      ? fmtTime(t.started_at) + " - " + fmtTime(t.ended_at)
      : fmtDayTime(t.started_at) + " - " + fmtDayTime(t.ended_at);
    const badges = [];
    if (t.reconstructed) {
      badges.push('<span class="badge r" title="漏采补记: 没有轨迹, 时间只是两次观测之间">补记</span>');
    }
    if (t.frozen) badges.push('<span class="badge f" title="车端失联后收尾, 时长可能有偏差">失联</span>');
    const mets = [
      ["耗时", (t.approx_time && t.duration_min != null ? "≈ " : "") + fmtDurShort(t.duration_min), "", "时长"],
      ["耗电", fmtKwh(t.energy_kwh), "kWh", "这段行程的耗电量"],
      // 平均能耗: 单位要写全 "kWh/100km" —— 只写 "kWh" 会被读成"耗电量"。
      // 窄列放不下时由 _fitUnits() **整段隐藏**(而不是截成 "kWh/10…"); 无值时也不挂单位。
      ["平均能耗", t.efficiency == null ? "—" : fmtNum(t.efficiency, 1),
       t.efficiency == null ? "" : "kWh/100km", "百公里能耗 (kWh/100km)", 1],
    ];
    const metHtml = mets
      .map((m) => '<div class="met" title="' + m[3] + '"><span class="k">' + m[0] + "</span><span class=\"v\">" +
        m[1] + (m[2] ? "<i" + (m[4] ? ' class="fit"' : "") + ">" + m[2] + "</i>" : "") + "</span></div>")
      .join("");
    return (
      '<div class="row trip' + (sel ? " sel" : "") + '" data-id="' + String(t.id) + '">' +
      '<div class="thumb" title="行程缩略图">' +
      (badges.length ? '<span class="rbadges">' + badges.join("") + "</span>" : "") +
      "</div>" +
      '<div class="rbody">' +
      '<div class="rtop">' +
      '<span class="rkm">' + fmtKm(t.distance_km) + "<i>km</i></span>" +
      '<span class="rtm">' + tm + "</span>" +
      '<button class="del" data-act="del" title="删除这段行程">' +
      '<ha-icon icon="mdi:trash-can-outline"></ha-icon></button>' +
      "</div>" +
      '<div class="mets">' + metHtml + "</div>" +
      "</div></div>"
    );
  }

  /** 列表里的长单位(如 "kWh/100km")在窄列放不下时**整段隐藏**, 而不是截成 "kWh/10…"。
      能放下就显示完整口径 —— 只写 "kWh" 会被读成耗电量, 缺了 /100km 是错的。
      尺子: .v 是 nowrap + overflow:hidden, scrollWidth 超出 clientWidth 就是放不下。
      由 _renderList() 和 ResizeObserver(列宽变化)调用。 */
  _fitUnits() {
    if (!this._listEl) return;
    for (const v of this._listEl.querySelectorAll(".met .v")) {
      const u = v.querySelector("i.fit");
      if (!u) continue;
      u.hidden = false;                           // 先复位再量(上一轮可能隐藏过)
      if (v.scrollWidth > v.clientWidth + 1) u.hidden = true;
    }
  }

  // ── 缩略图 ──
  _paintThumbs() {
    if (!this._listEl) return;
    const rows = this._listEl.querySelectorAll(".row[data-id]");
    let i = 0;
    for (const row of rows) {
      if (i >= THUMB_LIMIT) break;      // 只补前 N 段, 后面的保持占位(省瓦片请求)
      i++;
      if (this._thumbPrep[row.dataset.id]) this._paintThumb(row, row.dataset.id);
    }
    this._queueThumbs();
  }

  /** 排队拉缩略图轨迹: 并发 4, 拿到就只补那一张缩略图(不整表重画)。 */
  _queueThumbs() {
    if (!this._listEl || !this._hass || !this._hass.callWS) return;
    const rows = [];
    let i = 0;
    for (const row of this._listEl.querySelectorAll(".row[data-id]")) {
      if (i++ >= THUMB_LIMIT) break;
      rows.push(row);
    }
    if (!rows.length) return;
    const seq = ++this._thumbSeq;
    let idx = 0;
    const worker = async () => {
      while (idx < rows.length) {
        const row = rows[idx++];
        const id = row && row.dataset ? row.dataset.id : "";
        if (!id || !row.isConnected) continue;
        if (!this._thumbPrep[id]) {
          const raw = await this._ensureThumbTrack(id);
          if (seq !== this._thumbSeq) return;
          this._thumbPrep[id] = raw && raw.length ? this._prepare(raw, 160) : null;
        }
        if (seq !== this._thumbSeq || !row.isConnected) return;
        this._paintThumb(row, id);
      }
    };
    for (let k = 0; k < THUMB_CONCURRENCY; k++) worker();
  }

  /** 把一段行程画进某个 .thumb 容器(瓦片 + 红色折线; 没轨迹就退回虚线/占位)。 */
  _paintThumb(row, id) {
    const el = row.querySelector(".thumb");
    if (!el) return;
    const t = this._find(id);
    const prep = this._thumbPrep[id];
    const pts = prep ? this._flatPrep(prep) : [];
    // 瓦片/轨迹节点只建一次(里面可能压着徽标, 不能整块 innerHTML 覆盖)
    let box = el.querySelector(".tiles");
    let svg = el.querySelector("svg");
    if (!box) {
      box = document.createElement("div");
      box.className = "tiles";
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "ttraj");
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", String(THUMB_W));
      svg.setAttribute("height", String(THUMB_H));
      svg.setAttribute("viewBox", "0 0 " + THUMB_W + " " + THUMB_H);
      el.appendChild(box);
      el.appendChild(svg);
    }
    box.innerHTML = "";
    svg.innerHTML = "";
    if (pts.length < 2) {
      // 补记/没轨迹: 浅灰底 + 起终点一条虚线; 连坐标都没有就写一个"无轨迹"
      el.classList.add("empty");
      const a = t ? this._point(t.start_lat, t.start_lon) : null;
      const b = t ? this._point(t.end_lat, t.end_lon) : null;
      if (a && b) {
        const geom = this._geom([a, b], THUMB_W, THUMB_H);
        if (geom) {
          this._thumbTiles(el, geom, THUMB_W, THUMB_H);
          const mapPt = this._mapper(geom, THUMB_W, THUMB_H);
          svg.appendChild(this._poly([a, b], mapPt, "#e53935", 1.5, true));
        }
      }
      if (!a || !b) {
        const ph = document.createElement("span");
        ph.className = "ph";
        ph.textContent = t && t.reconstructed ? "补记·无轨迹" : "无轨迹";
        el.appendChild(ph);
      }
      return;
    }
    el.classList.remove("empty");
    el.classList.toggle("dark", this._effMapStyle() === "dark");
    const geom = this._geom(pts, THUMB_W, THUMB_H);
    if (!geom) return;
    this._thumbTiles(el, geom, THUMB_W, THUMB_H);
    const mapPt = this._mapper(geom, THUMB_W, THUMB_H);
    const SVG = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(SVG, "defs");
    svg.appendChild(defs);
    // 缩略图同样跟随"热力图/光效"开关(与大图一致)
    for (const run of prep.runs) {
      if (run.length < 2) continue;
      const hasSpeed = !!this._heatmap && run.some((p) => p.length >= 3 && p[2] != null);
      if (hasSpeed) {
        svg.appendChild(this._polyHeatmap(run, mapPt, 2, defs, this._flow));
      } else {
        svg.appendChild(this._poly(run, mapPt, "#e53935", 2, false));
        if (this._flow) svg.appendChild(this._polyFlow(run, mapPt, 2));
      }
    }
    for (const br of prep.breaks) svg.appendChild(this._poly(br, mapPt, "#e53935", 1.5, true));
  }

  // ── 每日叠加缩略图(比单段大一点) ──
  _dayRowEls() {
    if (!this._listEl) return [];
    const out = [];
    let i = 0;
    for (const dc of this._listEl.querySelectorAll(".daycard[data-day]")) {
      if (i++ >= DAY_THUMB_LIMIT) break;
      out.push(dc);
    }
    return out;
  }

  _paintDayThumbs() {
    if (this._group === false) return;
    for (const dc of this._dayRowEls()) {
      if (this._dayPrep[dc.dataset.day]) this._paintDayThumb(dc);
    }
    this._queueDayThumbs();
  }

  /** 拉"当天所有段"的轨迹并叠加成一张缩略图: 并发 2, 只补当天的, 失败保持占位。 */
  _queueDayThumbs() {
    if (this._group === false || !this._hass || !this._hass.callWS) return;
    const cards = [];
    let i = 0;
    for (const dc of this._listEl.querySelectorAll(".daycard[data-day]")) {
      if (i++ >= DAY_THUMB_LIMIT) break;
      cards.push(dc);
    }
    if (!cards.length) return;
    const seq = ++this._daySeq;
    const dayTrips = (key) => this._trips.filter(
      (t) => t && t.started_at && dayKey(t.started_at) === key);
    let idx = 0;
    const worker = async () => {
      while (idx < cards.length) {
        const dc = cards[idx++];
        const key = dc && dc.dataset ? dc.dataset.day : "";
        if (!key || !dc.isConnected) continue;
        if (this._dayPrep[key] === undefined) {
          const runs = [];
          const breaks = [];
          for (const t of dayTrips(key)) {
            if (!t.point_count) continue;
            let raw = [];
            try {
              raw = await this._ensureThumbTrack(t.id);
            } catch (e) { raw = []; }
            const prep = raw && raw.length ? this._prepare(raw, 120) : null;
            if (prep) { for (const r of prep.runs) runs.push(r); for (const b of prep.breaks) breaks.push(b); }
          }
          if (seq !== this._daySeq) return;
          this._dayPrep[key] = runs.length ? { runs, breaks } : null;
        }
        if (seq !== this._daySeq || !dc.isConnected) return;
        this._paintDayThumb(dc);
      }
    };
    for (let k = 0; k < 2; k++) worker();
  }

  _paintDayThumb(dc) {
    const el = dc.querySelector(".dthumb");
    if (!el) return;
    const prep = this._dayPrep[dc.dataset.day];
    const pts = prep ? this._flatPrep(prep) : [];
    let box = el.querySelector(".tiles");
    let svg = el.querySelector("svg");
    if (!box) {
      box = document.createElement("div");
      box.className = "tiles";
      svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      svg.setAttribute("class", "dttraj");
      svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
      svg.setAttribute("width", String(DAY_THUMB_W));
      svg.setAttribute("height", String(DAY_THUMB_H));
      svg.setAttribute("viewBox", "0 0 " + DAY_THUMB_W + " " + DAY_THUMB_H);
      el.appendChild(box);
      el.appendChild(svg);
    }
    box.innerHTML = "";
    svg.innerHTML = "";
    el.classList.toggle("dark", this._effMapStyle() === "dark");
    if (pts.length < 2) {
      el.classList.add("empty");
      const ph = document.createElement("span");
      ph.className = "ph";
      ph.textContent = "当天无轨迹";
      el.appendChild(ph);
      return;
    }
    el.classList.remove("empty");
    const geom = this._geom(pts, DAY_THUMB_W, DAY_THUMB_H);
    if (!geom) return;
    this._thumbTiles(el, geom, DAY_THUMB_W, DAY_THUMB_H);
    const mapPt = this._mapper(geom, DAY_THUMB_W, DAY_THUMB_H);
    const SVG = "http://www.w3.org/2000/svg";
    const defs = document.createElementNS(SVG, "defs");
    svg.appendChild(defs);
    for (const run of prep.runs) {
      if (run.length < 2) continue;
      const hasSpeed = !!this._heatmap && run.some((p) => p.length >= 3 && p[2] != null);
      if (hasSpeed) {
        svg.appendChild(this._polyHeatmap(run, mapPt, 2, defs, this._flow));
      } else {
        svg.appendChild(this._poly(run, mapPt, "#e53935", 2, false));
        if (this._flow) svg.appendChild(this._polyFlow(run, mapPt, 2));
      }
    }
    for (const br of prep.breaks) svg.appendChild(this._poly(br, mapPt, "#e53935", 1.5, true));
  }

  _flatPrep(prep) {
    const out = [];
    if (!prep) return out;
    for (const run of prep.runs) for (const p of run) out.push(p);
    for (const br of prep.breaks) { out.push(br[0]); out.push(br[1]); }
    return out;
  }

  /**
   * 取景: 让这些点在 w×h 的框里尽量撑满。
   * 返回 {z, k, cx, cy}(cx/cy 已经是该 zoom 下的世界像素中心), 点 < 2 个返回 null。
   */
  _geom(pts, w, h) {
    if (!pts || pts.length < 2 || !w || !h) return null;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const xy = project(p[0], p[1], 0);
      if (xy[0] < minX) minX = xy[0];
      if (xy[0] > maxX) maxX = xy[0];
      if (xy[1] < minY) minY = xy[1];
      if (xy[1] > maxY) maxY = xy[1];
    }
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    // fit = 1 个 zoom0 世界像素该缩成多少 CSS px; 0.86 是四周留的边距
    const fit = Math.min((w * 0.86) / spanX, (h * 0.86) / spanY);
    const z = clamp(Math.floor(Math.log2(fit)), 3, 18);
    const s = Math.pow(2, z);
    // 注意 k 要除以 s: 直接拿 w/(spanX*s) 会把边距吃掉, 轨迹会贴到框边上
    const k = fit / s;
    return { z: z, k: k, cx: ((minX + maxX) / 2) * s, cy: ((minY + maxY) / 2) * s };
  }

  _mapper(geom, w, h) {
    const z = geom.z;
    return (p) => {
      const xy = project(p[0], p[1], z);
      // 注意: x/y 必须各自先算完再拼字符串, 直接写成 `x + "," + y + h / 2`
      // 会被 JS 的 + 优先级变成字符串拼接(数字后面接 "36"), 点全飞到框外去。
      const sx = ((xy[0] - geom.cx) * geom.k + w / 2).toFixed(1);
      const sy = ((xy[1] - geom.cy) * geom.k + h / 2).toFixed(1);
      return sx + "," + sy;
    };
  }

  /** 缩略图底图: 一般 1~2 张瓦片就够, 全挂了就退回纯色底(轨迹线照画)。 */
  _thumbTiles(el, geom, w, h) {
    const box = el.querySelector(".tiles");
    if (!box) return;
    const left = geom.cx - w / (2 * geom.k);
    const top = geom.cy - h / (2 * geom.k);
    const vw = w / geom.k;
    const vh = h / geom.k;
    const z = geom.z;
    const k = geom.k;                   // 轨迹的缩放: 1 个 zoom-z 世界像素 = k 个 CSS 像素
    const x0 = Math.floor(left / TILE);
    const y0 = Math.floor(top / TILE);
    const x1 = Math.floor((left + vw) / TILE);
    const y1 = Math.floor((top + vh) / TILE);
    const max = Math.pow(2, z);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        const wx = ((x % max) + max) % max;
        const img = document.createElement("img");
        img.decoding = "async";
        // ★ 瓦片必须按 k 缩放: 轨迹折线是按 k = fit/2^z 缩放的(为撑满画布), 而整数 zoom
        //   的瓦片天然是"1 世界像素 = 1 CSS 像素" —— 不乘 k, 两者就不同尺度, 表现为
        //   "缩略图的轨迹和大图不一样、不贴路"(实测 k 可达 1.6, 即偏 60%)。
        const size = TILE * k;
        img.style.width = size + "px";
        img.style.height = size + "px";
        img.style.left = ((x * TILE - left) * k) + "px";
        img.style.top = ((y * TILE - top) * k) + "px";
        img.src = this._tileUrl(z, wx, y, false);
        img.addEventListener("error", () => {
          if (!img.dataset.retried) {
            // 高德连不上(海外网络)时回落 OSM
            img.dataset.retried = "1";
            img.src = this._tileUrl(z, wx, y, true);
          } else {
            img.remove();       // 两边都不行 → 留浅灰底, 轨迹线还在
          }
        });
        box.appendChild(img);
      }
    }
  }

  // ── 详情视图 ──
  _renderDetailInfo() {
    if (!this._dinfoEl) return;
    const t = this._selTrip;
    if (!t) {
      this._dinfoEl.innerHTML = '<div class="pempty">没有选中行程</div>';
      return;
    }
    const sameDay = dayKey(t.started_at) === dayKey(t.ended_at || t.started_at);
    const when = sameDay
      ? fmtStamp(t.started_at) + " - " + fmtTime(t.ended_at)
      : fmtStamp(t.started_at) + " - " + fmtStamp(t.ended_at);
    const sc = fmtCoord(t.start_lat, t.start_lon);
    const ec = fmtCoord(t.end_lat, t.end_lon);
    const bad = [];
    if (t.reconstructed) bad.push("补记");
    if (t.approx_time) bad.push("≈ 时间");
    if (t.frozen) bad.push("失联");
    const cells = [
      ["里程", fmtKm(t.distance_km), "km"],
      ["耗时", (t.approx_time && t.duration_min != null ? "≈ " : "") + fmtDurShort(t.duration_min), ""],
      ["耗电", fmtKwh(t.energy_kwh), "kWh"],
      ["百公里能耗", t.efficiency == null ? "—" : fmtNum(t.efficiency, 1), "kWh/100km"],
      ["平均速度", fmtNum(t.avg_speed_kmh, 1), "km/h"],
      ["轨迹点", t.point_count ? String(t.point_count) : "—", t.point_count ? "个" : ""],
    ];
    const legHtml = (kind, coord, when2, label) =>
      '<div class="leg ' + kind + '"><span class="dot"></span><span class="lwrap">' +
      '<span class="lt">' + label + "</span>" +
      '<span class="lc">' + (coord || "坐标未知") + "</span>" +
      '<span class="lc">' + when2 + "</span></span></div>";
    this._dinfoEl.innerHTML =
      '<div class="dwhen">' + when +
      (bad.length ? '<span class="dbad">' + bad.join(" · ") + "</span>" : "") + "</div>" +
      '<div class="legs">' +
      legHtml("start", sc, "出发 · " + fmtTime(t.started_at), "起点") +
      legHtml("end", ec, "到达 · " + fmtTime(t.ended_at), "终点") +
      "</div>" +
      '<div class="ddiv"></div>' +
      '<div class="dgrid">' +
      cells.map((c) => '<div class="dcell"><span class="k">' + c[0] + "</span><span class=\"v\">" +
        c[1] + (c[2] ? "<i>" + c[2] + "</i>" : "") + "</span></div>").join("") +
      "</div>" +
      (t.reconstructed ? '<div class="dnote">补记: 这段没有轨迹, 里程/耗电来自总里程与电量跳变。</div>' : "");
    this._ddelEl.dataset.id = String(t.id);
  }

  _renderLegend() {
    if (!this._legendEl) return;
    if (!this._overlayTracks.length) {
      this._legendEl.classList.remove("on");
      this._legendEl.innerHTML = "";
      return;
    }
    this._legendEl.classList.add("on");
    this._legendEl.innerHTML = this._overlayTracks
      .map((t) =>
        '<span class="lg" data-id="' + String(t.id) + '"><i style="background:' + t.color +
        '"></i>' + t.label + "</span>")
      .join("");
  }

  // ── 地图(详情大图) ──
  _renderMap() {
    if (!this._mapEl) return;
    if (this._view !== "detail" || this._detailView.hidden) return;
    if (this._needFit && this._fit(this._allPts())) this._needFit = false;
    this._renderTiles();
    this._renderLines();
    this._renderMarks();
    this._renderMapHint();
  }

  _allPts() {
    const out = [];
    const push = (prep) => {
      if (!prep) return;
      for (const run of prep.runs) for (const p of run) out.push(p);
      for (const br of prep.breaks) out.push(br[0], br[1]);
    };
    if (this._overlayTracks) for (const t of this._overlayTracks) push(t);
    push(this._sel);
    // 没有轨迹点(补记)时, 至少把起终点纳入取景范围
    if (!out.length && this._selTrip) {
      const s = this._point(this._selTrip.start_lat, this._selTrip.start_lon);
      const e = this._point(this._selTrip.end_lat, this._selTrip.end_lon);
      if (s) out.push(s);
      if (e) out.push(e);
    }
    return out;
  }

  /** WGS-84 坐标 → 显示坐标(无效返回 null)。 */
  _point(lat, lon) {
    const la = Number(lat);
    const lo = Number(lon);
    if (lat == null || lon == null || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (la === 0 && lo === 0) return null;
    return wgs84ToGcj02(la, lo);
  }

  /** 把视野缩放到刚好装下这些点(显示坐标)。装不下/没布局好时返回 false 等下次重试。 */
  _fit(pts) {
    if (!pts || !pts.length || !this._mapEl) return false;
    const rect = this._mapEl.getBoundingClientRect();
    const w = rect.width || this._mapEl.clientWidth;
    const h = rect.height || this._mapEl.clientHeight;
    if (!w || !h) return false;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of pts) {
      const xy = project(p[0], p[1], 0);
      if (xy[0] < minX) minX = xy[0];
      if (xy[0] > maxX) maxX = xy[0];
      if (xy[1] < minY) minY = xy[1];
      if (xy[1] > maxY) maxY = xy[1];
    }
    const pad = 36;
    const spanX = Math.max(maxX - minX, 1e-9);
    const spanY = Math.max(maxY - minY, 1e-9);
    const zx = Math.log2((w - pad) / spanX);
    const zy = Math.log2((h - pad) / spanY);
    this._zoom = clamp(Math.floor(Math.min(zx, zy)), 3, 18);
    this._center = unproject((minX + maxX) / 2, (minY + maxY) / 2, 0);
    return true;
  }

  _tileUrl(z, x, y, fallback) {
    const conf = this._config;
    // 深色底图 = 路网瓦片 + CSS 滤镜(见 _applyMapStyle), 瓦片源仍是 vector
    const style = this._effMapStyle();
    const src = style === "satellite" ? TILE_SOURCES.satellite : TILE_SOURCES.vector;
    let tpl = conf.tiles || src;
    if (fallback) tpl = TILE_FALLBACK;
    const s = ((x + y) % 4) + 1;
    return tpl
      .replace("{s}", String(s))
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  _renderTiles() {
    if (!this._tilesEl || !this._mapEl || !this._center) return;
    const rect = this._mapEl.getBoundingClientRect();
    const w = rect.width || this._mapEl.clientWidth || 400;
    const h = rect.height || this._mapEl.clientHeight || this._config.height;
    const z = this._zoom;
    const [cx, cy] = project(this._center[0], this._center[1], z);
    const left = cx - w / 2;
    const top = cy - h / 2;
    const x0 = Math.floor(left / TILE);
    const y0 = Math.floor(top / TILE);
    const x1 = Math.floor((left + w) / TILE);
    const y1 = Math.floor((top + h) / TILE);
    const max = Math.pow(2, z);
    const needed = new Set();

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        const wx = ((x % max) + max) % max;      // 经度方向绕回
        const key = z + "/" + x + "/" + y;
        needed.add(key);
        if (!this._tiles.has(key)) {
          const img = document.createElement("img");
          img.decoding = "async";
          img.src = this._tileUrl(z, wx, y, false);
          img.addEventListener("error", () => {
            // 高德连不上(海外网络)时回落 OSM, 至少还能看图
            if (!img.dataset.retried) {
              img.dataset.retried = "1";
              img.src = this._tileUrl(z, wx, y, true);
            }
          });
          this._tiles.set(key, img);
          this._tilesEl.appendChild(img);
        }
        const img = this._tiles.get(key);
        img.style.left = (x * TILE - left) + "px";
        img.style.top = (y * TILE - top) + "px";
      }
    }
    // 回收滚出视野的瓦片, 避免长时间拖动后 DOM 堆积
    this._tiles.forEach((img, key) => {
      if (!needed.has(key)) {
        img.remove();
        this._tiles.delete(key);
      }
    });
  }

  _screenMapper() {
    const rect = this._mapEl.getBoundingClientRect();
    const w = rect.width || this._mapEl.clientWidth || 400;
    const h = rect.height || this._mapEl.clientHeight || this._config.height;
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const fx = w / 2;
    const fy = h / 2;
    return (p) => {
      const xy = project(p[0], p[1], this._zoom);
      return (xy[0] - cx + fx).toFixed(1) + "," + (xy[1] - cy + fy).toFixed(1);
    };
  }

  _poly(pts, mapPt, color, width, dash) {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    const parts = [];
    for (const p of pts) parts.push(mapPt(p));
    el.setAttribute("points", parts.join(" "));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", color);
    el.setAttribute("stroke-width", String(width));
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("stroke-linecap", "round");
    if (dash) el.setAttribute("stroke-dasharray", "6 5");
    return el;
  }

  /** 流动光效折线: 白色虚线, 靠 CSS 的 stroke-dashoffset 动画顺着方向流动(硬件加速)。
      独立于速度热力图 —— 不叠热力图时也能单独开光效。 */
  _polyFlow(pts, mapPt, width) {
    const SVG = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(SVG, "polyline");
    const parts = [];
    for (const p of pts) parts.push(mapPt(p));
    el.setAttribute("points", parts.join(" "));
    el.setAttribute("fill", "none");
    el.setAttribute("stroke", "rgba(255,255,255,.8)");
    el.setAttribute("stroke-width", String(Math.max(1, width * 0.55)));
    el.setAttribute("stroke-linejoin", "round");
    el.setAttribute("stroke-linecap", "round");
    el.setAttribute("class", "flow-line");
    return el;
  }

  /** 逐段折线(带可选速度渐变 + 流动光效)。mapPt 返回 "x,y" 或 [x,y]; flow 由调用方传入,
      这样缩略图/详情可以各用各的开关(不再隐式读 this._flow)。 */
  _polyHeatmap(run, mapPt, width, defsEl, flow) {
    const SVG = "http://www.w3.org/2000/svg";
    const group = document.createElementNS(SVG, "g");
    const pt = (p) => {
      const xy = mapPt(p);
      return Array.isArray(xy) ? xy : String(xy).split(",");
    };
    for (let i = 0; i < run.length - 1; i++) {
      const p1 = run[i];
      const p2 = run[i + 1];
      const a = pt(p1);
      const b = pt(p2);
      const gradId = "spd-" + Math.random().toString(36).slice(2, 11);
      const grad = document.createElementNS(SVG, "linearGradient");
      grad.setAttribute("id", gradId);
      grad.setAttribute("gradientUnits", "userSpaceOnUse");
      grad.setAttribute("x1", a[0]); grad.setAttribute("y1", a[1]);
      grad.setAttribute("x2", b[0]); grad.setAttribute("y2", b[1]);
      const s1 = document.createElementNS(SVG, "stop");
      s1.setAttribute("offset", "0%");
      s1.setAttribute("stop-color", getSpeedColor(p1[2]));
      const s2 = document.createElementNS(SVG, "stop");
      s2.setAttribute("offset", "100%");
      s2.setAttribute("stop-color", getSpeedColor(p2[2]));
      grad.appendChild(s1); grad.appendChild(s2);
      defsEl.appendChild(grad);

      const line = document.createElementNS(SVG, "line");
      line.setAttribute("x1", a[0]); line.setAttribute("y1", a[1]);
      line.setAttribute("x2", b[0]); line.setAttribute("y2", b[1]);
      line.setAttribute("stroke", `url(#${gradId})`);
      line.setAttribute("stroke-width", String(width));
      line.setAttribute("stroke-linecap", "round");
      group.appendChild(line);

      if (flow) {
        const flowEl = document.createElementNS(SVG, "line");
        flowEl.setAttribute("x1", a[0]); flowEl.setAttribute("y1", a[1]);
        flowEl.setAttribute("x2", b[0]); flowEl.setAttribute("y2", b[1]);
        flowEl.setAttribute("stroke", "rgba(255,255,255,.75)");
        flowEl.setAttribute("stroke-width", String(width * 0.6));
        flowEl.setAttribute("stroke-linecap", "round");
        flowEl.setAttribute("class", "flow-line");
        group.appendChild(flowEl);
      }
    }
    return group;
  }

  _renderLines() {
    if (!this._trajEl || !this._mapEl || !this._center) return;
    const SVG = "http://www.w3.org/2000/svg";
    const mapPt = this._screenMapper();
    const frag = document.createDocumentFragment();
    const defsEl = document.createElementNS(SVG, "defs");
    frag.appendChild(defsEl);
    // 先画叠加的(细、半透明), 再把选中的那段压在上面(粗、醒目)
    for (const t of this._overlayTracks) {
      const draw = (runs, color, width, dash) => {
        for (const run of runs) {
          if (run.length < 2) continue;
          frag.appendChild(this._poly(run, mapPt, color, width, dash));
        }
      };
      draw(t.runs, t.color, 2.5, false);
      draw(t.breaks, t.color, 2, true);
    }
    if (this._sel) {
      for (const run of this._sel.runs) {
        if (run.length < 2) continue;
        // 热力图只在"开了且这点列真的带 speed"时用; 否则单色红。
        const hasSpeed = !!this._heatmap && run.some((p) => p.length >= 3 && p[2] != null);
        if (hasSpeed) {
          frag.appendChild(this._polyHeatmap(run, mapPt, 3.5, defsEl, this._flow));
        } else {
          frag.appendChild(this._poly(run, mapPt, "#e53935", 3.5, false));
          if (this._flow) frag.appendChild(this._polyFlow(run, mapPt, 3.5));
        }
      }
      for (const br of this._sel.breaks) {
        frag.appendChild(this._poly(br, mapPt, "#e53935", 2.5, true));
      }
    }
    this._trajEl.innerHTML = "";
    this._trajEl.appendChild(frag);
  }

  _renderMarks() {
    if (!this._marksEl || !this._mapEl || !this._center) return;
    const mapPt = this._screenMapper();
    const rect = this._mapEl.getBoundingClientRect();
    const w = rect.width || this._mapEl.clientWidth || 400;
    const h = rect.height || this._mapEl.clientHeight || this._config.height;
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const place = (pt) => {
      const xy = project(pt[0], pt[1], this._zoom);
      return "left:" + (xy[0] - cx + w / 2) + "px;top:" + (xy[1] - cy + h / 2) + "px";
    };
    let start = null;
    let end = null;
    if (this._sel) {
      const runs = this._sel.runs.filter((r) => r.length);
      if (runs.length) {
        start = runs[0][0];
        const lastRun = runs[runs.length - 1];
        end = lastRun[lastRun.length - 1];
      }
    }
    if (!start && this._selTrip) start = this._point(this._selTrip.start_lat, this._selTrip.start_lon);
    if (!end && this._selTrip) end = this._point(this._selTrip.end_lat, this._selTrip.end_lon);
    let html = "";
    if (start) html += '<div class="mk start" style="' + place(start) + '">起</div>';
    if (end) html += '<div class="mk end" style="' + place(end) + '">终</div>';
    this._marksEl.innerHTML = html;
  }

  _renderMapHint() {
    if (!this._mhintEl) return;
    let text = "";
    if (this._err) {
      text = "";
    } else if (!this._trips.length) {
      text = this._loading || !this._loaded ? "读取中…" : "还没有行程记录";
    } else if (!this._selectedId) {
      text = "回列表选一段行程";
    } else if (this._selTrip && !this._selTrip.point_count) {
      text = this._selTrip.reconstructed ? "这段没有轨迹(靠里程跳变补记)" : "这段没有轨迹";
    } else if (this._selTrip && !this._sel) {
      text = "轨迹点太少, 画不出路线";
    } else if (this._selTrip && !this._sel.runs.length) {
      text = "轨迹点太少, 画不出路线";
    }
    this._mhintEl.textContent = text;
    this._mhintEl.style.display = text ? "block" : "none";
  }

  // ── 交互 ──
  /** 删除按钮的两态: 平时垃圾桶, 确认态打勾。 */
  _delIcon(btn, armed) {
    if (armed) {
      btn.innerHTML = '<ha-icon icon="mdi:check"></ha-icon>';
      btn.title = "再点一次确认删除";
    } else {
      btn.innerHTML = '<ha-icon icon="mdi:trash-can-outline"></ha-icon>';
      btn.title = "删除这段行程";
    }
  }

  /** 导出当前选中行程: fmt ∈ {csv, xml, json}。轨迹点走缓存(没有则现拉)。 */
  async _exportTrip(fmt) {
    const id = this._selectedId;
    const t = this._find(id);
    if (!t) return;
    let pts = [];
    try {
      pts = (t.point_count > 0) ? await this._ensureTrack(id) : [];
    } catch (err) {
      pts = [];
    }
    const stamp = fmtStamp(t.started_at).replace(/[^0-9]/g, "") || "trip";
    const base = "leapmotor-trip-" + String(id) + "-" + stamp;
    let text = "";
    let mime = "text/plain";
    let ext = fmt;
    if (fmt === "csv") {
      mime = "text/csv;charset=utf-8";
      text = this._tripCsv(t, pts);
    } else if (fmt === "xml") {
      mime = "application/xml;charset=utf-8";
      text = this._tripXml(t, pts);
    } else {
      fmt = "json";
      ext = "json";
      mime = "application/json;charset=utf-8";
      text = this._tripJson(t, pts);
    }
    try {
      const blob = new Blob(["\ufeff" + text], { type: mime });   // BOM: Excel 打开 CSV 不乱码
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = base + "." + ext;      // 文件名不进 DOM, 不会被 Shadow DOM 影响
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (err) {
      // 兜底: 下载被拦时, 退回"复制到剪贴板"(仍可用)
      try { await navigator.clipboard.writeText(text); } catch (e) { /* ignore */ }
    }
  }

  _tripCsv(t, pts) {
    const head = ["trip_id", "started_at", "ended_at", "distance_km", "duration_min",
                  "energy_kwh", "efficiency_kwh_100km", "avg_speed_kmh",
                  "start_soc", "end_soc", "point_index", "latitude_wgs84",
                  "longitude_wgs84", "speed_kmh"];
    const rows = [head.join(",")];
    const c = (v) => (v == null ? "" : String(v));
    const iso = (ts) => {
      const n = Number(ts);
      return n ? new Date(n * 1000).toISOString() : "";
    };
    const sd = iso(t.started_at);
    const ed = iso(t.ended_at);
    if (!pts.length) {
      rows.push([t.id, sd, ed, c(t.distance_km), c(t.duration_min), c(t.energy_kwh),
                 c(t.efficiency), c(t.avg_speed_kmh), c(t.start_soc), c(t.end_soc),
                 "", "", "", ""].join(","));
    } else {
      pts.forEach((p, i) => {
        rows.push([t.id, sd, ed, c(t.distance_km), c(t.duration_min), c(t.energy_kwh),
                   c(t.efficiency), c(t.avg_speed_kmh), c(t.start_soc), c(t.end_soc),
                   i, p[0], p[1], p.length >= 3 ? p[2] : ""].join(","));
      });
    }
    return rows.join("\n");
  }

  _tripXml(t, pts) {
    const esc = (s) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const iso = (ts) => { const n = Number(ts); return n ? new Date(n * 1000).toISOString() : ""; };
    const attrs = [
      ["id", t.id], ["started_at", iso(t.started_at)], ["ended_at", iso(t.ended_at)],
      ["distance_km", t.distance_km], ["duration_min", t.duration_min],
      ["energy_kwh", t.energy_kwh], ["efficiency_kwh_100km", t.efficiency],
      ["avg_speed_kmh", t.avg_speed_kmh], ["start_soc", t.start_soc],
      ["end_soc", t.end_soc], ["reconstructed", t.reconstructed], ["frozen", t.frozen],
    ].filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => ` ${k}="${esc(v)}"`).join("");
    const pt = pts.map((p) => `    <point lat="${esc(p[0])}" lon="${esc(p[1])}"` +
      (p.length >= 3 ? ` speed="${esc(p[2])}"` : "") + " />").join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<leapmotor-trip xmlns="https://github.com/MiRaToo/ha-leapmotor-cn" ` +
      `coordinate_system="WGS-84"${attrs}>\n` +
      `  <track point_count="${pts.length}">\n${pt}\n  </track>\n</leapmotor-trip>\n`;
  }

  _tripJson(t, pts) {
    const obj = {
      format: "leapmotor-trip",
      coordinate_system: "WGS-84",
      generated_at: new Date().toISOString(),
      trip: {
        id: t.id, started_at: t.started_at, ended_at: t.ended_at,
        distance_km: t.distance_km, duration_min: t.duration_min,
        energy_kwh: t.energy_kwh, efficiency_kwh_100km: t.efficiency,
        avg_speed_kmh: t.avg_speed_kmh, start_soc: t.start_soc, end_soc: t.end_soc,
        reconstructed: !!t.reconstructed, frozen: !!t.frozen,
      },
      points: pts.map((p) => (p.length >= 3
        ? { lat: p[0], lon: p[1], speed: p[2] } : { lat: p[0], lon: p[1] })),
    };
    return JSON.stringify(obj, null, 2);
  }

  async _deleteTrip(id, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      this._delIcon(btn, true);
      setTimeout(() => {                        // 3 秒内没确认就复位, 防止误触
        if (btn.dataset.armed && btn.isConnected) {
          delete btn.dataset.armed;
          btn.classList.remove("armed");
          this._delIcon(btn, false);
        }
      }, 3000);
      return;
    }
    if (!this._hass || !this._hass.callWS) return;
    if (this._hass.user && !this._hass.user.is_admin) {
      this._err = "需要管理员权限才能删除行程";
      this._render();
      return;
    }
    btn.disabled = true;
    btn.innerHTML = "";
    try {
      await this._hass.callWS({ type: "leapmotor/trips/delete", trip_id: id });
      delete this._trackCache[id];
      delete this._thumbCache[id];
      delete this._thumbPrep[id];
      if (String(this._selectedId) === String(id)) {
        this._selectedId = "";
        this._selTrip = null;
        this._sel = null;
        this._view = "list";
      }
      await this._load();
    } catch (err) {
      btn.disabled = false;
      delete btn.dataset.armed;
      btn.classList.remove("armed");
      this._delIcon(btn, false);
      this._err = "删除失败: " + this._errText(err);
      this._render();
    }
  }

  _onMapButton(action) {
    if (!this._center) return;
    const rect = this._mapEl.getBoundingClientRect();
    const cxp = rect.left + rect.width / 2;
    const cyp = rect.top + rect.height / 2;
    if (action === "fit") {
      if (this._fit(this._allPts())) {
        this._renderMap();
      }
    } else if (action === "in" || action === "out") {
      this._zoomAt(cxp, cyp, action === "in" ? 1 : -1);
    }
  }

  _zoomAt(clientX, clientY, delta) {
    if (!this._center) return;
    const z0 = this._zoom;
    const z1 = clamp(z0 + delta, 3, 18);
    if (z1 === z0) return;
    const rect = this._mapEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const cx = rect.width / 2;
    const cy = rect.height / 2;
    const c0 = project(this._center[0], this._center[1], z0);
    const [lat, lon] = unproject(c0[0] + px - cx, c0[1] + py - cy, z0);
    const c1 = project(lat, lon, z1);
    this._zoom = z1;
    this._center = unproject(c1[0] - px + cx, c1[1] - py + cy, z1);
    this._needFit = false;
    this._renderMap();
  }

  // ── 构建 ──
  _build() {
    const h = this._config.height;
    const listH = this._config.list_height;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          color: var(--primary-text-color, #212121);
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 10px 12px 12px; box-sizing: border-box;
          font-size: 13px;
        }
        /* 行程卡/信息卡的底色 —— HA 深浅色主题下都靠这几个变量自适应 */
        .sheet {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        }
        .sub { color: var(--secondary-text-color, #6b7280); }

        .head { display: flex; align-items: center; gap: 8px; }
        .head .title { font-weight: 600; font-size: 14px; white-space: nowrap; flex: 0 0 auto; }
        .head .sum {
          flex: 0 1 auto; min-width: 0; font-size: 12px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .head .spacer { flex: 1; }
        /* 小按钮统一长相: 白底(卡片同款) + 灰边 + 与外框同款轻阴影; hover 淡蓝 */
        button {
          font: inherit; font-size: 12px; color: inherit; cursor: pointer;
          border-radius: 8px; border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          background: var(--ha-card-background, var(--card-background-color, #fff));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
          transition: background .15s ease;
        }
        button:not([disabled]):hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        /* 刷新按钮: 圆形白底 + 与外框同款轻阴影 —— 与「零跑·车辆控制」顶部那颗同一套写法 */
        .head button.refresh,
        .head button.collapseAll {
          width: 27px; height: 27px; padding: 0; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280);
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
          transition: background .15s ease;
        }
        .head button.refresh:not([disabled]):hover,
        .head button.collapseAll:hover {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
        }
        .head button.refresh.spin { opacity: .45; }
        .head button.refresh ha-icon,
        .head button.collapseAll ha-icon { width: 16px; height: 16px; --mdc-icon-size: 16px; }
        ha-icon { display: inline-flex; width: 16px; height: 16px; --mdc-icon-size: 16px; }

        .active {
          display: none; align-items: center; gap: 6px; margin-top: 6px; padding: 4px 8px;
          font-size: 12px; border-radius: 8px;
          background: rgba(3,169,244,.12); border: 1px solid rgba(3,169,244,.35);
        }
        .active.on { display: flex; }
        .active .dot { width: 8px; height: 8px; border-radius: 50%; background: #03a9f4; animation: lpulse 1.4s infinite; }
        @keyframes lpulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

        .view[hidden] { display: none !important; }

        /* ── 列表视图 ── */
        .list { max-height: ${listH}px; overflow: auto; margin: 0 -4px; padding: 0 4px; }
        .grp {
          position: sticky; top: 0; z-index: 2; display: flex; align-items: baseline; gap: 6px;
          padding: 9px 2px 5px;
          background: var(--ha-card-background, var(--card-background-color, #fff));
        }
        .grp .dn { font-weight: 600; font-size: 14px; }
        .grp .dc { font-size: 11px; }
        .grp .dk { margin-left: auto; font-weight: 600; font-size: 14px; }

        /* 每日卡片: 包住当天的各段行程; 头部可点收起/展开 */
        .daycard {
          margin: 0 0 10px; border-radius: 16px; overflow: hidden;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .1);
        }
        /* 收起态: 缩略图在左, 数据(日期/段数 + 汇总)在右 */
        .daytop {
          display: flex; align-items: center; gap: 10px;
          padding: 8px 10px; cursor: pointer; user-select: none;
        }
        .dayinfo { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
        .dayhead {
          display: flex; align-items: center; gap: 8px;
        }
        /* 日期与"N 段 · M km"排在同一行(基线对齐) */
        .dayhead .dn { font-weight: 600; font-size: 15px; white-space: nowrap; }
        .dayhead .dmeta {
          flex: 1 1 auto; min-width: 0; font-size: 12px; color: var(--secondary-text-color, #6b7280);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dayhead .chev {
          flex: 0 0 auto; transition: transform .18s ease; color: var(--secondary-text-color, #6b7280);
        }
        .daycard.collapsed .chev { transform: rotate(-90deg); }
        /* 展开=看当天各段明细: 隐藏缩略图与汇总; 收起=看当天概览: 缩略图在左、汇总在右 */
        .daycard:not(.collapsed) .dthumb { display: none; }
        .daycard:not(.collapsed) .daysum { display: none; }
        .daycard.collapsed .dayrows { display: none; }
        .daycard .daysum { margin-top: 0; }   /* 压过 .mets 的 margin-top:auto */
        /* 当天叠加缩略图: 比单段缩略图稍大 */
        .dthumb {
          position: relative; flex: 0 0 auto; width: ${DAY_THUMB_W}px; height: ${DAY_THUMB_H}px;
          border-radius: 10px; overflow: hidden; background: #111418;
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(255, 255, 255, .08));
        }
        .dthumb .tiles { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
        .dthumb.dark .tiles { filter: invert(100%) hue-rotate(180deg) brightness(85%) contrast(90%); }
        .dthumb .tiles img { position: absolute; width: ${TILE}px; height: ${TILE}px; -webkit-user-drag: none; }
        .dthumb svg { position: absolute; left: 0; top: 0; }
        .dthumb .ph {
          position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
          text-align: center; font-size: 10px; color: #cfd6dc;
        }
        .dayrows { padding: 8px 8px 0; }
        .row {
          position: relative;                     /* 徽标要压在缩略图上, 得有个定位父级 */
          display: flex; gap: 10px; padding: 9px; margin: 0 0 8px;
          border-radius: 14px; cursor: pointer;
          background: var(--ha-card-background, var(--card-background-color, #fff));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        }
        .row:hover { box-shadow: 0 2px 8px rgba(0, 0, 0, .2); }
        .row.sel { border-color: var(--primary-color, #03a9f4); box-shadow: 0 0 0 1px var(--primary-color, #03a9f4); }

        /* 缩略图: 固定尺寸的小地图 + 红色轨迹 */
        .thumb {
          position: relative; flex: 0 0 auto; width: ${THUMB_W}px; height: ${THUMB_H}px;
          border-radius: 10px; overflow: hidden;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0, 0, 0, .08));
        }
        .thumb .tiles { position: absolute; left: 0; top: 0; width: 100%; height: 100%; }
        /* 缩略图也跟随底图样式: 深色 = 瓦片整体反相(与详情大图一致) */
        .thumb.dark .tiles { filter: invert(100%) hue-rotate(180deg) brightness(85%) contrast(90%); }
        .thumb .tiles img { position: absolute; width: ${TILE}px; height: ${TILE}px; -webkit-user-drag: none; }
        /* 缩略图里的流动光效(比大图更细、更淡, 免得小图糊成一团) */
        .thumb .flow-line { stroke-dasharray: 4 10; animation: dash-flow 1.2s linear infinite; }
        .thumb svg { position: absolute; left: 0; top: 0; }
        .thumb .ph {
          position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%);
          text-align: center; font-size: 9px; line-height: 1.3;
        }

        .rbody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 5px; }
        .rtop { display: flex; align-items: center; gap: 6px; }
        .rkm { font-size: 26px; font-weight: 600; line-height: 1.05; letter-spacing: -.5px; white-space: nowrap; }
        .rkm i, .met .v i, .dcell .v i {
          font-style: normal; font-size: 11px; font-weight: 500; margin-left: 2px;
          color: var(--secondary-text-color, #6b7280);
        }
        .rtm {
          margin-left: auto; font-size: 12px;
          /* 跨天的时间串("10月1日 23:30 - 10月2日 00:11")很长; 窄屏放不下时**换行**,
             而不要用省略号截断(截断后时间就没法看了) */
          white-space: normal; text-align: right; line-height: 1.15;
          color: var(--secondary-text-color, #6b7280);
        }
        /* 补记/失联徽标: 压在缩略图左上角 —— 放行内会把时间段/指标挤没 */
        .thumb .rbadges { position: absolute; left: 4px; top: 4px; z-index: 3; display: flex; gap: 4px; }
        .badge {
          padding: 0 5px; border-radius: 999px; font-size: 9px; line-height: 14px;
          white-space: nowrap; color: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .3);
        }
        .badge.r { background: rgba(245, 158, 11, .95); }
        .badge.f { background: rgba(229, 57, 53, .95); }

        .mets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 6px; margin-top: auto; }
        .met { min-width: 0; }
        .met .k {
          display: block; font-size: 10px; line-height: 1.2;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
          color: var(--secondary-text-color, #6b7280);
        }
        .met .v {
          display: block; font-size: 14px; font-weight: 600; line-height: 1.3;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .met .v i { font-size: 9px; }

        /* 删除按钮保持低调: 不加白底/阴影(全局 button 的长相在这里被刻意去掉), 只是淡淡的图标 */
        .del {
          flex: 0 0 auto; width: 24px; height: 24px; padding: 0;
          display: flex; align-items: center; justify-content: center;
          border-color: transparent; background: transparent; opacity: .45; box-shadow: none;
        }
        .del:hover { opacity: 1; background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .del.armed {
          opacity: 1; color: #fff; border-color: var(--error-color, #db4437);
          background: var(--error-color, #db4437);
        }
        .del[disabled] { opacity: .3; }
        .lmsg { padding: 10px 2px; font-size: 12px; }
        .lmsg.err { color: var(--error-color, #db4437); }

        /* ── 详情视图 ── */
        .dhead { display: flex; align-items: center; gap: 8px; margin-bottom: 8px; }
        .dhead .dtitle { font-weight: 600; font-size: 14px; }
        .dhead .spacer { flex: 1; }
        .back {
          width: 28px; height: 28px; padding: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .back ha-icon { width: 18px; height: 18px; --mdc-icon-size: 18px; }
        .tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; margin-top: 8px; }
        .tools label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .tools select, .tools input[type="number"] {
          padding: 2px 4px; font: inherit; font-size: 12px; color: inherit;
          border: 1px solid var(--divider-color, #d8dde2); border-radius: 6px;
          background: var(--card-background-color, #fff);
        }
        .tools input[type="number"].ovln { width: 52px; }
        /* 导出格式气泡菜单(点导出按钮弹出) */
        .expmenu {
          position: absolute; right: 10px; top: 42px; z-index: 30; display: none;
          flex-direction: column; min-width: 200px; padding: 4px;
          border-radius: 12px; background: var(--card-background-color, #fff);
          border: 1px solid var(--divider-color, #d8dde2);
          box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
        }
        .expmenu.on { display: flex; }
        .expmenu button {
          text-align: left; padding: 9px 12px; border: none; background: transparent;
          box-shadow: none; border-radius: 8px; font-size: 13px; cursor: pointer;
        }
        .expmenu button:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .detailview { position: relative; }
        .tools .spacer { flex: 1; }
        .tools button { width: 30px; height: 26px; }

        .map {
          position: relative; height: ${h}px;
          /* 必须用 clip 而不是 hidden: hidden 仍是可滚动容器, 会让绝对定位的瓦片整体偏移 */
          overflow: clip; border-radius: 12px; background: #dfe6ea;
          cursor: grab; touch-action: none; user-select: none;
        }
        .map.dragging { cursor: grabbing; }
        /* 深色底图: 亮色路网瓦片整体反相 + 色相翻转 → 夜色地图(与官方 App 深色图观感一致) */
        .map.dark { background: #111418; }
        .map.dark .tiles { filter: invert(100%) hue-rotate(180deg) brightness(85%) contrast(90%); }
        .tiles { position: absolute; left: 0; top: 0; z-index: 0; }
        .tiles img { position: absolute; width: ${TILE}px; height: ${TILE}px; -webkit-user-drag: none; }
        .traj { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
        .marks { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 4; pointer-events: none; }
        /* 轨迹流动光效: 白色虚线顺着行驶方向流动(靠 stroke-dashoffset 动画, 硬件加速) */
        @keyframes dash-flow { 0% { stroke-dashoffset: 24; } 100% { stroke-dashoffset: 0; } }
        .flow-line { stroke-dasharray: 8 16; animation: dash-flow 1.2s linear infinite; pointer-events: none; }
        /* 车速热力图图例: 关热力图时**只做视觉隐藏**(visibility), 保留占位 ——
           否则关掉它时下方元素会往上跳一下 */
        .speed-bar {
          display: flex; align-items: center; gap: 8px; margin-top: 8px; font-size: 10px;
          color: var(--secondary-text-color, #6b7280);
        }
        .speed-bar:not(.on) { visibility: hidden; }
        .speed-gradient {
          flex: 1; height: 6px; border-radius: 3px;
          background: linear-gradient(to right, #2196f3, #4caf50, #ffeb3b, #ff9800, #f44336);
        }
        .mk {
          position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; box-sizing: border-box;
          border-radius: 50%; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px;
          text-align: center; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4);
        }
        .mk.start { background: #111; }
        .mk.end { background: #e53935; }
        .mhint {
          position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 6;
          display: none; padding: 3px 9px; border-radius: 999px; font-size: 11px; white-space: nowrap;
          background: rgba(0,0,0,.62); color: #fff;
        }

        .dinfo { margin-top: 10px; padding: 12px 14px; border-radius: 14px; }
        .dwhen { font-size: 17px; font-weight: 600; letter-spacing: .2px; }
        .dwhen .dbad { margin-left: 8px; font-size: 11px; font-weight: 500; color: var(--secondary-text-color, #6b7280); }
        .legs { margin-top: 10px; display: flex; flex-direction: column; gap: 9px; }
        .leg { position: relative; display: flex; align-items: flex-start; gap: 9px; }
        .leg .dot { margin-top: 5px; width: 9px; height: 9px; border-radius: 50%; flex: 0 0 auto; }
        .leg.start .dot { background: #111; }
        .leg.end .dot { background: #e53935; }
        .leg.start::after {
          content: ""; position: absolute; left: 4px; top: 18px; bottom: -11px;
          border-left: 2px dotted var(--divider-color, #b9c0c6);
        }
        .leg .lwrap { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
        .leg .lt { font-weight: 600; font-size: 13px; }
        .leg .lc { font-size: 12px; color: var(--secondary-text-color, #6b7280); }
        .ddiv { height: 1px; margin: 12px 0; background: var(--divider-color, #e0e0e0); }
        .dgrid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 12px 8px; }
        .dcell { min-width: 0; }
        .dcell .k { display: block; font-size: 11px; color: var(--secondary-text-color, #6b7280); }
        .dcell .v {
          display: block; font-size: 19px; font-weight: 600; margin-top: 1px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .dnote { margin-top: 10px; font-size: 11px; color: var(--secondary-text-color, #6b7280); }
        .pempty { opacity: .6; font-size: 12px; padding: 6px 2px; }

        .legend { display: none; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 11px; }
        .legend.on { display: flex; }
        .lg { display: flex; align-items: center; gap: 4px; cursor: pointer; opacity: .85; }
        .lg:hover { opacity: 1; }
        .lg i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; }
      </style>
      <div class="card">
        <div class="head">
          <span class="title">行程</span>
          <span class="sum sub"></span>
          <span class="spacer"></span>
          <button class="collapseAll" title="全部收起 / 展开"><ha-icon icon="mdi:unfold-less-horizontal"></ha-icon></button>
          <button class="refresh" title="刷新行程列表"><ha-icon icon="mdi:refresh"></ha-icon></button>
        </div>
        <div class="active"><span class="dot"></span><span class="atext"></span></div>

        <div class="view listview">
          <div class="list"></div>
          <div class="lmsg"></div>
        </div>

        <div class="view detailview" hidden>
          <div class="dhead">
            <button class="back" title="返回行程列表"><ha-icon icon="mdi:arrow-left"></ha-icon></button>
            <span class="dtitle">行程详情</span>
            <span class="spacer"></span>
            <button class="del dexp" data-act="export" title="导出这段行程(CSV / XML / JSON)">
              <ha-icon icon="mdi:download-outline"></ha-icon>
            </button>
            <button class="del ddel" data-act="del" title="删除这段行程">
              <ha-icon icon="mdi:trash-can-outline"></ha-icon>
            </button>
          </div>
          <div class="expmenu">
            <button data-fmt="csv">CSV(表格 · Excel 可开)</button>
            <button data-fmt="xml">XML(通用交换格式)</button>
            <button data-fmt="json">JSON(结构化 · 含完整轨迹)</button>
          </div>
          <div class="map">
            <div class="tiles"></div>
            <svg class="traj" xmlns="http://www.w3.org/2000/svg"></svg>
            <div class="marks"></div>
            <div class="mhint"></div>
          </div>
          <div class="speed-bar">
            <span>0</span>
            <div class="speed-gradient"></div>
            <span>120+ km/h</span>
          </div>
          <div class="tools">
            <label><input type="checkbox" class="ovlbox">叠加最近</label>
            <input type="number" class="ovln" min="1" max="50" step="1" value="5" title="叠加最近几段(1~50, 手填)">段
            <select class="mstyle" title="底图样式">
              <option value="auto">自动</option>
              <option value="vector">路网</option>
              <option value="satellite">卫星</option>
              <option value="dark">深色</option>
            </select>
            <label><input type="checkbox" class="hmbox">热力图</label>
            <label><input type="checkbox" class="flowbox">光效</label>
            <span class="spacer"></span>
            <button data-m="fit" title="缩放至轨迹">⤢</button>
            <button data-m="in" title="放大">＋</button>
            <button data-m="out" title="缩小">－</button>
          </div>
          <div class="dinfo sheet"></div>
          <div class="legend"></div>
        </div>
      </div>`;

    this._cardEl = this.shadowRoot.querySelector(".card");
    this._sumEl = this.shadowRoot.querySelector(".head .sum");
    this._refreshBtn = this.shadowRoot.querySelector(".head .refresh");
    this._collapseBtn = this.shadowRoot.querySelector(".head .collapseAll");
    this._activeEl = this.shadowRoot.querySelector(".active");
    this._activeText = this.shadowRoot.querySelector(".active .atext");
    this._listView = this.shadowRoot.querySelector(".listview");
    this._detailView = this.shadowRoot.querySelector(".detailview");
    this._listEl = this.shadowRoot.querySelector(".list");
    this._lmsgEl = this.shadowRoot.querySelector(".lmsg");
    this._mapEl = this.shadowRoot.querySelector(".map");
    this._tilesEl = this.shadowRoot.querySelector(".tiles");
    this._trajEl = this.shadowRoot.querySelector(".traj");
    this._marksEl = this.shadowRoot.querySelector(".marks");
    this._mhintEl = this.shadowRoot.querySelector(".mhint");
    this._dinfoEl = this.shadowRoot.querySelector(".dinfo");
    this._ddelEl = this.shadowRoot.querySelector(".ddel");
    this._legendEl = this.shadowRoot.querySelector(".legend");
    this._dexportEl = this.shadowRoot.querySelector(".dexp");
    this._expMenuEl = this.shadowRoot.querySelector(".expmenu");
    this._ovlBox = this.shadowRoot.querySelector(".ovlbox");
    this._ovlN = this.shadowRoot.querySelector(".ovln");
    this._mstyleSel = this.shadowRoot.querySelector(".mstyle");
    this._hmBox = this.shadowRoot.querySelector(".hmbox");
    this._flowBox = this.shadowRoot.querySelector(".flowbox");
    this._speedBar = this.shadowRoot.querySelector(".speed-bar");

    this._refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._load();
    });
    this._collapseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._toggleAllDays();
    });
    this.shadowRoot.querySelector(".back").addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._backToList();
    });
    this._dexportEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._expMenuEl.classList.toggle("on");
    });
    this._expMenuEl.querySelectorAll("button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._expMenuEl.classList.remove("on");
        this._exportTrip(b.dataset.fmt);
      });
    });
    this._ovlBox.addEventListener("change", () => this._toggleOverlay(this._ovlBox.checked));
    this._ovlN.addEventListener("change", () => {
      if (this._ovlBox.checked) this._toggleOverlay(true);
    });
    this._mstyleSel.addEventListener("change", () => {
      this._mapStyle = this._normMapStyle(this._mstyleSel.value);
      // ★ 必须丢掉已缓存的瓦片节点: `_tiles` 按 "z/x/y" 缓存 <img>, 坐标键不含样式 ——
      //   不丢的话换到卫星/深色时仍显示旧的矢量瓦片, 表现为"切了没反应"。
      this._tiles.forEach((img) => img.remove());
      this._tiles.clear();
      this._applyMapStyle();
      this._renderMap();
      this._paintThumbs();          // 缩略图也要换底图/深色滤境
      this._paintDayThumbs();
    });
    this._hmBox.addEventListener("change", () => {
      this._heatmap = this._hmBox.checked;
      this._applyMapStyle();
      this._renderMap();
      this._paintThumbs();
      this._paintDayThumbs();
    });
    this._flowBox.addEventListener("change", () => {
      this._flow = this._flowBox.checked;
      this._renderMap();
      this._paintThumbs();
      this._paintDayThumbs();
    });
    this.shadowRoot.querySelectorAll(".tools button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._onMapButton(b.dataset.m);
      });
    });
    this._listEl.addEventListener("click", (ev) => {
      const del = ev.target.closest("button.del");
      if (del) {
        ev.stopPropagation();
        const row = del.closest(".row");
        if (row) this._deleteTrip(row.dataset.id, del);
        return;
      }
      // 点每日卡片顶部(缩略图/标题/汇总) → 收起/展开这一天
      const head = ev.target.closest(".daytop");
      if (head) {
        const dc = head.closest(".daycard");
        if (dc) {
          dc.classList.toggle("collapsed");
          this._collapsed[dc.dataset.day] = dc.classList.contains("collapsed");
        }
        return;
      }
      const row = ev.target.closest(".row");
      if (row && row.dataset.id) this._openDetail(row.dataset.id);
    });
    this._ddelEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this._ddelEl.dataset.id) this._deleteTrip(this._ddelEl.dataset.id, this._ddelEl);
    });
    this._legendEl.addEventListener("click", (ev) => {
      const lg = ev.target.closest(".lg");
      if (lg && lg.dataset.id) this._openDetail(lg.dataset.id);
    });
    this._bindMap();

    // 卡片尺寸变化(切视图/改列宽)时要重算可视瓦片与轨迹位置;
    // 列表视图下还要重挑长单位的显示(见 _fitUnits —— "kWh/100km" 放不下就整段隐藏)
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (this._view === "detail" && this._center) this._renderMap();
        else this._fitUnits();
      });
      this._ro.observe(this._mapEl);
      this._ro.observe(this._listEl);
    }
  }

  _bindMap() {
    let start = null;
    this._mapEl.addEventListener("pointerdown", (ev) => {
      if (!this._center) return;
      this._mapEl.setPointerCapture(ev.pointerId);
      start = { x: ev.clientX, y: ev.clientY, center: [this._center[0], this._center[1]] };
      this._dragging = false;
    });
    this._mapEl.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!this._dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
      this._dragging = true;
      this._mapEl.classList.add("dragging");
      const c = project(start.center[0], start.center[1], this._zoom);
      this._center = unproject(c[0] - dx, c[1] - dy, this._zoom);
      this._needFit = false;
      this._renderMap();
    });
    const end = () => {
      if (!start) return;
      start = null;
      this._mapEl.classList.remove("dragging");
      this._dragging = false;
    };
    this._mapEl.addEventListener("pointerup", end);
    this._mapEl.addEventListener("pointercancel", end);
    this._mapEl.addEventListener("dblclick", (ev) => {
      ev.stopPropagation();
      this._zoomAt(ev.clientX, ev.clientY, 1);
    });
    this._mapEl.addEventListener(
      "wheel",
      (ev) => {
        ev.preventDefault();       // 拦下页面滚动, 让滚轮专心缩放地图
        ev.stopPropagation();
        this._zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
  }
}

/* ── 自定义元素注册守卫 ──────────────────────────────────────────────────────
 * HA 新版前端启动时会**整个替换** window.customElements(scoped registry polyfill):
 * 若本模块在替换前求值, 元素就注册进了被丢弃的旧注册表 —— 前端查"当前"注册表查不到,
 * 卡片会永久显示 "Custom element does not exist"(不报错、无日志; 冷加载 / 手机 App
 * 上更易命中, 打开 DevTools 反而掩盖)。上游: home-assistant/frontend#52960、#53890。
 * 修法: 记住加载时的注册表对象, 一旦它被换掉, 就把尚未生效的元素补注册到"当前"注册表;
 * HA 的错误卡会在 whenDefined 解析后自动重建, 于是自愈。未换表时轮询自然结束。 */
const _REG = customElements;
const _pend = new Map();
let _pollN = 0;
function _heal() {
  if (customElements === _REG || _pend.size === 0) return;   // 注册表没被换 → 无需处理
  for (const [name, ctor] of [..._pend]) {
    try {
      if (!customElements.get(name)) customElements.define(name, ctor);
      _pend.delete(name);
    } catch (e) { /* 交给下一轮重试 */ }
  }
}
function _pollHeal() {
  if (_pend.size === 0 || _pollN >= 30) return;
  _pollN += 1;
  setTimeout(() => { _heal(); _pollHeal(); }, 1000);
}
function _defineCard(name, ctor) {
  try {
    if (!_REG.get(name)) _REG.define(name, ctor);
  } catch (e) { console.warn(`leapmotor: 注册 ${name} 失败`, e); return; }
  _pend.set(name, ctor);
  try { _REG.whenDefined("home-assistant").then(_heal).catch(() => {}); } catch (e) {}
  _pollHeal();
}
_defineCard("leapmotor-trips", LeapmotorTripsCard);

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-trips")) {
  window.customCards.push({
    type: "leapmotor-trips",
    name: "零跑·行程浏览",
    description: "行程卡片(缩略图/按天分组/起终点/断档虚线/最近多段叠加)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}

console.info(`%c 零跑行程浏览 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");