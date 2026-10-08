/**
 * 零跑 · 里程耗电 —— 以"天"为单位的折线图(周/月切换, 里程/耗电/百公里能耗三线可叠显)。
 *
 * 为什么按天(而不是把轮询采样点直接画出来): 里程/能耗这类数据只在"天"的粒度上有意义 ——
 * 采样点连成的线反映的是轮询节奏, 不是车用了多少; 云端官方也只提供逐日明细。
 *
 * 数据来源(服务端 assemble; 卡片上**不标注来源** —— 2026-10-08 用户要求去掉,
 * 角落仅在有补拉时提示进度):
 *   * **耗电(橙)**: 官方 getEC 逐日拆分(`getLastweekEC` 传任意窗口, 与官方 App 周报同源;
 *     驱动/空调/其它, **不含驻停/待机**)。官方缺的日子用本机自记 ΔSOC 兜底。
 *     已完结的日子服务端只拉一次并持久缓存, 月视图第二次打开零请求;
 *     未补完的天 `pending>0`, 卡片稍后自动续拉(分批取数, 首屏不等一长串请求)。
 *     ⚠️ 不再用云端 `mileage/energy/detail` 的逐日 `accumulatedEnergyConsume` ——
 *     实测该字段不可靠(逐日为 0、求和远小于官方聚合), 详见 docs/PROTOCOL.md。
 *   * **里程(蓝)**: 本机自记行程(与行程卡同口径), 缺的日子退回云端逐日里程。
 *   * **百公里能耗(绿)**: 当日耗电(同上, 官方优先) ÷ 当日里程 —— 与「行程统计」同口径。
 *
 * 读法: 共享横轴(日期)。三条线可独立开关(至少留一条, 选择会按车记住):
 *   里程(蓝, km) — 每日行驶里程;  耗电(橙, kWh) — 每日驱动+空调+其它;
 *   百公里能耗(绿, kWh/100km) — 当日效率。
 * 图表最多标两根刻度轴, 按 里程 → 耗电 → 百公里能耗 的顺序分配给左/右(三条全开时
 * 第三条不标刻度, 点一下看精确值); 点某天会浮出当天所有可见数值。
 *
 * 配置:
 *   type: custom:leapmotor-energy
 *   title: 里程 / 耗电        # 可选, 不填就只显示摘要
 *   range: week              # 可选, week(默认) | month
 *   show_mileage: true       # 可选, 默认 true
 *   show_energy: true        # 可选, 默认 true(每日耗电)
 *   show_efficiency: true    # 可选, 默认 true(百公里能耗)
 *
 * 视觉上与「零跑·行程浏览」「零跑·车辆控制」同一套: 白底大卡 + 白底灰框子块 + 胶囊按钮,
 * 颜色全部走 HA 主题变量(深色主题自适应)。
 */

const CARD_VERSION = "1.2.1";

const PENDING_RETRY_MS = 8000;   // pending>0 时自动续拉前的等待(分批取数, 不阻塞首屏)

const COLOR_KM = "#1e88e5";      // 蓝 = 里程(km)
const COLOR_KWH = "#fb8c00";     // 橙 = 耗电(每日 kWh)
const COLOR_EFF = "#43a047";     // 绿 = 百公里能耗(kWh/100km)
const CHART_H = 176;             // 图表高度(CSS px); 宽度自适应卡片
const PAD = { l: 34, r: 40, t: 12, b: 22 };
const REFRESH_THROTTLE_MS = 60000;   // 传感器联动刷新(「近7天里程」更新后)的最小间隔

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function pad2(n) { return (n < 10 ? "0" : "") + n; }

