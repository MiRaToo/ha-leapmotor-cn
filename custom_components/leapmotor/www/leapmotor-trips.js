/*
 * 零跑行程浏览 —— 行程列表 + 轨迹地图的 Lovelace 卡片。
 *
 * 数据来源(集成的 WebSocket 命令, 见 custom_components/leapmotor/ws_api.py):
 *   * `leapmotor/trips/list`   —— 行程摘要列表 + 今日/近7天/近30天统计 + 正在记录的那段
 *   * `leapmotor/trips/track`  —— 单段行程的轨迹点(max_points: 0 = 全量, 坐标 WGS-84)
 *   * `leapmotor/trips/delete` —— 删除一段行程(需要管理员)
 *
 * 列表按日期分组(今天/昨天/…), 点一行就会在地图上画出那段轨迹; 勾上"叠加最近 N 段"
 * 可以把最近几段轨迹用不同颜色画在一起, 看常走路线。
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
 * 计算与绘制代码也是从地图卡里搬过来的(投影/瓦片/换算), 两张卡行为一致。
 *
 * 用法
 * ----
 *   type: custom:leapmotor-trips
 *   # 可选
 *   height: 340          # 地图高度 px
 *   satellite: false     # true = 卫星底图(默认路网图)
 *   overlay: 0           # 打开时默认叠加最近 N 段(0=关, 可选 5/10/20), 卡片上也能开关
 *   list_height: 460     # 左侧行程列表最大高度 px
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 */

const TILE = 256;

const CARD_VERSION = "1.0.2";

/* 断档阈值(km): 相邻轨迹点距离超过它 → 视为中间丢过采样, 用虚线连 */
const TRACK_GAP_KM = 2;

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

function gcj02ToWgs84(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLat(lon - 105.0, lat - 35.0);
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
  let dLon2 = transformLat(wLon - 105.0, wLat - 35.0);
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
  let dLon = transformLat(lon - 105.0, lat - 35.0);
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

function fmtNum(v, digits, unit) {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits) + (unit ? " " + unit : "");
}

