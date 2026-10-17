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
 *     右上大号里程 + 时间段, 底部三列小指标(耗时 / 耗电 kWh / 平均电耗)。
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
 *   **按可视区懒加载**(IntersectionObserver): 行/日卡滚到附近才拉, 并发 4,
 *   拉失败的保持占位, 绝不阻塞列表。THUMB_LIMIT / DAY_THUMB_LIMIT 只是安全上限
 *   (防止超长列表一直滚动时把瓦片请求拉爆), 不再是"只补前 30 行"的硬闸。
 *   30 天窗口里有近百段行程, 固定补前 30 行会让更早的日子永远没有缩略图。
 *
 * 断档怎么画
 * ----------
 *   轨迹点里**没有时间戳**, 没法直接按"时间差 > 采样间隔"判断丢采样, 所以退化成用
 *   距离判断: 相邻两点距离 > 2 km 就当作断档(正常 6 秒采样下相邻点通常只有几十米,
 *   高速也远小于 2 km), 断档处用**虚线**连过去, 实线部分是连续采到的路段。
 *
 * 底图与坐标系
 * ------------
 *   与 `leapmotor-map.js` 完全同一套做法: 底图取高德瓦片(GCJ-02 火星坐标), 集成给的
 *   轨迹是 WGS-84, 画之前用 wgs84ToGcj02() 换算 —— 不换算会偏 300~500 米。
 *   缩略图与大图共用 project()/unproject() 与同一份瓦片模板。
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
 * 时间窗口
 * --------
 *   顶部一行是"时间范围"控件: 分段「7 天 / 30 天 / 90 天」+「选择月份 ▾」(只有有数据的
 *   月份, 带段数·里程) + 往前/往后翻页箭头。默认**最近 30 天滚动窗口** —— 与自然月解耦,
 *   月初也能看到上月的行程, 不必先切月份。列表只渲染当前窗口内的行程, 表头统计也是
 *   该窗口的汇总; 卡片底部一行小字是轨迹存储占用(如 `11.9/300MB,共7个月`)。
 *   「叠加最近 N 段」锚定在**当前窗口的结束时刻**: 看最近 30 天 = 截至现在, 看某个月 =
 *   截至该月末, 所以月初看当月叠加时也取得到上个月的轨迹(走 `leapmotor/trips/tracks` 批量命令,
 *   点已在服务端抽稀)。
 *
 * 详情页工具条上还有同名开关(底图样式下拉 / 叠加段数输入框 / 热力图 / 光效), 可临时切换,
 *   不必改 yaml。旧写法 `satellite: true` 仍兼容(等价于 map_style: satellite)。
 *   详情页头部有导出按钮(CSV / XML / JSON)。
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 *
 * ⚠️ 本文件是 Lit + TS 重构版, 行为与视觉须与原 leapmotor-trips.js **逐项等价**:
 *    元素名/配置字段(含别名)/WS 命令/localStorage/错误文案/条件显示/CSS 与动画全部保留。
 *    轨迹绘制/瓦片引擎/SVG 折线仍是**命令式**; 列表渲染保留整块 innerHTML 结构,
 *    以确保命令式的缩略图绘制仍能按 class/data-* 找到节点。
 */
import { LitElement, nothing } from "lit";
import type { HomeAssistant, LovelaceCardConfig } from "../types/hass";
import { esc, clamp, pad2 } from "../lib/dom";
import { fmtNum, fmtKm, fmtKwhTrip as fmtKwh } from "../lib/format";
import {
  TILE,
  TILE_SOURCES,
  TILE_FALLBACK,
  project,
  unproject,
  wgs84ToGcj02,
  haversineKm,
  getSpeedColor,
  simplify,
} from "../lib/geo";
import { ipIcon } from "../lib/icons";
import { normMapStyle, effMapStyle, isDark } from "../lib/theme";
import { defineCard, registerCustomCard, banner } from "../lib/register";
import { CARD_VERSIONS } from "../lib/version";
import { interactionStyles } from "../lib/motion";
import { uiStyles } from "../lib/ui/styles";
import { bindAppearance, unbindAppearance } from "../lib/appearance";
import { bindScrub } from "../lib/scrub";
import { profileSvg, profileStyles } from "./trip-profile";

const CARD_VERSION = CARD_VERSIONS.trips;

/* 断档阈值(km): 相邻轨迹点距离超过它 → 视为中间丢过采样, 用虚线连 */
const TRACK_GAP_KM = 2;

/* 列表缩略图: 固定尺寸 + 懒加载预算(见下方 THUMB_LIMIT 说明) */
const THUMB_W = 96;
const THUMB_H = 72;
/* 缩略图预算(**安全上限**, 不再是主闸): 现在按可视区懒加载, 滚到哪拉到哪;
   这两个值只在"超长列表 + 一直滚动"的极端情况下兜底, 免得把瓦片/WS 请求拉爆。 */
const THUMB_LIMIT = 200;
const DAY_THUMB_LIMIT = 60;
const THUMB_ROOT_MARGIN = "200px 0px"; // 可视区外提前多远开始拉(滚到附近就开拉)
const THUMB_FETCH_POINTS = 80; // 缩略图只要这么多点, 详情大图才是全量
const THUMB_CONCURRENCY = 4;
const OVERLAY_MAX = 50; // 「叠加最近」手填上限(拉太多轨迹会拖慢首屏)
/* 每日卡片头部的"当天叠加轨迹"缩略图: 比单段缩略图大一点(看得清当天都跑了哪些路) */
const DAY_THUMB_W = 120;
const DAY_THUMB_H = 88;

/* 叠加模式的配色(相邻两段尽量不同色) */
const OVERLAY_COLORS = [
  "#1e88e5", "#e53935", "#00897b", "#8e24aa", "#f4511e",
  "#3949ab", "#7cb342", "#d81b60", "#00acc1", "#6d4c41",
  "#5e35b1", "#c0ca33", "#039be5", "#ad1457", "#43a047",
  "#8d6e63", "#3f51b5", "#ef6c00", "#0097a7", "#f06292",
];

/* ── 小工具(不引入任何依赖) ── */
/** epoch 秒 → "10月11日 20:35:12"(点选轨迹点时显示采样时刻) */
function fmtMoment(ts: unknown): string {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " +
    pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + ":" + pad2(d.getSeconds());
}

