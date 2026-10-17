// 零跑 · 里程耗电 —— 以"天"为单位的折线图(周/月切换, 里程/耗电/百公里能耗三线可叠显)。
//
// 为什么按天(而不是把轮询采样点直接画出来): 里程/能耗这类数据只在"天"的粒度上有意义 ——
// 采样点连成的线反映的是轮询节奏, 不是车用了多少; 云端官方也只提供逐日明细。
//
// 数据来源(服务端 assemble; 卡片上**不标注来源**,
// 角落仅在有补拉时提示进度):
//   * **耗电(橙)**: 官方 getEC 逐日拆分(`getLastweekEC` 传任意窗口, 与官方 App 周报同源;
//     驱动/空调/其它, **不含驻停/待机**)。官方缺的日子用本机自记 ΔSOC 兜底。
//     已完结的日子服务端只拉一次并持久缓存, 月视图第二次打开零请求;
//     未补完的天 `pending>0`, 卡片稍后自动续拉(分批取数, 首屏不等一长串请求)。
//     ⚠️ 不再用云端 `mileage/energy/detail` 的逐日 `accumulatedEnergyConsume` ——
//     实测该字段不可靠(逐日为 0、求和远小于官方聚合), 详见 docs/PROTOCOL.md。
//   * **里程(蓝)**: 本机自记行程(与行程卡同口径), 缺的日子退回云端逐日里程。
//   * **百公里能耗(绿)**: 当日耗电(同上, 官方优先) ÷ 当日里程 —— 与「行程统计」同口径。
//
// 读法: 共享横轴(日期)。三条线可独立开关(至少留一条, 选择会按车记住):
//   里程(蓝, km) — 每日行驶里程;  耗电(橙, kWh) — 每日驱动+空调+其它;
//   百公里能耗(绿, kWh/100km) — 当日效率。
// 图表最多标两根刻度轴, 按 里程 → 耗电 → 百公里能耗 的顺序分配给左/右(三条全开时
// 第三条不标刻度, 点一下看精确值); 点某天会浮出当天所有可见数值(各指标逐行显示,
// 官方拆分 驱动/空调/其它 合占一行)。
//
// 配置:
//   type: custom:leapmotor-energy
//   title: 里程 / 耗电        # 可选, 不填就只显示摘要
//   range: week              # 可选, week(默认) | month
//   chart: line              # 可选, line(折线, 默认) | bar(分组柱状图)
//   show_mileage: true       # 可选, 默认 true
//   show_energy: true        # 可选, 默认 true(每日耗电)
//   show_efficiency: true    # 可选, 默认 true(百公里能耗)
//
// 增程车另有本地逐日耗油估算；缺燃油量采样留空，云端近期油耗不拆成日数据。
// 视觉上与「零跑·行程浏览」「零跑·车辆控制」同一套: 卡片底色 + 轻阴影子块 + 胶囊按钮,
// 颜色全部走 HA 主题变量(深色主题自适应)。
//
// ⚠️ 本文件是 Lit + TS 重构版, 行为与视觉须与原 leapmotor-energy.js **逐项等价**:
//    元素名/配置字段/localStorage 键/WS 命令/错误文案/条件显示/SVG 图表几何/芯片与交互 全部保留。
//    图表为**命令式 SVG**(字符串拼装, 见 _renderChart), 刻意不转成 lit 模板 —— 增量重绘更快,
//    且尺寸依赖 clientWidth 实测值。Lit 只负责 DOM 外壳(header/消息/控件)与 shadow 样式。
import { LitElement, html, css, unsafeCSS, nothing, type TemplateResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { HomeAssistant, HassEntity, LovelaceCardConfig } from "../types/hass";
import { esc } from "../lib/dom";
import { fmtDayCn, fmtDayShort, fmtKm, fmtKwh, niceAxis, fmtTick } from "../lib/format";
import { ipIcon } from "../lib/icons";
import { callWs } from "../lib/ws";
import { isDark } from "../lib/theme";
import { defineCard, registerCustomCard, banner } from "../lib/register";
import { CARD_VERSIONS } from "../lib/version";
import { interactionStyles } from "../lib/motion";
import { uiStyles } from "../lib/ui/styles";
import { bindAppearance, unbindAppearance } from "../lib/appearance";
import { bindScrub } from "../lib/scrub";
import { chargePanel, tariffForm, decimal, energyPanelStyles, type ChargeData, type ChargeSession } from "./energy-charging";

const CARD_VERSION = CARD_VERSIONS.energy;

const PENDING_RETRY_MS = 8000; // pending>0 时自动续拉前的等待(分批取数, 不阻塞首屏)

const COLOR_KM = "#1e88e5"; // 蓝 = 里程(km)
const COLOR_KWH = "#fb8c00"; // 橙 = 耗电(每日 kWh)
const COLOR_EFF = "#43a047"; // 绿 = 百公里能耗(kWh/100km)
const CHART_H = 176; // 图表高度(CSS px); 宽度自适应卡片
const PAD = { l: 34, r: 40, t: 12, b: 22 };
const REFRESH_THROTTLE_MS = 60000; // 传感器联动刷新(「近7天里程」更新后)的最小间隔

/** 百分公里能耗保留 1 位 —— 与行程卡的显示口径一致(原文件内的 fmtEff; 不在共享 format 表内)。 */
function fmtEff(v: number | string): string {
  return Number(v).toFixed(1);
}

/** 把 [v0, v1, null, v2…] 切成连续段: [[[0, v0], [1, v1]], [[3, v2]]] */
function runsOf(values: (number | null)[]): [number, number][][] {
  const runs: [number, number][][] = [];
  let cur: [number, number][] | null = null;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v == null) {
      cur = null;
      continue;
    }
    if (!cur) {
      cur = [];
      runs.push(cur);
    }
    cur.push([i, v]);
  }
  return runs;
}

// ── 数据模型 ──
interface EnergyDay {
  day: string;
  km?: number | null;
  kwh?: number | null;
  eff?: number | null;
  // 增程车本地燃油量差值估算，缺采样时为 null；云端 oc100km 只用于近期摘要。
  fuel?: number | null;
  fuel_src?:string|null;
  kwh_src?: string | null;
  drv?: number | null;
  ac?: number | null;
  oth?: number | null;
}
interface EnergyData {
  source?: string;
  vin?: string;
  days?: EnergyDay[];
  summary?: { km?: number | null; kwh?: number | null } | null;
  pending?: number;
  reev?:boolean;fuel_average?:number|string|null;
}
interface Series {
  key: "km" | "kwh" | "eff" | "fuel";
  vals: (number | null)[];
  color: string;
  on: boolean;
  tipFmt: (v: number) => string;
  axis?: { max: number; step: number; ticks: number[] };
  y?: (v: number) => number;
}

