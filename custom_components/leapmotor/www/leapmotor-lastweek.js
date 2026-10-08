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
 *
 * 视觉与其它四张卡同一套: 白底大卡 + 白底灰框子块 + 圆形刷新钮, 颜色走 HA 主题变量。
 */

const CARD_VERSION = "1.0.1";

const COLOR_DRIVER = "#1e88e5";   // 蓝 = 驱动耗电
const COLOR_AC = "#26a69a";       // 青 = 空调耗电
const COLOR_OTHER = "#90a4ae";    // 灰蓝 = 其它(低压电器等)

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
  }

  static getStubConfig() {
    return { type: "custom:leapmotor-lastweek" };
  }

  setConfig(config) {
    this._config = config || {};
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this._build();
      this._renderAll();
      this._load(false);
    }
  }

  getCardSize() { return 3; }

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
      '<section class="sec">' +
      '<div class="stack"></div>' +
      '<div class="rows"></div>' +
      '<div class="foot"><span class="tot"></span><span class="ago"></span></div>' +
      "</section>" +
      "</div>";
    this._titleEl = root.querySelector(".head .title");
    this._sumEl = root.querySelector(".head .sum");
    this._msgEl = root.querySelector(".lmsg");
    this._stackEl = root.querySelector(".stack");
    this._rowsEl = root.querySelector(".rows");
    this._totEl = root.querySelector(".tot");
    this._agoEl = root.querySelector(".ago");
    this._refreshBtn = root.querySelector(".head .refresh");
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

      /* 子块: 白底 + 灰框 + 轻阴影(与行程/控制/里程卡同一套) */
      .sec {
        background: var(--ha-card-background, var(--card-background-color, #fff));
        border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
        border-radius: 14px; padding: 12px;
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
        flex: 0 0 auto; min-width: 40px; text-align: right; font-size: 12px;
        color: var(--secondary-text-color, #6b7280);
      }
      .foot {
        display: flex; align-items: center; gap: 8px; padding-top: 8px;
        border-top: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        font-size: 12px; color: var(--secondary-text-color, #6b7280);
      }
      .foot .tot { font-weight: 600; color: var(--primary-text-color, #212121); }
      .foot .ago { margin-left: auto; }
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
      { key: "driver", name: "驱动", color: COLOR_DRIVER },
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
        '<span class="lb">' + esc(it.name) + "</span>" +
        '<span class="vl">' + (v == null ? "—" : fmtKwh(v)) + "</span>" +
        '<span class="un">kWh</span>' +
        '<span class="pc">' + esc(pct) + "</span>" +
        "</div>";
    }
    this._rowsEl.innerHTML = rows;
    // 合计 + 更新时间
    if (total != null) {
      this._totEl.textContent = "合计 " + fmtKwh(total) + " kWh";
    } else {
      this._totEl.textContent = "合计 —";
    }
    this._agoEl.textContent = d && d.fetched_at ? "更新于 " + fmtUpdated(d.fetched_at) : "";
    // 合计 0(上周没用车/没数据): 明细行保留("—"), 只有一条温和提示
    if (d && total === 0 && !this._err) {
      this._msgEl.textContent = "上周没有能耗记录";
      this._msgEl.className = "lmsg on";
    }
  }
}

if (!customElements.get("leapmotor-lastweek")) {
  customElements.define("leapmotor-lastweek", LeapmotorLastweekCard);
}
window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-lastweek")) {
  window.customCards.push({
    type: "leapmotor-lastweek",
    name: "零跑·上周能耗",
    description: "上周能耗拆分: 驱动 / 空调 / 其它(堆叠条 + 明细)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}
console.info(`%c 零跑上周能耗 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");
