/**
 * 零跑 · 上周能耗 —— 把上一整周(周一~周日)的能耗拆成 驱动 / 空调 / 其它 三块。
 *
 * 数据来自云端 `getLastweekEC`(官方就有这张周报), 由集成按需取:
 *   * 卡片打开时通过 WebSocket `leapmotor/energy/lastweek` 拿(集成里有 1 小时缓存);
 *   * 「上周」= 上一个**完整自然周**, 周一零点自动翻篇(缓存随之失效, 下次打开卡片重取);
 *   * 右上角刷新按钮强制重取一次。
 *
 * 读法: 一根堆叠条按比例分红/青/灰三段, 下面三行给各自的 kWh 与占比, 末行是合计。
 * 数值是云端汇总(字符串 kWh), 缺字段显示 "—" —— 不会把"没数据"画成 0。
 *
 * 配置:
 *   type: custom:leapmotor-lastweek
 *   title: 上周能耗        # 可选
 *   style: donut          # 可选, donut(圆环, 默认, 仿官方 App) | bar(堆叠条 + 明细)
 *
 * 两种样式点右上角的小胶囊按钮切换, 选择按浏览器本地记忆。视觉与其它四张卡同一套:
 * 白底大卡 + 白底灰框子块 + 圆形刷新钮, 颜色走 HA 主题变量。
 */

const CARD_VERSION = "1.1.5";

/* 配色对齐官方 App 的三色: 驾驶=绿 / 空调=蓝 / 其它=橙 */
const COLOR_DRIVER = "#43a047";   // 绿 = 行车(驱动)能耗
const COLOR_AC = "#2196f3";       // 蓝 = 空调能耗
const COLOR_OTHER = "#ffb300";    // 橙 = 其它能耗

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
/** epoch 秒 → "9月21日" */
function fmtDayCn(ts) {
  const n = Number(ts);
  if (!n) return "";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日";
}
/** epoch 秒 → "23:05"(今天)/ "10-04 23:05"(更早) */
function fmtUpdated(ts) {
  const n = Number(ts);
  if (!n) return "";
  const d = new Date(n * 1000);
  const hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return (d.getMonth() + 1) + "-" + String(d.getDate()).padStart(2, "0") + " " + hm;
}
function fmtKwh(v) { return String(Number(Number(v).toFixed(2))); }
function fmtPct(v) { return Math.round(Number(v) * 10) / 10; }

class LeapmotorLastweekCard extends HTMLElement {
  constructor() {
    super();
    this._config = null;
    this._hass = null;
    this._built = false;
    this._data = null;
    this._loading = false;
    this._err = "";
    this._hint = "";
    this._fetchedOnce = false;
    this._style = "donut";        // donut(圆环, 仿官方 App) | bar(堆叠条)
    this._prefLoaded = false;
  }

  static getStubConfig() {
    return { type: "custom:leapmotor-lastweek", style: "donut" };
  }

  setConfig(config) {
    this._config = config || {};
    const s = this._config.style;
    if (s === "bar" || s === "donut") this._style = s;
    this._prefLoaded = false;
  }