class LeapmotorEnergyCard extends LitElement {
  private _config: LovelaceCardConfig | null = null;
  private _hass: HomeAssistant | null = null;
  private _built = false;
  private _range: "week" | "month" = "week";
  private _chart: "line" | "bar" = "line";
  private _showKm = true;
  private _showKwh = true;
  private _showEff = true; // 百公里能耗(默认开, 可关)
  private _showFuel=true;
  private _chargePlotWidth=350;private _chargeSeries=['charge','used'];private _chargeChart='line';
  private _unbindScrub:(()=>void)|null=null;
  private _unbindChargeScrub:(()=>void)|null=null;
  private _cache: Record<string, EnergyData> = {}; // range → 数据(切回时不重拉)
  private _loading = false;
  private _err = "";
  private _data: EnergyData | null = null;
  private _day = -1; // 气泡选中的天(索引)
  private _loadSeq = 0; // 取数轮次: 切视图后作废在途的旧请求
  private _lastLoad = 0;
  private _watchId = "";
  private _watchStamp = "";
  private _vin = "";
  private _pendingTimer: ReturnType<typeof setTimeout> | null = null; // pending>0 时的自动续拉定时器
  private _prefLoaded = false;
  private _rafPending = false;
  private _mode: "drive" | "charge" = "drive";
  private _chargeData: ChargeData | null = null;
  private _chargeCache: Record<string,ChargeData> = {};
  private _chargeLoading = false;
  private _chargeErr = "";
  private _chargeSeq = 0;
  private _chargeLastLoad = 0;
  private _chargeKey = "";
  private _chargeSelected = -1;
  private _tariffOpen = false;
  private _priceId='';private _priceMode='auto';private _priceValue='';private _priceError='';private _priceSaving=false;
  private _tariffSaving = false;
  private _tariffError = "";
  private _tariffDraft: Record<string,string> = {};
  private _dcPeriods:{start:string;end:string;price:string}[]=[];

  // 命令式 DOM 引用(图表/控件为字符串重绘, 不走 lit 模板)
  private _titleEl: HTMLElement | null = null;
  private _sumEl: HTMLElement | null = null;
  private _msgEl: HTMLElement | null = null;
  private _boxEl: HTMLElement | null = null;
  private _noteEl: HTMLElement | null = null;
  private _ctrlsEl: HTMLElement | null = null;
  private _refreshBtn: HTMLElement | null = null;
  private _ro: ResizeObserver | null = null;

  static getStubConfig() {
    return { type: "custom:leapmotor-energy" };
  }

  setConfig(config: LovelaceCardConfig): void {
    if (!config) return;
    this._config = config;
    if (config.range === "month" || config.range === "week") this._range = config.range;
    if (config.chart === "line" || config.chart === "bar") this._chart = config.chart;
    if (config.show_mileage === false) this._showKm = false;
    if (config.show_energy === false) this._showKwh = false;
    if (config.show_efficiency === false) this._showEff = false;
    if (!this._showKm && !this._showKwh && !this._showEff) this._showKm = true; // 至少留一条
    this._prefLoaded = false; // 配置变了, 允许重新读取本地偏好(仅未持久化过时)
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    if (!this._built) {
      // ⚠️ Lit 的模板是**异步**渲染的: renderRoot 里的节点要等首帧 update() 之后才存在。
      //    原实现是同步 innerHTML 后立刻 querySelector, 所以在 set hass 里就能建好;
      //    迁移到 Lit 后必须把"取节点引用 + 挂监听 + 首绘 + 首次取数"挪到 firstUpdated()
      //    (模板渲染完成回调), 否则引用永远为 null、整卡空白。
      this._prefLoaded || this._loadPref();
      this.requestUpdate(); // 确保首帧一定会发生(即便上游没有别的触发)
      return;
    }
    this._maybeFollowSensor();
    if (this._mode === "charge" && !this._chargeLoading && Date.now()-this._chargeLastLoad>60000) void this._loadCharge(true);
  }
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  /** 首帧渲染完成后: 缓存节点引用 + 挂监听 + 首绘 + 首次取数(一次性)。 */
  protected firstUpdated(): void {
    if (this._built) return;
    this._built = true;
    this._loadPref();
    this._build();
    this._renderAll();
    this._load();
  }

  getCardSize(): number {
    return 5;
  }

  // ── 本地偏好(与控车卡的折叠记忆同一套做法) ──
  private _prefKey(): string {
    return "leapmotor-energy.pref." + (this._vin || this._config?.title || "default");
  }
  private _loadPref(): void {
    if (this._prefLoaded) return;
    this._prefLoaded = true;
    try {
      const raw = window.localStorage.getItem(this._prefKey()) || "";
      if (!raw) return;
      const p = JSON.parse(raw);
      if (!this._config?.range && (p.range === "week" || p.range === "month")) this._range = p.range;
      if (!this._config?.chart && (p.chart === "line" || p.chart === "bar")) this._chart = p.chart;
      if (this._config?.show_mileage !== false && typeof p.km === "boolean") this._showKm = p.km;
      if (this._config?.show_energy !== false && typeof p.kwh === "boolean") this._showKwh = p.kwh;
      if (this._config?.show_efficiency !== false && typeof p.eff === "boolean") this._showEff = p.eff;
      if (!this._showKm && !this._showKwh && !this._showEff) this._showKm = true;
    } catch (err) {
      /* 本地存储不可用就算了 */
    }
  }
  /** 只落"用户**确实改过**的那一项** —— 别把配置给的值也写进共享存储。
      踩过的坑: 加载完成后无条件全量保存, 一张 `range: month` 的卡(比如另一块屏)
      会把 month 写进同一把键, 让其它没写配置的卡在重读时也跟着变月视图。 */
  private _savePref(patch: Record<string, unknown>): void {
    try {
      let cur: Record<string, unknown> = {};
      try {
        cur = JSON.parse(window.localStorage.getItem(this._prefKey()) || "{}") || {};
      } catch (err) {
        cur = {};
      }
      window.localStorage.setItem(this._prefKey(), JSON.stringify(Object.assign(cur, patch || {})));
    } catch (err) {
      /* 本地存储不可用时忽略 */
    }
  }