function fmtTime(ts: unknown): string {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function fmtDayTime(ts: unknown): string {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 详情页标题用的"9月13日 20:11"。 */
function fmtStamp(ts: unknown): string {
  const n = Number(ts);
  if (!n || !Number.isFinite(n)) return "—";
  const d = new Date(n * 1000);
  return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

function dayKey(ts: unknown): string {
  const d = new Date(Number(ts) * 1000);
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate());
}

/** 某个时刻所在自然日的 0 点(本地时区), 返回 epoch 秒。 */
function dayStart(ts: unknown): number {
  const d = new Date(Number(ts) * 1000);
  d.setHours(0, 0, 0, 0);
  return Math.floor(d.getTime() / 1000);
}

function dayLabel(ts: unknown): string {
  const d = new Date(Number(ts) * 1000);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const day = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const diff = Math.round((today.getTime() - day.getTime()) / 86400000);
  if (diff === 0) return "今天";
  if (diff === 1) return "昨天";
  const wk = "日一二三四五六"[d.getDay()];
  const y = d.getFullYear() !== now.getFullYear() ? d.getFullYear() + "年" : "";
  return y + (d.getMonth() + 1) + "月" + d.getDate() + "日 周" + wk;
}

function fmtDuration(min: unknown): string {
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
function fmtDurShort(min: unknown): string {
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

/** 坐标文本(没有地点名, 就老实给坐标 —— 不编地名)。 */
function fmtCoord(lat: unknown, lon: unknown): string | null {
  const la = Number(lat);
  const lo = Number(lon);
  if (lat == null || lon == null || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
  return Math.abs(la).toFixed(4) + "°" + (la >= 0 ? "N" : "S") + "  " +
    Math.abs(lo).toFixed(4) + "°" + (lo >= 0 ? "E" : "W");
}

/* 显示轨迹点: [0]=GCJ 纬度 [1]=GCJ 经度 [2]=车速 [3]=WGS 纬度 [4]=WGS 经度 [5]=采样时刻(epoch 秒) */
type Pt = [number, number, number | null, number | null, number | null, number | null, (number|null)?];
interface Prep {
  runs: Pt[][];
  breaks: [Pt, Pt][];
  lo: number | null;
  hi: number | null;
}
interface Trip {
  id: unknown;
  started_at?: number;
  ended_at?: number;
  distance_km?: number;
  duration_min?: number;
  energy_kwh?: number;
  efficiency?: number;
  avg_speed_kmh?: number;
  start_soc?: number;
  end_soc?: number;
  point_count?: number;
  reconstructed?: boolean;
  approx_time?: boolean;
  frozen?: boolean;
  track_dropped?: boolean;
  start_lat?: number;
  start_lon?: number;
  end_lat?: number;
  end_lon?: number;
  [k: string]: any;
}
interface OverlayTrack {
  id: unknown;
  runs: Pt[][];
  breaks: [Pt, Pt][];
  color: string;
  label: string;
}
interface MonthInfo {
  month: string;
  count?: number;
  km?: number;
}
interface StoreInfo {
  tracks_mb?: number;
  index_mb?: number;
  limit_mb?: number;
  months?: number;
}

class LeapmotorTripsCard extends LitElement {
  // 命令式渲染: 自己持有 shadow root 与所有节点引用, 不走 Lit 模板(与原实现一致)。
  // ⚠️ 必须同时覆写 update()/render(): LitElement.update() 会调用 this.render(),
  //    不覆写的话会抛 "render() is not implemented" → HA 显示「配置错误」(实测踩过)。
  //    (控制卡有同样的覆写; 两卡都是纯命令式, 不用 Lit 模板。)
  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this._ensureShadow();
  }
  protected update(): void {
    /* no-op: 本卡不使用 Lit 模板渲染 */
  }
  render() {
    /* no-op: 本卡不使用 Lit 模板渲染 */
    return nothing;
  }

  /** 确保 open 模式 shadow root 已挂载(幂等)。setConfig 可能早于 connectedCallback,
   *  那时 Lit 还没调 createRenderRoot, this.shadowRoot 为 null —— 这里兜住。 */
  private _ensureShadow(): ShadowRoot {
    return this.shadowRoot || this.attachShadow({ mode: "open" });
  }

  _config!: LovelaceCardConfig | null;
  _hass: HomeAssistant | null = null;
  _zoom = 16;
  _center: [number, number] | null = null; // [lat, lon](显示坐标系 = GCJ-02)
  _built = false;
  _loaded = false; // 只自动拉一次; 之后靠刷新按钮
  _loading = false;
  _err = "";
  _trips: Trip[] = [];
  _stats: any = null;
  _months: MonthInfo[] = []; // [{month, count, km}] 有数据的月份(新→旧) —— 时间范围跳转用
  _store: StoreInfo | null = null; // {tracks_mb, index_mb, limit_mb, months} 轨迹存储占用(卡片底部小字)
  _active: any = null;
  // ── 时间窗口(默认"最近 30 天"滚动窗口; 与自然月解耦, 月初也能看到上月的行程)──
  _winMode: "days" | "month" = "days"; // days = 滚动窗口 | month = 指定月份
  _winDays = 30; // 窗口长度(7 / 30 / 90)
  _winEnd: number | null = null; // 窗口结束时刻(epoch 秒); null = 锚在"现在"
  _winMonth: string | null = null; // month 模式下的 "YYYY-MM"
  _wpop = false; // 月份弹层是否展开
  _selectedId: unknown = "";
  _selTrip: Trip | null = null;
  _sel: Prep | null = null; // 选中行程的 {runs, breaks}(显示坐标)
  _trackCache: Record<string, any[]> = {}; // trip_id → 全量轨迹点(WGS-84), 详情大图用
  _thumbCache: Record<string, any[]> = {}; // trip_id → 降采样轨迹点(WGS-84), 缩略图用
  _thumbPrep: Record<string, Prep | null> = {}; // trip_id → 缩略图用的 {runs, breaks}(null = 没轨迹)
  _thumbSeq = 0;
  _delAsk: string | null = null; // 待确认删除的行程 id(见 _askDelete)
  _delTimer: any = null; // 确认气泡的自动收起定时器
  _thumbTasks: { kind: "row" | "day"; id?: string; key?: string }[] = []; // 缩略图懒加载队列
  _thumbBusy = 0; // 正在跑的缩略图任务数(并发上限 THUMB_CONCURRENCY)
  _thumbObs: IntersectionObserver | null = null; // 可视区观察器(见 _build)
  _dayPrep: Record<string, Prep | null> = {}; // dayKey → {runs, breaks}(当天所有轨迹叠加, 给每日缩略图用)
  _daySeq = 0;
  _dayMode: "overview"|"compact"|"expanded" = "overview";
  _collapsed: Record<string, boolean> = {}; // dayKey → false = 该天**展开**; 未设置 = 默认收起
  private _motionKey = "";

  private _animateAction(el: HTMLElement | null) {
    if (!el || typeof el.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    for (const animation of el.getAnimations?.() || []) animation.cancel();
    el.animate([{ opacity: .6, transform: "translateY(4px)" }, { opacity: 1, transform: "translateY(0)" }],
      { duration: 160, easing: "ease-out" });
  }
  _view: "list" | "detail" = "list"; // list | detail
  _overlayN = 0;
  _overlayTracks: OverlayTrack[] = [];
  _overlaySeq = 0;
  _tiles: Map<string, HTMLImageElement> = new Map();
  _needFit = true;
  _dragging = false;
  _pt: { x: number; y: number; lines: string[];p?:Pt;idx?:number } | null = null;
  private _scrubRAF=0;
  // 详情图的可视化开关(可在 yaml 里设默认值, 也能在卡片上临时切换)
  _heatmap = true; // 速度热力图(按实时车速给轨迹上色)
  _flow = true; // 流动光效(顺着行驶方向的动画)
  _mapStyle: string = "auto"; // auto 随 HA 主题 | vector | satellite | dark
  _group = true;
  _themeDark: boolean | undefined = undefined;

  // 节点引用(命令式)
  _cardEl!: HTMLElement;
  _sumEl!: HTMLElement;
  _refreshBtn!: HTMLButtonElement;
  _collapseBtn!: HTMLButtonElement;
  _activeEl!: HTMLElement;
  _activeText!: HTMLElement;
  _listView!: HTMLElement;
  _detailView!: HTMLElement;
  _listEl!: HTMLElement;
  _lmsgEl!: HTMLElement;
  _winbarEl!: HTMLElement;
  _winDaysEls: HTMLButtonElement[] = [];
  _monLabEl!: HTMLButtonElement;
  _monPopEl!: HTMLElement;
  _prevBtn!: HTMLButtonElement;
  _nextBtn!: HTMLButtonElement;
  _winsumEl!: HTMLElement;
  _wlabEl!: HTMLElement;
  _wrangeEl!: HTMLElement;
  _usageEl!: HTMLElement;
  _mapEl!: HTMLElement;
  _tilesEl!: HTMLElement;
  _trajEl!: SVGElement;
  _marksEl!: HTMLElement;
  _mhintEl!: HTMLElement;
  _dinfoEl!: HTMLElement;
  _ddelEl!: HTMLButtonElement;
  _legendEl!: HTMLElement;
  _dexportEl!: HTMLButtonElement;
  _expMenuEl!: HTMLElement;
  _delPopEl!: HTMLElement;
  _ovlBox!: HTMLInputElement;
  _ovlN!: HTMLInputElement;
  _mbtnsEl!: HTMLElement;
  _styleBtn!: HTMLButtonElement;
  _speedBar!: HTMLElement;
  _spdLoEl!: HTMLElement;
  _spdHiEl!: HTMLElement;
  _ro: ResizeObserver | null = null;

  /** 从卡片选择器添加时不需要填任何东西(数据走本集成的 WS 命令)。 */
  static getStubConfig() {
    return { height: 340, map_style: "auto", heatmap: true, flow: true,
             overlay: 0, list_height: 520 };
  }

  setConfig(config: LovelaceCardConfig) {
    const raw: any = config || {};
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
      this._config!.map_style = raw.satellite ? "satellite" : "vector";
    }
    // overlay_count 是 overlay 的别名(两版卡片都有人这么写)
    if (this._config!.overlay == null && this._config!.overlay_count != null) {
      this._config!.overlay = this._config!.overlay_count;
    }
    this._config!.height = clamp(Number(this._config!.height) || 340, 200, 900);
    this._config!.list_height = clamp(Number(this._config!.list_height) || 520, 160, 1600);
    this._mapStyle = normMapStyle(this._config!.map_style);
    this._heatmap = this._config!.heatmap !== false;
    this._flow = this._config!.flow !== false;
    this._group = this._config!.group !== false;
    const ov = Number(this._config!.overlay) || 0;
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
  _normMapStyle(v: unknown): string {
    return normMapStyle(v);
  }

  /** 实际生效的底图: auto → HA 深色主题时用深色, 否则路网。 */
  _effMapStyle(): string {
    return effMapStyle(this._mapStyle, this._hass);
  }

  set hass(hass: HomeAssistant | null) {
    this._hass = hass;
    // "自动"底图随 HA 主题: 主题从浅切深时重画一次瓦片/缩略图(否则要等下次交互才变)
    const dark = isDark(hass);
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
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  getCardSize(): number {
    const h = (this._config && this._config.height) || 340;
    return Math.ceil(h / 50) + 3;
  }

  // ── 数据 ──
  _errText(err: unknown): string {
    const code = String((err as any)?.code || "");
    const msg = String((err as any)?.message || err || "");
    if (code === "unknown_command" || /unknown command/i.test(msg)) {
      return "";                      // 命令没注册(旧版集成): 不提示, 安静留空
    }
    if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
    if (code === "unauthorized" || /admin|管理员/i.test(msg)) return "需要管理员权限";
    return "读取失败: " + msg.slice(0, 80);
  }

  _find(id: unknown): Trip | null {
    for (const t of this._trips) {
      if (t && String(t.id) === String(id)) return t;
    }
    return null;
  }

  async _load() {
    if (!this._hass || this._loading) return;
    if (!this._hass.callWS) {
      this._err = "";                 // 拿不到 WS: 安静留空, 不再提示"需要 beta 版集成"
      this._render();
      return;
    }
    this._loading = true;
    this._err = "";
    this._render();
    try {
      // 时间窗口: 滚动窗口(days + 锚点)或整月(month)。服务端 limit 只是安全上限(一个月最多几十段)。
      const req: Record<string, any> = { type: "leapmotor/trips/list", limit: 500 };
      if (this._winMode === "month" && this._winMonth) {
        req.month = this._winMonth;
      } else {
        req.days = this._winDays;
        if (this._winEnd) req.end = this._winEnd;
      }
      const res: any = await this._hass.callWS(req);
      this._trips = (res && res.trips) || [];
      this._stats = (res && res.stats) || null;
      this._months = (res && res.months) || [];
      this._store = (res && res.store) || null;
      this._active = (res && res.active) || null;
      // 服务端若把窗口锚定了(整月模式), 记下来, 翻页/叠加都用同一个锚点
      if (this._winMode === "month") this._winEnd = null;
      this._trackCache = {};
      this._thumbCache = {};
      this._thumbPrep = {};
      this._thumbSeq++;
      this._thumbTasks = [];        // 丢掉上一份列表遗留的懒加载任务
      if (this._thumbObs) this._thumbObs.disconnect();
      this._dayPrep = {};
      this._daySeq++;
      this._overlayTracks = [];
      this._overlaySeq++;
      this._loading = false;
      this._needFit = true;
      this._render();
      if (this._view === "detail" && this._selectedId) await this._openDetail(this._selectedId, true);
      if (this._overlayN > 0) await this._loadOverlay();
    } catch (err) {
      this._loading = false;
      this._err = this._errText(err);
      this._render();
    }
  }

  /** 取一段行程的**全量**轨迹(详情大图用), 带缓存。 */
  async _ensureTrack(id: unknown): Promise<any[]> {
    if (this._trackCache[String(id)]) return this._trackCache[String(id)];
    let pts: any[] = [];
    try {
      const res: any = await this._hass!.callWS!({
        type: "leapmotor/trips/track",
        trip_id: id,
        max_points: 0,
      });
      pts = (res && res.points) || [];
    } catch (err) {
      pts = [];
      if (!this._err) this._err = this._errText(err);
    }
    this._trackCache[String(id)] = pts;
    return pts;
  }

  /** 取一段行程的**降采样**轨迹(缩略图用, 只 80 点), 带缓存; 失败返回空数组。 */
  async _ensureThumbTrack(id: unknown): Promise<any[]> {
    if (this._thumbCache[String(id)]) return this._thumbCache[String(id)];
    let pts: any[] = [];
    try {
      const res: any = await this._hass!.callWS!({
        type: "leapmotor/trips/track",
        trip_id: id,
        max_points: THUMB_FETCH_POINTS,
      });
      pts = (res && res.points) || [];
    } catch (err) {
      pts = [];
    }
    this._thumbCache[String(id)] = pts;
    return pts;
  }

  /** 原始轨迹(WGS-84)→ 显示坐标, 并按距离切成 runs(实线)/ breaks(虚线)。
   *  保留可选的第三维车速(p[2]), 供速度热力图着色用。 */
  _prepare(raw: any[], maxN: number): Prep {
    const src = simplify(raw || [], maxN);
    const disp: Pt[] = [];
    for (const p of src) {
      if (!p || p.length < 2) continue;
      const la = Number(p[0]);
      const lo = Number(p[1]);
      const speed = p[2]!=null&&Number.isFinite(Number(p[2])) ? Number(p[2]) : null;
      const ts = p.length >= 4 && Number.isFinite(Number(p[3])) ? Number(p[3]) : null;
      if (!Number.isFinite(la) || !Number.isFinite(lo)) continue;
      if (la === 0 && lo === 0) continue;
      const gcj = wgs84ToGcj02(la, lo);
      // [0]=GCJ 纬度 [1]=GCJ 经度 [2]=车速 [3]=WGS 纬度 [4]=WGS 经度 [5]=采样时刻(epoch 秒)
      disp.push([gcj[0], gcj[1], speed, la, lo, ts, p[4]!=null&&Number.isFinite(Number(p[4]))?Number(p[4]):null]);
    }
    // 本条行程的**实际速度区间** —— 热力图配色与下方速度条都按它取值(而不是固定的 0~120)
    let lo: number | null = null, hi: number | null = null;
    for (const q of disp) {
      if (q.length < 3 || q[2] == null) continue;
      const v = Number(q[2]);
      if (!Number.isFinite(v)) continue;
      lo = lo == null ? v : Math.min(lo, v);
      hi = hi == null ? v : Math.max(hi, v);
    }
    if (lo != null && hi != null && hi - lo < 10) {      // 区间太窄(全程匀速) → 左右各撑 5
      lo = Math.max(0, lo - 5);
      hi = hi + 5;
    }
    const runs: Pt[][] = [];
    const breaks: [Pt, Pt][] = [];
    let cur: Pt[] = [];
    for (let i = 0; i < disp.length; i++) {
      if (i > 0) {
        if (haversineKm(disp[i - 1] as unknown as [number, number], disp[i] as unknown as [number, number]) > TRACK_GAP_KM) {
          if (cur.length) runs.push(cur);
          breaks.push([disp[i - 1], disp[i]]);
          cur = [];
        }
      }
      cur.push(disp[i]);
    }
    if (cur.length) runs.push(cur);
    return { runs: runs, breaks: breaks, lo: lo, hi: hi };
  }

  async _openDetail(id: unknown, keepView?: boolean) {
    const previousIndex=keepView?this._pt?.idx:undefined;
    if(!keepView){this._pt=null;this._plotOpen=false;this._sel=null;}
    const t = this._find(id);
    this._selectedId = id;
    this._selTrip = t;
    this._view = "detail";
    this._render();
    if (!t) return;
    if ((t.point_count || 0) > 0) {
      const pts = await this._ensureTrack(id);
      if (String(this._selectedId) !== String(id) || this._view !== "detail") return;
      this._sel = this._prepare(pts, 4000);
    } else {
      this._sel = null;
    }
    if (keepView === true && this._overlayN > 0) { this._renderDetailInfo();if(previousIndex!=null)this._selectProfilePoint(previousIndex,false);this._renderMarks();return; }
    this._needFit = true;
    this._renderMap();
    this._renderDetailInfo();
    if(previousIndex!=null)this._selectProfilePoint(previousIndex,false);
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
    // 叠加锚在**当前视图的结束时刻**: 看最近 30 天 = 截至现在; 看某个月 = 截至该月末。
    // 与"列表里正好显示哪几段"无关 —— 月初看当月时, 叠加照样能取到上个月的轨迹。
    const before = this._winAnchor();
    let items: any[] | null = null;
    try {
      const res: any = await this._hass.callWS({
        type: "leapmotor/trips/tracks", limit: n, max_points: 400, before,
      });
      items = (res && res.tracks) || [];
    } catch (err) {
      const msg = String((err as any)?.code || (err as any)?.message || err || "");
      if (!/unknown_command|unknown command/i.test(msg)) {
        this._overlayTracks = [];
        this._renderLegend();
        this._renderMap();
        return;
      }
      items = null;                     // 旧版集成: 退回"逐段拉全量"(下面的兼容路径)
    }
    if (seq !== this._overlaySeq || this._overlayN !== n) return;   // 期间开关/刷新过
    const out: OverlayTrack[] = [];
    if (items) {
      for (const item of items) {
        const t = (item && item.trip) || {};
        const prep = this._prepare((item && item.points) || [], 400);
        if (!prep.runs.length) continue;
        out.push({
          id: t.id,
          runs: prep.runs,
          breaks: prep.breaks,
          color: OVERLAY_COLORS[out.length % OVERLAY_COLORS.length],
          label: fmtTime(t.started_at) + " → " + fmtTime(t.ended_at),
        });
      }
    } else {
      const cands = this._trips.filter((t) => t && (t.point_count || 0) > 0).slice(0, n);
      for (const t of cands) await this._ensureTrack(t.id);
      if (seq !== this._overlaySeq || this._overlayN !== n) return;
      for (const t of cands) {
        const prep = this._prepare(this._trackCache[String(t.id)] || [], 400);
        if (!prep.runs.length) continue;
        out.push({
          id: t.id,
          runs: prep.runs,
          breaks: prep.breaks,
          color: OVERLAY_COLORS[out.length % OVERLAY_COLORS.length],
          label: fmtTime(t.started_at) + " → " + fmtTime(t.ended_at),
        });
      }
    }
    this._overlayTracks = out;
    this._needFit = true;
    this._renderLegend();
    this._renderMap();
  }

  _toggleOverlay(on: boolean) {
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
    this._renderWinbar();
    this._renderWinsum();
    this._renderUsage();
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
    this._syncActionMotion();
  }

  // ── 时间窗口(默认"最近 30 天"; 与自然月解耦) ──
  private _syncActionMotion() {
    const key = this._view + ":" + this._selectedId + ":" + this._winMode + ":" + this._winDays + ":" + this._winMonth + ":" + this._winEnd;
    if (this._motionKey && this._motionKey !== key) this._animateAction(this._view === "detail" ? this._detailView : this._listView);
    this._motionKey = key;
  }

  /** 当前窗口内行程的汇总(段数/里程/耗电/百公里电耗) —— 表头统计用它。 */
  _winSummary() {
    let km = 0, kwh = 0, n = 0;
    for (const t of this._trips) {
      if (!t) continue;
      n += 1;
      km += Number(t.distance_km) || 0;
      kwh += Number(t.energy_kwh) || 0;
    }
    return { n, km, kwh, eff: (km > 0.5 && kwh > 0) ? (kwh / km) * 100 : null };
  }

  _windowLabel(): string {
    if (this._winMode === "month" && this._winMonth) {
      const [y, m] = this._winMonth.split("-");
      return `${y} 年 ${Number(m)} 月`;
    }
    return `最近 ${this._winDays} 天`;
  }

  /** 窗口锚点(epoch 秒): 滚动 = 结束时刻(默认现在); 整月 = 下月 1 号 0 点(开区间上界)。 */
  _winAnchor(): number {
    if (this._winMode === "month" && this._winMonth) {
      const [y, m] = this._winMonth.split("-").map(Number);
      return new Date(y, m, 1, 0, 0, 0).getTime() / 1000;
    }
    return this._winEnd || Date.now() / 1000;
  }

  _windowRangeText(): string {
    const now = Date.now() / 1000;
    if (this._winMode === "month" && this._winMonth) {
      const [y, m] = this._winMonth.split("-").map(Number);
      const last = new Date(y, m, 0);                     // 该月最后一天
      return `${this._winMonth}-01 ~ ${dayKey(last.getTime() / 1000)}`;
    }
    const end = Math.min(this._winEnd || now, now);
    const start = dayStart(end) - (this._winDays - 1) * 86400;
    return `${dayKey(start)} ~ ${dayKey(end)}`;
  }

  /** 月份列表(只有有数据的月份; 新→旧), 弹层里用。 */
  _monthsHtml(): string {
    const cur = this._winMode === "month" ? this._winMonth : "";
    if (!this._months.length) return '<div class="wph">还没有历史月份</div>';
    return '<div class="wph">有数据的月份</div>' + this._months.map((m) => {
      const [y, mm] = String(m.month).split("-");
      const on = String(m.month) === String(cur) ? " on" : "";
      return `<button data-month="${esc(m.month)}" class="wopt${on}">` +
        `<span class="wm">${y} 年 ${Number(mm)} 月</span>` +
        `<span class="wd">${m.count || 0} 段 · ${fmtKm(m.km)} km</span></button>`;
    }).join("");
  }

  _renderWinbar() {
    if (!this._winbarEl) return;
    const days = this._winMode !== "month";
    this._winDaysEls.forEach((b) => {
      b.classList.toggle("on", days && Number(b.dataset.days) === this._winDays);
    });
    if (this._monLabEl) {
      this._monLabEl.classList.toggle("on", !days);
      this._monLabEl.textContent = (days ? "选择月份" : this._windowLabel()) + " ▾";
    }
    this._monPopEl.classList.toggle("on", !!this._wpop);
    this._monPopEl.innerHTML = this._monthsHtml();
    // 翻页箭头: 到最早/最新边界就禁用(不翻进空白区)
    const months = this._months.map((m) => String(m.month));
    let canPrev: boolean;
    let canNext: boolean;
    if (days) {
      const now = Date.now() / 1000;
      canNext = !!this._winEnd && this._winEnd < now - 60;
      const widest = months.length ? months[months.length - 1] : null;
      canPrev = widest ? dayStart(this._winAnchor()) - (this._winDays - 1) * 86400
        > new Date(Number(widest.slice(0, 4)), Number(widest.slice(5, 7)) - 1, 1).getTime() / 1000
        : false;
    } else {
      const i = months.indexOf(String(this._winMonth));
      canPrev = i >= 0 && i < months.length - 1;          // 列表是新→旧, 往后 = 更早
      canNext = i > 0;
    }
    if (this._prevBtn) this._prevBtn.disabled = !canPrev;
    if (this._nextBtn) this._nextBtn.disabled = !canNext;
  }

  /** 窗口行: 范围标签 + 日期区间 + 行尾的翻页箭头(只改文本, 不重画 —— 箭头是建好一次的节点)。 */
  _renderWinsum() {
    if (this._wlabEl) this._wlabEl.textContent = this._windowLabel();
    if (this._wrangeEl) this._wrangeEl.textContent = this._windowRangeText();
  }

  /** 卡片底部小字: 轨迹占用/上限/月数, 如 "11.9/300MB,共7个月"。 */
  _renderUsage() {
    if (!this._usageEl) return;
    const s = this._store;
    if (!s) {
      this._usageEl.textContent = "";
      this._usageEl.hidden = true;
      return;
    }
    const used = Number(s.tracks_mb) || 0;
    const lim = Number(s.limit_mb) || 0;
    const months = Number(s.months) || 0;
    this._usageEl.textContent = (lim ? `${used}/${lim}MB` : `${used}MB`) + `,共${months}个月`;
    this._usageEl.title = "轨迹按月保存(摘要是纯文本账本, 永久保留);" +
      (lim ? `超出 ${lim} MB 后自动清理最老月份的轨迹` : "当前未设空间上限") + "。在集成「配置」里可调整。";
    this._usageEl.hidden = false;
  }

  /** 切换时间窗口(等宽/整月), 并重新拉数据。 */
  async _setWindow({ days: d, month: m }: { days?: number; month?: string } = {}) {
    if (d) {
      this._winMode = "days";
      this._winDays = Number(d);
      this._winEnd = null;                 // 回到"锚在现在"
    } else if (m) {
      this._winMode = "month";
      this._winMonth = String(m);
    }
    this._wpop = false;
    await this._load();
  }

  /** 翻页: 滚动模式翻一个窗口, 整月模式切上/下个有数据的月。 */
  async _pageWindow(dir: number) {
    if (this._winMode === "month") {
      const months = this._months.map((x) => String(x.month));
      const i = months.indexOf(String(this._winMonth));
      const j = i + dir;
      if (i < 0 || j < 0 || j >= months.length) return;
      this._winMonth = months[j];
      this._wpop = false;
      await this._load();
      return;
    }
    const now = Date.now() / 1000;
    const end = (this._winEnd || now) + dir * this._winDays * 86400;
    this._winEnd = end >= now - 60 ? null : end;     // 回到最新一屏就取消锚点
    this._wpop = false;
    await this._load();
  }

  _renderHead() {
    if (!this._sumEl) return;
    const w = this._winSummary();
    const parts: string[] = [];
    if (w.n) {
      parts.push(`${w.n} 段 · ${fmtKm(w.km)} km`);
      if (w.kwh > 0) parts.push(`${fmtNum(w.kwh, 1)} kWh`);
      if (w.eff != null) parts.push(`${fmtNum(w.eff, 1)} kWh/100km`);
    } else if (!this._loading && !this._err) {
      parts.push("这段时间没有行程记录");
    }
    const gaps = this._stats && this._stats.gaps;
    if (gaps) parts.push(`漏采 ${gaps} 次`);
    this._sumEl.textContent = parts.join(" · ");
    if (this._refreshBtn) this._refreshBtn.classList.toggle("spin", this._loading);
    this._syncCollapseBtn();
  }

  /** 列表里出现过的所有日期(天)。 */
  _allDays(): string[] {
    const days: string[] = [];
    for (const t of this._trips) {
      if (!t || !t.started_at) continue;
      const k = dayKey(t.started_at);
      if (!days.includes(k)) days.push(k);
    }
    return days;
  }

  /** 三种密度循环；单日仍可独立展开。紧凑模式不创建或请求每日缩略图。 */
  _toggleAllDays() {
    const days=this._allDays();if(!days.length)return;
    this._dayMode=this._dayMode==='overview'?'compact':this._dayMode==='compact'?'expanded':'overview';
    for(const key of days)this._collapsed[key]=this._dayMode!=='expanded';
    if(this._dayMode==='compact')this._thumbTasks=this._thumbTasks.filter(task=>task.kind!=='day');
    this._render();this._animateAction(this._listEl);
  }

  _syncCollapseBtn() {
    if(!this._collapseBtn)return;
    const next=this._dayMode==='overview'?'compact':this._dayMode==='compact'?'expanded':'overview';
    const labels={overview:'缩略图概览',compact:'紧凑单行',expanded:'全部展开'};
    const icons={overview:'mdi:image-outline',compact:'mdi:format-list-bulleted',expanded:'mdi:unfold-more-horizontal'};
    this._collapseBtn.innerHTML='<ha-icon icon="'+icons[next]+'"></ha-icon>';
    this._collapseBtn.title='当前：'+labels[this._dayMode]+'；切换到'+labels[next];
    this._collapseBtn.setAttribute('aria-label',this._collapseBtn.title);
    this._collapseBtn.dataset.mode=this._dayMode;
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

  /** 底图按钮(与地图卡同一套): 一律用图标表示当前底图, 点一下按 自动→路网→卫星→深色 循环。 */
  _syncStyleBtn() {
    if (!this._styleBtn) return;
    const s = this._mapStyle || "vector";
    const ICON: Record<string, string> = {
      auto: "mdi:theme-light-dark",
      vector: "mdi:map-outline",
      satellite: "mdi:satellite-variant",
      dark: "mdi:weather-night",
    };
    const NAME: Record<string, string> = {
      auto: "自动(随主题)", vector: "路网", satellite: "卫星", dark: "深色",
    };
    this._styleBtn.innerHTML = '<ha-icon icon="' + (ICON[s] || ICON.vector) + '"></ha-icon>';
    this._styleBtn.title = "底图: " + (NAME[s] || "路网") + " —— 点一下切换";
    this._styleBtn.classList.toggle("on", s !== "vector");
  }

  /** 切底图: 换瓦片源必须**丢掉已缓存的瓦片节点**(坐标键不含样式, 不丢会"切了没反应")。 */
  _cycleMapStyle() {
    const order = ["auto", "vector", "satellite", "dark"];
    const i = order.indexOf(this._mapStyle || "vector");
    this._mapStyle = order[(i + 1) % order.length];
    this._tiles.forEach((img) => img.remove());
    this._tiles.clear();
    this._syncStyleBtn();
    this._applyMapStyle();
    this._renderMap();
    this._paintThumbs();
    this._paintDayThumbs();
  }

  _renderToolbar() {
    if (!this._ovlBox) return;
    const chip = (box: HTMLInputElement, on: boolean) => {
      box.checked = !!on;
      const lab = box.closest(".tchip");
      if (lab) lab.classList.toggle("on", !!on);
    };
    chip(this._ovlBox, this._overlayN > 0);
    this._ovlN.value = String(this._overlayN || 5);
    // 热力图/光效/底图都在地图右上角那列图标钮里: 选中态 = 主题蓝(与"叠加"胶囊同一套观感)
    for (const [m, on] of [["heat", !!this._heatmap], ["flow", !!this._flow]] as [string, boolean][]) {
      const b = this.shadowRoot!.querySelector('.mbtns [data-m="' + m + '"]');
      if (b) b.classList.toggle("on", on);
    }
    this._syncStyleBtn();
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
      // 有窗口就有"这段时间"的语义: 窗口内没有行程 ≠ 从来没有记录过
      const anyTrips = this._months.reduce((s, m) => s + (Number(m.count) || 0), 0);
      this._lmsgEl.textContent = anyTrips ? "这段时间没有行程记录" : "还没有行程记录";
      return;
    }
    this._lmsgEl.textContent = "";
    let html = "";
    let curDay = "";
    let group: Trip[] = [];
    const flush = () => {
      if (!group.length) return;
      let km = 0;
      for (const t of group) km += Number(t.distance_km) || 0;
      const key = dayKey(group[0].started_at);
      if (this._group === false) {
        // 关掉分组卡片(旧版式): 只给一行日期小标题
        html += '<div class="grp" data-day="' + key + '">' +
          '<span class="dn" title="'+dayLabel(group[0].started_at)+'">' + (this._dayMode==='compact'?dayLabel(group[0].started_at).replace(/\s*周./,'').replace('月','/').replace('日',''):dayLabel(group[0].started_at)) + "</span>" +
          '<span class="dc">' + group.length + " 段</span>" +
          '<span class="dk">' + km.toFixed(1) + " km</span></div>";
        for (const t of group) html += this._rowHtml(t);
        group = [];
        return;
      }
      const closed = key in this._collapsed ? this._collapsed[key] !== false : this._dayMode !== "expanded";   // 默认收起
      // 当天汇总(与单段行程同一套 .mets 排版): 收起时显示"耗时/耗电/百公里电耗"
      let dur = 0, kwh = 0, hasDur = false, hasKwh = false;
      for (const t of group) {
        if (t.duration_min != null) { dur += Number(t.duration_min) || 0; hasDur = true; }
        if (t.energy_kwh != null) { kwh += Number(t.energy_kwh) || 0; hasKwh = true; }
      }
      const dayEff = (hasKwh && km > 0.5 && kwh > 0) ? kwh / km * 100 : null;
      const sumMets: [string, string, string, string, number?][] = [
        ["耗时", hasDur ? fmtDurShort(dur) : "—", "", "当天累计耗时"],
        ["耗电", hasKwh ? fmtKwh(kwh) : "—", hasKwh ? "kWh" : "", "当天累计耗电"],
        ["平均电耗", dayEff == null ? "—" : fmtNum(dayEff, 1),
         dayEff == null ? "" : "kWh/100km", "当天百公里电耗", 1],
      ];
      const sumHtml = sumMets.map((m) =>
        '<div class="met" title="' + m[3] + '"><span class="k">' + m[0] + '</span><span class="v">' +
        m[1] + (m[2] ? '<i' + (m[4] ? ' class="fit"' : "") + ">" + m[2] + "</i>" : "") +
        "</span></div>").join("");
      // 每日包一层卡片: 收起态 = 左侧当天叠加缩略图 + 右侧汇总(耗时/耗电/能耗);
      // 展开态 = 隐藏缩略图与汇总, 改看当日各段明细。
      html += '<div class="daycard' + (closed ? " collapsed" : "") + (this._dayMode==='compact'?' compactDay':'') + '" data-day="' + key + '">' +
        '<div class="daytop">' +
        (this._dayMode==='compact'?'':'<div class="dthumb" title="当天轨迹叠加"></div>') +
        '<div class="dayinfo">' +
        '<div class="dayhead">' +
        '<span class="dn" title="'+dayLabel(group[0].started_at)+'">' + (this._dayMode==='compact'?dayLabel(group[0].started_at).replace(/\s*周./,'').replace('月','/').replace('日',''):dayLabel(group[0].started_at)) + "</span>" +
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

  /** 一段行程 = 紧凑两行(缩略图 + 里程/时间段 + 指标行), 行与行之间用通栏细线分隔。

   * 不再用"子卡片"(白底 + 边框 + 阴影): 展开一天后动辄 5~10 段, 一堆卡片会很吵;
   * 细线列表更紧凑, 也把视觉重点留给缩略图和数字。
   */
  _rowHtml(t: Trip): string {
    const sameDay = dayKey(t.started_at) === dayKey(t.ended_at || t.started_at);
    const tm = sameDay
      ? fmtTime(t.started_at) + " - " + fmtTime(t.ended_at)
      : fmtDayTime(t.started_at) + " - " + fmtDayTime(t.ended_at);
    const badges: string[] = [];
    if (t.reconstructed) {
      badges.push('<span class="badge r" title="漏采补记: 没有轨迹, 时间只是两次观测之间">补记</span>');
    }
    if (t.frozen) badges.push('<span class="badge f" title="车端失联后收尾, 时长可能有偏差">失联</span>');
    if (t.track_dropped) {
      badges.push('<span class="badge d" title="轨迹因存储上限被清理(行程记录仍在); 上限可在集成「配置」里调整">轨迹已清理</span>');
    }
    // 指标一行到底: "耗时 29'00" · 耗电 2.1 kWh · 平均电耗 14.7 kWh/100km"
    // 单位写全(只写 kWh 会被读成耗电量); 窄卡片**换行**而不是截断(信息一条都不丢)。
    const durTxt = (t.approx_time && t.duration_min != null ? "≈ " : "") + fmtDurShort(t.duration_min);
    const line2 =
      '<div class="rline2">' +
      '耗时 <b>' + durTxt + "</b>" +
      ' · 耗电 <b>' + fmtKwh(t.energy_kwh) + " kWh</b>" +
      (t.efficiency == null
        ? " · 平均电耗 <b>—</b>"
        : " · 平均电耗 <b>" + fmtNum(t.efficiency, 1) + " kWh/100km</b>") +
      "</div>";
    return (
      '<div class="row trip" data-id="' + String(t.id) + '">' +
      '<div class="thumb" title="行程缩略图">' +
      (badges.length ? '<span class="rbadges">' + badges.join("") + "</span>" : "") +
      "</div>" +
      '<div class="rbody">' +
      '<div class="rline1">' +
      '<span class="rkm">' + fmtKm(t.distance_km) + "<i>km</i></span>" +
      '<span class="rtm">' + tm + "</span>" +
      "</div>" + line2 +
      "</div>" +
      '<button class="del" data-act="del" title="删除这段行程">' +
      '<ha-icon icon="mdi:trash-can-outline"></ha-icon></button>' +
      "</div>"
    );
  }

  /** 列表里的长单位(如 "kWh/100km")在窄列放不下时**整段隐藏**, 而不是截成 "kWh/10…"。
      能放下就显示完整口径 —— 只写 "kWh" 会被读成耗电量, 缺了 /100km 是错的。
      尺子: .v 是 nowrap + overflow:hidden, scrollWidth 超出 clientWidth 就是放不下。
      由 _renderList() 和 ResizeObserver(列宽变化)调用。 */
  _fitUnits() {
    if (!this._listEl) return;
    for (const v of this._listEl.querySelectorAll(".met .v")) {
      const u = v.querySelector("i.fit") as HTMLElement | null;
      if (!u) continue;
      u.hidden = false;                           // 先复位再量(上一轮可能隐藏过)
      if ((v as HTMLElement).scrollWidth > (v as HTMLElement).clientWidth + 1) u.hidden = true;
    }
  }

  // ── 缩略图(按可视区懒加载) ──
  /** 重画已有数据的行缩略图, 并把"还没数据"的行交给观察器(滚到附近才拉)。 */
  _paintThumbs() {
    if (!this._listEl) return;
    for (const row of this._listEl.querySelectorAll<HTMLElement>(".row[data-id]")) {
      const id = row.dataset.id;
      if (id && this._thumbPrep[id] !== undefined) this._paintThumb(row, id);
    }
    this._observeThumbs();
  }

  _observeThumbs() {
    if (!this._listEl) return;
    let i = 0;
    for (const row of this._listEl.querySelectorAll<HTMLElement>(".row[data-id]")) {
      if (i++ >= THUMB_LIMIT) break;               // 兜底预算(懒加载下几乎不会碰到)
      const id = row.dataset.id;
      if (!id || this._thumbPrep[id] !== undefined) continue;
      const el = row.querySelector<HTMLElement>(".thumb");
      if (!el) continue;
      el.dataset.thumbId = id;                     // 观察器回调靠它认领
      if (this._thumbObs) this._thumbObs.observe(el);
      else this._enqueueThumb(id);                 // 老浏览器: 退回"按顺序补齐"
    }
  }

  // ── 每日叠加缩略图(同懒加载) ──
  _paintDayThumbs() {
    if (this._group === false || !this._listEl) return;
    for (const dc of this._listEl.querySelectorAll<HTMLElement>(".daycard[data-day]")) {
      const key = dc.dataset.day;
      if (key && this._dayPrep[key] !== undefined) this._paintDayThumb(dc);
    }
    this._observeDayThumbs();
  }

  _observeDayThumbs() {
    if (this._group === false || !this._listEl) return;
    let i = 0;
    for (const dc of this._listEl.querySelectorAll<HTMLElement>(".daycard[data-day]")) {
      if (i++ >= DAY_THUMB_LIMIT) break;
      const key = dc.dataset.day;
      if (!key || this._dayPrep[key] !== undefined) continue;
      const el = dc.querySelector<HTMLElement>(".dthumb");
      if (!el) continue;
      el.dataset.dayKey = key;
      if (this._thumbObs) this._thumbObs.observe(el);
      else this._enqueueDayThumb(key);
    }
  }

  _enqueueThumb(id: string) {
    if (!id || this._thumbPrep[id] !== undefined) return;
    this._thumbTasks.push({ kind: "row", id });
    this._pumpThumbTasks();
  }

  _enqueueDayThumb(key: string) {
    if (!key || this._dayPrep[key] !== undefined) return;
    this._thumbTasks.push({ kind: "day", key });
    this._pumpThumbTasks();
  }

  _pumpThumbTasks() {
    while (this._thumbBusy < THUMB_CONCURRENCY && this._thumbTasks.length) {
      const task = this._thumbTasks.shift()!;
      this._thumbBusy += 1;
      this._runThumbTask(task).catch(() => {}).finally(() => {
        this._thumbBusy -= 1;
        this._pumpThumbTasks();
      });
    }
  }

  /** 跑一个缩略图任务: 拉轨迹(带缓存) → 准备 → 只补那一张图(不整表重画)。 */
  async _runThumbTask(task: { kind: "row" | "day"; id?: string; key?: string }) {
    const seq = this._thumbSeq;
    if (task.kind === "row") {
      const id = task.id!;
      if (this._thumbPrep[id] === undefined) {
        const raw = await this._ensureThumbTrack(id);
        if (seq !== this._thumbSeq) return;
        this._thumbPrep[id] = raw && raw.length ? this._prepare(raw, 160) : null;
      }
      if (seq !== this._thumbSeq) return;
      const row = this._rowEl(id);
      if (row) this._paintThumb(row, id);
      return;
    }
    // 日卡: 把当天各段的轨迹叠加成一张(与行缩略图共享轨迹缓存)
    const key = task.key!;
    if (this._dayPrep[key] === undefined) {
      const runs: Pt[][] = [];
      const breaks: [Pt, Pt][] = [];
      let dLo: number | null = null, dHi: number | null = null; // 当天的速度区间(供配色)
      const dayTrips = this._trips.filter(
        (t) => t && t.started_at && dayKey(t.started_at) === key);
      for (const t of dayTrips) {
        if (!t.point_count) continue;
        let raw: any[] = [];
        try {
          raw = await this._ensureThumbTrack(t.id);
        } catch (e) { raw = []; }
        const prep = raw && raw.length ? this._prepare(raw, 120) : null;
        if (!prep) continue;
        for (const r of prep.runs) runs.push(r);
        for (const b of prep.breaks) breaks.push(b);
        if (prep.lo != null && prep.hi != null) {
          dLo = dLo == null ? prep.lo : Math.min(dLo, prep.lo);
          dHi = dHi == null ? prep.hi : Math.max(dHi, prep.hi);
        }
      }
      if (seq !== this._thumbSeq) return;
      this._dayPrep[key] = runs.length ? { runs, breaks, lo: dLo, hi: dHi } : null;
    }
    const card = this._dayEl(key);
    if (card) this._paintDayThumb(card);
  }

  _rowEl(id: unknown): HTMLElement | null {
    return this._listEl
      ? this._listEl.querySelector('.row[data-id="' + String(id) + '"]') : null;
  }

  _dayEl(key: string): HTMLElement | null {
    return this._listEl
      ? this._listEl.querySelector('.daycard[data-day="' + String(key) + '"]') : null;
  }

  /** 把一段行程画进某个 .thumb 容器(瓦片 + 红色折线; 没轨迹就退回虚线/占位)。 */
  _paintThumb(row: HTMLElement, id: string) {
    const el = row.querySelector<HTMLElement>(".thumb");
    if (!el) return;
    const t = this._find(id);
    const prep = this._thumbPrep[id];
    const pts = prep ? this._flatPrep(prep) : [];
    // 瓦片/轨迹节点只建一次(里面可能压着徽标, 不能整块 innerHTML 覆盖)
    let box = el.querySelector<HTMLElement>(".tiles");
    let svg = el.querySelector<SVGElement>("svg");
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
    svg!.innerHTML = "";
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
          svg!.appendChild(this._poly([a, b], mapPt, "#e53935", 1.5, true));
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
    svg!.appendChild(defs);
    // 缩略图同样跟随"热力图/光效"开关(与大图一致)
    for (const run of prep!.runs) {
      if (run.length < 2) continue;
      const hasSpeed = !!this._heatmap && run.some((p) => p.length >= 3 && p[2] != null);
      if (hasSpeed) {
        svg!.appendChild(this._polyHeatmap(run, mapPt, 2, defs, this._flow, prep!.lo, prep!.hi));
      } else {
        svg!.appendChild(this._poly(run, mapPt, "#e53935", 2, false));
        if (this._flow) svg!.appendChild(this._polyFlow(run, mapPt, 2));
      }
    }
    for (const br of prep!.breaks) svg!.appendChild(this._poly(br, mapPt, "#e53935", 1.5, true));
  }

  _paintDayThumb(dc: HTMLElement) {
    const el = dc.querySelector<HTMLElement>(".dthumb");
    if (!el) return;
    const prep = this._dayPrep[dc.dataset.day as string];
    const pts = prep ? this._flatPrep(prep) : [];
    let box = el.querySelector<HTMLElement>(".tiles");
    let svg = el.querySelector<SVGElement>("svg");
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
    svg!.innerHTML = "";
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
    svg!.appendChild(defs);
    for (const run of prep!.runs) {
      if (run.length < 2) continue;
      const hasSpeed = !!this._heatmap && run.some((p) => p.length >= 3 && p[2] != null);
      if (hasSpeed) {
        svg!.appendChild(this._polyHeatmap(run, mapPt, 2, defs, this._flow, prep!.lo, prep!.hi));
      } else {
        svg!.appendChild(this._poly(run, mapPt, "#e53935", 2, false));
        if (this._flow) svg!.appendChild(this._polyFlow(run, mapPt, 2));
      }
    }
    for (const br of prep!.breaks) svg!.appendChild(this._poly(br, mapPt, "#e53935", 1.5, true));
  }

  _flatPrep(prep: Prep | null): Pt[] {
    const out: Pt[] = [];
    if (!prep) return out;
    for (const run of prep.runs) for (const p of run) out.push(p);
    for (const br of prep.breaks) { out.push(br[0]); out.push(br[1]); }
    return out;
  }

  /**
   * 取景: 让这些点在 w×h 的框里尽量撑满。
   * 返回 {z, k, cx, cy}(cx/cy 已经是该 zoom 下的世界像素中心), 点 < 2 个返回 null。
   */
  _geom(pts: Pt[] | [number, number][], w: number, h: number) {
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

  _mapper(geom: { z: number; k: number; cx: number; cy: number }, w: number, h: number) {
    const z = geom.z;
    return (p: { 0: number; 1: number } | number[]) => {
      const xy = project(p[0], p[1], z);
      // 注意: x/y 必须各自先算完再拼字符串, 直接写成 `x + "," + y + h / 2`
      // 会被 JS 的 + 优先级变成字符串拼接(数字后面接 "36"), 点全飞到框外去。
      const sx = ((xy[0] - geom.cx) * geom.k + w / 2).toFixed(1);
      const sy = ((xy[1] - geom.cy) * geom.k + h / 2).toFixed(1);
      return sx + "," + sy;
    };
  }

  /** 缩略图底图: 一般 1~2 张瓦片就够, 全挂了就退回纯色底(轨迹线照画)。 */
  _thumbTiles(el: HTMLElement, geom: { z: number; k: number; cx: number; cy: number }, w: number, h: number) {
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
    const bad: string[] = [];
    if (t.reconstructed) bad.push("补记");
    if (t.approx_time) bad.push("≈ 时间");
    if (t.frozen) bad.push("失联");
    const cells: [string, string, string][] = [
      ["里程", fmtKm(t.distance_km), "km"],
      ["耗时", (t.approx_time && t.duration_min != null ? "≈ " : "") + fmtDurShort(t.duration_min), ""],
      ["耗电", fmtKwh(t.energy_kwh), "kWh"],
      ["百公里电耗", t.efficiency == null ? "—" : fmtNum(t.efficiency, 1), "kWh/100km"],
      ["平均速度", fmtNum(t.avg_speed_kmh, 1), "km/h"],
      ["轨迹点", t.point_count ? String(t.point_count) : "—", t.point_count ? "个" : ""],
    ];
    const legHtml = (kind: string, coord: string | null, when2: string, label: string) =>
      '<div class="leg ' + kind + '"><span class="dot"></span><span class="lwrap">' +
      '<span class="lt">' + label + "</span>" +
      '<span class="lc">' + (coord || "坐标未知") + "</span>" +
      '<span class="lc">' + when2 + "</span></span></div>";
    this._dinfoEl.innerHTML =
      '<div class="dwhen">' + when +
      (bad.length ? '<span class="dbad">' + bad.join(" · ") + "</span>" : "") + "</div>" +
      '<div class="detailTop"><div class="legs">' +
      legHtml("start", sc, "出发 · " + fmtTime(t.started_at), "起点") +
      legHtml("end", ec, "到达 · " + fmtTime(t.ended_at), "终点") +
      '</div><div class="profilePane'+(this._plotOpen?' is-open':'')+'">' + profileSvg(this._sel?.runs||[],this._sel?.lo??0,this._sel?.hi??120) + '</div></div>' +
      '<div class="ddiv"></div>' +
      '<div class="dgrid">' +
      cells.map((c) => '<div class="dcell"><span class="k">' + c[0] + "</span><span class=\"v\">" +
        c[1] + (c[2] ? "<i>" + c[2] + "</i>" : "") + "</span></div>").join("") +
      "</div>" +
      (t.reconstructed ? '<div class="dnote">补记: 这段没有轨迹, 里程/耗电来自总里程与电量跳变。</div>' : "");
    this._ddelEl.dataset.id = String(t.id);
    this._syncPlot();
    this._renderPointData();
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
  /** 速度条两端标签: 显示**本条行程**的实际速度区间(没有速度数据时回落到 0 / 120+)。 */
  _renderSpeedBar() {
    if (!this._spdLoEl || !this._spdHiEl) return;
    const lo = this._sel && this._sel.lo, hi = this._sel && this._sel.hi;
    if (lo == null || hi == null) {
      this._spdLoEl.textContent = "0";
      this._spdHiEl.textContent = "120+ km/h";
      return;
    }
    this._spdLoEl.textContent = String(Math.round(lo));
    this._spdHiEl.textContent = Math.round(hi) + " km/h";
  }

  _renderMap() {
    if (!this._mapEl) return;
    if (this._view !== "detail" || this._detailView.hidden) return;
    if (this._needFit && this._fit(this._allPts())) this._needFit = false;
    this._renderTiles();
    this._renderLines();
    this._renderMarks();
    this._renderSpeedBar();
    this._renderMapHint();
  }

  _allPts(): Pt[] {
    const out: Pt[] = [];
    const push = (prep: Prep | null) => {
      if (!prep) return;
      for (const run of prep.runs) for (const p of run) out.push(p);
      for (const br of prep.breaks) out.push(br[0], br[1]);
    };
    if (this._overlayTracks) for (const t of this._overlayTracks) push(t as any);
    push(this._sel);
    // 没有轨迹点(补记)时, 至少把起终点纳入取景范围
    if (!out.length && this._selTrip) {
      const s = this._point(this._selTrip.start_lat, this._selTrip.start_lon);
      const e = this._point(this._selTrip.end_lat, this._selTrip.end_lon);
      if (s) out.push(s as unknown as Pt);
      if (e) out.push(e as unknown as Pt);
    }
    return out;
  }

  /** WGS-84 坐标 → 显示坐标(无效返回 null)。 */
  _point(lat: unknown, lon: unknown): [number, number] | null {
    const la = Number(lat);
    const lo = Number(lon);
    if (lat == null || lon == null || !Number.isFinite(la) || !Number.isFinite(lo)) return null;
    if (la === 0 && lo === 0) return null;
    return wgs84ToGcj02(la, lo);
  }

  /** 把视野缩放到刚好装下这些点(显示坐标)。装不下/没布局好时返回 false 等下次重试。 */
  _fit(pts: Pt[]): boolean {
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

  _tileUrl(z: number, x: number, y: number, fallback: boolean): string {
    const conf = this._config!;
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
    const h = rect.height || this._mapEl.clientHeight || this._config!.height;
    const z = this._zoom;
    const [cx, cy] = project(this._center[0], this._center[1], z);
    const left = cx - w / 2;
    const top = cy - h / 2;
    const x0 = Math.floor(left / TILE);
    const y0 = Math.floor(top / TILE);
    const x1 = Math.floor((left + w) / TILE);
    const y1 = Math.floor((top + h) / TILE);
    const max = Math.pow(2, z);
    const needed = new Set<string>();

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
        const img = this._tiles.get(key)!;
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
    const h = rect.height || this._mapEl.clientHeight || this._config!.height;
    const [cx, cy] = project(this._center![0], this._center![1], this._zoom);
    const fx = w / 2;
    const fy = h / 2;
    return (p: any[]) => {
      const xy = project(p[0], p[1], this._zoom);
      return (xy[0] - cx + fx).toFixed(1) + "," + (xy[1] - cy + fy).toFixed(1);
    };
  }

  _poly(pts: any[], mapPt: (p: any) => string, color: string, width: number, dash: boolean): SVGElement {
    const el = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    const parts: string[] = [];
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
  _polyFlow(pts: any[], mapPt: (p: any) => string, width: number): SVGElement {
    const SVG = "http://www.w3.org/2000/svg";
    const el = document.createElementNS(SVG, "polyline");
    const parts: string[] = [];
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
  _polyHeatmap(
    run: Pt[], mapPt: (p: any) => string, width: number,
    defsEl: SVGElement, flow: boolean, lo: number | null, hi: number | null
  ): SVGElement {
    const SVG = "http://www.w3.org/2000/svg";
    const group = document.createElementNS(SVG, "g");
    const pt = (p: any) => {
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
      s1.setAttribute("stop-color", getSpeedColor(p1[2], lo, hi));
      const s2 = document.createElementNS(SVG, "stop");
      s2.setAttribute("offset", "100%");
      s2.setAttribute("stop-color", getSpeedColor(p2[2], lo, hi));
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
      const draw = (runs: any[], color: string, width: number, dash: boolean) => {
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
          frag.appendChild(this._polyHeatmap(run, mapPt, 3.5, defsEl, this._flow,
            this._sel && this._sel.lo, this._sel && this._sel.hi));
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

  /** 点选轨迹点: 以点击处为中心找**屏幕上**最近的一个点(命中半径 22px), 组气泡内容。 */
  _pickPoint(clientX: number, clientY: number) {
    if (!this._sel || !this._mapEl) return;
    const rect = this._mapEl.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const mapPt = this._screenMapper();
    const toXY = (p: any) => {
      const xy = mapPt(p);
      return Array.isArray(xy) ? xy.map(Number) : String(xy).split(",").map(Number);
    };
    let best: { p: Pt; idx: number; dist: number } | null = null;
    let bestD = Infinity;
    let idx = 0, dist = 0, total = 0;
    let prev: Pt | null = null;
    for (const run of this._sel.runs) {
      for (const p of run) {
        const segment=prev?haversineKm(prev as unknown as [number,number],p as unknown as [number,number]):0;
        dist+=segment;
        const [sx, sy] = toXY(p);
        const d = Math.hypot(sx - px, sy - py);
        if (d < bestD) { bestD = d; best = { p, idx, dist }; }
        if(prev){const [ax,ay]=toXY(prev),dx=sx-ax,dy=sy-ay,t=clamp(((px-ax)*dx+(py-ay)*dy)/Math.max(1e-9,dx*dx+dy*dy),0,1),near=Math.hypot(ax+t*dx-px,ay+t*dy-py);if(near<bestD){bestD=near;best=t<.5?{p:prev,idx:idx-1,dist:dist-segment}:{p,idx,dist};}}
        prev = p; idx++; total++;
      }
      prev = null;                                // 断档处不累加距离
    }
    if (!best || bestD > 22) {                    // 点空白处 → 收起气泡
      if (this._pt) { this._pt = null; this._renderMarks();this._renderPointData(); }
      return false;
    }
    const xy = toXY((best as any).p);
    const bp = (best as any).p as Pt;
    const spd = bp.length >= 3 && bp[2] != null ? Number(bp[2]) : null;
    const lines: string[] = [];
    lines.push("第 " + ((best as any).idx + 1) + " / " + total + " 点");
    if (bp.length >= 5 && Number.isFinite(Number(bp[3])) && Number.isFinite(Number(bp[4]))) {
      lines.push(fmtCoord(bp[3], bp[4]) || "坐标未知");
    }
    lines.push(spd == null ? "速度 —" : "速度 " + fmtNum(spd, 1, "km/h"));
    if (bp.length >= 6) {
      const tsTxt = fmtMoment(bp[5]);
      if (tsTxt) lines.push("时间 " + tsTxt);
    }
    lines.push("距起点 " + fmtNum((best as any).dist, 2, "km"));
    this._revealPlot();
    if(this._pt?.idx===best.idx){this._renderPointData();return true;}
    this._pt = { x: Number(xy[0]), y: Number(xy[1]), lines,p:bp,idx:best.idx };
    this._renderMarks();
    this._renderPointData();
    return true;
  }

  private _selectProfilePoint(index:number,reveal=true) {
    const points=this._sel?.runs.flat()||[];const p=points[index];if(!p)return;
    const mapPt=this._screenMapper(),xy=String(mapPt(p)).split(",").map(Number);
    const lines=["第 "+(index+1)+" / "+points.length+" 点",p[2]==null?"速度 —":"速度 "+fmtNum(p[2],1,"km/h"),p[5]?"时间 "+fmtMoment(p[5]):"采样时间未知"];
    if(reveal)this._revealPlot();this._pt={x:xy[0],y:xy[1],lines,p,idx:index};this._renderMarks();this._renderPointData();
  }

  private _plotOpen=false;
  private _revealPlot(){
    this._plotOpen=true;
    this._syncPlot();
  }
  private _syncPlot(){
    this._dinfoEl?.querySelector('.profilePane')?.classList.toggle('is-open',this._plotOpen);
    const toggle=this._dinfoEl?.querySelector<HTMLButtonElement>('.profileToggle');
    toggle?.setAttribute('aria-expanded',String(this._plotOpen));
    toggle?.setAttribute('aria-label',this._plotOpen?'收起采样趋势':'展开采样趋势');
    toggle?.setAttribute('title',this._plotOpen?'收起采样趋势':'采样趋势');
    toggle?.querySelector('ha-icon')?.setAttribute('icon',this._plotOpen?'mdi:close':'mdi:dots-horizontal');
    this._dinfoEl?.querySelector('.profileBody')?.setAttribute('inert', '');
    if(this._plotOpen)this._dinfoEl?.querySelector('.profileBody')?.removeAttribute('inert');
  }

  private _renderPointData() {
    const dot=this.shadowRoot?.querySelector<HTMLElement>(".speedCursor"),readout=this._dinfoEl?.querySelector<HTMLElement>(".pointReadout"),cursor=this._dinfoEl?.querySelector(".profileCursor");
    const p=this._pt?.p,index=this._pt?.idx,total=this._sel?.runs.reduce((n,r)=>n+r.length,0)||0;
    if(dot){const speed=p?.[2];dot.style.display=speed==null?"none":"block";dot.style.top=(100-clamp((speed!-Number(this._sel?.lo??0))/Math.max(1,Number(this._sel?.hi??120)-Number(this._sel?.lo??0)),0,1)*100)+"%";dot.title=speed==null?"":"当前速度 "+fmtNum(speed,1,"km/h");const value=dot.querySelector('.speedValue');if(value)value.textContent=speed==null?'':fmtNum(speed,1,'km/h');}
    if(cursor){cursor.setAttribute("visibility",index==null?"hidden":"visible");const x=String(20+(index||0)/Math.max(1,total-1)*260);cursor.setAttribute("x1",x);cursor.setAttribute("x2",x);}
    if(readout)readout.textContent=p?this._pt!.lines.filter(l=>/^(第|时间|距|采样)/.test(l)).join(" · "):"沿轨迹或图表滑动查看采样";
  }

  _renderMarks() {
    if (!this._marksEl || !this._mapEl || !this._center) return;
    const mapPt = this._screenMapper();
    void mapPt;
    const rect = this._mapEl.getBoundingClientRect();
    const w = rect.width || this._mapEl.clientWidth || 400;
    const h = rect.height || this._mapEl.clientHeight || this._config!.height;
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const place = (pt: (number | null | undefined)[]) => {
      const xy = project(Number(pt[0]), Number(pt[1]), this._zoom);
      return "left:" + (xy[0] - cx + w / 2) + "px;top:" + (xy[1] - cy + h / 2) + "px";
    };
    let start: Pt | null = null;
    let end: Pt | null = null;
    if (this._sel) {
      const runs = this._sel.runs.filter((r) => r.length);
      if (runs.length) {
        start = runs[0][0];
        const lastRun = runs[runs.length - 1];
        end = lastRun[lastRun.length - 1];
      }
    }
    if (!start && this._selTrip) start = this._point(this._selTrip.start_lat, this._selTrip.start_lon) as unknown as Pt;
    if (!end && this._selTrip) end = this._point(this._selTrip.end_lat, this._selTrip.end_lon) as unknown as Pt;
    let html = "";
    if (start) html += '<div class="mk start" style="' + place(start) + '">起</div>';
    if (end) html += '<div class="mk end" style="' + place(end) + '">终</div>';
    if (this._pt) {
      // 气泡横向夹回地图内(靠边时不要溢出), 竖向固定点在点上方
      html += '<div class="mk pt" style="'+(this._pt.p?place(this._pt.p):'left:'+this._pt.x+'px;top:'+this._pt.y+'px')+'"></div>';
    }
    this._marksEl.innerHTML = html;
    this._renderPointData();
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
    } else if (this._selTrip && !this._sel!.runs.length) {
      text = "轨迹点太少, 画不出路线";
    }
    this._mhintEl.textContent = text;
    this._mhintEl.style.display = text ? "block" : "none";
  }

  // ── 交互 ──
  /** 删除前弹一个明确的确认气泡(比"再点一次图标"醒目得多, 也更难误删)。

   * 气泡由调用方给出锚点(行内的垃圾桶 / 详情页头部的垃圾桶), 位置夹在卡片内;
   * 6 秒无操作自动收起, 取消 / 点别处 / Esc 都算取消。
   */
  _askDelete(id: unknown, btn?: HTMLElement) {
    const t = this._find(id);
    if (!t || !this._delPopEl) return;
    if (this._hass && this._hass.user && !this._hass.user.is_admin) {
      this._err = "需要管理员权限才能删除行程";
      this._render();
      return;
    }
    this._delAsk = String(id);
    const q = this._delPopEl.querySelector(".dpq");
    const info = this._delPopEl.querySelector(".dpt");
    if (q) q.textContent = "删除这段行程?";
    if (info) {
      info.textContent = fmtStamp(t.started_at) + " · " + fmtKm(t.distance_km) + " km" +
        ((t.point_count || 0) > 0 ? "(轨迹会一起删除)" : "");
    }
    this._delPopEl.classList.add("on");
    // 定位: 右对齐锚点按钮, 下方放不下就翻到上方; 左右都夹在卡片内
    const cardRect = this._cardEl.getBoundingClientRect();
    const br = (btn || this._cardEl).getBoundingClientRect();
    const pw = this._delPopEl.offsetWidth;
    const ph = this._delPopEl.offsetHeight;
    let left = br.right - cardRect.left - pw;
    left = Math.max(6, Math.min(left, Math.max(6, cardRect.width - pw - 6)));
    let top = br.bottom - cardRect.top + 6;
    if (top + ph > cardRect.height - 4) top = Math.max(4, br.top - cardRect.top - ph - 6);
    this._delPopEl.style.left = left + "px";
    this._delPopEl.style.top = top + "px";
    clearTimeout(this._delTimer);
    this._delTimer = setTimeout(() => this._closeDeleteAsk(), 6000);
  }

  _closeDeleteAsk() {
    clearTimeout(this._delTimer);
    this._delTimer = null;
    this._delAsk = null;
    if (this._delPopEl) this._delPopEl.classList.remove("on");
  }

  async _deleteTrip(id: unknown) {
    this._closeDeleteAsk();
    if (!this._hass || !this._hass.callWS) return;
    if (this._hass.user && !this._hass.user.is_admin) {
      this._err = "需要管理员权限才能删除行程";
      this._render();
      return;
    }
    const btn = this._delPopEl ? this._delPopEl.querySelector<HTMLButtonElement>(".dpOk") : null;
    if (btn) btn.disabled = true;
    try {
      await this._hass.callWS({ type: "leapmotor/trips/delete", trip_id: id });
      delete this._trackCache[String(id)];
      delete this._thumbCache[String(id)];
      delete this._thumbPrep[String(id)];
      if (String(this._selectedId) === String(id)) {
        this._selectedId = "";
        this._selTrip = null;
        this._sel = null;
        this._view = "list";
      }
      await this._load();
    } catch (err) {
      this._err = "删除失败: " + this._errText(err);
      this._render();
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  /** 导出当前选中行程: fmt ∈ {csv, xml, json}。轨迹点走缓存(没有则现拉)。 */
  async _exportTrip(fmt: string) {
    const id = this._selectedId;
    const t = this._find(id);
    if (!t) return;
    let pts: any[] = [];
    try {
      pts = ((t.point_count || 0) > 0) ? await this._ensureTrack(id) : [];
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

  _tripCsv(t: Trip, pts: any[]): string {
    const head = ["trip_id", "started_at", "ended_at", "distance_km", "duration_min",
                  "energy_kwh", "efficiency_kwh_100km", "avg_speed_kmh",
                  "start_soc", "end_soc", "point_index", "latitude_wgs84",
                  "longitude_wgs84", "speed_kmh"];
    const rows = [head.join(",")];
    const c = (v: unknown) => (v == null ? "" : String(v));
    const iso = (ts: unknown) => {
      const n = Number(ts);
      return n ? new Date(n * 1000).toISOString() : "";
    };
    const sd = iso(t.started_at);
    const ed = iso(t.ended_at);
    if (!pts.length) {
      rows.push([String(t.id), sd, ed, c(t.distance_km), c(t.duration_min), c(t.energy_kwh),
                 c(t.efficiency), c(t.avg_speed_kmh), c(t.start_soc), c(t.end_soc),
                 "", "", "", ""].join(","));
    } else {
      pts.forEach((p, i) => {
        rows.push([String(t.id), sd, ed, c(t.distance_km), c(t.duration_min), c(t.energy_kwh),
                   c(t.efficiency), c(t.avg_speed_kmh), c(t.start_soc), c(t.end_soc),
                   String(i), p[0], p[1], p.length >= 3 ? p[2] : ""].join(","));
      });
    }
    return rows.join("\n");
  }

  _tripXml(t: Trip, pts: any[]): string {
    const escXml = (s: unknown) => String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
    const iso = (ts: unknown) => { const n = Number(ts); return n ? new Date(n * 1000).toISOString() : ""; };
    const attrs = ([
      ["id", t.id], ["started_at", iso(t.started_at)], ["ended_at", iso(t.ended_at)],
      ["distance_km", t.distance_km], ["duration_min", t.duration_min],
      ["energy_kwh", t.energy_kwh], ["efficiency_kwh_100km", t.efficiency],
      ["avg_speed_kmh", t.avg_speed_kmh], ["start_soc", t.start_soc],
      ["end_soc", t.end_soc], ["reconstructed", t.reconstructed], ["frozen", t.frozen],
    ] as [string, unknown][]).filter(([, v]) => v != null && v !== "")
      .map(([k, v]) => ` ${k}="${escXml(v)}"`).join("");
    const pt = pts.map((p) => `    <point lat="${escXml(p[0])}" lon="${escXml(p[1])}"` +
      (p.length >= 3 ? ` speed="${escXml(p[2])}"` : "") + " />").join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<leapmotor-trip xmlns="https://github.com/MiRaToo/ha-leapmotor-cn" ` +
      `coordinate_system="WGS-84"${attrs}>\n` +
      `  <track point_count="${pts.length}">\n${pt}\n  </track>\n</leapmotor-trip>\n`;
  }

  _tripJson(t: Trip, pts: any[]): string {
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

  _onMapButton(action: string) {
    // 三个"看地图"的开关/切换不依赖取景, 任何视图下都能用
    if (action === "style") {
      this._cycleMapStyle();
      return;
    }
    if (action === "heat" || action === "flow") {
      if (action === "heat") this._heatmap = !this._heatmap;
      else this._flow = !this._flow;
      this._renderToolbar();          // 钮的选中态(蓝底)跟着变
      this._applyMapStyle();          // 图例显隐
      this._renderMap();
      this._paintThumbs();
      this._paintDayThumbs();
      return;
    }
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

  _zoomAt(clientX: number, clientY: number, delta: number) {
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
    // ⚠️ HA 会在元素**尚未连接**时就调用 setConfig()(为校验配置 / 读 getCardSize),
    //    而 Lit 的 createRenderRoot() 要等 connectedCallback 才跑 —— 此时 this.shadowRoot
    //    为 null, 直接 .innerHTML 会抛 "Cannot set properties of null" → HA 显示「配置错误」。
    //    所以在 _build 里按需挂载 shadow root(幂等): 无论先 setConfig 还是先连接都能建好。
    this._ensureShadow();
    const h = this._config!.height;
    const listH = this._config!.list_height;
    this.shadowRoot!.innerHTML = `
      <style>${this._css(h, listH)}</style>
      <div class="card">
        <div class="head">
          <span class="title">行程</span>
          <span class="sum sub"></span>
          <span class="spacer"></span>
          <button class="collapseAll" title="全部收起 / 展开"><ha-icon icon="mdi:unfold-less-horizontal"></ha-icon></button>
          <button class="refresh" title="刷新行程列表">${ipIcon("redo", 16)}</button>
        </div>
        <div class="active"><span class="dot"></span><span class="atext"></span></div>

        <div class="view listview">
          <div class="winbar">
            <div class="seg">
              <button data-days="7">7 天</button>
              <button data-days="30">30 天</button>
              <button data-days="90">90 天</button>
            </div>
            <button class="monlab" title="按月份查看">选择月份 ▾</button>
            <div class="winpop"></div>
          </div>
          <div class="winsum sub">
            <b class="wlab"></b><span class="wrange"></span>
            <span class="wnav">
              <button class="arw wprev" title="往前看(更早)">‹</button>
              <button class="arw wnext" title="往后看(更新)">›</button>
            </span>
          </div>
          <div class="list"></div>
          <div class="lmsg"></div>
          <div class="usage sub" hidden></div>
        </div>

        <div class="view detailview" hidden>
          <div class="dhead">
            <button class="back" title="返回行程列表">${ipIcon("back", 18)}</button>
            <span class="dtitle">行程详情</span>
            <span class="spacer"></span>
            <label class="tchip ovlLab" title="叠加最近几段行程的轨迹"><input type="checkbox" class="ovlbox" hidden>叠加</label>
            <input type="number" class="ovln" min="1" max="50" step="1" value="5" title="叠加最近几段(1~50, 手填)">段
            <button class="del dexp" data-act="export" title="导出这段行程(CSV / XML / JSON)">
              ${ipIcon("download", 18)}
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
            <div class="spd">
              <span class="spdHi">120+ km/h</span>
              <div class="speed-gradient"><i class="speedCursor"><span class="speedValue"></span></i></div>
              <span class="spdLo">0</span>
            </div>
            <div class="mbtns">
              <button data-m="style" class="style" title="底图: 点一下切换">
                <ha-icon icon="mdi:theme-light-dark"></ha-icon>
              </button>
              <button data-m="heat" title="热力图">${ipIcon("thermometer", 16)}</button>
              <button data-m="flow" title="光效">${ipIcon("shine", 16)}</button>
              <button data-m="fit" title="聚焦到轨迹(归位)">${ipIcon("aiming", 16)}</button>
              <button data-m="in" title="放大">${ipIcon("zoomIn", 16)}</button>
              <button data-m="out" title="缩小">${ipIcon("zoomOut", 16)}</button>
            </div>
          </div>
          <div class="dinfo sheet"></div>
          <div class="legend"></div>
        </div>

        <div class="delpop">
          <div class="dpq">删除这段行程?</div>
          <div class="dpt"></div>
          <div class="dpn">删除后<b>无法恢复</b>, 这段的轨迹会一并移除</div>
          <div class="dpa">
            <button class="dpCancel">取消</button>
            <button class="dpOk">删除</button>
          </div>
        </div>
      </div>`;

    this._cardEl = this.shadowRoot!.querySelector(".card")!;
    this._sumEl = this.shadowRoot!.querySelector(".head .sum")!;
    this._refreshBtn = this.shadowRoot!.querySelector(".head .refresh")!;
    this._collapseBtn = this.shadowRoot!.querySelector(".head .collapseAll")!;
    this._activeEl = this.shadowRoot!.querySelector(".active")!;
    this._activeText = this.shadowRoot!.querySelector(".active .atext")!;
    this._listView = this.shadowRoot!.querySelector(".listview")!;
    this._detailView = this.shadowRoot!.querySelector(".detailview")!;
    this._listEl = this.shadowRoot!.querySelector(".list")!;
    this._lmsgEl = this.shadowRoot!.querySelector(".lmsg")!;
    this._winbarEl = this.shadowRoot!.querySelector(".winbar")!;
    this._winDaysEls = [...this.shadowRoot!.querySelectorAll(".winbar .seg button")] as HTMLButtonElement[];
    this._monLabEl = this.shadowRoot!.querySelector(".winbar .monlab")!;
    this._monPopEl = this.shadowRoot!.querySelector(".winbar .winpop")!;
    this._winsumEl = this.shadowRoot!.querySelector(".winsum")!;
    this._wlabEl = this.shadowRoot!.querySelector(".winsum .wlab")!;
    this._wrangeEl = this.shadowRoot!.querySelector(".winsum .wrange")!;
    this._prevBtn = this.shadowRoot!.querySelector(".winsum .wprev")!;
    this._nextBtn = this.shadowRoot!.querySelector(".winsum .wnext")!;
    this._usageEl = this.shadowRoot!.querySelector(".usage")!;
    // 缩略图懒加载: 行/日卡进入列表可视区(root = 滚动容器)才去拉轨迹。
    // 30 天窗口里有近百段行程, 固定"只补前 30 行"会让更早的日子永远没有缩略图。
    if (typeof IntersectionObserver === "function") {
      this._thumbObs = new IntersectionObserver((entries) => {
        for (const en of entries) {
          if (!en.isIntersecting) continue;
          const el = en.target as HTMLElement;
          this._thumbObs!.unobserve(el);
          if (el.dataset.thumbId) this._enqueueThumb(el.dataset.thumbId);
          else if (el.dataset.dayKey) this._enqueueDayThumb(el.dataset.dayKey);
        }
      }, { root: this._listEl, rootMargin: THUMB_ROOT_MARGIN });
    }
    this._mapEl = this.shadowRoot!.querySelector(".map")!;
    this._tilesEl = this.shadowRoot!.querySelector(".tiles")!;
    this._trajEl = this.shadowRoot!.querySelector(".traj")!;
    this._marksEl = this.shadowRoot!.querySelector(".marks")!;
    this._mhintEl = this.shadowRoot!.querySelector(".mhint")!;
    this._dinfoEl = this.shadowRoot!.querySelector(".dinfo")!;
    this._ddelEl = this.shadowRoot!.querySelector(".ddel")!;
    this._legendEl = this.shadowRoot!.querySelector(".legend")!;
    this._dexportEl = this.shadowRoot!.querySelector(".dexp")!;
    this._expMenuEl = this.shadowRoot!.querySelector(".expmenu")!;
    this._delPopEl = this.shadowRoot!.querySelector(".delpop")!;
    this._ovlBox = this.shadowRoot!.querySelector(".ovlbox")!;
    this._ovlN = this.shadowRoot!.querySelector(".ovln")!;
    this._mbtnsEl = this.shadowRoot!.querySelector(".mbtns")!;
    this._styleBtn = this.shadowRoot!.querySelector('.mbtns button[data-m="style"]') as HTMLButtonElement;
    this._speedBar = this.shadowRoot!.querySelector(".spd")!;
    this._spdLoEl = this.shadowRoot!.querySelector(".spd .spdLo")!;
    this._spdHiEl = this.shadowRoot!.querySelector(".spd .spdHi")!;

    this._refreshBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._load();
    });
    // 时间窗口: 分段(7/30/90 天) / 月份弹层 / 翻页箭头
    // 时间窗口: 分段(7/30/90 天) / 月份弹层 / 翻页箭头。
    // 翻页箭头在下面那行(.winsum)里, 所以两个容器都要挂同一个委托处理。
    const winClick = (ev: Event) => {
      const t = ev.target as HTMLElement;
      const seg = t.closest("[data-days]") as HTMLElement | null;
      if (seg) {
        ev.stopPropagation();
        this._setWindow({ days: Number(seg.dataset.days) });
        return;
      }
      const opt = t.closest("[data-month]") as HTMLElement | null;
      if (opt) {
        ev.stopPropagation();
        this._setWindow({ month: opt.dataset.month });
        return;
      }
      const arw = t.closest(".arw") as HTMLElement | null;
      if (arw) {
        ev.stopPropagation();
        this._pageWindow(arw.classList.contains("wprev") ? -1 : 1);
        return;
      }
      if (t.closest(".monlab")) {
        ev.stopPropagation();
        this._wpop = !this._wpop;
        this._renderWinbar();
        return;
      }
      ev.stopPropagation();      // 点弹层空白处不要穿到卡片
    };
    this._winbarEl.addEventListener("click", winClick);
    this._winsumEl.addEventListener("click", winClick);
    // 点卡片其它地方 → 收起月份弹层与删除确认气泡
    this.shadowRoot!.addEventListener("click", () => {
      if (this._wpop) {
        this._wpop = false;
        this._renderWinbar();
      }
      if (this._delAsk) this._closeDeleteAsk();
    });
    this._collapseBtn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      this._toggleAllDays();
    });
    this.shadowRoot!.querySelector(".back")!.addEventListener("click", (ev) => {
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
        this._exportTrip((b as HTMLElement).dataset.fmt!);
      });
    });
    this._ovlBox.addEventListener("change", () => this._toggleOverlay(this._ovlBox.checked));
    this._ovlN.addEventListener("change", () => {
      if (this._ovlBox.checked) this._toggleOverlay(true);
    });
    // 地图右上角那列图标钮: 底图切换 / 热力图 / 光效 / 聚焦(归位) / 放大 / 缩小
    this.shadowRoot!.querySelectorAll(".mbtns button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._onMapButton((b as HTMLElement).dataset.m!);
      });
    });
    this._listEl.addEventListener("click", (ev) => {
      const t = ev.target as HTMLElement;
      const del = t.closest("button.del") as HTMLElement | null;
      if (del) {
        ev.stopPropagation();
        const row = del.closest(".row") as HTMLElement | null;
        if (row) this._askDelete(row.dataset.id!, del);
        return;
      }
      // 点每日卡片顶部(缩略图/标题/汇总) → 收起/展开这一天
      const head = t.closest(".daytop") as HTMLElement | null;
      if (head) {
        const dc = head.closest(".daycard") as HTMLElement | null;
        if (dc) {
          dc.classList.toggle("collapsed");
          this._collapsed[dc.dataset.day as string] = dc.classList.contains("collapsed");
          if (!dc.classList.contains("collapsed")) this._animateAction(dc.querySelector(".dayrows"));
        }
        return;
      }
      const row = t.closest(".row") as HTMLElement | null;
      if (row && row.dataset.id) this._openDetail(row.dataset.id);
    });
    this._ddelEl.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (this._ddelEl.dataset.id) this._askDelete(this._ddelEl.dataset.id, this._ddelEl);
    });
    // 删除确认气泡: 只有"删除"才真的删; 取消 / 点别处 / Esc 都撤回
    if (this._delPopEl) {
      this._delPopEl.querySelector(".dpCancel")!.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._closeDeleteAsk();
      });
      this._delPopEl.querySelector(".dpOk")!.addEventListener("click", (ev) => {
        ev.stopPropagation();
        if (this._delAsk) this._deleteTrip(this._delAsk);
      });
      this._delPopEl.addEventListener("click", (ev) => ev.stopPropagation());
    }
    this.shadowRoot!.addEventListener("keydown", (ev) => {
      if ((ev as KeyboardEvent).key === "Escape" && this._delAsk) this._closeDeleteAsk();
    });
    this._legendEl.addEventListener("click", (ev) => {
      const lg = (ev.target as HTMLElement).closest(".lg") as HTMLElement | null;
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
    bindScrub(this._dinfoEl,(x)=>{const svg=this._dinfoEl.querySelector(".tripPlot svg"),count=this._sel?.runs.reduce((n,r)=>n+r.length,0)||0;if(!svg||!count)return;const r=svg.getBoundingClientRect();this._selectProfilePoint(Math.round(clamp(((x-r.left)/Math.max(1,r.width)*300-20)/260,0,1)*(count-1)))},target=>!!target.closest?.(".tripPlot svg"));
    this._dinfoEl.addEventListener("keydown",e=>{if(!(e.target as Element).closest?.(".tripPlot")||!["ArrowLeft","ArrowRight"].includes(e.key))return;e.preventDefault();const n=this._sel?.runs.reduce((n,r)=>n+r.length,0)||0;this._selectProfilePoint(clamp((this._pt?.idx||0)+(e.key==="ArrowRight"?1:-1),0,n-1))});
    this._dinfoEl.addEventListener('click',e=>{if(!(e.target as Element).closest?.('[data-act="plot-toggle"]'))return;this._plotOpen=!this._plotOpen;this._syncPlot();});
    this._dinfoEl.addEventListener('keydown',e=>{if(!(e.target as Element).closest?.('.pointReadout')||!['Enter',' '].includes(e.key))return;e.preventDefault();this._plotOpen=false;this._syncPlot();});
    let start: { x: number; y: number; center: [number, number];scrub:boolean } | null = null;
    let suppressPointClick=false;
    // 浮在地图上的那层控件(右上角图标钮 / 左侧图例)不是地图内容: 按在它们身上时
    // **不能**走下面的拖拽逻辑 —— 拖拽第一步会 setPointerCapture, 指针一旦被地图捕获,
    // 浏览器就把随后的 click 派发给地图而不是那颗钮, 表现为"按钮点了没反应"(真机实测)。
    const onOverlay = (ev: Event) => {
      const t = ev.target as HTMLElement | null;
      return !!(t && t.closest && t.closest(".mbtns, .spd"));
    };
    this._mapEl.addEventListener("pointerdown", (ev) => {
      if (!this._center || onOverlay(ev)) return;
      suppressPointClick=false;
      this._mapEl.setPointerCapture(ev.pointerId);
      start = { x: ev.clientX, y: ev.clientY, center: [this._center[0], this._center[1]],scrub:this._pickPoint(ev.clientX,ev.clientY)===true };
      this._dragging = false;
    });
    this._mapEl.addEventListener("pointermove", (ev) => {
      if (!start) return;
      if(start.scrub){if(!this._scrubRAF){const x=ev.clientX,y=ev.clientY;this._scrubRAF=requestAnimationFrame(()=>{this._scrubRAF=0;this._pickPoint(x,y)})}return;}
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!this._dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
      if (!this._dragging) this._pt = null;       // 开始拖动 → 收起旧气泡
      this._dragging = true;
      suppressPointClick=true;
      this._mapEl.classList.add("dragging");
      const c = project(start.center[0], start.center[1], this._zoom);
      this._center = unproject(c[0] - dx, c[1] - dy, this._zoom);
      this._needFit = false;
      this._renderMap();
    });
    const end = (ev:PointerEvent) => {
      if (!start) return;
      if(this._scrubRAF){cancelAnimationFrame(this._scrubRAF);this._scrubRAF=0;}
      if(start.scrub&&ev.type==="pointerup")this._pickPoint(ev.clientX,ev.clientY);
      start = null;
      this._mapEl.classList.remove("dragging");
      this._dragging = false;
    };
    // ── 双指捏合缩放(手机/平板) ──
    let pinch: { d: number; zoom: number; cx: number; cy: number } | null = null;
    const dist2 = (ts: TouchList) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    this._mapEl.addEventListener("touchstart", (ev) => {
      if (ev.touches.length !== 2) return;
      ev.preventDefault();
      start = null;                       // 捏合期间不做拖拽
      this._pt = null;                    // 开始缩放 → 收起气泡
      pinch = { d: dist2(ev.touches) || 1, zoom: this._zoom,
                cx: (ev.touches[0].clientX + ev.touches[1].clientX) / 2,
                cy: (ev.touches[0].clientY + ev.touches[1].clientY) / 2 };
    }, { passive: false });
    this._mapEl.addEventListener("touchmove", (ev) => {
      if (!pinch || ev.touches.length !== 2) return;
      ev.preventDefault();
      const want = clamp(Math.round(pinch.zoom + Math.log2(dist2(ev.touches) / pinch.d)), 3, 18);
      if (want !== this._zoom) this._zoomAt(pinch.cx, pinch.cy, want - this._zoom);
    }, { passive: false });
    this._mapEl.addEventListener("touchend", () => { pinch = null; });
    this._mapEl.addEventListener("touchcancel", () => { pinch = null; });
    this._mapEl.addEventListener("pointerup", end);
    this._mapEl.addEventListener("pointercancel", end);
    // 点轨迹附近 → 弹出该点的信息气泡(拖拽/缩放会先收起它);
    // 点在地图上那层按钮上也别去"选点" —— 那颗钮有自己的动作
    this._mapEl.addEventListener("click", (ev) => {
      if(suppressPointClick){suppressPointClick=false;return;}
      if (this._dragging || onOverlay(ev)) return;
      this._pickPoint(ev.clientX, ev.clientY);
    });
    this._mapEl.addEventListener("dblclick", (ev) => {
      if (onOverlay(ev)) return;
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

  /** 整段样式(逐字搬运原 _build 的 <style> 内容, 仅插值常量)。 */
  _css(h: number, listH: number): string {
    return `
        ${interactionStyles}
        :host { display: block; }
        .card {
          position: relative;                 /* 删除确认气泡 / 导出气泡相对卡片定位 */
          padding: 10px 12px 12px; box-sizing: border-box;
          font-size: 13px;
        }
        /* 行程卡/信息卡的底色 —— HA 深浅色主题下都靠这几个变量自适应。
           1.9.40 起与控车卡的子块同款: **不描边**, 只靠一层阴影 0 1px 4px/.16 跟大卡分开。 */
        .sheet {
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
        }
        .sub { color: var(--secondary-text-color, #6b7280); }

        .head { display: flex; align-items: center; gap: 8px; }
        .head .title { font-weight: 600; font-size: 14px; white-space: nowrap; flex: 0 0 auto; }
        .head .sum {
          flex: 0 1 auto; min-width: 0; font-size: 12px;
          overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        .head .spacer { flex: 1; }
        /* 小按钮统一长相(1.9.40 起与控车卡同款): 白底(卡片同款) + 一层阴影, 不描边; hover 淡蓝。
           ⚠️ border: 0 不能省: 只删掉原来的 1px 会让 <button> 露出 UA 默认的 2px outset 描边。 */
        button {
          font: inherit; font-size: 12px; color: inherit; cursor: pointer;
          border-radius: var(--lm-radius-control, 8px); border: 0;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
          transition: background .15s ease;
        }
        button:not([disabled]):hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        /* 刷新按钮: 圆形白底 + 一层阴影(与「零跑·车辆控制」顶部那颗同一套写法; 1.9.40 起同款不描边) */
        .head button.refresh,
        .head button.collapseAll {
          width: 27px; height: 27px; padding: 0; border-radius: 50%;
          flex: 0 0 auto;                    /* 表头拥挤时不许被压扁(与控制卡保持一致尺寸) */
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280);
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
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

        /* 「点地图选点中」提示条: 这一圈是**淡主题色描边**, 1.9.40 的"去边框"不覆盖它 ——
           它跟控车卡的 .hint / .pill 同一类"贴在卡面上的小提示", 描边是读出边界的必需品。 */
        .active {
          display: none; align-items: center; gap: 6px; margin-top: 6px; padding: 4px 8px;
          font-size: 12px; border-radius: var(--lm-radius-control, 8px);
          /* 强调色走主题变量(默认值与原硬编码的 #03a9f4 相同 —— 观感不变, 但卡片配色能统一覆盖) */
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
          border: 1px solid rgba(var(--rgb-primary-color, 3, 169, 244), .35);
        }
        .active.on { display: flex; }
        .active .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--primary-color, #03a9f4); animation: lpulse 1.4s infinite; }
        @keyframes lpulse { 0%, 100% { opacity: 1; } 50% { opacity: .25; } }

        .view[hidden] { display: none !important; }

        /* ── 时间窗口控件(第一行: 分段 7/30/90 天 + 月份跳转; 第二行末尾: 翻页) ──
           为什么分两行: 手机宽度下"选择月份"会变成"2026 年 10 月"(更长), 一行放不下时
           浏览器会把分段钮里的"7 天"从中间断成两行 —— 现在翻页箭头挪到下面那行,
           并且分段钮/月份钮都禁止折行(放不下就整体换行, 文字永不从中间断开)。 */
        .winbar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap;
          margin: 8px 0 2px; position: relative; }
        .wsp { flex: 1 1 auto; }
        /* 分段控件(7/30/90 天): 外面这一整条 + 段间竖线是**有意保留**的描边 —— 去掉就看不出
           是一个分段控件了(与控车卡 .seg2 的处置一致; 1.9.40 只去掉"块/按钮"的边框)。 */
        .winbar .seg { display: inline-flex; border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          border-radius: var(--lm-radius-badge, 999px); overflow: hidden; background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff))); }
        .winbar .seg button {
          font: inherit; font-size: 12px; padding: 4px 12px; cursor: pointer; border: 0;
          border-right: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          background: transparent; color: var(--secondary-text-color, #6b7280);
          box-shadow: none; border-radius: 0; white-space: nowrap;
        }
        .winbar .seg button:last-child { border-right: 0; }
        .winbar .seg button.on {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .18);
          color: var(--primary-text-color, #212121); font-weight: 600;
        }
        .winbar .monlab {
          font: inherit; font-size: 12px; padding: 4px 12px; border-radius: var(--lm-radius-badge, 999px); cursor: pointer;
          display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
        }
        /* 选中态: 淡主题色底 + 加粗(1.9.40 起按钮不描边了, 原来那圈 "border-color: .55"
           随之去掉 —— 底色与加粗已经足够区分, 与 .seg button.on 的写法对齐)。 */
        .winbar .monlab.on {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .18);
          font-weight: 600;
        }
        .arw {
          width: 28px; height: 28px; padding: 0; font-size: 16px; line-height: 1;
          border-radius: 50%; display: inline-flex; align-items: center; justify-content: center;
        }
        .arw[disabled] { opacity: .3; cursor: default; box-shadow: none; }
        .arw[disabled]:hover { background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff))); }
        /* 月份弹层: 只有有数据的月份(段数 · 里程)。
           1.9.40: 去边框(原 1px 灰边), 保留"浮层该有的"强投影 —— 它压在列表内容上,
           阴影要保持能把它托起来的力度(与控车卡弹窗 .smodal"无边框 + 强投影"同一口径)。 */
        .winbar .winpop {
          position: absolute; z-index: 20; top: calc(100% + 6px); left: 0; min-width: 220px;
          max-height: 300px; overflow: auto; padding: 6px; display: none;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0; border-radius: var(--lm-radius-control, 12px);
          box-shadow: 0 6px 22px rgba(0, 0, 0, .28);
        }
        .winbar .winpop.on { display: block; }
        .winbar .winpop .wph {
          padding: 5px 8px 2px; font-size: 10px; letter-spacing: .5px;
          color: var(--secondary-text-color, #6b7280);
        }
        .winbar .winpop .wopt {
          display: flex; align-items: center; gap: 8px; width: 100%; text-align: left;
          font: inherit; font-size: 13px; padding: 6px 8px; border: 0; border-radius: var(--lm-radius-control, 8px);
          background: transparent; box-shadow: none; color: inherit;
        }
        .winbar .winpop .wopt:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .winbar .winpop .wopt.on { background: rgba(var(--rgb-primary-color, 3, 169, 244), .18); font-weight: 600; }
        .winbar .winpop .wopt .wm { flex: 1 1 auto; }
        .winbar .winpop .wopt .wd {
          font-size: 11px; color: var(--secondary-text-color, #6b7280); white-space: nowrap;
        }
        /* 窗口行: 范围标签 + 日期区间 + 行尾的翻页箭头。
           箭头那一组**绝对定位钉在行尾**(与空调卡的开关钮同一手法): 文字再长也只在左侧
           那一段里换行, 箭头始终在这行的最后, 不会被挤到下一行去。 */
        .winsum { display: flex; align-items: center; gap: 8px; font-size: 12px; padding: 5px 2px 6px;
          position: relative; padding-right: 66px; }
        .winsum b { font-size: 13px; font-weight: 600; color: var(--primary-text-color, #212121); }
        .winsum .wnav {
          position: absolute; right: 0; top: 50%; transform: translateY(-50%);
          display: inline-flex; align-items: center; gap: 6px;
        }
        /* 卡片底部小字: 轨迹占用/上限/月数(如 11.9/300MB,共7个月) */
        .usage { font-size: 11px; padding: 6px 2px 0; text-align: right; }

        /* ── 列表视图 ── */
        .list { max-height: ${listH}px; overflow: auto; margin: 0 -4px; padding: 0 4px; }
        .grp {
          position: sticky; top: 0; z-index: 2; display: flex; align-items: baseline; gap: 6px;
          padding: 9px 2px 5px;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
        }
        .grp .dn { font-weight: 600; font-size: 14px; }
        .grp .dc { font-size: 11px; }
        .grp .dk { margin-left: auto; font-weight: 600; font-size: 14px; }

        /* 每日卡片: 包住当天的各段行程; 头部可点收起/展开。
           1.9.40 起与控车卡子块同款: 不描边, 一层阴影 0 1px 4px/.16 */
        .daycard {
          margin: 0 0 10px; border-radius: 16px; overflow: hidden;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
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
        .compactDay.collapsed .daytop{padding:10px;}.compactDay.collapsed .dayinfo{display:flex;flex-direction:row;align-items:center;flex-wrap:nowrap;gap:6px 8px;}.compactDay.collapsed .dayhead{flex:1;gap:6px;min-width:0;}.compactDay.collapsed .dn{font-size:12px;}.compactDay.collapsed .dmeta{font-size:10px;}.compactDay.collapsed .daysum{display:flex;gap:6px;flex:0 1 auto;min-width:0;}.compactDay.collapsed .met{min-width:0;display:flex;flex-direction:row;gap:3px;align-items:baseline;}.compactDay.collapsed .met .k{display:none;}.compactDay.collapsed .met .v{font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}.compactDay.collapsed .met i{font-size:9px;}.compactDay.collapsed .chev{width:14px;--mdc-icon-size:14px;}
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
        /* 展开后的一天: 紧凑列表, 行与行之间**通栏细线**分隔(不再是一堆子卡片) */
        .dayrows { padding: 0 10px; }
        .row {
          position: relative;                     /* 徽标/确认气泡要定位, 得有个定位父级 */
          display: flex; align-items: center; gap: 10px;
          padding: 9px 2px; margin: 0; cursor: pointer;
          border-bottom: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        }
        .dayrows .row:last-child { border-bottom: 0; }
        .row:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .05); }

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

        .rbody { flex: 1 1 auto; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
        .rline1 { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
        .rkm { font-size: 18px; font-weight: 600; line-height: 1.15; letter-spacing: -.3px; white-space: nowrap; }
        .rkm i, .met .v i, .dcell .v i {
          font-style: normal; font-size: 10px; font-weight: 500; margin-left: 2px;
          color: var(--secondary-text-color, #6b7280);
        }
        .rtm {
          font-size: 12px;
          /* 跨天的时间串("10月1日 23:30 - 10月2日 00:11")很长; 窄屏放不下时**换行**,
             而不要用省略号截断(截断后时间就没法看了) */
          white-space: normal; line-height: 1.2;
          color: var(--secondary-text-color, #6b7280);
        }
        /* 指标一行到底; 窄卡片换行, 绝不截断(单位要写全) */
        .rline2 { font-size: 12px; line-height: 1.35; white-space: normal;
          color: var(--secondary-text-color, #6b7280); }
        .rline2 b { color: var(--primary-text-color, #212121); font-weight: 600; }
        /* 补记/失联徽标: 压在缩略图左上角 —— 放行内会把时间段/指标挤没 */
        .thumb .rbadges { position: absolute; left: 4px; top: 4px; z-index: 3; display: flex; gap: 4px; }
        .badge {
          padding: 0 5px; border-radius: var(--lm-radius-badge, 999px); font-size: 9px; line-height: 14px;
          white-space: nowrap; color: #fff; box-shadow: 0 1px 2px rgba(0, 0, 0, .3);
        }
        .badge.r { background: rgba(245, 158, 11, .95); }
        .badge.f { background: rgba(229, 57, 53, .95); }
        .badge.d { background: rgba(120, 120, 128, .92); }

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

        /* 删除按钮保持低调: 不加白底/阴影(全局 button 的长相在这里被刻意去掉), 只是淡淡的图标。
           (1.9.40 起全局 button 已是 border: 0, 这里原来那句 border-color: transparent 随之删掉) */
        .del {
          flex: 0 0 auto; width: 24px; height: 24px; padding: 0;
          display: flex; align-items: center; justify-content: center;
          background: transparent; opacity: .45; box-shadow: none;
        }
        .del:hover { opacity: 1; background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .del[disabled] { opacity: .3; }
        .lmsg { padding: 10px 2px; font-size: 12px; }
        .lmsg.err { color: var(--error-color, #db4437); }

        /* ── 详情视图 ── */
        /* 详情页头: 返回 / 标题 / [叠加 + 段数] / 导出 / 删除。
           标题可压缩 —— 窄屏先省略标题, 不让那几个钮被挤走或换行。 */
        .dhead { display: flex; align-items: center; gap: 6px; margin-bottom: 8px;
          flex-wrap: nowrap; font-size: 12px; }
        .dhead .dtitle { font-weight: 600; font-size: 14px; min-width: 0; overflow: hidden;
          text-overflow: ellipsis; white-space: nowrap; }
        .dhead .spacer { flex: 1 1 auto; min-width: 0; }
        .dhead .tchip { flex: none; }
        /* 「叠加最近几段」的段数输入框(原先在下方工具行里)。
           数值输入框: **有意保留** 1px 描边(表单控件没有边框会显得没做完; 与控制卡 .tinput 同口径) */
        .ovln {
          flex: none; width: 34px; padding: 2px 3px; text-align: center;
          font: inherit; font-size: 12px; color: inherit;
          border: 1px solid var(--divider-color, #d8dde2); border-radius: 6px;
          background: var(--lm-surface-control, var(--card-background-color, #fff));
        }
        .back {
          width: 28px; height: 28px; padding: 0;
          display: flex; align-items: center; justify-content: center;
        }
        .back ha-icon { width: 18px; height: 18px; --mdc-icon-size: 18px; }
        /* 胶囊开关(选中=主题色): 详情页头里的「叠加」—— 1.9.40 起与卡片其它按钮同款: 不描边 */
        .tchip {
          display: inline-flex; align-items: center; gap: 4px; cursor: pointer;
          padding: 4px 9px; border-radius: var(--lm-radius-badge, 999px); font-size: 12px; white-space: nowrap;
          color: var(--primary-text-color, #212121);
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
          transition: background .15s ease;
        }
        /* 三态与卡片其它按钮一致: 常态白底 + 阴影 / hover 淡主题色 / 按下轻微缩放 */
        .tchip:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .tchip:active { transform: scale(.96); }
        .ip { display: inline-block; vertical-align: middle; flex: none; }
        .tchip.on {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
          /* (原来是 border-color: transparent 藏灰边; 整条边框已去, 不再需要) */
        }
        .tchip.on:hover { background: var(--primary-color, #03a9f4); filter: brightness(1.08); }
        /* 导出格式气泡菜单(点导出按钮弹出)。
           1.9.40: 去边框(原 1px 灰边), 保留浮层的强投影(同 .winpop 的口径)。 */
        .expmenu {
          position: absolute; right: 10px; top: 42px; z-index: 30; display: none;
          flex-direction: column; min-width: 200px; padding: 4px;
          border-radius: var(--lm-radius-control, 12px); background: var(--lm-surface-control, var(--card-background-color, #fff));
          border: 0;
          box-shadow: 0 6px 24px rgba(0, 0, 0, .28);
        }
        .expmenu.on { display: flex; }
        /* 删除确认气泡: 明确写出要删哪一段 + 不可恢复的警告; 只有"删除"才真删 */
        .delpop {
          position: absolute; z-index: 40; display: none; min-width: 220px; max-width: 300px;
          padding: 10px 12px 10px; border-radius: var(--lm-radius-control, 12px);
          background: var(--lm-surface-control, var(--card-background-color, #fff));
          border: 1px solid var(--error-color, #db4437);
          box-shadow: 0 8px 26px rgba(0, 0, 0, .3);
        }
        .delpop.on { display: block; }
        .delpop .dpq { font-size: 13px; font-weight: 600; color: var(--error-color, #db4437); }
        .delpop .dpt {
          margin-top: 3px; font-size: 12px; color: var(--primary-text-color, #212121);
          white-space: normal;
        }
        .delpop .dpn {
          margin-top: 4px; font-size: 11px; line-height: 1.35; white-space: normal;
          color: var(--secondary-text-color, #6b7280);
        }
        .delpop .dpn b { color: var(--error-color, #db4437); }
        .delpop .dpa { display: flex; justify-content: flex-end; gap: 8px; margin-top: 9px; }
        /* 删除确认气泡里的两个按钮: 与卡片其它按钮同款(1.9.40: 去 1px 灰边, 换一层阴影) */
        .delpop .dpa button {
          font: inherit; font-size: 12px; padding: 4px 12px; border-radius: var(--lm-radius-control, 8px); cursor: pointer;
          border: 0;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          color: var(--primary-text-color, #212121);
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
        }
        .delpop .dpa button:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .delpop .dpa .dpOk {
          /* (原来是 border-color: transparent 藏灰边; 整条边框已去, 不再需要) */
          color: #fff; background: var(--error-color, #db4437);
          font-weight: 600;
        }
        .delpop .dpa .dpOk:hover { background: var(--error-color, #db4437); filter: brightness(1.08); }
        .delpop .dpa .dpOk[disabled] { opacity: .55; }
        .expmenu button {
          text-align: left; padding: 9px 12px; border: none; background: transparent;
          box-shadow: none; border-radius: var(--lm-radius-control, 8px); font-size: 13px; cursor: pointer;
        }
        .expmenu button:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .detailview { position: relative; }

        .map {
          position: relative; height: ${h}px;
          /* 必须用 clip 而不是 hidden: hidden 仍是可滚动容器, 会让绝对定位的瓦片整体偏移 */
          overflow: clip; border-radius: var(--lm-radius-control, 12px); background: #dfe6ea;
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
        /* 车速热力图图例: **竖向**贴着地图左缘悬浮(上=快, 下=慢); 关热力图时只做视觉隐藏
           (visibility), 不参与排版也不会被地图裁掉。
           align-items: flex-start —— 色条要**贴左**(居中的话它会被上面那行文字的宽度推进去);
           文字从左缘往右排, 半透明白底保证压在底图上仍读得清。 */
        .spd {
          position: absolute; left: 3px; top: 6px; bottom: 6px; z-index: 6;
          display: flex; flex-direction: column; align-items: flex-start; gap: 4px;
          font-size: 10px; color: var(--primary-text-color, #212121);
          pointer-events: none;
        }
        .spd:not(.on) { visibility: hidden; }
        .spd .spdHi, .spd .spdLo {
          padding: 1px 5px; border-radius: var(--lm-radius-badge, 999px); white-space: nowrap;
          background: rgba(255, 255, 255, .82); box-shadow: 0 1px 3px rgba(0, 0, 0, .18);
        }
        .spd .speed-gradient {
          flex: 1; width: 7px; border-radius: 4px; box-shadow: 0 1px 3px rgba(0, 0, 0, .22);
          background: linear-gradient(to top, #2196f3, #4caf50, #ffeb3b, #ff9800, #f44336);
        }
        /* 地图右上角的一列图标钮(与地图卡那套一致; 1.9.40 起同款不描边): 白底圆角 + 一层阴影, 选中=主题蓝。
           ⚠️ 用 absolute 钉住: 不参与地图排版, 也不会把地图挤窄。 */
        .mbtns {
          position: absolute; right: 8px; top: 8px; z-index: 8;
          display: flex; flex-direction: column; gap: 6px;
        }
        .mbtns button {
          width: 32px; height: 32px; padding: 0; border-radius: var(--lm-radius-control, 8px); cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--primary-text-color, #222);
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
          transition: background .15s ease;
        }
        /* 底图切换钮: 用图标表示当前底图(与地图卡同款) */
        .mbtns button.style ha-icon { width: 18px; height: 18px; --mdc-icon-size: 18px; }
        .mbtns button:not(.on):hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .mbtns button:active { transform: scale(.95); }
        .mbtns button.on {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
          /* (原来是 border-color: transparent 藏灰边; 整条边框已去, 不再需要) */
        }
        .mk {
          position: absolute; width: 22px; height: 22px; margin: -11px 0 0 -11px; box-sizing: border-box;
          border-radius: 50%; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px;
          text-align: center; border: 2px solid #fff; box-shadow: 0 1px 3px rgba(0,0,0,.4);
        }
        .mk.start { background: #111; }
        .mk.end { background: #e53935; }
        /* 点中的轨迹点: 小蓝点 + 信息气泡 */
        .mk.pt {
          width: 11px; height: 11px; margin: -5.5px 0 0 -5.5px;
          background: var(--primary-color, #03a9f4); border: 2px solid #fff;
        }
        .ptTip {
          position: absolute; z-index: 8; width: 178px; box-sizing: border-box;
          transform: translate(-50%, -100%);
          padding: 6px 9px; border-radius: 10px; font-size: 11px; line-height: 1.55;
          color: #fff; background: rgba(33, 33, 33, .92);
          box-shadow: 0 2px 10px rgba(0, 0, 0, .3);
          pointer-events: none; text-align: center; white-space: nowrap;
        }
        .mhint {
          position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%); z-index: 6;
          display: none; padding: 3px 9px; border-radius: var(--lm-radius-badge, 999px); font-size: 11px; white-space: nowrap;
          background: rgba(0,0,0,.62); color: #fff;
        }

        .dinfo { margin-top: 10px; padding: 12px 14px; border-radius: var(--lm-radius-section, 14px); }
        ${profileStyles}
        .dwhen { padding-right:84px; font-size: 17px; font-weight: 600; letter-spacing: .2px; }
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

        /* 共享控件层: 必须放在**最后**(同特异度下由它定稿), 见 src/lib/ui/styles.ts */
        ${uiStyles}
      `;
  }

  /** 卡片配色(本机; 六张卡统一): 连接期间订阅配色变化 —— 变量写在宿主元素上(见 lib/palette.ts) */
  connectedCallback() {
    super.connectedCallback();
    // 界面风格 + 本机主题色(本机; 六张卡统一): 变量写在宿主元素上, 继承进 shadow root,
    // 卡内 CSS 只消费 --lm-*/HA 变量, 见 lib/appearance.ts。
    bindAppearance(this, { getDark: () => isDark(this._hass) });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    // 与原实现等价的清理: 观察器/定时器断开(不得改变对外行为)
    unbindAppearance(this); // 外观订阅同样只在"连接期间"需要
    if (this._thumbObs) this._thumbObs.disconnect();
    if (this._ro) this._ro.disconnect();
    clearTimeout(this._delTimer);
  }
}

/* ── 注册(带 registry-swap 自愈守卫) ── */
defineCard("leapmotor-trips", LeapmotorTripsCard as unknown as CustomElementConstructor);

registerCustomCard({
  type: "leapmotor-trips",
  name: "零跑·行程浏览",
  description: "行程卡片(缩略图/按天分组/起终点/断档虚线/最近多段叠加)",
  preview: false,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});

banner("零跑行程浏览", CARD_VERSION);
