// 零跑 · 上周电耗 —— 把上一整周(周一~周日)的**电耗**拆成 驱动 / 空调 / 其它 三块。
//
// 数据来自云端 `getLastweekEC`(官方就有这张周报), 由集成按需取:
//   * 卡片打开时通过 WebSocket `leapmotor/energy/lastweek` 拿(集成里有 1 小时缓存);
//   * 「上周」= 上一个**完整自然周**, 周一零点自动翻篇(缓存随之失效, 下次打开卡片重取);
//   * 右上角刷新按钮强制重取一次。
//
// 读法: 一根堆叠条按比例分红/青/灰三段, 下面三行给各自的 kWh 与占比, 末行是合计。
// 数值是云端汇总(字符串 kWh), 缺字段显示 "—" —— 不会把"没数据"画成 0。
//
// 配置:
//   type: custom:leapmotor-lastweek
//   title: 上周电耗        # 可选
//   style: donut          # 可选, donut(圆环, 默认, 仿官方 App) | bar(堆叠条 + 明细)
//
// 两种样式点右上角的小胶囊按钮切换, 选择按浏览器本地记忆。视觉与其它四张卡同一套:
// 白底大卡 + 白底灰框子块 + 圆形刷新钮, 颜色走 HA 主题变量。
//
// ⚠️ 本文件是 Lit + TS 重构版, 行为与视觉须与原 leapmotor-lastweek.js **逐项等价**:
//    元素名/配置字段/localStorage 键/WS 命令/错误文案/条件显示/圆环与条纹几何/动画 全部保留。
import { LitElement, html, css, nothing, unsafeCSS, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { HomeAssistant, LovelaceCardConfig } from "../types/hass";
import { esc } from "../lib/dom";
import { fmtDayCnTs, fmtKwh, fmtPct1, fmtUpdated } from "../lib/format";
import { ipIcon } from "../lib/icons";
import { callWs, isUnknownCommand } from "../lib/ws";
import { isDark } from "../lib/theme";
import { defineCard, registerCustomCard, banner } from "../lib/register";
import { CARD_VERSIONS } from "../lib/version";
import { interactionStyles } from "../lib/motion";
import { uiStyles } from "../lib/ui/styles";
import { bindAppearance, unbindAppearance } from "../lib/appearance";

const CARD_VERSION = CARD_VERSIONS.lastweek;

/* 配色对齐官方 App 的三色: 驾驶=绿 / 空调=蓝 / 其它=橙 */
const COLOR_DRIVER = "#43a047"; // 绿 = 行车(驱动)能耗
const COLOR_AC = "#2196f3"; // 蓝 = 空调能耗
const COLOR_OTHER = "#ffb300"; // 橙 = 其它能耗

interface WeekBreakdown {
  driver?: number | string | null;
  ac?: number | string | null;
  other?: number | string | null;
  total?: number | string | null;
}
interface WeekData {
  breakdown: WeekBreakdown;
  week: { begin?: number; end?: number } | null;
  fetched_at?: number;
}

interface Item {
  key: "driver" | "ac" | "other";
  name: string;
  color: string;
}

const ITEMS: Item[] = [
  { key: "driver", name: "行车", color: COLOR_DRIVER },
  { key: "ac", name: "空调", color: COLOR_AC },
  { key: "other", name: "其它", color: COLOR_OTHER },
];

class LeapmotorLastweekCard extends LitElement {
  private _config: LovelaceCardConfig | null = null;
  private _hass: HomeAssistant | null = null;
  private _built = false;
  private _data: WeekData | null = null;
  private _loading = false;
  private _err = "";
  private _hint = "";
  private _fetchedOnce = false;
  private _style: "donut" | "bar" = "donut"; // donut(圆环, 仿官方 App) | bar(堆叠条)
  private _prefLoaded = false;

  static getStubConfig() {
    return { type: "custom:leapmotor-lastweek", style: "donut" };
  }

  /** 卡片配色(本机; 六张卡统一): 连接期间订阅配色变化 —— 变量写在宿主元素上(见 lib/palette.ts) */
  connectedCallback() {
    super.connectedCallback();
    // 界面风格 + 本机主题色(六张卡统一; 变量写在宿主元素上, 见 lib/appearance.ts)
    bindAppearance(this, { getDark: () => isDark(this._hass) });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    unbindAppearance(this); // 外观订阅同样只在"连接期间"需要
  }

  setConfig(config: LovelaceCardConfig) {
    this._config = config || {};
    const s = this._config.style;
    if (s === "bar" || s === "donut") this._style = s;
    this._prefLoaded = false;
    // 配置变化时若已建好, 直接重绘(与原实现一致: 元素已挂载则刷新)
    if (this._built) this.requestUpdate();
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (!this._built) {
      this._built = true;
      this._loadPref();
      this._load(false);
      return;
    }
    this.requestUpdate();
  }
  // 与 trips/energy 保持一致:有 setter 就给 getter —— 否则 `card.hass` 读出来是
  // undefined(原型上只挂了 setter), 任何读它的代码(含测试/HA 侧包装)都拿不到状态。
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  // 圆环排布比堆叠条高, 给足行数, 免得在分区视图里因高度不足被裁("超出卡片范围")
  getCardSize() {
    return this._style === "bar" ? 3 : 5;
  }

  // ── 本地偏好 ──
  private _prefKey() {
    return "leapmotor-lastweek.style";
  }
  private _loadPref() {
    if (this._prefLoaded) return;
    this._prefLoaded = true;
    if (this._config && (this._config.style === "bar" || this._config.style === "donut")) return;
    try {
      const s = window.localStorage.getItem(this._prefKey());
      if (s === "bar" || s === "donut") this._style = s;
    } catch (err) {
      /* 本地存储不可用就算了 */
    }
  }
  private _savePref() {
    try {
      window.localStorage.setItem(this._prefKey(), this._style);
    } catch (err) {
      /* ignore */
    }
  }

  // ── 取数 ──
  private async _load(force: boolean) {
    if (!this._hass) return;
    this._loading = true;
    this._err = "";
    this._hint = "";
    this.requestUpdate();
    let res: any = null;
    try {
      res = await callWs(this._hass, { type: "leapmotor/energy/lastweek", refresh: !!force });
    } catch (err) {
      this._loading = false;
      if (isUnknownCommand(err)) {
        // "命令没注册"是版本问题, 不是错误 —— 安静留空(与行程/里程卡同一约定)
        this._hint = "";
        this._err = "";
      } else {
        this._hint = "";
        this._err = this._errText(err);
      }
      this.requestUpdate();
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
    this.requestUpdate();
  }

  private _errText(err: unknown) {
    const { code, message } = { code: String((err as any)?.code || ""), message: String((err as any)?.message || err || "") };
    if (code === "unknown_command" || code === "no_callws" || /unknown command/i.test(message)) {
      return ""; // 同上: 不再提示"需要更新版集成"
    }
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(message)) return "需要管理员权限";
    return "读取失败: " + (message || "未知错误").slice(0, 80);
  }

  // ── 交互 ──
  private _onToggleStyle() {
    this._style = this._style === "donut" ? "bar" : "donut";
    this._savePref();
    this.requestUpdate();
  }
  private _onRefresh() {
    if (this._loading) return;
    this._load(true);
  }

  // ── 计算 ──
  private _totals() {
    const bd = this._data && this._data.breakdown;
    const total = bd && bd.total != null ? Number(bd.total) : null;
    const vals: Record<string, number | null> = {};
    for (const it of ITEMS) {
      const v = bd ? (bd as any)[it.key] : null;
      vals[it.key] = v == null ? null : Number(v);
    }
    return { total, vals };
  }

  // ── 渲染(与原实现同结构: .card/.head/.lmsg/.sec/.stack/.rows/.donut/.foot) ──
  render() {
    if (!this._config) return nothing;
    const title = (this._config.title as string) || "上周电耗";
    const d = this._data;
    const { total, vals } = this._totals();

    // 摘要行: 周窗口(如 "9月21日 – 9月27日")
    const sum =
      d && d.week && d.week.begin
        ? fmtDayCnTs(d.week.begin) + " – " + fmtDayCnTs(d.week.end)
        : "";

    // 消息行
    let text = "";
    let err = false;
    if (this._err) {
      text = this._err;
      err = true;
    } else if (this._hint) {
      text = this._hint;
    } else if (this._loading && !d) text = "读取中…";
    else if (!d && this._fetchedOnce) text = "暂时拿不到上周数据(稍后自动重试)";
    // 合计 0(上周没用车/没数据): 明细行保留("—"), 只有一条温和提示
    if (d && total === 0 && !this._err) {
      text = "上周没有能耗记录";
      err = false;
    }

    const donut = this._style !== "bar";
    const agoTxt = d && d.fetched_at ? "更新于 " + fmtUpdated(d.fetched_at) : "";

    return html`
      <div class="card">
        <div class="head">
          <span class="title">${title}</span>
          <span class="sum">${sum}</span>
          <span class="spacer"></span>
          <button
            class="stchip"
            title=${donut ? "当前: 圆环(点一下切到条形)" : "当前: 条形(点一下切到圆环)"}
            @click=${this._onToggleStyle}
          >
            ${unsafeSVG(ipIcon(donut ? "ring" : "histogram", 18))}
          </button>
          <button
            class="refresh ${this._loading ? "spin" : ""}"
            title="重新读取"
            @click=${this._onRefresh}
          >
            ${unsafeSVG(ipIcon("redo", 16))}
          </button>
        </div>
        <div class="lmsg ${text ? "on" : ""} ${err ? "err" : ""}">
          <span>${text}</span>
        </div>
        <section class="sec ${donut ? "mode-donut" : "mode-bar"}">
          <div class="lwbody">
            <div class="donutWrap">
              <div class="donut">
                <svg viewBox="0 0 168 168" preserveAspectRatio="xMidYMid meet">
                  <circle class="ring-bg" cx="84" cy="84" r="64"></circle>
                  ${unsafeSVG(this._donutSegs(vals, total))}
                </svg>
                <div class="donutCenter">
                  <span class="dtot">${esc(total != null ? fmtKwh(total) : "—")}</span>
                  <span class="dlab">总能耗(kWh)</span>
                </div>
              </div>
            </div>
            <div class="lwmetrics">
              <div class="stack">${this._renderStack(vals, total)}</div>
              <div class="rows">${this._renderRows(vals, total)}</div>
              <div class="lwago" style=${agoTxt ? "" : "display:none"}>${agoTxt}</div>
            </div>
          </div>
          <div class="foot">
            <span class="tot">${total != null ? "合计 " + fmtKwh(total) + " kWh" : "合计 —"}</span>
            <span class="ago">${agoTxt}</span>
          </div>
        </section>
      </div>
    `;
  }

  /** 堆叠条: 有数据且合计 > 0 才画。 */
  private _renderStack(vals: Record<string, number | null>, total: number | null) {
    if (total == null || total <= 0) return nothing;
    const segs: TemplateResult[] = [];
    for (const it of ITEMS) {
      const v = vals[it.key];
      const pct = v == null ? 0 : Math.max(0, v) / total * 100;
      if (pct <= 0) continue;
      segs.push(
        html`<span class="seg ${it.key}" style="width:${pct.toFixed(2)}%"></span>`
      );
    }
    return segs;
  }

  /** 三行明细。 */
  private _renderRows(vals: Record<string, number | null>, total: number | null) {
    return ITEMS.map((it) => {
      const v = vals[it.key];
      const pct = v != null && total ? fmtPct1((v / total) * 100) + "%" : "—";
      return html`
        <div class="row" data-key=${it.key}>
          <span class="dot ${it.key}"></span>
          <span class="lb">${esc(it.name)}能耗</span>
          <span class="vl">${v == null ? "—" : fmtKwh(v)}</span>
          <span class="un">kWh</span>
          <span class="pc">${esc(pct)}</span>
        </div>
      `;
    });
  }

  /** 圆环分段: 返回三个(或更少)环形 <circle> 的 **SVG 标记字符串**。
   *
   * ⚠️ 必须用字符串 + unsafeSVG 注入, **不能**返回子模板(TemplateResult)再插进外层 <svg>:
   *    lit 在"子模板"这一层不会继承父级的 SVG 命名空间, 里面的 <circle> 会被建成 HTML
   *    元素 —— DOM 里存在但浏览器不渲染, 表现为"圆环不显示"(实测踩过)。
   *    用字符串贴进 <svg> 内部则由解析器按 SVG 命名空间建元素, 正常显示。 */
  private _donutSegs(vals: Record<string, number | null>, total: number | null): string {
    const R = 64,
      CX = 84,
      CY = 84,
      C = 2 * Math.PI * R;
    let out = "";
    if (total != null && total > 0) {
      let acc = 0;
      for (const it of ITEMS) {
        const v = vals[it.key];
        if (v == null || v <= 0) continue;
        const frac = v / total;
        const len = Math.max(0, frac * C);
        // stroke-dasharray = [本段长度, 其余]; dashoffset 把本段起点推到 acc 处(顺时针)
        out +=
          '<circle class="ring-seg" cx="' + CX + '" cy="' + CY + '" r="' + R +
          '" stroke="' + it.color +
          '" stroke-dasharray="' + len.toFixed(2) + " " + (C - len).toFixed(2) +
          '" stroke-dashoffset="' + (-acc * C).toFixed(2) +
          '" transform="rotate(-90 ' + CX + " " + CY + ')"></circle>';
        acc += frac;
      }
    }
    return out;
  }

  static styles = css`
    ${unsafeCSS(interactionStyles)}
    :host { display: block; }
    .card {
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
    /* 刷新按钮: 圆形白底 + 一层阴影(1.9.40 起与控车卡同款: 不描边); hover 淡蓝。
       ⚠️ border: 0 不能省: 只删掉原来的 1px 会让 <button> 露出 UA 默认的 2px outset 描边。 */
    .head button.refresh {
      width: 27px; height: 27px; padding: 0; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      color: var(--secondary-text-color, #6b7280);
      background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
      border: 0;
      box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      transition: background .15s ease;
    }
    .head button.refresh:not([disabled]):hover {
      background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
    }
    .head button.refresh.spin { opacity: .45; }
    .head button.refresh ha-icon { width: 16px; height: 16px; --mdc-icon-size: 16px; }
    /* 样式切换钮: 圆形, 只放一个图标(圆环/条形); 同款: 不描边 + 一层阴影 */
    .head button.stchip {
      width: 27px; height: 27px; padding: 0; border-radius: 50%;
      display: inline-flex; align-items: center; justify-content: center; cursor: pointer;
      color: var(--secondary-text-color, #6b7280);
      background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
      border: 0;
      box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      transition: background .15s ease;
    }
    .head button.stchip:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
    .head button.stchip ha-icon { width: 16px; height: 16px; --mdc-icon-size: 16px; }
    .ip { display: inline-block; vertical-align: middle; flex: none; }
    ha-icon { display: inline-flex; width: 16px; height: 16px; --mdc-icon-size: 16px; }

    .lmsg { display: none; font-size: 12px; color: var(--secondary-text-color, #6b7280); padding: 2px 2px 0; }
    .lmsg.on { display: block; }
    .lmsg.err { color: var(--error-color, #db4437); }

    /* 子块: 白底 + 一层阴影(与行程/控制/里程卡同一套; 1.9.40 起不描边) */
    .sec {
      background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
      border: 0;
      box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      border-radius: var(--lm-radius-section, 14px); padding: 12px; box-sizing: border-box;
      width: 100%; min-width: 0;
      display: flex; flex-direction: column; gap: 10px;
    }
    /* 堆叠条: 三段按占比分宽; 空数据不画 */
    .stack {
      display: flex; height: 12px; border-radius: var(--lm-radius-badge, 999px); overflow: hidden;
      background: var(--secondary-background-color, #e7eaed);
    }
    .stack:empty { display: none; }
    .seg { min-width: 2px; }
    .seg.driver { background: ${unsafeCSS(COLOR_DRIVER)}; }
    .seg.ac { background: ${unsafeCSS(COLOR_AC)}; }
    .seg.other { background: ${unsafeCSS(COLOR_OTHER)}; }
    .rows { display: flex; flex-direction: column; gap: 6px; }
    .row { display: flex; align-items: center; gap: 8px; }
    .row .dot { flex: 0 0 auto; width: 8px; height: 8px; border-radius: 50%; }
    .row .dot.driver { background: ${unsafeCSS(COLOR_DRIVER)}; }
    .row .dot.ac { background: ${unsafeCSS(COLOR_AC)}; }
    .row .dot.other { background: ${unsafeCSS(COLOR_OTHER)}; }
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
    /* 两种模式共用单行明细；窄卡片缩小圆环，保留百分比。 */
    .lwbody { display: flex; align-items: center; gap: 12px; flex-wrap: nowrap; }
    .donutWrap { flex: 0 0 auto; }
    .lwmetrics { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: 10px; }
    .donut { position: relative; flex: 0 0 auto; width: clamp(72px,25cqi,112px); height: auto; aspect-ratio:1; }
    .card { container-type: inline-size; }
    .row { display:grid; grid-template-columns:6px minmax(0,1fr) auto auto auto; gap:4px; white-space:nowrap; }
    .row .dot { width:6px;height:6px; }.row .lb { font-size:11px; }.row .vl { font-size:13px; }
    .row .un { margin:0;font-size:10px; }.row .pc { min-width:0;font-size:10px; }
    @container(max-width:320px) { .lwbody{gap:8px;}.sec{padding:9px;}.row .lb{font-size:10px;}.row .vl{font-size:12px;}.donutCenter .dtot{font-size:16px;}.donutCenter .dlab{font-size:7px;} }
    .donut svg { display: block; width: 100%; height: 100%; }
    .donut .ring-bg { fill: none; stroke: var(--secondary-background-color, #e7eaed); stroke-width: 16; }
    .donut .ring-seg { fill: none; stroke-width: 16; stroke-linecap: butt; transition: stroke-dasharray .3s ease; }
    .donutCenter {
      position: absolute; left: 0; top: 0; width: 100%; height: 100%;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      pointer-events: none; gap: 2px;
    }
    .donutCenter .dtot { font-size: clamp(16px,6cqi,28px); font-weight: 600; line-height: 1; letter-spacing: -.5px; }
    .donutCenter .dlab { font-size: clamp(6px,2cqi,9px); color: var(--secondary-text-color, #6b7280); }
    /* 两种样式互斥显示 */
    .sec.mode-donut .stack { display: none; }
    .sec.mode-donut .foot { display: none; }        /* 圆环态合计在圆心, 不需要底部合计 */
    .sec.mode-bar .donutWrap { display: none; }
    .sec.mode-bar .lwago { display: none; }         /* 条形态"更新于"仍走 .foot */
    .sec.mode-bar .foot { padding-top: 8px; border-top: 1px solid var(--divider-color, rgba(0, 0, 0, .09)); }
    .sec.mode-bar .foot .ago { margin-left: auto; }

    /* 共享控件层: 必须放在**最后**(同特异度下由它定稿), 见 src/lib/ui/styles.ts */
    ${unsafeCSS(uiStyles)}
  `;
}

/* ── 注册(带 registry-swap 自愈守卫) ── */
defineCard("leapmotor-lastweek", LeapmotorLastweekCard as unknown as CustomElementConstructor);

registerCustomCard({
  type: "leapmotor-lastweek",
  name: "零跑·上周电耗",
  description: "上周电耗拆分: 驱动 / 空调 / 其它(圆环 或 堆叠条 + 明细)",
  preview: false,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});

banner("零跑上周电耗", CARD_VERSION);