  // ── 构建(DOM 外壳用 lit 模板; 图表/控件保持命令式) ──
  private _build(): void {
    this._titleEl = this.renderRoot.querySelector(".head .title");
    this._sumEl = this.renderRoot.querySelector(".head .sum");
    this._msgEl = this.renderRoot.querySelector(".lmsg");
    this._boxEl = this.renderRoot.querySelector(".chartBox");
    this._noteEl = this.renderRoot.querySelector(".srcNote");
    this._ctrlsEl = this.renderRoot.querySelector(".ctrls");
    this._refreshBtn = this.renderRoot.querySelector(".energyTop .refresh");

    if (this._refreshBtn) {
      this._refreshBtn.addEventListener("click", () => {
        if (this._mode === "charge") { void this._loadCharge(true); return; }
        if (this._loading) return;
        delete this._cache[this._range];
        this._load(true);
      });
    }
    if (this._boxEl) {
      this._boxEl.tabIndex=0;this._boxEl.setAttribute("role","group");this._boxEl.setAttribute("aria-label","每日趋势，左右滑动或按方向键选择日期");
      this._bindDayScrub();
      this._boxEl.addEventListener("keydown",(e)=>{if(e.key==="ArrowLeft"||e.key==="ArrowRight"){e.preventDefault();this._setDay(Math.max(0,Math.min((this._data?.days?.length||1)-1,this._day+(e.key==="ArrowRight"?1:-1))))}});
      this._boxEl.addEventListener("click", (ev) => {
        if(ev.detail>0)return; // 指针选择由悬停/触摸跟踪处理，点击不保留气泡
        const t = ev.target as HTMLElement | null;
        const hit = t && t.closest ? t.closest("[data-day]") : null;
        if (!hit) {
          return;
        }
        const i = parseInt((hit as HTMLElement).dataset.day as string, 10);
        this._setDay(i);
      });
    }
    this._bindChargeScrub();

    if (this._ctrlsEl) {
      this._ctrlsEl.addEventListener("click", (ev) => {
        const t = ev.target as HTMLElement | null;
        const el = t && t.closest ? (t.closest("[data-act]") as HTMLElement | null) : null;
        if (!el) return;
        const act = el.dataset.act;
        if(act==="toggle-fuel"){this._showFuel=!this._showFuel;this._renderAll();return;}
        if (act === "toggle-km") {
          const next = !this._showKm;
          if (!next && !this._showKwh && !this._showEff) return; // 至少留一条
          this._showKm = next;
          this._day = -1;
          this._savePref({ km: next });
          this._renderAll();
        } else if (act === "toggle-kwh") {
          const next = !this._showKwh;
          if (!next && !this._showKm && !this._showEff) return;
          this._showKwh = next;
          this._day = -1;
          this._savePref({ kwh: next });
          this._renderAll();
        } else if (act === "toggle-eff") {
          const next = !this._showEff;
          if (!next && !this._showKm && !this._showKwh) return;
          this._showEff = next;
          this._day = -1;
          this._savePref({ eff: next });
          this._renderAll();
        } else if (act === "range") {
          const r = el.dataset.val;
          if (r !== "week" && r !== "month") return;
          if (r === this._range) return;
          this._range = r;
          this._chargeSelected = -1;
          void this._loadCharge();
          this._day = -1;
          this._savePref({ range: r });
          // ⚠️ 这里必须走 _load: 有缓存时它会**把 this._data 换成缓存的那一份**再重绘。
          //    原来只 _renderAll() 不换数据 → 从月切回周时画的还是 30 天数据, 看起来"切不回去"。
          this._load(false);
        } else if (act === "chart") {
          // 折线 / 柱状 切换: 只换画法, 不用重取数
          this._chart = this._chart === "bar" ? "line" : "bar";
          this._day = -1;
          this._savePref({ chart: this._chart });
          this._renderCtrls();
          this._renderChart();
        }
      });
    }

    // 宽度变化 → 重算横轴标签抽稀与图形(与行程卡同一套 ResizeObserver 思路)
    if (typeof ResizeObserver !== "undefined" && this._boxEl) {
      this._ro = new ResizeObserver(() => {
        if (this._rafPending) return;
        this._rafPending = true;
        requestAnimationFrame(() => {
          this._rafPending = false;
          this._renderChart();
          const width=Math.max(220,Math.round(this.clientWidth-48));if(width!==this._chargePlotWidth){this._chargePlotWidth=width;this.requestUpdate()}
        });
      });
      this._ro.observe(this._boxEl);this._ro.observe(this);
    }
  }

  /** 卡片配色(本机; 六张卡统一): 连接期间订阅配色变化 —— 变量写在宿主元素上(见 lib/palette.ts) */
  connectedCallback(): void {
    super.connectedCallback();
    // 界面风格 + 本机主题色(六张卡统一; 变量写在宿主元素上, 见 lib/appearance.ts)
    bindAppearance(this, { getDark: () => isDark(this._hass) });
    this._bindDayScrub();
    this._bindChargeScrub();
    if(this._boxEl){this._ro?.observe(this._boxEl);this._ro?.observe(this);}
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    unbindAppearance(this); // 外观订阅同样只在"连接期间"需要
    this._unbindScrub?.();this._unbindScrub=null;
    this._unbindChargeScrub?.();this._unbindChargeScrub=null;
    if (this._ro) {
      this._ro.disconnect();

    }
    if (this._pendingTimer) {
      clearTimeout(this._pendingTimer);
      this._pendingTimer = null;
    }
  }

  private _bindDayScrub() {
    if(!this._boxEl||this._unbindScrub)return;
    this._unbindScrub=bindScrub(this._boxEl,(clientX)=>{
        const svg=this._boxEl?.querySelector("svg");if(!svg||!this._data?.days?.length)return;
        const rect=svg.getBoundingClientRect(),view=Number(svg.getAttribute("viewBox")?.split(" ")[2])||360;
        const x=(clientX-rect.left)/Math.max(1,rect.width)*view;
        this._setDay(Math.max(0,Math.min(this._data.days.length-1,Math.floor((x-PAD.l)/(view-PAD.l-PAD.r)*this._data.days.length))));
      },()=>true,{hover:true,clear:()=>this._setDay(-1)});
  }

  private _bindChargeScrub() {
    const host=this.shadowRoot?.querySelector<HTMLElement>(".chargeBody");
    if(!host||this._unbindChargeScrub)return;
    this._unbindChargeScrub=bindScrub(host,(clientX)=>{const svg=host.querySelector(".chargeSvg"),n=this._chargeData?.days.length||0;if(!svg||!n)return;const r=svg.getBoundingClientRect(),width=Number(svg.getAttribute("viewBox")?.split(" ")[2])||350,x=(clientX-r.left)/Math.max(1,r.width)*width,i=Math.max(0,Math.min(n-1,Math.floor((x-32)/(width-50)*n)));if(i!==this._chargeSelected){this._chargeSelected=i;this.requestUpdate()}},target=>!!target.closest?.(".chargeSvg"),{hover:true,clear:()=>{if(this._chargeSelected!==-1){this._chargeSelected=-1;this.requestUpdate()}}});
  }