  _prefKey() { return "leapmotor-lastweek.style"; }
  _loadPref() {
    if (this._prefLoaded) return;
    this._prefLoaded = true;
    if (this._config && (this._config.style === "bar" || this._config.style === "donut")) return;
    try {
      const s = window.localStorage.getItem(this._prefKey());
      if (s === "bar" || s === "donut") this._style = s;
    } catch (err) { /* 本地存储不可用就算了 */ }
  }
  _savePref() {
    try { window.localStorage.setItem(this._prefKey(), this._style); } catch (err) { /* ignore */ }
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this._loadPref();
      this._build();
      this._renderAll();
      this._load(false);
    }
  }

  // 圆环排布比堆叠条高, 给足行数, 免得在分区视图里因高度不足被裁("超出卡片范围")
  getCardSize() { return this._style === "bar" ? 3 : 5; }

  // ── 构建 ──
  _build() {
    const root = this.attachShadow({ mode: "open" });
    root.innerHTML =
      "<style>" + this._css() + "</style>" +
      '<div class="card">' +
      '<div class="head"><span class="title"></span><span class="sum"></span>' +
      '<span class="spacer"></span>' +
      '<button class="stchip" title="切换样式: 圆环 / 堆叠条"></button>' +
      '<button class="refresh" title="重新读取"><ha-icon icon="mdi:refresh"></ha-icon></button>' +
      "</div>" +
      '<div class="lmsg"></div>' +
      '<section class="sec">' +
      '<div class="lwbody">' +
      '<div class="donutWrap"><div class="donut"></div></div>' +
      '<div class="lwmetrics"><div class="stack"></div><div class="rows"></div>' +
      '<div class="lwago"></div></div>' +
      "</div>" +
      '<div class="foot"><span class="tot"></span><span class="ago"></span></div>' +
      "</section>" +
      "</div>";
    this._titleEl = root.querySelector(".head .title");
    this._sumEl = root.querySelector(".head .sum");
    this._msgEl = root.querySelector(".lmsg");
    this._secEl = root.querySelector(".sec");
    this._stackEl = root.querySelector(".stack");
    this._rowsEl = root.querySelector(".rows");
    this._donutEl = root.querySelector(".donut");
    this._totEl = root.querySelector(".tot");
    this._agoEl = root.querySelector(".ago");                       // (旧引用, 可能为 null)
    this._agoMetricsEl = root.querySelector(".lwago");
    this._stBtn = root.querySelector(".head .stchip");
    this._refreshBtn = root.querySelector(".head .refresh");
    this._stBtn.addEventListener("click", () => {
      this._style = this._style === "donut" ? "bar" : "donut";
      this._savePref();
      this._renderAll();
    });
    this._refreshBtn.addEventListener("click", () => {
      if (this._loading) return;
      this._load(true);
    });
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
        align-items: stretch;
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
        width: 27px; height: 27px; padding: 0; border-radius: 50%;
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
      .head button.refresh ha-icon { width: 16px; height: 16px; --mdc-icon-size: 16px; }
      /* 样式切换钮: 圆形, 只放一个图标(圆环/条形) */
      .head button.stchip {
        width: 27px; height: 27px; padding: 0; border-radius: 50%;
        display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
        color: var(--secondary-text-color, #6b7280);
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        transition: background .15s ease;
      }
      .head button.stchip:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
      .head button.stchip ha-icon { width: 16px; height: 16px; --mdc-icon-size: 16px; }
      ha-icon { display: inline-flex; width: 16px; height: 16px; --mdc-icon-size: 16px; }

      .lmsg { display: none; font-size: 12px; color: var(--secondary-text-color, #6b7280); padding: 2px 2px 0; }
      .lmsg.on { display: block; }
      .lmsg.err { color: var(--error-color, #db4437); }

      /* 子块: 白底 + 灰框 + 轻阴影(与行程/控制/里程卡同一套) */
      .sec {
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        border-radius: 14px; padding: 12px; box-sizing: border-box;
        width: 100%; min-width: 0;
        display: flex; flex-direction: column; gap: 10px;
      }
      /* 堆叠条: 三段按占比分宽; 空数据不画 */
      .stack {
        display: flex; height: 12px; border-radius: 999px; overflow: hidden;
        background: var(--secondary-background-color, #e7eaed);
      }
      .stack:empty { display: none; }
      .seg { min-width: 2px; }
      .seg.driver { background: ${COLOR_DRIVER}; }
      .seg.ac { background: ${COLOR_AC}; }
      .seg.other { background: ${COLOR_OTHER}; }
      .rows { display: flex; flex-direction: column; gap: 6px; }
      .row { display: flex; align-items: center; gap: 8px; }
      .row .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
      .row .dot.driver { background: ${COLOR_DRIVER}; }
      .row .dot.ac { background: ${COLOR_AC}; }
      .row .dot.other { background: ${COLOR_OTHER}; }
      .row .lb { flex: 1 1 auto; min-width: 0; }
      .row .vl { font-weight: 600; font-size: 15px; white-space: nowrap; }
      .row .un { font-size: 11px; font-weight: 500; margin-left: 2px; color: var(--secondary-text-color, #6b7280); }
      .row .pc {
        flex: 0 0 auto; min-width: 46px; text-align: right; font-size: 12px;
        color: var(--secondary-text-color, #6b7280);
      }
      .sec.mode-donut .pc { display: block; }
      .foot {
        display: flex; align-items: center; gap: 8px;
        font-size: 12px; color: var(--secondary-text-color, #6b7280);
      }
      .foot .tot { font-weight: 600; color: var(--primary-text-color, #212121); }
      /* "更新于"紧跟在数据之后, 用一条分割线与明细分开 */
      .lwago {
        margin-top: 2px; padding-top: 8px; font-size: 11px; text-align: right;
        color: var(--secondary-text-color, #6b7280);
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
      }
      /* 圆环(仿官方 App) */
      /* 圆环 + 明细: 宽度够时**左右分**(圆环在左, 数值在右), 窄了自动上下堆叠 */
      .lwbody { display: flex; align-items: center; gap: 18px; flex-wrap: wrap; }
      .donutWrap { flex: 0 0 auto; }
      .lwmetrics { flex: 1 1 170px; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
      .donut { position: relative; flex: 0 0 auto; width: 150px; height: 150px; }
      .donut svg { display: block; width: 100%; height: 100%; }
      .donut .ring-bg { fill: none; stroke: var(--secondary-background-color, #e7eaed); stroke-width: 16; }
      .donut .ring-seg { fill: none; stroke-width: 16; stroke-linecap: butt; transition: stroke-dasharray .3s ease; }
      .donutCenter {
        position: absolute; left: 0; top: 0; width: 100%; height: 100%;
        display: flex; flex-direction: column; align-items: center; justify-content: center;
        pointer-events: none; gap: 2px;
      }
      .donutCenter .dtot { font-size: 30px; font-weight: 600; line-height: 1; letter-spacing: -.5px; }
      .donutCenter .dlab { font-size: 11px; color: var(--secondary-text-color, #6b7280); }
      /* 两种样式互斥显示 */
      .sec.mode-donut .stack { display: none; }
      .sec.mode-donut .foot { display: none; }        /* 圆环态合计在圆心, 不需要底部合计 */
      .sec.mode-bar .donutWrap { display: none; }
      .sec.mode-bar .row .pc { display: none; }
      .sec.mode-bar .lwago { display: none; }         /* 条形态"更新于"仍走 .foot */
      .sec.mode-bar .foot { padding-top: 8px; border-top: 1px solid var(--divider-color, rgba(0, 0, 0, .09)); }
      .sec.mode-bar .foot .ago { margin-left: auto; }
    `;
  }

  // ── 取数 ──
  async _load(force) {
    if (!this._hass) return;
    this._loading = true;
    this._err = "";
    this._hint = "";
    this._renderAll();
    let res = null;
    try {
      if (!this._hass.callWS) throw Object.assign(new Error("no callWS"), { code: "no_callws" });
      res = await this._hass.callWS({
        type: "leapmotor/energy/lastweek", refresh: !!force,
      });
    } catch (err) {
      this._loading = false;
      const code = String((err && err.code) || "");
      const unknown = code === "unknown_command" || code === "no_callws"
        || /unknown command/i.test(String((err && err.message) || ""));
      if (unknown) {
        // "命令没注册"是版本问题, 不是错误 —— 用普通提示色, 不吓用户(与行程/里程卡同一约定)
        this._hint = "需要更新版集成(上周能耗命令未注册)";
        this._err = "";
      } else {
        this._hint = "";
        this._err = this._errText(err);
      }
      this._renderAll();
      return;
    }
    this._loading = false;
    this._fetchedOnce = true;
    const bd = res && res.breakdown;
    if (bd) {
      this._data = { breakdown: bd, week: res.week || null, fetched_at: res.fetched_at };
    } else if (force) {
      this._err = "暂时拿不到上周数据(稍后自动重试)";
    }
    this._renderAll();
  }

  _errText(err) {
    const code = String((err && err.code) || "");
    const msg = String((err && err.message) || err || "");
    if (code === "unknown_command" || code === "no_callws" || /unknown command/i.test(msg)) {
      return "需要更新版集成(上周能耗命令未注册)";
    }
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(msg)) return "需要管理员权限";
    return "读取失败: " + (msg || "未知错误").slice(0, 80);
  }

  // ── 渲染 ──
  _renderAll() {
    if (!this._built) return;
    const title = (this._config && this._config.title) || "上周能耗";
    this._titleEl.textContent = title;
    const d = this._data;
    // 摘要行: 周窗口(如 "9月21日 – 9月27日")
    if (d && d.week && d.week.begin) {
      this._sumEl.textContent = fmtDayCn(d.week.begin) + " – " + fmtDayCn(d.week.end);
    } else {
      this._sumEl.textContent = "";
    }
    this._refreshBtn.classList.toggle("spin", !!this._loading);
    // 消息行
    let text = "";
    let err = false;
    if (this._err) { text = this._err; err = true; }
    else if (this._hint) { text = this._hint; }
    else if (this._loading && !d) text = "读取中…";
    else if (!d && this._fetchedOnce) text = "暂时拿不到上周数据(稍后自动重试)";
    this._msgEl.textContent = text;
    this._msgEl.className = "lmsg" + (text ? " on" : "") + (err ? " err" : "");
    // 明细
    const items = [
      { key: "driver", name: "行车", color: COLOR_DRIVER },
      { key: "ac", name: "空调", color: COLOR_AC },
      { key: "other", name: "其它", color: COLOR_OTHER },
    ];
    const bd = d && d.breakdown;
    const total = bd && bd.total != null ? Number(bd.total) : null;
    const vals = {};
    for (const it of items) {
      const v = bd ? bd[it.key] : null;
      vals[it.key] = v == null ? null : Number(v);
    }
    // 堆叠条: 有数据且合计 > 0 才画
    let stack = "";
    if (total != null && total > 0) {
      for (const it of items) {
        const v = vals[it.key];
        const pct = v == null ? 0 : Math.max(0, v) / total * 100;
        if (pct <= 0) continue;
        stack += '<span class="seg ' + it.key + '" style="width:' + pct.toFixed(2) + '%"></span>';
      }
    }
    this._stackEl.innerHTML = stack;
    // 三行明细
    let rows = "";
    for (const it of items) {
      const v = vals[it.key];
      const pct = (v != null && total) ? fmtPct(v / total * 100) + "%" : "—";
      rows += '<div class="row" data-key="' + it.key + '">' +
        '<span class="dot ' + it.key + '"></span>' +
        '<span class="lb">' + esc(it.name) + "能耗</span>" +
        '<span class="vl">' + (v == null ? "—" : fmtKwh(v)) + "</span>" +
        '<span class="un">kWh</span>' +
        '<span class="pc">' + esc(pct) + "</span>" +
        "</div>";
    }
    this._rowsEl.innerHTML = rows;
    // 圆环(仿官方 App): 环形分段 + 中心合计 + 右侧图例
    this._renderDonut(items, vals, total);
    // 两种样式的显隐(类挂在 section 上)
    this._secEl.className = "sec " + (this._style === "bar" ? "mode-bar" : "mode-donut");
    if (this._stBtn) {
      const donut = this._style !== "bar";
      this._stBtn.innerHTML = '<ha-icon icon="' + (donut ? "mdi:chart-donut" : "mdi:chart-bar") +
        '"></ha-icon>';
      this._stBtn.title = donut ? "当前: 圆环(点一下切到条形)" : "当前: 条形(点一下切到圆环)";
    }
    // 合计 + 更新时间
    if (total != null) {
      this._totEl.textContent = "合计 " + fmtKwh(total) + " kWh";
    } else {
      this._totEl.textContent = "合计 —";
    }
    // "更新于": 条形态放 foot 右侧; 圆环态放明细下方(lwago, 带分割线, 更紧凑)
    const agoTxt = d && d.fetched_at ? "更新于 " + fmtUpdated(d.fetched_at) : "";
    if (this._agoEl) this._agoEl.textContent = agoTxt;
    if (this._agoMetricsEl) {
      this._agoMetricsEl.textContent = agoTxt;
      this._agoMetricsEl.style.display = agoTxt ? "" : "none";
    }
    // 合计 0(上周没用车/没数据): 明细行保留("—"), 只有一条温和提示
    if (d && total === 0 && !this._err) {
      this._msgEl.textContent = "上周没有能耗记录";
      this._msgEl.className = "lmsg on";
    }
  }

  /** 圆环: 三个环形分段(按占比) + 中心合计; 明细数值沿用条形那套 .rows(名字+数值+占比)。 */
  _renderDonut(items, vals, total) {
    if (!this._donutEl) return;
    const R = 64, CX = 84, CY = 84, C = 2 * Math.PI * R;
    let segs = '<circle class="ring-bg" cx="' + CX + '" cy="' + CY + '" r="' + R + '"/>';
    if (total != null && total > 0) {
      let acc = 0;
      for (const it of items) {
        const v = vals[it.key];
        if (v == null || v <= 0) continue;
        const frac = v / total;
        const len = Math.max(0, frac * C);
        // stroke-dasharray = [本段长度, 其余]; dashoffset 把本段起点推到 acc 处(顺时针)
        segs += '<circle class="ring-seg" cx="' + CX + '" cy="' + CY + '" r="' + R +
          '" stroke="' + it.color + '" stroke-dasharray="' + len.toFixed(2) + " " +
          (C - len).toFixed(2) + '" stroke-dashoffset="' + (-acc * C).toFixed(2) +
          '" transform="rotate(-90 ' + CX + " " + CY + ')"/>';
        acc += frac;
      }
    }
    const dtot = total != null ? fmtKwh(total) : "—";
    this._donutEl.innerHTML =
      '<svg viewBox="0 0 168 168" preserveAspectRatio="xMidYMid meet">' + segs + "</svg>" +
      '<div class="donutCenter"><span class="dtot">' + esc(dtot) +
      '</span><span class="dlab">总能耗(kWh)</span></div>';
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
_defineCard("leapmotor-lastweek", LeapmotorLastweekCard);
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-lastweek")) {
  window.customCards.push({
    type: "leapmotor-lastweek",
    name: "零跑·上周能耗",
    description: "上周能耗拆分: 驱动 / 空调 / 其它(圆环 或 堆叠条 + 明细)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}
console.info(`%c 零跑上周能耗 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");