/** "2026-10-04" → "10月4日"(气泡里用) */
function fmtDayCn(day) {
  const p = String(day || "").split("-");
  if (p.length < 3) return String(day || "");
  return parseInt(p[1], 10) + "月" + parseInt(p[2], 10) + "日";
}
/** "2026-10-04" → "10/4"(横轴标签) */
function fmtDayShort(day) {
  const p = String(day || "").split("-");
  if (p.length < 3) return String(day || "");
  return parseInt(p[1], 10) + "/" + parseInt(p[2], 10);
}
/** 坐标轴刻度取整: 目标 4 段, 步长取 1/2/2.5/5 × 10ⁿ */
function niceAxis(maxValue, targetTicks) {
  const t = Math.max(1, targetTicks || 4);
  let raw = (Number(maxValue) || 0) / t;
  if (!(raw > 0)) raw = 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  const step = s * pow;
  let max = Math.ceil((Number(maxValue) || 0) / step) * step;
  if (!(max > 0)) max = step;
  const ticks = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks.length < 2) ticks.push(Number((max).toFixed(6)));
  return { max: max, step: step, ticks: ticks };
}
function fmtTick(v) {
  const n = Number(v) || 0;
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}
/** 一天的里程保留 1 位; 耗电 2 位; 百公里能耗 1 位 —— 与行程卡的显示口径一致 */
function fmtKm(v) { return Number(v).toFixed(1); }
function fmtKwh(v) { return String(Number(Number(v).toFixed(2))); }
function fmtEff(v) { return Number(v).toFixed(1); }

/** 把 [v0, v1, null, v2…] 切成连续段: [[[0, v0], [1, v1]], [[3, v2]]] */
function runsOf(values) {
  const runs = [];
  let cur = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) { cur = null; continue; }
    if (!cur) { cur = []; runs.push(cur); }
    cur.push([i, v]);
  }
  return runs;
}

class LeapmotorEnergyCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._built = false;
    this._range = "week";                 // week | month
    this._showKm = true;
    this._showKwh = true;
    this._showEff = true;                 // 百公里能耗(默认开, 可关)
    this._cache = {};                     // range → 数据(切回时不重拉)
    this._loading = false;
    this._err = "";
    this._data = null;
    this._day = -1;                       // 气泡选中的天(索引)
    this._loadSeq = 0;                    // 取数轮次: 切视图后作废在途的旧请求
    this._lastLoad = 0;
    this._watchId = "";
    this._watchStamp = "";
    this._vin = "";
    this._pendingTimer = null;            // pending>0 时的自动续拉定时器(见 _schedulePendingRetry)
    this._prefLoaded = false;
  }

  static getStubConfig() {
    return { type: "custom:leapmotor-energy" };
  }

  setConfig(config) {
    if (!config) return;
    this._config = config;
    if (config.range === "month" || config.range === "week") this._range = config.range;
    if (config.show_mileage === false) this._showKm = false;
    if (config.show_energy === false) this._showKwh = false;
    if (config.show_efficiency === false) this._showEff = false;
    if (!this._showKm && !this._showKwh && !this._showEff) this._showKm = true;   // 至少留一条
    this._prefLoaded = false;             // 配置变了, 允许重新读取本地偏好(仅未持久化过时)
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this._loadPref();
      this._build();
      this._renderAll();
      this._load();
    } else {
      this._maybeFollowSensor();
    }
  }

  getCardSize() { return 5; }

  // ── 本地偏好(与控车卡的折叠记忆同一套做法) ──
  _prefKey() {
    return "leapmotor-energy.pref." + (this._vin || this._config.title || "default");
  }
  _loadPref() {
    if (this._prefLoaded) return;
    this._prefLoaded = true;
    try {
      const raw = window.localStorage.getItem(this._prefKey()) || "";
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!this._config.range && (p.range === "week" || p.range === "month")) this._range = p.range;
      if (this._config.show_mileage !== false && typeof p.km === "boolean") this._showKm = p.km;
      if (this._config.show_energy !== false && typeof p.kwh === "boolean") this._showKwh = p.kwh;
      if (this._config.show_efficiency !== false && typeof p.eff === "boolean") this._showEff = p.eff;
      if (!this._showKm && !this._showKwh && !this._showEff) this._showKm = true;
    } catch (err) { /* 本地存储不可用就算了 */ }
  }
  /** 只落"用户**确实改过**的那一项" —— 别把配置给的值也写进共享存储。
      踩过的坑: 加载完成后无条件全量保存, 一张 `range: month` 的卡(比如另一块屏)
      会把 month 写进同一把键, 让其它没写配置的卡在重读时也跟着变月视图。 */
  _savePref(patch) {
    try {
      let cur = {};
      try { cur = JSON.parse(window.localStorage.getItem(this._prefKey()) || "{}") || {}; } catch (err) { cur = {}; }
      window.localStorage.setItem(this._prefKey(), JSON.stringify(Object.assign(cur, patch || {})));
    } catch (err) { /* 本地存储不可用时忽略 */ }
  }

  // ── 构建 ──
  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>" + this._css() + "</style>" +
      '<div class="card">' +
      '<div class="head"><span class="title"></span><span class="sum"></span>' +
      '<span class="spacer"></span>' +
      '<button class="refresh" title="重新读取"><ha-icon icon="mdi:refresh"></ha-icon></button>' +
      "</div>" +
      '<div class="lmsg"></div>' +
      '<section class="chartSec"><div class="chartBox"></div>' +
      '<div class="srcNote"></div></section>' +
      '<div class="ctrls"></div>' +
      "</div>";
    this._titleEl = root.querySelector(".head .title");
    this._sumEl = root.querySelector(".head .sum");
    this._msgEl = root.querySelector(".lmsg");
    this._boxEl = root.querySelector(".chartBox");
    this._noteEl = root.querySelector(".srcNote");
    this._ctrlsEl = root.querySelector(".ctrls");
    this._refreshBtn = root.querySelector(".head .refresh");

    this._refreshBtn.addEventListener("click", () => {
      if (this._loading) return;
      delete this._cache[this._range];
      this._load(true);
    });
    this._boxEl.addEventListener("click", (ev) => {
      const hit = ev.target && ev.target.closest ? ev.target.closest("[data-day]") : null;
      if (!hit) { this._setDay(-1); return; }
      const i = parseInt(hit.dataset.day, 10);
      this._setDay(i === this._day ? -1 : i);
    });

    this._ctrlsEl.addEventListener("click", (ev) => {
      const el = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
      if (!el) return;
      const act = el.dataset.act;
      if (act === "toggle-km") {
        const next = !this._showKm;
        if (!next && !this._showKwh && !this._showEff) return;   // 至少留一条
        this._showKm = next;
        this._day = -1;
        this._savePref({ km: next }); this._renderAll();
      } else if (act === "toggle-kwh") {
        const next = !this._showKwh;
        if (!next && !this._showKm && !this._showEff) return;
        this._showKwh = next;
        this._day = -1;
        this._savePref({ kwh: next }); this._renderAll();
      } else if (act === "toggle-eff") {
        const next = !this._showEff;
        if (!next && !this._showKm && !this._showKwh) return;
        this._showEff = next;
        this._day = -1;
        this._savePref({ eff: next }); this._renderAll();
      } else if (act === "range") {
        const r = el.dataset.val;
        if (r !== "week" && r !== "month") return;
        if (r === this._range) return;
        this._range = r;
        this._day = -1;
        this._savePref({ range: r });
        // ⚠️ 这里必须走 _load: 有缓存时它会**把 this._data 换成缓存的那一份**再重绘。
        //    原来只 _renderAll() 不换数据 → 从月切回周时画的还是 30 天数据, 看起来"切不回去"。
        this._load(false);
      }
    });

    // 宽度变化 → 重算横轴标签抽稀与图形(与行程卡同一套 ResizeObserver 思路)
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (this._rafPending) return;
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._rafPending = false;
          this._renderChart();
        });
      });
      this._ro.observe(this._boxEl);
    }
  }

  _css() {
    return `
      :host { display: block; }
      .card {
        background: var(--ha-card-background, var(--card-background-color, #fff));
        color: var(--primary-text-color, #212121);
        border-radius: var(--ha-card-border-radius, 12px);
        padding: 14px; box-sizing: border-box;
        font-size: 13px; line-height: 1.4;
        display: flex; flex-direction: column; gap: 10px;
      }
      .head { display: flex; align-items: center; gap: 8px; }
      .head .title { font-weight: 600; font-size: 14px; white-space: nowrap; flex: 0 0 auto; }
      .head .sum {
        flex: 0 1 auto; min-width: 0; font-size: 12px;
        overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      }
      .head .spacer { flex: 1; }
      /* 刷新按钮: 圆形白底 + 与外框同款轻阴影; hover 淡蓝 */
      .head button.refresh {
        width: 30px; height: 30px; padding: 0; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
        color: var(--secondary-text-color, #6b7280);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        transition: background .15s ease;
      }
      .head button.refresh:not([disabled]):hover {
        background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
      }
      .head button.refresh.spin { opacity: .45; }
      .head button.refresh ha-icon { width: 18px; height: 18px; --mdc-icon-size: 18px; }
      ha-icon { display: inline-flex; width: 16px; height: 16px; --mdc-icon-size: 16px; }

      .lmsg { display: none; font-size: 12px; color: var(--secondary-text-color, #6b7280); padding: 2px 2px 0; }
      .lmsg.on { display: block; }
      .lmsg.err { color: var(--error-color, #db4437); }

      /* 图表子块: 白底 + 灰框 + 轻阴影(与行程卡 .sec/.row 同一套) */
      .chartSec {
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        border-radius: 14px; padding: 10px 10px 6px;
      }
      .chartBox { position: relative; height: ${CHART_H}px; }
      .chartBox svg { display: block; width: 100%; height: ${CHART_H}px; }
      .gridline { stroke: var(--divider-color, rgba(0, 0, 0, .09)); stroke-width: 1; }
      .axisTxt { font-size: 10px; fill: var(--secondary-text-color, #6b7280); }
      .axisTxt.km { fill: ${COLOR_KM}; }
      .axisTxt.kwh { fill: ${COLOR_KWH}; }
      .axisTxt.eff { fill: ${COLOR_EFF}; }
      .line { fill: none; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
      .pt.km { fill: ${COLOR_KM}; }
      .pt.kwh { fill: ${COLOR_KWH}; }
      .pt.eff { fill: ${COLOR_EFF}; }
      .pt.sel { stroke: var(--card-background-color, #fff); stroke-width: 1.6; }
      .hit { fill: transparent; cursor: pointer; }
      .selcol { fill: var(--secondary-background-color, #e7eaed); opacity: .55; }
      .tip {
        position: absolute; z-index: 5; pointer-events: none; white-space: nowrap;
        padding: 4px 8px; border-radius: 8px; font-size: 11px; line-height: 1.5;
        color: #fff; background: rgba(33, 33, 33, .92); box-shadow: 0 2px 8px rgba(0, 0, 0, .25);
      }
      .srcNote { margin-top: 2px; text-align: right; font-size: 10px; color: var(--secondary-text-color, #6b7280); }

      /* 底部选择项: 左侧两个显隐开关(带颜色点), 右侧周/月 */
      /* 底部选择项: 收紧间距, 手机上一行放得下(以前 5 个胶囊容易折成两行) */
      .ctrls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
      .ctrls .sp { flex: 1; }
      /* 胶囊: 不再用小圆点标识系列 —— 启用时整个按钮就是那条线的颜色(省一截宽度) */
      .chip {
        display: inline-flex; align-items: center; cursor: pointer;
        padding: 6px 10px; border-radius: 999px; font-size: 12px;
        color: var(--primary-text-color, #212121);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        transition: background .15s ease;
      }
      .chip:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
      .chip.off { opacity: .6; }
      /* 启用时显示各自的系列色: 蓝=里程 / 橙=耗电 / 绿=百公里能耗 */
      .chip.km.on { background: ${COLOR_KM}; color: #fff; border-color: transparent; }
      .chip.kwh.on { background: ${COLOR_KWH}; color: #fff; border-color: transparent; }
      .chip.eff.on { background: ${COLOR_EFF}; color: #fff; border-color: transparent; }
      .chip.rng.on {
        background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
        border-color: transparent;
      }
      .chip.km.on:hover, .chip.kwh.on:hover, .chip.eff.on:hover, .chip.rng.on:hover { filter: brightness(1.06); }
    `;
  }

  // ── 取数 ──
  async _load(force) {
    if (!this._hass) return;
    const range = this._range;
    const seq = ++this._loadSeq;                  // 给这轮取数发号; 结果回来时对不上就作废
    if (!force && this._cache[range]) {
      // 有缓存就直接换用缓存(切回周视图走的这条路 —— 之前漏了换数据, 看起来"切不回去")
      this._data = this._cache[range];
      this._loading = false;
      this._renderAll();
      return;
    }
    this._loading = true;
    this._err = "";
    if (!this._cache[range]) this._data = null;   // 别把上一个范围的数据顶着新范围的标题显示
    this._renderAll();
    const days = range === "month" ? 30 : 7;
    let res = null;
    try {
      if (this._hass.callWS) {
        res = await this._hass.callWS({ type: "leapmotor/energy/daily", days: days });
      } else {
        throw Object.assign(new Error("no callWS"), { code: "no_callws" });
      }
    } catch (err) {
      if (seq !== this._loadSeq) return;          // 期间用户切了视图 → 丢弃
      res = this._fallback(err, range);
    }
    if (seq !== this._loadSeq) return;
    this._loading = false;
    if (res) {
      this._data = res;
      this._cache[range] = res;
      if (res.vin && !this._vin) {
        // 拿到 vin 后用"这辆车"的偏好键重读一次(首次渲染时还不知道 vin, 用的是兜底键)
        this._vin = res.vin;
        const before = this._range;
        this._prefLoaded = false;
        this._loadPref();
        if (this._range !== before) { this._load(true); return; }
      }
      this._lastLoad = Date.now();
      this._schedulePendingRetry(range, res);
    }
    this._renderAll();
  }

  /** 官方数据还没补完(pending>0)时稍后自动续拉一次 —— 分批取数, 首屏不等一长串请求。 */
  _schedulePendingRetry(range, res) {
    if (this._pendingTimer) return;
    if (!res || !(res.pending > 0)) return;
    if (this._range !== range) return;
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      if (this._range !== range || this._loading) return;
      delete this._cache[range];
      this._load(true);
    }, PENDING_RETRY_MS);
  }

  /** 拿不到 WS 命令时: 周视图退化为读「近7天里程」传感器属性; 月视图给提示。 */
  _fallback(err, range) {
    const code = String((err && err.code) || "");
    const unknown = code === "unknown_command" || code === "no_callws"
      || /unknown command/i.test(String((err && err.message) || ""));
    if (range === "month") {
      this._err = unknown ? "月视图需要 beta 版集成(升级后重试)" : "读取失败: " + this._errText(err);
      return null;
    }
    const st = this._sensorState();
    if (st) {
      const a = st.attributes || {};
      const days = (a.days || []).map((d, i) => {
        const km = a.daily_km && a.daily_km[i] != null ? Number(a.daily_km[i]) : null;
        const kwh = a.daily_kwh && a.daily_kwh[i] != null ? Number(a.daily_kwh[i]) : null;
        return {
          day: String(d), km: km, kwh: kwh,
          // 传感器只有 km/kwh, 自己折算百公里能耗(里程太小不给 —— 除出来没意义)
          eff: km != null && kwh != null && km > 0.5 && kwh > 0
            ? Math.round(kwh / km * 1000) / 10 : null,
        };
      });
      if (days.length) {
        this._err = "";
        let km = 0, kwh = 0;
        for (const d of days) { km += d.km || 0; kwh += d.kwh || 0; }
        return { source: "sensor", days: days, summary: { km: Math.round(km * 10) / 10, kwh: Math.round(kwh * 100) / 100 } };
      }
    }
    this._err = unknown ? "需要 beta 版集成(里程能耗命令未注册)" : "读取失败: " + this._errText(err);
    return null;
  }

  _errText(err) {
    const code = String((err && err.code) || "");
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(String((err && err.message) || ""))) return "需要管理员权限";
    return String((err && err.message) || err || "未知错误").slice(0, 80);
  }

  /** 找「近7天里程」这类传感器(属性里带 days/daily_km 的那个)。 */
  _sensorState() {
    const states = (this._hass && this._hass.states) || {};
    let best = null;
    for (const id of Object.keys(states)) {
      if (id.indexOf("sensor.") !== 0) continue;
      const st = states[id];
      const a = (st && st.attributes) || {};
      if (Array.isArray(a.days) && Array.isArray(a.daily_km)) {
        if (/_jin_7tian_li_cheng$/.test(id)) return st;
        if (!best) best = st;
      }
    }
    return best;
  }

  /** 「近7天里程」传感器一更新就续拉(≥60s 节流), 让周视图跟官方数据同步。 */
  _maybeFollowSensor() {
    const st = this._sensorState();
    if (!st) return;
    const id = st.entity_id || "";
    const stamp = String(st.last_updated || "");
    if (!this._watchId) { this._watchId = id; this._watchStamp = stamp; return; }
    if (id !== this._watchId) { this._watchId = id; this._watchStamp = stamp; return; }
    if (stamp && stamp !== this._watchStamp) {
      this._watchStamp = stamp;
      if (Date.now() - this._lastLoad > REFRESH_THROTTLE_MS && !this._loading) {
        delete this._cache[this._range];
        this._load(true);
      }
    }
  }

  // ── 渲染 ──
  _renderAll() {
    if (!this._built) return;
    if (this._titleEl) this._titleEl.textContent = this._config.title || "";
    this._renderHead();
    this._renderMsg();
    this._renderCtrls();
    this._renderChart();
  }

  _renderHead() {
    const d = this._data;
    if (this._sumEl) {
      if (d && d.days && d.days.length) {
        const km = d.summary && d.summary.km != null ? d.summary.km : 0;
        const kwh = d.summary && d.summary.kwh != null ? d.summary.kwh : 0;
        const scope = this._range === "month" ? "近 30 天" : "近 7 天";
        this._sumEl.textContent = scope + " · " + fmtKm(km) + " km · " + fmtKwh(kwh) + " kWh";
      } else {
        this._sumEl.textContent = "";
      }
    }
    if (this._refreshBtn) this._refreshBtn.classList.toggle("spin", !!this._loading);
  }

  _renderMsg() {
    if (!this._msgEl) return;
    let text = "";
    let err = false;
    if (this._err) { text = this._err; err = true; }
    else if (this._loading && !this._data) text = "读取中…";
    else if (!this._data || !this._data.days || !this._data.days.length) text = "还没有数据";
    else {
      const has = this._data.days.some((d) => d.km != null || d.kwh != null || d.eff != null);
      if (!has) text = "这段时间还没有记录";
    }
    this._msgEl.textContent = text;
    this._msgEl.className = "lmsg" + (text ? " on" : "") + (err ? " err" : "");
  }

  _renderCtrls() {
    if (!this._ctrlsEl) return;
    // 系列芯片: 类名带自己的键(km/kwh/eff), 启用时由 CSS 上对应颜色; 关掉时中性白底。
    const ser = (act, on, key, label, title) =>
      '<button class="chip ' + key + (on ? " on" : " off") +
      '" data-act="' + act + '"' + (title ? ' title="' + esc(title) + '"' : "") + ">" +
      esc(label) + "</button>";
    const rng = (act, on, label, title, val) =>
      '<button class="chip rng' + (on ? " on" : "") + '" data-act="' + act + '"' +
      (val ? ' data-val="' + val + '"' : "") + (title ? ' title="' + esc(title) + '"' : "") +
      ">" + esc(label) + "</button>";
    this._ctrlsEl.innerHTML =
      ser("toggle-km", this._showKm, "km", "里程", "显示/隐藏每日里程折线(km)") +
      ser("toggle-kwh", this._showKwh, "kwh", "耗电", "显示/隐藏每日耗电折线(kWh)") +
      ser("toggle-eff", this._showEff, "eff", "百公里能耗",
          "显示/隐藏百公里能耗折线(kWh/100km, 按本机自记行程计)") +
      '<span class="sp"></span>' +
      rng("range", this._range === "week", "周", "近 7 天", "week") +
      rng("range", this._range === "month", "月", "近 30 天(官方 + 自记)", "month");
  }

  // ── 图表(SVG, 零依赖) ──
  _renderChart() {
    if (!this._boxEl) return;
    const d = this._data;
    // 角落只留"补拉中"这个**进度**提示; 不再标注数据来源(2026-10-08 用户要求去掉)
    this._noteEl.textContent = d && d.pending > 0
      ? "官方数据补拉中(" + d.pending + " 天)" : "";
    if (!d || !d.days || !d.days.length) {
      this._boxEl.innerHTML = "";
      return;
    }
    if (this._day >= d.days.length) this._day = -1;   // 切换范围后旧选中索引失效
    const days = d.days;
    const n = days.length;
    const W = Math.max(240, Math.round(this._boxEl.clientWidth || 360));
    const plotW = W - PAD.l - PAD.r;
    const plotH = CHART_H - PAD.t - PAD.b;
    const kmVals = days.map((x) => (x.km == null ? null : Number(x.km)));
    const kwhVals = days.map((x) => (x.kwh == null ? null : Number(x.kwh)));
    const effVals = days.map((x) => (x.eff == null ? null : Number(x.eff)));
    // 三条可切换的线。每条的 y 轴刻度 = 自己的 nice ticks(量纲不同, 不能共用一根轴)。
    const all = [
      { key: "km", vals: kmVals, color: COLOR_KM, on: this._showKm,
        tipFmt: (v) => "里程 " + fmtKm(v) + " km" },
      { key: "kwh", vals: kwhVals, color: COLOR_KWH, on: this._showKwh,
        tipFmt: (v) => "耗电 " + fmtKwh(v) + " kWh" },
      { key: "eff", vals: effVals, color: COLOR_EFF, on: this._showEff,
        tipFmt: (v) => "百公里能耗 " + fmtEff(v) + " kWh/100km" },
    ];
    const live = all.filter((x) => x.on && x.vals.some((v) => v != null));
    if (!live.length) {                            // 一条可画的线都没有 → 不画空轴
      this._boxEl.innerHTML = "";
      this._renderMsg();
      return;
    }
    for (const x of live) {
      x.axis = niceAxis(Math.max(0, ...x.vals.filter((v) => v != null)), 4);
      x.y = (v) => PAD.t + plotH * (1 - v / x.axis.max);
    }
    // 最多两根刻度轴: 按 里程 → 耗电 → 百公里能耗 的顺序分配左/右;
    // 第三条(三条全开时才会有)用自己独立的刻度但不标刻度线 —— 点一下能看精确值。
    const left = live[0];
    const right = live.length > 1 ? live[1] : null;
    const xs = [];
    for (let i = 0; i < n; i++) xs.push(PAD.l + (i + 0.5) * plotW / n);

    // 网格线由左轴提供
    let svg = '<svg viewBox="0 0 ' + W + " " + CHART_H + '" preserveAspectRatio="none">';
    for (const t of left.axis.ticks) {
      const y = left.y(t);
      svg += '<line class="gridline" x1="' + PAD.l + '" y1="' + y.toFixed(1) +
        '" x2="' + (W - PAD.r) + '" y2="' + y.toFixed(1) + '"/>';
    }
    // 轴刻度(颜色跟着线走, 一眼看出哪根轴对应哪条线)
    const ticks = (x, side) => {
      let out = "";
      for (const t of x.axis.ticks) {
        const tx = side === "l" ? PAD.l - 4 : W - PAD.r + 4;
        out += '<text class="axisTxt ' + x.key + '" x="' + tx + '" y="' + (x.y(t) + 3).toFixed(1) +
          '" text-anchor="' + (side === "l" ? "end" : "start") + '">' + fmtTick(t) + "</text>";
      }
      return out;
    };
    svg += ticks(left, "l");
    if (right) svg += ticks(right, "r");
    // 横轴日期: 周=全标; 月=从"今天"往回按固定间隔标, 保证最后一个标签一定在且不重叠
    const maxLabels = Math.max(2, Math.floor(plotW / 34));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = n - 1; i >= 0; i -= step) {
      svg += '<text class="axisTxt" x="' + xs[i].toFixed(1) + '" y="' + (CHART_H - 6) +
        '" text-anchor="middle">' + esc(fmtDayShort(days[i].day)) + "</text>";
    }
    // 选中的天: 一条竖光带
    if (this._day >= 0 && this._day < n) {
      const bw = plotW / n;
      svg += '<rect class="selcol" x="' + (PAD.l + this._day * bw).toFixed(1) + '" y="' + PAD.t +
        '" width="' + bw.toFixed(1) + '" height="' + plotH + '" rx="3"/>';
    }
    // 折线 + 点(缺数据的日断开, 不硬连); 点自带 data-day, 直接点圆点也能选中
    for (const x of live) {
      const runs = runsOf(x.vals);
      for (const run of runs) {
        if (run.length >= 2) {
          const pts = run.map(([i, v]) => xs[i].toFixed(1) + "," + x.y(v).toFixed(1)).join(" ");
          svg += '<polyline class="line" stroke="' + x.color + '" points="' + pts + '"/>';
        }
      }
      for (const run of runs) {
        for (const [i, v] of run) {
          const sel = i === this._day;
          svg += '<circle class="pt ' + x.key + (sel ? " sel" : "") + '" data-day="' + i +
            '" cx="' + xs[i].toFixed(1) + '" cy="' + x.y(v).toFixed(1) +
            '" r="' + (sel ? 4.2 : 2.6) + '"/>';
        }
      }
    }
    // 点击热区(整列)
    const bw = plotW / n;
    for (let i = 0; i < n; i++) {
      svg += '<rect class="hit" data-day="' + i + '" x="' + (PAD.l + i * bw).toFixed(1) +
        '" y="' + PAD.t + '" width="' + bw.toFixed(1) + '" height="' + plotH + '"/>';
    }
    svg += "</svg>";
    // 气泡
    let tip = "";
    if (this._day >= 0 && this._day < n) {
      const i = this._day;
      const parts = [];
      for (const x of live) {
        const v = x.vals[i];
        if (v != null) parts.push(x.tipFmt(v));
      }
      const dd = days[i];
      if (this._showKwh && dd && dd.kwh != null && dd.kwh > 0
          && dd.kwh_src === "official"
          && (dd.drv != null || dd.ac != null || dd.oth != null)) {
        // 官方 getEC 的当日拆分(驱动/空调/其它)—— 纯数据细节, 不标注来源(2026-10-08 用户要求)
        parts.push("驱动 " + fmtKwh(dd.drv || 0) + " + 空调 " + fmtKwh(dd.ac || 0)
                   + " + 其它 " + fmtKwh(dd.oth || 0));
      }
      if (!parts.length) parts.push("没有数据");
      const cssW = Math.max(1, this._boxEl.clientWidth || W);
      const half = Math.min(90, cssW / 2);
      const tipX = Math.min(cssW - half, Math.max(half, xs[i] * cssW / W));
      tip = '<div class="tip" style="left:' + tipX.toFixed(1) + "px;top:2px;transform:translateX(-50%)" +
        '">' + esc(fmtDayCn(days[i].day)) + " · " + parts.join(" · ") + "</div>";
    }
    this._boxEl.innerHTML = svg + tip;
    this._clampTip();
  }

  /** 气泡渲染后按**实际宽度**再收一次边(文字长短不定, 预估半宽可能不准)。 */
  _clampTip() {
    const tip = this._boxEl ? this._boxEl.querySelector(".tip") : null;
    if (!tip) return;
    const bw = this._boxEl.clientWidth;
    const tw = tip.offsetWidth;
    if (!bw || !tw || tw + 4 > bw) return;      // 比容器还宽就放弃(极端窄屏)
    const min = tw / 2 + 2;
    const max = bw - tw / 2 - 2;
    const cur = parseFloat(tip.style.left) || 0;
    const x = Math.min(max, Math.max(min, cur));
    if (Math.abs(x - cur) > 0.5) tip.style.left = x.toFixed(1) + "px";
  }

  _setDay(i) {
    this._day = i;
    this._renderChart();
  }
}

if (!customElements.get("leapmotor-energy")) {
  customElements.define("leapmotor-energy", LeapmotorEnergyCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-energy")) {
  window.customCards.push({
    type: "leapmotor-energy",
    name: "零跑·里程耗电",
    description: "里程 / 耗电 / 百公里能耗逐日折线(周/月切换, 三线可叠显)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}
console.info(`%c 零跑里程能耗 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");