  // ── 取数 ──
  private async _load(force?: boolean): Promise<void> {
    if (!this._hass) return;
    const range = this._range;
    const seq = ++this._loadSeq; // 给这轮取数发号; 结果回来时对不上就作废
    if (!force && this._cache[range]) {
      // 有缓存就直接换用缓存(切回周视图走的这条路 —— 之前漏了换数据, 看起来"切不回去")
      this._data = this._cache[range];
      this._loading = false;
      this._renderAll();
      return;
    }
    this._loading = true;
    this._err = "";
    if (!this._cache[range]) this._data = null; // 别把上一个范围的数据顶着新范围的标题显示
    this._renderAll();
    const days = range === "month" ? 30 : 7;
    let res: EnergyData | null = null;
    try {
      res = await callWs<EnergyData>(this._hass, { type: "leapmotor/energy/daily", days: days, ...this._vehicleSelector() });
    } catch (err) {
      if (seq !== this._loadSeq) return; // 期间用户切了视图 → 丢弃
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
        if (this._range !== before) {
          this._load(true);
          return;
        }
      }
      void this._loadCharge(force);
      this._lastLoad = Date.now();
      this._schedulePendingRetry(range, res);
    }
    this._renderAll();
  }

  /** 官方数据还没补完(pending>0)时稍后自动续拉一次 —— 分批取数, 首屏不等一长串请求。 */
  private _schedulePendingRetry(range: string, res: EnergyData | null): void {
    if (this._pendingTimer) return;
    if (!res || !(res.pending && res.pending > 0)) return;
    if (this._range !== range) return;
    this._pendingTimer = setTimeout(() => {
      this._pendingTimer = null;
      if (this._range !== range || this._loading) return;
      delete this._cache[range];
      this._load(true);
    }, PENDING_RETRY_MS);
  }

  /** 拿不到 WS 命令时: 周视图退化为读「近7天里程」传感器属性; 月视图给提示。 */
  private _fallback(err: unknown, range: string): EnergyData | null {
    const code = String((err as any)?.code || "");
    const unknown =
      code === "unknown_command" ||
      code === "no_callws" ||
      /unknown command/i.test(String((err as any)?.message || ""));
    if (range === "month") {
      this._err = unknown ? "" : "读取失败: " + this._errText(err);
      return null;
    }
    const st = this._sensorState();
    if (st) {
      const a = st.attributes || {};
      const days: EnergyDay[] = (a.days || []).map((d: unknown, i: number) => {
        const km = a.daily_km && a.daily_km[i] != null ? Number(a.daily_km[i]) : null;
        const kwh = a.daily_kwh && a.daily_kwh[i] != null ? Number(a.daily_kwh[i]) : null;
        return {
          day: String(d),
          km: km,
          kwh: kwh,
          // 传感器只有 km/kwh, 自己折算百公里能耗(里程太小不给 —— 除出来没意义)
          eff: km != null && kwh != null && km > 0.5 && kwh > 0 ? Math.round((kwh / km) * 1000) / 10 : null,
        };
      });
      if (days.length) {
        this._err = "";
        let km = 0,
          kwh = 0;
        for (const d of days) {
          km += d.km || 0;
          kwh += d.kwh || 0;
        }
        return {
          source: "sensor",
          days: days,
          summary: { km: Math.round(km * 10) / 10, kwh: Math.round(kwh * 100) / 100 },
        };
      }
    }
    this._err = unknown ? "" : "读取失败: " + this._errText(err);
    return null;
  }

  private _errText(err: unknown): string {
    const code = String((err as any)?.code || "");
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(String((err as any)?.message || ""))) return "需要管理员权限";
    return String((err as any)?.message || err || "未知错误").slice(0, 80);
  }

  /** 找「近7天里程」这类传感器(属性里带 days/daily_km 的那个)。 */
  private _sensorState(): HassEntity | null {
    const states = (this._hass && this._hass.states) || {};
    let best: HassEntity | null = null;
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
  private _maybeFollowSensor(): void {
    const st = this._sensorState();
    if (!st) return;
    const id = st.entity_id || "";
    const stamp = String(st.last_updated || "");
    if (!this._watchId) {
      this._watchId = id;
      this._watchStamp = stamp;
      return;
    }
    if (id !== this._watchId) {
      this._watchId = id;
      this._watchStamp = stamp;
      return;
    }
    if (stamp && stamp !== this._watchStamp) {
      this._watchStamp = stamp;
      if (Date.now() - this._lastLoad > REFRESH_THROTTLE_MS && !this._loading) {
        delete this._cache[this._range];
        this._load(true);
      }
    }
  }

  // ── 渲染(lit 模板: header/消息/外壳) ──
  private _vehicleSelector(): Record<string,string> {
    if (this._config?.entry_id) return {entry_id:String(this._config.entry_id)};
    const vin = this._config?.vin || this._vin;
    return vin ? {vin:String(vin)} : {};
  }

  private async _loadCharge(force = false) {
    if (!this._hass) return;
    const key = JSON.stringify(this._vehicleSelector()) + ":" + this._range;
    if (this._chargeLoading && key === this._chargeKey) return;
    const seq = ++this._chargeSeq;
    this._chargeErr="";
    if (key!==this._chargeKey) this._chargeData=null;
    this._chargeKey=key;
    if (!force && this._chargeCache[key]) { this._chargeData=this._chargeCache[key];this._chargeLoading=false;this.requestUpdate();return; }
    this._chargeLoading=true;this._chargeErr="";this._chargeLastLoad=Date.now();this.requestUpdate();
    try {
      const data=await callWs<ChargeData>(this._hass,{type:"leapmotor/charging/history",days:this._range==="week"?7:30,...this._vehicleSelector()});
      if(seq!==this._chargeSeq)return;
      if(!data||!Array.isArray(data.days)||!data.tariff)throw new Error("充电记录尚未就绪");
      this._chargeData=data;this._chargeCache[key]=data;
    } catch(err) {
      if(seq!==this._chargeSeq)return;
      this._chargeErr="充电记录读取失败："+String((err as {message?:string})?.message||"请更新集成后重试").slice(0,100);
    } finally {
      if(seq===this._chargeSeq){this._chargeLoading=false;this._renderHead();this.requestUpdate();}
    }
  }

  private _selectMode(mode: "drive" | "charge") {
    this._mode=mode;this._renderAll();
    if(mode!=="charge")this._tariffOpen=false;
    if(mode==="charge")void this._loadCharge();
  }

  private _openTariff() {
    if(!this._chargeData)return;
    const t=this._chargeData.tariff;
    this._tariffDraft={peak_price:t.peak_price==null?"":String(t.peak_price),valley_price:t.valley_price==null?"":String(t.valley_price),
      ac_peak_price:(t.ac_peak_price??t.peak_price)==null?'':String(t.ac_peak_price??t.peak_price),ac_valley_price:(t.ac_valley_price??t.valley_price)==null?'':String(t.ac_valley_price??t.valley_price),
      valley_start:t.valley_start,valley_end:t.valley_end,efficiency:String(Math.round(t.efficiency*100)),ac_efficiency:String(Math.round((t.ac_efficiency??t.efficiency)*100)),dc_efficiency:String(Math.round((t.dc_efficiency??t.efficiency)*100))};
    this._dcPeriods=t.dc_periods?.map(p=>({...p,price:String(p.price)}))||
      (t.peak_price!=null&&t.valley_price!=null?[{start:t.valley_start,end:t.valley_end,price:String(t.valley_price)},{start:t.valley_end,end:t.valley_start,price:String(t.peak_price)}]:[{start:'00:00',end:'00:00',price:''}]);
    this._tariffError="";this._tariffOpen=true;this.requestUpdate();
    void this.updateComplete.then(()=>this.shadowRoot?.querySelector<HTMLButtonElement>('.tariffHead button')?.focus());
  }
  private _closeTariff(){if(this._tariffSaving)return;this._tariffOpen=false;this.requestUpdate();void this.updateComplete.then(()=>this.shadowRoot?.querySelector<HTMLButtonElement>('.priceBtn')?.focus());}
  private _addPeriod(){
    const last=this._dcPeriods[this._dcPeriods.length-1],minute=(s:string)=>Number(s.slice(0,2))*60+Number(s.slice(3)),clock=(n:number)=>String(Math.floor(n%1440/60)).padStart(2,'0')+':'+String(n%60).padStart(2,'0');
    const a=minute(last.start),b=minute(last.end),duration=(b-a+1440)%1440||1440;
    if(!Number.isFinite(a)||!Number.isFinite(b)||duration<2){this._tariffError='请先填写有效时段';this.requestUpdate();return;}
    const mid=clock(a+Math.floor(duration/2)),end=last.end;last.end=mid;this._dcPeriods.push({start:mid,end,price:last.price});this.requestUpdate();
  }
  private _removePeriod(i:number){
    if(this._dcPeriods.length<2)return;const row=this._dcPeriods[i];if(i)this._dcPeriods[i-1].end=row.end;else this._dcPeriods[1].start=row.start;this._dcPeriods.splice(i,1);this.requestUpdate();
  }

  private async _saveTariff() {
    if(!this._hass||this._tariffSaving)return;
    const d=this._tariffDraft;
    const price=(key:string)=>(d[key]||'').trim()===""?null:Number(d[key]);
    const peak=price("peak_price"),valley=price("valley_price"),eff=Number(d.efficiency)/100,acEff=Number(d.ac_efficiency)/100,dcEff=Number(d.dc_efficiency)/100;
    if([peak,valley,price('ac_peak_price'),price('ac_valley_price')].some(p=>p!=null&&(!Number.isFinite(p)||p<0||p>100))||[eff,acEff,dcEff].some(v=>!Number.isFinite(v)||v<.5||v>1)){this._tariffError="请填写有效电价及 50%～100% 的效率";this.requestUpdate();return;}
    const dcConfigured=this._dcPeriods.some(p=>p.price.trim()!==''),occupied=new Set<number>();let bad='';
    for(const p of dcConfigured?this._dcPeriods:[]){
      const minute=(s:string)=>/^([01]\d|2[0-3]):[0-5]\d$/.test(s)?Number(s.slice(0,2))*60+Number(s.slice(3)):NaN,a=minute(p.start),b=minute(p.end),v=Number(p.price);
      if(!Number.isFinite(a)||!Number.isFinite(b)||!p.price.trim()||!Number.isFinite(v)||v<0||v>100){bad='每个时段须填写有效时间和 0～100 元/kWh 的价格';break;}
      const duration=(b-a+1440)%1440||1440;
      for(let j=0;j<duration;j++){const m=(a+j)%1440;if(occupied.has(m))bad='直流电价时段不能重叠';occupied.add(m);}
    }
    if(bad||(dcConfigured&&occupied.size!==1440)){this._tariffError=bad||'直流电价时段须完整覆盖一天 24 小时';this.requestUpdate();return;}
    this._tariffSaving=true;this._tariffError="";this.requestUpdate();
    try {
      await callWs(this._hass,{type:"leapmotor/charging/tariff",...this._vehicleSelector(),tariff:{peak_price:peak,valley_price:valley,ac_peak_price:price('ac_peak_price'),ac_valley_price:price('ac_valley_price'),dc_periods:dcConfigured?this._dcPeriods.map(p=>({...p,price:Number(p.price)})):null,valley_start:d.valley_start,valley_end:d.valley_end,efficiency:eff,ac_efficiency:acEff,dc_efficiency:dcEff}});
      this._chargeCache={};this._tariffOpen=false;
      // 保存前发出的历史读取可能含旧电价；让它失效并重新读取。
      ++this._chargeSeq;this._chargeLoading=false;await this._loadCharge(true);
    } catch(err) { this._tariffError=String((err as {message?:string})?.message||"电价保存失败").slice(0,140); }
    finally {this._tariffSaving=false;this.requestUpdate();}
  }

  private _sessionPrice(s:ChargeSession):TemplateResult|typeof nothing {
    if(!this._hass?.user?.is_admin||s.active)return nothing;
    const open=this._priceId===s.id;
    return html`<div class="sessionPrice"><button @click=${()=>{this._priceId=open?'':s.id;this._priceMode=s.price_override?.mode||'auto';this._priceValue=s.price_override?String(s.price_override.value):'';this._priceError='';this.requestUpdate()}}>修改本次价格</button>${open?html`<label>计价方式<select .value=${this._priceMode} @change=${(e:Event)=>{this._priceMode=(e.target as HTMLSelectElement).value;this.requestUpdate()}} ?disabled=${this._priceSaving}><option value="auto">按全局电价估算</option><option value="unit">本次单价 · 元/kWh</option><option value="total">实际总费用 · 元</option></select></label>${this._priceMode!=='auto'?html`<label>${this._priceMode==='unit'?'本次单价 · 元/kWh':'实际总费用 · 元'}<input type="number" min="0" step="0.01" .value=${this._priceValue} @input=${(e:Event)=>{this._priceValue=(e.target as HTMLInputElement).value}} ?disabled=${this._priceSaving}></label>`:nothing}<p class="billNote">仅修改这条已结束的记录，跨日期按观测取电量分配费用。</p>${this._priceError?html`<p class="billNote error">${this._priceError}</p>`:nothing}<div class="tariffActions"><button @click=${()=>{this._priceId='';this.requestUpdate()}} ?disabled=${this._priceSaving}>取消</button><button class="savePrice" @click=${()=>void this._saveSessionPrice(s.id)} ?disabled=${this._priceSaving}>${this._priceSaving?'保存中…':'保存本次价格'}</button></div>`:nothing}</div>`;
  }
  private async _saveSessionPrice(id:string){
    if(this._priceSaving||!this._hass)return;
    const value=this._priceMode==='auto'?null:Number(this._priceValue);
    if(this._priceMode!=='auto'&&(!this._priceValue.trim()||!Number.isFinite(value)||value!<0||value!>(this._priceMode==='unit'?100:100000))){this._priceError='请输入有效金额';this.requestUpdate();return;}
    this._priceSaving=true;this._priceError='';this.requestUpdate();
    try{await callWs(this._hass,{type:'leapmotor/charging/price',...this._vehicleSelector(),session_id:id,mode:this._priceMode,value});this._priceId='';this._chargeCache={};++this._chargeSeq;this._chargeLoading=false;await this._loadCharge(true)}
    catch(err){this._priceError=String((err as any)?.message||'价格保存失败').slice(0,140)}finally{this._priceSaving=false;this.requestUpdate()}
  }

  private _summaryPanel(): TemplateResult {
    const drive=this._mode==="drive",d=this._data?.summary,c=this._chargeData?.summary;
    const km=d?.km,used=d?.kwh;
    const paired=(this._data?.days||[]).filter(d=>d.km!=null&&d.km>0&&d.kwh!=null);
    const pairedKm=paired.reduce((a,d)=>a+Number(d.km),0),pairedKwh=paired.reduce((a,d)=>a+Number(d.kwh),0);
    const eff=pairedKm>0?pairedKwh/pairedKm*100:null;
    const corrected=!!this._chargeData?.sessions.some(s=>s.price_override);
    const stats=drive?[["行驶里程",decimal(km),"km"],["行驶耗电",decimal(used),"kWh"],["平均能耗",decimal(eff),"kWh/100km"]]:
      [["电池侧充电",decimal(c?.kwh),"kWh"],["估算取电",decimal(c?.grid_kwh),"kWh"],[corrected?"充电费用":"估算电费",c?.cost==null?"—":"¥"+decimal(c.cost,2),c?.cost==null?"请设置电价":corrected?"元 · 含手动修正":"元"]];
    if(drive&&this._data?.reev)stats.push(["近期油耗",decimal(this._data.fuel_average==null?null:Number(this._data.fuel_average)),"L/100km · 云端近期窗口"]);
    return html`<div class="energySummary${drive&&this._data?.reev?" reev":""}">${stats.map(([label,value,unit],i)=>html`<div class="energyStat${!drive&&i===2?" cost":""}"><span>${label}</span><b>${value}</b><small>${unit}</small></div>`)}</div>`;
  }

  protected render(): TemplateResult {
    return html`
      <div class="card">
        <div class="energyTop"><div class="energyModes ${this._mode}"><i class="modeIndicator" aria-hidden="true"></i><button class=${this._mode==="drive"?"on":""} aria-pressed=${this._mode==="drive"} @click=${()=>this._selectMode("drive")}>里程与耗能</button><button class=${this._mode==="charge"?"on":""} aria-pressed=${this._mode==="charge"} @click=${()=>this._selectMode("charge")}>充电与电费</button></div><button class="refresh" title="重新读取">${unsafeSVG(ipIcon("redo", 16))}</button></div>
        ${this._summaryPanel()}
        <div class="lmsg" ?hidden=${this._mode!=="drive"}></div>
        <section class="chartSec" ?hidden=${this._mode!=="drive"}><div class="plotHeading"><b>每日趋势</b><span>滑动选择日期</span></div><div class="chartBox"></div><div class="srcNote"></div><div class="ctrls"></div>${this._data?.reev?html`<p class="billNote">逐日耗油按行车燃油量下降估算，缺样本留空；近期油耗使用云端窗口。油量变化有误差，安装前无法追溯。</p>`:nothing}</section>

        <div class="chargeBody" ?hidden=${this._mode!=="charge"}>${chargePanel(this._chargeData,this._chargeErr,this._chargeSelected,i=>{if(i!==this._chargeSelected){this._chargeSelected=i;this.requestUpdate()}},s=>this._sessionPrice(s),html`<div class="energyTools"><button class=${this._range==="week"?"on":""} aria-pressed=${this._range==="week"} @click=${()=>this._chargeRange("week")}>近 7 天</button><button class=${this._range==="month"?"on":""} aria-pressed=${this._range==="month"} @click=${()=>this._chargeRange("month")}>近 30 天</button></div>`,html`<button class="priceBtn" @click=${()=>this._openTariff()} ?disabled=${!this._hass?.user?.is_admin}>电价设置</button>`,{width:this._chargePlotWidth,series:this._chargeSeries,chart:this._chargeChart,toggle:key=>{if(this._chargeSeries.includes(key)){if(this._chargeSeries.length>1)this._chargeSeries=this._chargeSeries.filter(k=>k!==key)}else this._chargeSeries=[...this._chargeSeries,key];this.requestUpdate()},switchChart:()=>{this._chargeChart=this._chargeChart==='line'?'bar':'line';this.requestUpdate()}})}</div>
      </div>
      <!-- 电价弹窗必须挂在 .card 外面: 玻璃风格给 .card 加了 backdrop-filter,
           会把它变成 fixed 后代的定位基准(遮罩会缩到卡片范围内)。 -->
      ${this._tariffOpen?tariffForm(this._tariffDraft,this._tariffSaving,this._tariffError,this._chargeData?.timezone||"",(k,v)=>{this._tariffDraft[k]=v},()=>void this._saveTariff(),()=>this._closeTariff(),this._dcPeriods,(i,k,v)=>{this._dcPeriods[i][k]=v},()=>this._addPeriod(),i=>this._removePeriod(i)):nothing}
    `;
  }

  private _renderAll(): void {
    if (!this._built) return;
    if (this._titleEl) this._titleEl.textContent = this._config?.title || "里程与能耗";
    this._renderHead();
    this._renderMsg();
    this._renderCtrls();
    this._renderChart();
    this.requestUpdate();
  }

  private _chargeRange(range: "week"|"month") {
    if(this._range===range)return;
    this._range=range;this._chargeSelected=-1;this._savePref({range});
    this._chargeData=null;void this._loadCharge();this._load(false);
  }


  private _renderHead(): void {
    const d = this._data;
    if (this._sumEl) {
      if (d && d.days && d.days.length) {
        const km = d.summary && d.summary.km != null ? d.summary.km : 0;
        const kwh = d.summary && d.summary.kwh != null ? d.summary.kwh : 0;
        const scope = this._range === "month" ? "近 30 天" : "近 7 天";
        this._sumEl.textContent = scope;
      } else {
        this._sumEl.textContent = "";
      }
    }
    if (this._refreshBtn) this._refreshBtn.classList.toggle("spin", this._mode==="charge"?this._chargeLoading:!!this._loading);
  }

  private _renderMsg(): void {
    if (!this._msgEl) return;
    let text = "";
    let err = false;
    if (this._err) {
      text = this._err;
      err = true;
    } else if (this._loading && !this._data) text = "读取中…";
    else if (!this._data || !this._data.days || !this._data.days.length) text = "还没有数据";
    else {
      const has = this._data.days.some((d) => d.km != null || d.kwh != null || d.eff != null);
      if (!has) text = "这段时间还没有记录";
    }
    this._msgEl.textContent = text;
    this._msgEl.className = "lmsg" + (text ? " on" : "") + (err ? " err" : "");
  }

  private _renderCtrls(): void {
    if (!this._ctrlsEl) return;
    const ser = (act: string, on: boolean, key: string, label: string, title: string, color:string) =>
      '<button class="seriesBtn' + (on ? " on" : "") + '" aria-pressed="' + on + '" data-act="' + act + '"' +
      (title ? ' title="' + esc(title) + '"' : "") + '><i style="background:' + color + '"></i>' + esc(label) + "</button>";
    const rng = (act: string, on: boolean, label: string, title: string, val: string) =>
      '<button class="' + (on ? "on" : "") + '" data-act="' +
      act +
      '"' +
      (val ? ' data-val="' + val + '"' : "") +
      (title ? ' title="' + esc(title) + '"' : "") +
      ">" +
      esc(label) +
      "</button>";
    this._ctrlsEl.classList.add("chargeCtrls");
    this._ctrlsEl.innerHTML = '<div class="chargeSeries">' +
      ser("toggle-km", this._showKm, "km", "里程", "显示/隐藏每日里程折线(km)", COLOR_KM) +
      ser("toggle-kwh", this._showKwh, "kwh", "耗电", "显示/隐藏每日耗电折线(kWh)", COLOR_KWH) +
      ser("toggle-eff", this._showEff, "eff", "百公里能耗", "显示/隐藏百公里能耗折线(kWh/100km, 按本机自记行程计)", COLOR_EFF) +
      (this._data?.reev?ser("toggle-fuel",this._showFuel,"fuel","耗油","每日耗油估算(L)，独立刻度，滑动查看数值","#ab7351"):"") +
      '</div><div class="chargeRange"><div class="energyTools">' +
      rng("range", this._range === "week", "周", "近 7 天", "week") +
      rng("range", this._range === "month", "月", "近 30 天(官方 + 自记)", "month") +
      '</div><button class="chartSwitch" data-act="chart" title="切换图表: 折线 / 柱状">' +
      (this._chart === "bar" ? "柱状" : "折线") + "</button></div>";
  }

  // ── 图表(SVG, 零依赖; 命令式字符串拼装, 保持与原实现一致) ──
  private _renderChart(): void {
    if (!this._boxEl || !this._noteEl) return;
    const d = this._data;
    // 角落只留"补拉中"这个**进度**提示; 不再标注数据来源
    this._noteEl.textContent = d && d.pending && d.pending > 0 ? "官方数据补拉中(" + d.pending + " 天)" : "";
    if (!d || !d.days || !d.days.length) {
      this._boxEl.innerHTML = "";
      return;
    }
    if (this._day >= d.days.length) this._day = -1; // 切换范围后旧选中索引失效
    const days = d.days;
    const n = days.length;
    const W = Math.max(240, Math.round(this._boxEl.clientWidth || 360));
    const plotW = W - PAD.l - PAD.r;
    const plotH = CHART_H - PAD.t - PAD.b;
    const kmVals = days.map((x) => (x.km == null ? null : Number(x.km)));
    const kwhVals = days.map((x) => (x.kwh == null ? null : Number(x.kwh)));
    const effVals = days.map((x) => (x.eff == null ? null : Number(x.eff)));
    // 三条可切换的线。每条的 y 轴刻度 = 自己的 nice ticks(量纲不同, 不能共用一根轴)。
    const all: Series[] = [
      { key: "km", vals: kmVals, color: COLOR_KM, on: this._showKm, tipFmt: (v) => "里程 " + fmtKm(v) + " km" },
      { key: "kwh", vals: kwhVals, color: COLOR_KWH, on: this._showKwh, tipFmt: (v) => "耗电 " + fmtKwh(v) + " kWh" },
      { key: "eff", vals: effVals, color: COLOR_EFF, on: this._showEff, tipFmt: (v) => "百公里能耗 " + fmtEff(v) + " kWh/100km" },
      { key: "fuel",vals:days.map(d=>this._data?.reev&&d.fuel!=null?Number(d.fuel):null),color:"#ab7351",on:!!this._data?.reev&&this._showFuel,tipFmt:v=>"耗油估算 "+decimal(v,2)+" L" },
    ];
    const live = all.filter((x) => x.on && x.vals.some((v) => v != null));
    if (!live.length) {
      // 一条可画的线都没有 → 不画空轴
      this._boxEl.innerHTML = "";
      this._renderMsg();
      return;
    }
    for (const x of live) {
      x.axis = niceAxis(Math.max(0, ...x.vals.filter((v): v is number => v != null)), 4);
      const axis = x.axis;
      x.y = (v: number) => PAD.t + plotH * (1 - v / axis.max);
    }
    // 最多两根刻度轴: 按 里程 → 耗电 → 百公里能耗 的顺序分配左/右;
    // 第三条(三条全开时才会有)用自己独立的刻度但不标刻度线 —— 点一下能看精确值。
    const left = live[0];
    const right = live.length > 1 ? live[1] : null;
    const xs: number[] = [];
    for (let i = 0; i < n; i++) xs.push(PAD.l + ((i + 0.5) * plotW) / n);

    // 网格线由左轴提供
    let svg = '<svg viewBox="0 0 ' + W + " " + CHART_H + '" preserveAspectRatio="none">';
    for (const t of left.axis!.ticks) {
      const y = left.y!(t);
      svg +=
        '<line class="gridline" x1="' +
        PAD.l +
        '" y1="' +
        y.toFixed(1) +
        '" x2="' +
        (W - PAD.r) +
        '" y2="' +
        y.toFixed(1) +
        '"/>';
    }
    // 轴刻度(颜色跟着线走, 一眼看出哪根轴对应哪条线)
    const ticks = (x: Series, side: "l" | "r") => {
      let out = "";
      for (const t of x.axis!.ticks) {
        const tx = side === "l" ? PAD.l - 4 : W - PAD.r + 4;
        out +=
          '<text class="axisTxt ' +
          x.key +
          '" x="' +
          tx +
          '" y="' +
          (x.y!(t) + 3).toFixed(1) +
          '" text-anchor="' +
          (side === "l" ? "end" : "start") +
          '">' +
          fmtTick(t) +
          "</text>";
      }
      return out;
    };
    svg += ticks(left, "l");
    if (right) svg += ticks(right, "r");
    // 横轴日期: 周=全标; 月=从"今天"往回按固定间隔标, 保证最后一个标签一定在且不重叠
    const maxLabels = Math.max(2, Math.floor(plotW / 34));
    const step = Math.max(1, Math.ceil(n / maxLabels));
    for (let i = n - 1; i >= 0; i -= step) {
      svg +=
        '<text class="axisTxt" x="' +
        xs[i].toFixed(1) +
        '" y="' +
        (CHART_H - 6) +
        '" text-anchor="middle">' +
        esc(fmtDayShort(days[i].day)) +
        "</text>";
    }
    // 选中的天: 一条竖光带
    if (this._day >= 0 && this._day < n) {
      const bw = plotW / n;
      svg +=
        '<rect class="selcol" x="' +
        (PAD.l + this._day * bw).toFixed(1) +
        '" y="' +
        PAD.t +
        '" width="' +
        bw.toFixed(1) +
        '" height="' +
        plotH +
        '" rx="3"/>';
    }
    // 折线 + 点(缺数据的日断开, 不硬连); 点自带 data-day, 直接点圆点也能选中
    // —— 或柱状(每天一组, 每种可见系列一根, 各自对着自己的轴)。
    if (this._chart === "bar") {
      const groupW = plotW / n;
      const pad = Math.min(6, groupW * 0.18);
      const slotW = Math.max(1.5, (groupW - pad * 2) / Math.max(1, live.length));
      const barW = Math.max(1, slotW - Math.min(2, slotW * 0.22));
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < live.length; j++) {
          const x = live[j];
          const v = x.vals[i];
          if (v == null) continue;
          const h = Math.max(0, plotH * (v / x.axis!.max));
          const bx = PAD.l + i * groupW + pad + j * slotW + (slotW - barW) / 2;
          const by = PAD.t + plotH - h;
          const sel = i === this._day;
          svg +=
            '<rect class="bar" data-day="' +
            i +
            '" fill="' +
            x.color +
            '" opacity="' +
            (sel ? 1 : 0.9) +
            '" x="' +
            bx.toFixed(1) +
            '" y="' +
            by.toFixed(1) +
            '" width="' +
            barW.toFixed(1) +
            '" height="' +
            h.toFixed(1) +
            '" rx="1.5"/>';
        }
      }
    } else {
      for (const x of live) {
        const runs = runsOf(x.vals);
        for (const run of runs) {
          if (run.length >= 2) {
            const pts = run.map(([i, v]) => xs[i].toFixed(1) + "," + x.y!(v).toFixed(1)).join(" ");
            svg += '<polyline class="line" stroke="' + x.color + '" points="' + pts + '"/>';
          }
        }
        for (const run of runs) {
          for (const [i, v] of run) {
            const sel = i === this._day;
            svg +=
              '<circle class="pt ' +
              x.key +
              (sel ? " sel" : "") +
              '" data-day="' +
              i +
              '" cx="' +
              xs[i].toFixed(1) +
              '" cy="' +
              x.y!(v).toFixed(1) +
              '" r="' +
              (sel ? 4.2 : 2.6) +
              '"/>';
          }
        }
      }
    }
    // 点击热区(整列)
    const bw = plotW / n;
    for (let i = 0; i < n; i++) {
      svg +=
        '<rect class="hit" data-day="' +
        i +
        '" x="' +
        (PAD.l + i * bw).toFixed(1) +
        '" y="' +
        PAD.t +
        '" width="' +
        bw.toFixed(1) +
        '" height="' +
        plotH +
        '"/>';
    }
    svg += "</svg>";
    // 气泡: 逐项一行(整条拼成一行时信息过长会横向溢出);
    // 官方拆分(驱动/空调/其它)也各占一行 —— 不再用 "+" 连接。
    let tip = "";
    if (this._day >= 0 && this._day < n) {
      const i = this._day;
      const lines: string[] = [];
      for (const x of live) {
        const v = x.vals[i];
        if (v != null) lines.push(x.tipFmt(v));
      }
      const dd = days[i];
      if (
        this._showKwh &&
        dd &&
        dd.kwh != null &&
        dd.kwh > 0 &&
        dd.kwh_src === "official" &&
        (dd.drv != null || dd.ac != null || dd.oth != null)
      ) {
        // 官方 getEC 的当日拆分: 三项**合占一行**, 用「·」分隔
        // (不再用 "+" 连接); 其余指标各自一行
        lines.push("驱动 " + fmtKwh(dd.drv || 0) + " · 空调 " + fmtKwh(dd.ac || 0) + " · 其它 " + fmtKwh(dd.oth || 0));
      }
      if (!lines.length) lines.push("没有数据");
      const cssW = Math.max(1, this._boxEl.clientWidth || W);
      const half = Math.min(90, cssW / 2);
      const tipX = Math.min(cssW - half, Math.max(half, (xs[i] * cssW) / W));
      tip =
        '<div class="tip" style="left:' +
        tipX.toFixed(1) +
        "px;top:12px;transform:translateX(-50%)" +
        '"><div>' +
        esc(fmtDayCn(days[i].day)) +
        "</div>" +
        lines.map((s) => "<div>" + esc(s) + "</div>").join("") +
        "</div>";
    }
    this._boxEl.innerHTML = svg + tip;
    this._clampTip();
  }

  /** 气泡渲染后按**实际宽度**再收一次边(文字长短不定, 预估半宽可能不准)。 */
  private _clampTip(): void {
    const tip = this._boxEl ? this._boxEl.querySelector<HTMLElement>(".tip") : null;
    if (!tip) return;
    const bw = this._boxEl!.clientWidth;
    const tw = tip.offsetWidth;
    if (!bw || !tw || tw + 4 > bw) return; // 比容器还宽就放弃(极端窄屏)
    const min = tw / 2 + 2;
    const max = bw - tw / 2 - 2;
    const cur = parseFloat(tip.style.left) || 0;
    const x = Math.min(max, Math.max(min, cur));
    if (Math.abs(x - cur) > 0.5) tip.style.left = x.toFixed(1) + "px";
  }

  private _setDay(i: number): void {
    if(i===this._day)return;
    this._day = i;
    this._renderChart();
  }

  static styles = css`
    ${unsafeCSS(interactionStyles)}
    :host { display: block; }
    .card {
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
    ha-icon { display: inline-flex; width: 16px; height: 16px; --mdc-icon-size: 16px; }

    .lmsg { display: none; font-size: 12px; color: var(--secondary-text-color, #6b7280); padding: 2px 2px 0; }
    .lmsg.on { display: block; }
    .lmsg.err { color: var(--error-color, #db4437); }

    /* 图表子块: 白底 + 一层阴影(与控车卡子块/行程卡 .sheet 同一套; 1.9.40 起不描边) */
    .chartSec {
      background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
      border: 0;
      box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      border-radius: var(--lm-radius-section, 14px); padding: 10px 10px 6px;
    }
    .chartBox { position: relative; height: ${unsafeCSS(CHART_H)}px; }
    .chartBox svg { display: block; width: 100%; height: ${unsafeCSS(CHART_H)}px; }
    .gridline { stroke: var(--divider-color, rgba(0, 0, 0, .09)); stroke-width: 1; }
    .axisTxt { font-size: 10px; fill: var(--secondary-text-color, #6b7280); }
    .axisTxt.km { fill: ${unsafeCSS(COLOR_KM)}; }
    .axisTxt.kwh { fill: ${unsafeCSS(COLOR_KWH)}; }
    .axisTxt.eff { fill: ${unsafeCSS(COLOR_EFF)}; }
    .line { fill: none; stroke-width: 2.2; stroke-linejoin: round; stroke-linecap: round; }
    .pt.km { fill: ${unsafeCSS(COLOR_KM)}; }
    .pt.kwh { fill: ${unsafeCSS(COLOR_KWH)}; }
    .pt.eff { fill: ${unsafeCSS(COLOR_EFF)}; }
    .pt.fuel { fill:#ab7351; }.axisTxt.fuel { fill:#ab7351; }.chip.fuel.on{background:#ab7351;color:#fff;}
    .chartBox { touch-action:pan-y; }
    .pt.sel { stroke: var(--lm-surface-control, var(--card-background-color, #fff)); stroke-width: 1.6; }
    .hit { fill: transparent; cursor: pointer; }
    .selcol { fill: var(--secondary-background-color, #e7eaed); opacity: .55; }
    .tip { position:absolute;z-index:5;top:12px;pointer-events:none;display:flex;flex-direction:column;gap:4px;width:200px;max-width:calc(100% - 12px);box-sizing:border-box;padding:8px 10px;border-radius:var(--lm-radius-control, 10px);font-size:10px;line-height:1.5;white-space:normal;background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-floating, 0 1px 4px #0003); }
    .srcNote { margin-top: 2px; text-align: right; font-size: 10px; color: var(--secondary-text-color, #6b7280); }

    /* 底部选择项: 左侧两个显隐开关(带颜色点), 右侧周/月 */
    /* 底部选择项: 收紧间距, 手机上一行放得下(以前 5 个胶囊容易折成两行) */
    .ctrls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
    .chargeCtrls { width:100%; }
    .chargeCtrls .seriesBtn { display:flex;align-items:center;gap:4px;opacity:.5; }
    .chargeCtrls .seriesBtn.on { opacity:1; }
    .chargeCtrls .seriesBtn i { display:inline-block;width:6px;height:6px;border-radius:50%;margin-right:4px; }
    .chargeCtrls .chartSwitch { margin-left:0; }
    .ctrls .sp { flex: 1; }
    /* 胶囊: 不再用小圆点标识系列 —— 启用时整个按钮就是那条线的颜色(省一截宽度)。
       1.9.40 起与控车卡同款: 白底 + 一层阴影, 不描边(原来那几处 "border-color: transparent"
       藏灰边的写法随之删掉 —— 整条边框已去, 选中态由各自的底色表达)。 */
    .chip {
      display: inline-flex; align-items: center; cursor: pointer;
      padding: 6px 10px; border-radius: var(--lm-radius-badge, 999px); font-size: 12px;
      color: var(--primary-text-color, #212121);
      background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
      border: 0;
      box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      transition: background .15s ease;
    }
    .chip:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
    .chip.off { opacity: .6; }
    /* 启用时显示各自的系列色: 蓝=里程 / 橙=耗电 / 绿=百公里能耗 */
    .chip.km.on { background: ${unsafeCSS(COLOR_KM)}; color: #fff; }
    .chip.kwh.on { background: ${unsafeCSS(COLOR_KWH)}; color: #fff; }
    .chip.eff.on { background: ${unsafeCSS(COLOR_EFF)}; color: #fff; }
    .chip.rng.on {
      background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
    }
    .ip { display: inline-block; vertical-align: middle; flex: none; margin-right: 4px; }
    .chip.chart.on {
      background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
    }
    .chip.km.on:hover, .chip.kwh.on:hover, .chip.eff.on:hover, .chip.rng.on:hover { filter: brightness(1.06); }
    ${unsafeCSS(energyPanelStyles)}
    /* 共享控件层: 必须放在**最后**(同特异度下由它定稿), 见 src/lib/ui/styles.ts */
    ${unsafeCSS(uiStyles)}
    [hidden] { display:none !important; }
  `;
}

/* ── 注册(带 registry-swap 自愈守卫) ── */
defineCard("leapmotor-energy", LeapmotorEnergyCard as unknown as CustomElementConstructor);

registerCustomCard({
  type: "leapmotor-energy",
  name: "零跑·里程耗电",
  description: "里程 / 耗电 / 百公里能耗逐日折线或柱状(周/月切换, 三线可叠显)",
  preview: false,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});

banner("零跑里程能耗", CARD_VERSION);