/** 等距抽稀(保留首尾), 给"叠加模式"减负 —— 画在一起时每段不需要全量点。 */
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
    this._trackCache = {};      // trip_id → 原始轨迹点(WGS-84)
    this._overlayN = 0;
    this._overlayTracks = [];
    this._overlaySeq = 0;
    this._tiles = new Map();
    this._needFit = true;
    this._dragging = false;
  }

  /** 从卡片选择器添加时不需要填任何东西(数据走本集成的 WS 命令)。 */
  static getStubConfig() {
    return { height: 340, satellite: false, overlay: 0 };
  }

  setConfig(config) {
    this._config = {
      height: 340,
      satellite: false,
      overlay: 0,
      list_height: 460,
      ...(config || {}),
    };
    this._config.height = clamp(Number(this._config.height) || 340, 200, 900);
    this._config.list_height = clamp(Number(this._config.list_height) || 460, 160, 1200);
    const ov = Number(this._config.overlay) || 0;
    this._overlayN = ov === 5 || ov === 10 || ov === 20 ? ov : 0;
    this._overlayTracks = [];
    this._overlaySeq++;
    this._tiles.forEach((img) => img.remove());
    this._tiles.clear();
    this._built = false;
    this._center = null;
    this._needFit = true;
    this._render();
    if (this._overlayN > 0 && this._trips.length && this._hass) this._loadOverlay();
  }

  set hass(hass) {
    this._hass = hass;
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
      this._overlayTracks = [];
      this._overlaySeq++;
      this._loading = false;
      this._pickDefault();
      this._render();
      if (this._selectedId) await this._select(this._selectedId);
      if (this._overlayN > 0) await this._loadOverlay();
    } catch (err) {
      this._loading = false;
      this._err = this._errText(err);
      this._render();
    }
  }

  /** 默认选中"最近一段有轨迹的行程"(没有就选最新一段)。 */
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

  /** 取一段行程的轨迹(带缓存), 顺手把 WGS-84 换算成显示坐标并切好断档。 */
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
      this._err = this._errText(err);
    }
    this._trackCache[id] = pts;
    return pts;
  }

  async _select(id) {
    const t = this._find(id);
    this._selectedId = id;
    this._selTrip = t;
    this._renderList();
    this._renderPanel();
    if (!t) return;
    if (t.point_count > 0) {
      const pts = await this._ensureTrack(id);
      if (String(this._selectedId) !== String(id)) return;   // 用户又点了别的行
      this._sel = this._prepare(pts, 4000);
    } else {
      this._sel = null;
    }
    this._needFit = true;
    this._renderMap();
  }

  /**
   * 原始轨迹(WGS-84)→ 显示坐标, 并按距离切成 runs(实线)/ breaks(虚线)。
   * 返回 {runs: [[pt,…],…], breaks: [[a,b],…]}。
   */
  _prepare(raw, maxN) {
    const src = simplify(raw || [], maxN);
    const disp = [];
    for (const p of src) {
      if (!p || p.length < 2) continue;
      const la = Number(p[0]);
      const lo = Number(p[1]);
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (la === 0 && lo === 0) continue;
      disp.push(wgs84ToGcj02(la, lo));
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
    const n = Number(this._ovlN.value) || 5;
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
    this._renderList();
    this._renderLegend();
    this._renderPanel();
    this._renderMap();
  }

  _renderHead() {
    if (!this._sumEl) return;
    const st = this._stats;
    const parts = [];
    if (st && st.today) {
      parts.push(`今日 ${st.today.count || 0} 段 · ${fmtNum(st.today.km, 1, "km")}`);
      if (st.days7) parts.push(`近7天 ${fmtNum(st.days7.km, 1, "km")}`);
    }
    if (st && st.gaps) parts.push(`漏采 ${st.gaps} 次`);
    this._sumEl.textContent = parts.join(" · ");
    if (this._refreshBtn) this._refreshBtn.classList.toggle("spin", this._loading);
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
  }

  _renderList() {
    if (!this._listEl) return;
    if (this._err) {
      this._listEl.innerHTML = "";
      this._lmsgEl.textContent = this._err;
      return;
    }
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
      html += '<div class="grp">' + dayLabel(group[0].started_at) +
        " · " + group.length + " 段 · " + km.toFixed(1) + " km</div>";
      for (const t of group) html += this._rowHtml(t);
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
    this._listEl.innerHTML = html;
  }

  _rowHtml(t) {
    const sel = String(t.id) === String(this._selectedId);
    const sameDay = dayKey(t.started_at) === dayKey(t.ended_at || t.started_at);
    const tm = sameDay
      ? fmtTime(t.started_at) + " → " + fmtTime(t.ended_at)
      : fmtDayTime(t.started_at) + " → " + fmtDayTime(t.ended_at);
    const badges = [];
    if (t.reconstructed) badges.push('<span class="badge r" title="漏采补记: 没有轨迹, 时间只是两次观测之间">补记</span>');
    if (t.frozen) badges.push('<span class="badge f" title="车端失联后收尾, 时长可能有偏差">失联</span>');
    const sub = [];
    sub.push((t.approx_time ? "≈ " : "") + fmtDuration(t.duration_min));
    if (t.efficiency != null) sub.push(fmtNum(t.efficiency, 1, "kWh/100km"));
    if (t.energy_kwh != null) sub.push(fmtNum(t.energy_kwh, 2, "kWh"));
    return (
      '<div class="row' + (sel ? " sel" : "") + '" data-id="' + String(t.id) + '">' +
      '<div class="r1"><span class="tm">' + tm + "</span>" +
      '<span class="km">' + fmtNum(t.distance_km, 2, "km") + "</span></div>" +
      '<div class="r2">' + sub.map((s) => "<span>" + s + "</span>").join("") +
      badges.join("") + "</div>" +
      '<button class="del" title="删除这段行程">删</button>' +
      "</div>"
    );
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

  _renderPanel() {
    if (!this._panelEl) return;
    const t = this._selTrip;
    if (!t) {
      this._panelEl.innerHTML = '<div class="pempty">点左边的行程查看详情</div>';
      return;
    }
    const sameDay = dayKey(t.started_at) === dayKey(t.ended_at || t.started_at);
    const when = sameDay
      ? fmtTime(t.started_at) + " → " + fmtTime(t.ended_at)
      : fmtDayTime(t.started_at) + " → " + fmtDayTime(t.ended_at);
    const soc = (t.start_soc != null && t.end_soc != null)
      ? fmtNum(t.start_soc, 0, "%") + " → " + fmtNum(t.end_soc, 0, "%")
      : "—";
    const rows = [
      ["时间", when],
      ["时长", (t.approx_time ? "≈ " : "") + fmtDuration(t.duration_min)],
      ["里程", fmtNum(t.distance_km, 2, "km") +
        (t.distance_source === "odo" ? "（总里程）" : t.distance_source === "gps" ? "（GPS）" : "")],
      ["耗电", fmtNum(t.energy_kwh, 2, "kWh")],
      ["能耗", fmtNum(t.efficiency, 1, "kWh/100km")],
      ["平均速度", fmtNum(t.avg_speed_kmh, 1, "km/h")],
      ["电量", soc],
      ["轨迹点", t.point_count ? String(t.point_count) : "—"],
    ];
    let html = rows
      .map((r) => '<div class="prow"><span class="pk" title="' + r[0] + '">' + r[0] +
        '</span><span class="pv">' + r[1] + "</span></div>")
      .join("");
    const notes = [];
    if (t.reconstructed) notes.push("补记(无轨迹; 里程/耗电来自总里程与 SOC 跳变)");
    if (t.approx_time) notes.push("时间只是两次观测之间, 不是精确行程时刻");
    if (t.frozen) notes.push("失联收尾");
    if (notes.length) html += '<div class="prow"><span class="pk">备注</span><span class="pv">' +
      notes.join(" · ") + "</span></div>";
    this._panelEl.innerHTML = html;
  }

  // ── 地图 ──
  _renderMap() {
    if (!this._mapEl) return;
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
    let tpl = conf.tiles || (conf.satellite ? TILE_SOURCES.satellite : TILE_SOURCES.vector);
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

  _renderLines() {
    if (!this._trajEl || !this._mapEl || !this._center) return;
    const mapPt = this._screenMapper();
    const frag = document.createDocumentFragment();
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
        frag.appendChild(this._poly(run, mapPt, "#e53935", 3.5, false));
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
      text = "点左边的行程看轨迹";
    } else if (this._selTrip && !this._selTrip.point_count) {
      text = this._selTrip.reconstructed ? "这段没有轨迹(靠里程跳变补记)" : "这段没有轨迹";
    } else if (this._selTrip && this._sel && !this._sel.runs.length) {
      text = "轨迹点太少, 画不出路线";
    }
    this._mhintEl.textContent = text;
    this._mhintEl.style.display = text ? "block" : "none";
  }

  // ── 交互 ──
  async _deleteTrip(id, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      btn.textContent = "确认";
      setTimeout(() => {                        // 3 秒内没确认就复位, 防止误触
        if (btn.dataset.armed && btn.isConnected) {
          delete btn.dataset.armed;
          btn.classList.remove("armed");
          btn.textContent = "删";
        }
      }, 3000);
      return;
    }
    if (!this._hass || !this._hass.callWS) return;
    if (this._hass.user && !this._hass.user.is_admin) {
      this._err = "需要管理员权限才能删除行程";
      this._renderList();
      return;
    }
    btn.disabled = true;
    btn.textContent = "…";
    try {
      await this._hass.callWS({ type: "leapmotor/trips/delete", trip_id: id });
      if (String(this._selectedId) === String(id)) {
        this._selectedId = "";
        this._selTrip = null;
        this._sel = null;
      }
      delete this._trackCache[id];
      await this._load();
    } catch (err) {
      this._err = "删除失败: " + this._errText(err);
      this._renderList();
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
          color: var(--primary-text-color, #222);
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 8px 10px 10px; box-sizing: border-box;
          font-size: 13px;
        }
        .head { display: flex; align-items: center; gap: 8px; }
        .head .title { font-weight: 600; font-size: 14px; }
        .head .sum { font-size: 12px; opacity: .7; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .head .spacer { flex: 1; }
        button {
          font: inherit; font-size: 12px; color: inherit; cursor: pointer;
          border-radius: 8px; border: 1px solid var(--divider-color, #ccc);
          background: var(--card-background-color, #fff);
        }
        .head button.refresh { width: 30px; height: 26px; font-size: 15px; line-height: 1; }
        .head button.refresh.spin { opacity: .45; }
        .active {
          display: none; align-items: center; gap: 6px; margin-top: 6px; padding: 5px 8px;
          font-size: 12px; border-radius: 8px;
          background: rgba(3,169,244,.12); border: 1px solid rgba(3,169,244,.35);
        }
        .active.on { display: flex; }
        .active .dot { width: 8px; height: 8px; border-radius: 50%; background: #03a9f4; animation: lpulse 1.4s infinite; }
        @keyframes lpulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }
        .body { display: flex; flex-wrap: wrap; gap: 10px; margin-top: 8px; align-items: flex-start; }
        .listwrap { flex: 1 1 260px; min-width: 230px; max-width: 360px; }
        .list { max-height: ${listH}px; overflow: auto; font-size: 12px; }
        .grp {
          position: sticky; top: 0; z-index: 1; padding: 4px 2px; font-size: 11px; opacity: .7;
          background: var(--ha-card-background, var(--card-background-color, #fff));
        }
        .row { position: relative; padding: 6px 42px 6px 8px; border-radius: 8px; cursor: pointer; }
        .row:hover { background: rgba(127,127,127,.09); }
        .row.sel { background: rgba(3,169,244,.14); box-shadow: inset 0 0 0 1px rgba(3,169,244,.4); }
        .row.act { cursor: default; }
        .row .r1 { display: flex; justify-content: space-between; gap: 6px; }
        .row .tm { font-weight: 600; }
        .row .km { opacity: .85; }
        .row .r2 { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 2px; font-size: 11px; opacity: .7; }
        .badge { padding: 0 5px; border-radius: 999px; font-size: 10px; border: 1px solid currentColor; opacity: 1; }
        .badge.r { color: #f9a825; }
        .badge.f { color: #e53935; }
        .row .del {
          position: absolute; right: 4px; top: 50%; transform: translateY(-50%);
          padding: 2px 7px; font-size: 11px;
        }
        .row .del.armed { background: var(--error-color, #db4437); color: #fff; border-color: var(--error-color, #db4437); }
        .lmsg { padding: 6px 4px; font-size: 12px; opacity: .75; }
        .main { flex: 1 1 380px; min-width: 300px; }
        .tools { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 12px; margin-bottom: 6px; }
        .tools label { display: flex; align-items: center; gap: 4px; cursor: pointer; }
        .tools select {
          padding: 2px 4px; font: inherit; font-size: 12px; color: inherit;
          border: 1px solid var(--divider-color, #ccc); border-radius: 6px;
          background: var(--card-background-color, #fff);
        }
        .tools .spacer { flex: 1; }
        .tools button { width: 30px; height: 26px; }
        .map {
          position: relative; height: ${h}px;
          /* 必须用 clip 而不是 hidden: hidden 仍是可滚动容器, 会让绝对定位的瓦片整体偏移 */
          overflow: clip; border-radius: 10px; background: #dfe6ea;
          cursor: grab; touch-action: none; user-select: none;
        }
        .map.dragging { cursor: grabbing; }
        .tiles { position: absolute; left: 0; top: 0; z-index: 0; }
        .tiles img { position: absolute; width: ${TILE}px; height: ${TILE}px; -webkit-user-drag: none; }
        .traj { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 2; pointer-events: none; }
        .marks { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 4; pointer-events: none; }
        .mk {
          position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; box-sizing: border-box;
          border-radius: 50%; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px;
          text-align: center; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4);
        }
        .mk.start { background: #2e7d32; }
        .mk.end { background: #e53935; }
        .mhint {
          position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 6;
          display: none; padding: 3px 9px; border-radius: 999px; font-size: 11px; white-space: nowrap;
          background: rgba(0,0,0,.62); color: #fff;
        }
        .panel {
          margin-top: 6px; font-size: 12px;
          display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 2px 12px;
        }
        .prow { display: flex; gap: 5px; min-width: 0; }
        .prow .pk { opacity: .6; white-space: nowrap; }
        .prow .pv { font-weight: 600; min-width: 0; word-break: break-word; }
        .pempty { opacity: .6; }
        .legend { display: none; flex-wrap: wrap; gap: 4px 10px; margin-top: 6px; font-size: 11px; }
        .legend.on { display: flex; }
        .lg { display: flex; align-items: center; gap: 4px; cursor: pointer; opacity: .85; }
        .lg:hover { opacity: 1; }
        .lg i { display: inline-block; width: 14px; height: 3px; border-radius: 2px; }
      </style>
      <div class="card">
        <div class="head">
          <span class="title">行程</span>
          <span class="sum"></span>
          <span class="spacer"></span>
          <button class="refresh" title="刷新行程列表">↻</button>
        </div>
        <div class="active"><span class="dot"></span><span class="atext"></span></div>
        <div class="body">
          <div class="listwrap">
            <div class="list"></div>
            <div class="lmsg"></div>
          </div>
          <div class="main">
            <div class="tools">
              <label><input type="checkbox" class="ovlbox">叠加最近</label>
              <select class="ovln">
                <option value="5">5 段</option>
                <option value="10">10 段</option>
                <option value="20">20 段</option>
              </select>
              <span class="spacer"></span>
              <button data-m="fit" title="缩放至轨迹">⤢</button>
              <button data-m="in" title="放大">＋</button>
              <button data-m="out" title="缩小">－</button>
            </div>
            <div class="map">
              <div class="tiles"></div>
              <svg class="traj" xmlns="http://www.w3.org/2000/svg"></svg>
              <div class="marks"></div>
              <div class="mhint"></div>
            </div>
            <div class="panel"></div>
            <div class="legend"></div>
          </div>
        </div>
      </div>`;

    this._cardEl = this.shadowRoot.querySelector(".card");
    this._sumEl = this.shadowRoot.querySelector(".head .sum");
    this._refreshBtn = this.shadowRoot.querySelector(".head .refresh");
    this._activeEl = this.shadowRoot.querySelector(".active");
    this._activeText = this.shadowRoot.querySelector(".active .atext");
    this._listEl = this.shadowRoot.querySelector(".list");
    this._lmsgEl = this.shadowRoot.querySelector(".lmsg");
    this._mapEl = this.shadowRoot.querySelector(".map");
    this._tilesEl = this.shadowRoot.querySelector(".tiles");
    this._trajEl = this.shadowRoot.querySelector(".traj");
    this._marksEl = this.shadowRoot.querySelector(".marks");
    this._mhintEl = this.shadowRoot.querySelector(".mhint");
    this._panelEl = this.shadowRoot.querySelector(".panel");
    this._legendEl = this.shadowRoot.querySelector(".legend");
    this._ovlBox = this.shadowRoot.querySelector(".ovlbox");
    this._ovlN = this.shadowRoot.querySelector(".ovln");

    this._refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._load();
    });
    this._ovlBox.addEventListener("change", () => this._toggleOverlay(this._ovlBox.checked));
    this._ovlN.addEventListener("change", () => {
      if (this._ovlBox.checked) this._toggleOverlay(true);
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
      const row = ev.target.closest(".row");
      if (row && row.dataset.id) this._select(row.dataset.id);
    });
    this._legendEl.addEventListener("click", (ev) => {
      const lg = ev.target.closest(".lg");
      if (lg && lg.dataset.id) this._select(lg.dataset.id);
    });
    this._bindMap();

    // 卡片尺寸变化(切视图/改列宽)时要重算可视瓦片与轨迹位置
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (this._center) this._renderMap();
      });
      this._ro.observe(this._mapEl);
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

if (!customElements.get("leapmotor-trips")) {
  customElements.define("leapmotor-trips", LeapmotorTripsCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-trips")) {
  window.customCards.push({
    type: "leapmotor-trips",
    name: "零跑·行程浏览",
    description: "行程列表 + 轨迹地图(列表分组/起终点/断档虚线/最近多段叠加)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}

console.info(`%c 零跑行程浏览 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");
