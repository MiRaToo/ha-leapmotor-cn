/*
 * 零跑·车辆控制 —— App 风格的车辆控制卡(v2)。
 *
 * ⚠️ 本文件是 Lit + TS 重构版, 行为与视觉须与原 leapmotor-control.js **逐项等价**:
 *    元素名/customCards 元信息/配置字段(含别名)/交互事件/WS 命令/HA 服务调用/
 *    localStorage 键/文案/CSS 与动画 全部保留(见 .refactor-baseline/MIGRATION-CONTRACT.md)。
 *
 * 只依赖浏览器原生能力(单文件、零依赖、无构建); 服务调用只用 HA 标准域:
 *   lock.lock/unlock、climate.set_hvac_mode/set_temperature、switch.turn_on/off、
 *   number.set_value、button.press、time.set_value
 * —— 不调用任何 leapmotor.* 自定义服务。
 *
 * 实体怎么找(核心契约)
 * --------------------
 * 后端每个实体都带 `translation_key`(= 本文件里的那些键), 且 `unique_id = <VIN>_<键>`。
 * 卡片通过 WebSocket 命令 `config/entity_registry/list` + `config/device_registry/list`
 * 自己查(不用 HA 2026.8 才有的 hass.entities / hass.devices, 所以 2024.11+ 都能跑):
 *   1. 过滤 `platform === "leapmotor"` 的实体;
 *   2. 选设备: config.device(device_id / 该车任一 entity_id) → 否则只有一辆车就自动选,
 *      多辆就在卡片上列出候选让用户挑(或在配置里写死);
 *   3. 在该设备下建索引 `translation_key → entity_id`;
 *   4. config.entities 可逐项手工覆盖(键名就是下面这些);
 *   5. 解析不到的键 → 对应控件/区块整块隐藏 —— 纯电没有燃油键、C10 没有后排座椅键,
 *      界面自然就不显示(多车型适配靠这个, 不需要配置)。
 * 注册表查询只做一次, 结果缓存在卡片实例上, 不在每次渲染时重查。
 *
 * 渲染说明(C 档收尾后):
 * 原实现是"整块 innerHTML 重画"(每个面板一个 HTML 字符串 → panel.innerHTML)。现在
 * shadow DOM 的**骨架**仍由 _build() 用 innerHTML 一次性建好(只跑一次, 不是热路径),
 * 但每个面板都是一段 **Lit 模板**(见 templates.ts): 各 _renderXxx() 只切 `display` +
 * `render(xxxPanel(this), el)`, "只改变化的那部分"交给 Lit 自己。data-act/data-entity/
 * data-on/data-key/data-delta/data-sec/data-val 属性与 .p-* 面板结构全部原样保留;
 * 手工拼字符串那套(_setPanel / _panelCache / _panelDirty / _invalidatePanel / _panelOf)
 * 已随"最后一个字符串面板"一起删除。
 *
 * 界面结构(照 App 的信息架构, 常用功能默认收起、少几层)
 * ----------------------------------------------------------------
 *   hero      车名(双击可改, 存本机) + 状态更新 / 标题行右侧小 pill:
 *             「行驶中」橙 / 「已驻车」绿 / 未插枪灰 / 已插枪未充电红 / 充电中绿 / 胎压偏低红
 *             + 刷新车况
 *             + 超大续航 + 细电量条 + 锁状态胶囊
 *             + 增程车专有的「⚡纯电 / ⛽燃油」双胶囊
 *             + 车模示意图(点右下角小胶囊把四轮胎压叠上来)
 *               车模区三选一(优先级从高到低): 自定义外观图 → 3D 车模(素材装配好之后
 *               才出现的 iframe, 可拖动旋转) → 官方整车展示图或隐藏车图。素材没装配时不联网、
 *               不报错, 只在「设置」里给一个按钮, 由用户点了才去装配。
 *   actions   四个圆形动作按钮: 解锁·上锁 / 后备箱 / 车窗(弹气泡选四档) / 遮阳帘
 *   climate   左半空调卡: 大字车内温度 + 「车内」小角标 + 风扇图标(开关);
 *             温度行与一排圆形预设入口; 数字位置恒定, ± 只在开着时显示
 *   location  右半位置卡: 区域名(不在区域就显示「外出」)+ 坐标 + 更新时间, 背景是驻车照片;
 *             底部「驻车照片」「鸣笛寻车」胶囊 + 一个 ⓘ
 *   charging  充电: 与「设置」**并排各占一半**的入口卡(一行摘要 + 箭头), 点开弹窗 ——
 *             上限滑条 / 预约开关 / 起止时间 / 健康充电 / 充电状态 / 电池预热
 *   car3d     设置: 同上并排的另一张入口卡, 点开弹窗 —— 卡片配色(主题色, 六张卡统一) /
 *             车模颜色 / 背景 / 自定义外观图 / 素材下载 / 状态小字
 *   comfort   座椅与加热: 弹窗显示(浮在卡片上层)。座舱俯视位图底图(5座/7座 × 浅色/深色)
 *             + 方向盘/各排座椅控件按坐标叠加; 后视镜加热图标放在两侧后视镜位置;
 *             状态只用颜色: 加热=红 / 通风=蓝且风扇转动;
 *   seats     后排座椅 —— v4 起并进上面的座舱模型, 这里只留面板位(兼容 show 配置)
 *   fuel      燃油(增程车才有)
 * 现在**只剩 fuel** 是可折叠块: 标题行可点折叠, 默认收起, 折叠状态存 localStorage
 * (key 带设备 id); 收起时标题行右侧给摘要。
 * charging / comfort / car3d 三块的正文都是**卡片内弹窗**(浮在卡片上层, 一次性交互、
 * 绝不持久化 —— 见 _open), 入口分别是并排的两张卡与空调卡里的座椅钮。
 * 「设置」里的本机选择存 localStorage(配色是全局键, 其余键带设备 id), 集成选项只当默认值。
 *
 * 用法
 * ----
 *   type: custom:leapmotor-control
 *   # 全部可选
 *   device: <device_id 或该车任一实体 id>   # 只有一辆车时可省
 *   name: 我的零跑                          # 覆盖标题(默认用车名)
 *   entities: {battery: sensor.xxx, ...}    # 逐项手工覆盖
 *   show: [hero, actions, climate, location, charging, comfort, seats, fuel, car3d]
 *   compact: false                          # 紧凑模式(不显示车模上的胎压开关)
 *   tire_range: [2.3, 2.8]                  # 可选: 胎压正常区间(bar)
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 */
import { LitElement, html, nothing, render } from "lit";
import {readWrap,type CarWrap} from "./car-wrap";
import type { HomeAssistant, LovelaceCardConfig, HassEntity } from "../../types/hass";
import { esc, clamp } from "../../lib/dom";
import { isDark } from "../../lib/theme";
import { applyAppearance, bindAppearance, unbindAppearance } from "../../lib/appearance";
import { hasOverlay, openConfirm } from "../../lib/ui/overlay";
import { defineCard, registerCustomCard, banner } from "../../lib/register";
import type { RegistryEntity, RegistryDevice, Candidate, ClPending, TempPending, PresetMemo, Car3dInfo, Car3dMarketPicture, Car3dMarketModel, Car3dMarketVariant, Car3dPrefs, ControlCtx } from "./types";
import { CARD_VERSION, PANELS, SECTIONS, SHOW_EXTRA, KEY_NAMES, KEY_SUFFIX, KEYS_BY_LEN, CAR3D_INFO_WS, CAR3D_MARKET_PICTURES_WS, CAR3D_MARKET_CATALOG_WS, CAR3D_MARKET_VARIANTS_WS, CAR3D_ENSURE_WS, CAR3D_POLL_MS, CAR3D_POLL_MAX, CAR3D_SYNC_MS, CAR3D_DROP_PCT, LOW_TIRE_BAR, TIRE_DEFS, TEMP_DEBOUNCE_MS, TEMP_PENDING_MS, PRESET_MEMO_MS } from "./types";
import { CARD_CSS } from "./css";
import { actionsPanel, actionsVisible, cabinPanel, carToolsPanel, car3dBodyPanel, car3dPanel, car3dVisible, carDocksPanel, chargeBodyPanel, chargingPanel, chargingVisible, climatePanel, climateVisible, emptyPanel, fuelPanel, fuelVisible, heroFull, heroPanel, heroVisible, hintPanel, locationPanel, locationVisible, photoPanel, toastPanel } from "./templates";
import { car3dHexNow, car3dBackgroundNow, car3dAutoTsp, car3dColors, car3dSelTsp, car3dView } from "./render-hero";
import { CAR3D_BACKGROUNDS } from "./types";
import { vehiclePose, tireLayout } from "./car3d-state";
import { cabinAny, locBg } from "./render-panels";
import { onPalFocusOut, onPalKeyDown, onPalPointer, palInit, palPickerT, placePalPop } from "./picker";
import { onClick, onChange, onInput, onTitleDblClick } from "./handlers";

const MARKET_IMAGE_HOSTS = new Set([
  "lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com",
  "ueapp-oss-static.leapmotor.com",
  "ueapp-oss-static.leapmotor.cn",
  "lp-website-oss-static.leapmotor.com",
]);
const MIN_MARKET_YEAR = 2020;

function safeMarketPictureUrl(value: unknown): string {
  try {
    const url = new URL(String(value || ""));
    return url.protocol === "https:" && MARKET_IMAGE_HOSTS.has(url.hostname) ? url.href : "";
  } catch {
    return "";
  }
}

class LeapmotorControlCard extends LitElement implements ControlCtx {
  private _built = false;
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _hass: HomeAssistant | null = null;
  private _appearanceDark: boolean | null = null;
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _config: LovelaceCardConfig | null = null;
  private _show: string[] | null = null; // 配置 show 解析后的数组(或 null = 全显示)
  // 实体注册表(只查一次, 缓存在实例上)
  private _registry: { entities: RegistryEntity[]; devices: RegistryDevice[] } | null = null;
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _registryState: "idle" | "loading" | "done" | "failed" = "idle";
  private _hint = ""; // 顶部提示(退化模式等)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _devMsg = ""; // 设备选择提示
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _device = ""; // 解析出的 device_id
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _deviceName = ""; // 设备名(标题默认用它)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _model = ""; // 车型(设备注册表的 model 字段, 如 "C10"); 决定车模图用哪张
  private _customName = ""; // 标题自定义名(本机 localStorage; 双击标题可改; 空 = 跟随设备名)
  private _nameLoaded = false; // 是否已按设备 id 读过自定义名
  private _nameKey = "";
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _editingTitle = false; // 标题编辑中(期间 hero 不重刷, 免得输入框被擦掉)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _candidates: Candidate[] = []; // 多辆车时的候选
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _picked = ""; // 用户在卡片上临时点选的 device_id
  private _overrides: Record<string, string> = {}; // config.entities 手工覆盖
  private _index: Record<string, string> = {}; // translation_key → entity_id
  private _guessed = false; // 索引是否来自"猜"(用于提示)
  // 交互状态
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _busy: Record<string, boolean> = {}; // 键 → true(调用进行中)
  private _toast = "";
  private _toastKind = "info";
  private _toastTimer: ReturnType<typeof setTimeout> | null = null;
  private _raf = 0;
  // v2 的界面状态
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _collapsed: Record<string, boolean> = {}; // 区块名 → true(localStorage 里持久化)
  private _foldLoaded = false; // 是否已经按设备 id 读过 localStorage
  private _foldKey = "";
  // 页内展开态。seats/charge/car3d 是**弹窗**(一次性交互, 绝不从 localStorage 恢复 —— 否则
  // 刷新后弹窗自己弹出、遮罩盖住整张卡片, 这个坑座椅那张卡踩过)。
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _open = { climate: true, window: false, preset: false, photo: false, tires: false,
                    seats: false, charge: false, car3d: false, car2dSettings: false };
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _warnOpen = false;   // 车模右上角告警: false = 收起为红色「!」(默认), true = 逐条展开
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _chgOpen = false;    // 车模左侧的充电块: false = 收起(只显示"慢充中/快充中")
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _boltUid = 0;        // 充电图标的渐变/裁剪 id 序号(同一 shadow root 里必须唯一)
  private _regRetryAt = 0;     // 下一次允许重试读注册表的时刻(见 set hass 的自愈说明)
  private _regRetries = 0;     // 已重试次数(上限 30)
  private _winOutside: ((ev: Event) => void) | null = null; // 车窗气泡打开时挂的 document 点击监听
  private _presetOutside: ((ev: Event) => void) | null = null; // 空调预设气泡的 document 监听
  private _palOutside: ((ev: Event) => void) | null = null; // 取色器面板的 document 监听
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _lastHvac = ""; // 上次开的空调模式(set_hvac_mode 记忆)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _locBgSrc = ""; // 位置卡背景图: 当前在验证的地址
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _locBgOk = ""; // 位置卡背景图: 验证结果(ok / 其它=失败)
  // 车模图(按车型): 与 _locBg 同一套"先探针再上屏"的缓存; 探不过则不显示车图
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _carImgSrc = ""; // 当前在验证的地址
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _carImgOk = ""; // 验证结果(ok / bad)
  // 充电上限: 命令刚发出、实体状态还没更新时, 用本地值顶住滑杆(免得"弹回"旧位置)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _clPreview: number | null = null; // 滑条拖动中的预览值(模板优先显示它)
  public _clPending: ClPending | null = null;
  public _clPendingTimer: ReturnType<typeof setTimeout> | null = null;
  // 空调温度 ±: "本地待发值" + 抖动窗口(连点合并成一次下发, 见 _onTemp/_flushTemp)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _tempPending: TempPending | null = null;
  private _tempTimer: ReturnType<typeof setTimeout> | null = null; // 抖动窗口的定时器
  private _tempExpiryTimer: ReturnType<typeof setTimeout> | null = null;
  private _tempSent: number | null = null; // 最近发出去的值(与待发值相同 → 不重复刷云端)
  /** 空调预设的"本机记忆": 用户最近点过的那颗(实体不报 preset_mode 时, 温度区靠它显示) */
  public _lastPreset: PresetMemo | null = null;
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _carImgRetryAt = 0; // 外观图失败后按退避间隔重试
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _carImgApiFailedSrc = ""; // 记录失败的外观图地址, 到时重试
  // ── 3D 车模 ──
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3d: Car3dInfo | null = null; // 现状(本地读盘); null = 还没读到/读不到(那就不出现)
  private _car3dDev: string | null = null; // _car3d 是替哪辆车问的(换车要重问)
  private _car3dLoading = false;      // 正在问
  private _car3dRetryAt = 0;          // 问失败后的重试节流(免得每次状态推送都打一枪)
  private _car3dFrame: HTMLIFrameElement | null = null; // 复用的 iframe(见 _renderCarView 的说明)
  private _car3dSrc = "";             // iframe 当前的重载键(见 _car3dUrl); 只有它真变了才重设
  private _car3dBackgroundSent = "";
  private _car3dPoseSent = "";
  private _car3dPaintSent: string | null = null;
  private _car3dDock: HTMLElement | null = null; // 3D 盒里的浮动层(告警/充电/胎压), 每次重绘只换它
  private _car3dBox = false;          // .p-carview 现在是不是 3D 盒(退出时要连 iframe 一起拆)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dNightSent: boolean | null = null; // 上次发出去的 daynight 值(null = 新文档还没同步)
  private _car3dRadiusSent: number | null = null; // 上次发/带出去的取景 radius(盒子尺寸变了才再发)
  private _car3dSyncTries = 0;        // daynight 被 ack 回 false(天空还没建好)后的重试次数
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dViewErr = "";         // 包装页 {t:"err"} 的摘要(状态行显示)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dErr = "";             // 素材下载失败的一行小字(ensure / info 的 error 摘要)
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dBusy = false;         // ensure 进行中(按钮禁用)
  public _car3dReloading = false;    // 用户主动重载 3D 查看器
  public _marketPictures: Car3dMarketPicture[] = [];
  public _marketPicturesLoading = false;
  public _marketPicturesError = "";
  public _marketModels: Car3dMarketModel[] = [];
  public _marketVariants: Car3dMarketVariant[] = [];
  public _marketSelectedModel = "";
  public _marketSelectedYear = "";
  public _marketSelectedVariant = "";
  public _marketCatalogLoading = false;
  public _marketVariantsLoading = false;
  private _marketPicturesAskedDevice = "";
  private _marketActual: { model: string; year: string; energy: string; edition: string; model_id: string; color: string } | null = null;
  private _marketSelectionReq = 0;
  private _car3dPollTimer: ReturnType<typeof setTimeout> | null = null;
  private _car3dPolling = false;      // 轮询链在跑(含 callWS 往返期间, 免得重绘插进第二条链)
  private _car3dPollLeft = 0;         // 轮询剩余次数
  private _car3dSyncTimer: ReturnType<typeof setTimeout> | null = null; // full 缺失时的兜底同步
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dPrefs: Car3dPrefs = {}; // 本机覆盖(颜色/背景/自定义外观图)
  private _car3dPrefsLoaded = false;
  private _car3dPrefsKey = "";
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _car3dImgDraft: string | null = null; // 用户在文本框里打到一半的 URL(重绘不擦掉)
  /** @internal 设置子卡的取色器: 开的是哪一颗彩虹圆(""/accent/hex) + 面板当前的 HSV。 */
  public _palOpen: "" | "accent" | "hex" = "";
  public _palH = 0;                            // 色相 0~360
  public _palS = 0;                            // 饱和度 0~1
  public _palV = 0;                            // 明度 0~1
  /** @internal 取色器里 hex 输入框的草稿(打到一半被状态推送擦掉就不好用了) */
  public _palHexDraft: string | null = null;
  /** @internal 取色器是否正在拖动 SV 方块(拖动期间指针被它捕获) */
  public _palDrag = false;
  /** @internal 电池预热的"本机记忆": 上次点的是哪一段(车端不回报预热状态, 只为分段控件有个选中态) */
  public _preheatSel = "";
  private _heroLive = false;          // hero 这一帧画了完整布局(车模区才跟着出现)
  private _narrow: boolean | null = false; // 卡片宽度 < 420px(圆钮缩小 / 车模变矮等)
  private _tiny: boolean | null = false;   // 卡片宽度 < 280px(只有这么窄才把并排的两张小卡堆叠)
  private _ro: ResizeObserver | null = null;
  // 命令式 DOM 引用(_build() 建好后缓存; 每个面板都是 Lit 模板的挂载点)
  private _hintEl: HTMLElement | null = null;
  private _toastEl: HTMLElement | null = null;
  private _photoEl: HTMLElement | null = null;
  /** 驻车照片加载失败(覆盖层显示提示文字; 由 Lit 模板输出, 见 photoPanel) */
  public _photoErr = false;
  private _smaskEl: HTMLElement | null = null;
  private _smodalEl: HTMLElement | null = null;
  private _smbodyEl: HTMLElement | null = null;
  private _smtitleEl: HTMLElement | null = null;
  /* 弹窗正文的宿主 `.secB`(座椅与充电两支 Lit 模板二选一, 见 _renderModal)。 */
  private _smHost: HTMLElement | null = null;
  private _carViewEl: HTMLElement | null = null; // 3D 车模的独立容器(见 _renderCarView)
  private _heroStageEl: HTMLElement | null = null; // hero 的外层舞台(3D 时数据叠在车模上)
  private _carToolsEl: HTMLElement | null = null;  // 车模下方的小控件行(胎压开关)
  private _panels: Record<string, HTMLElement> = {};
  private _cardEl: HTMLElement | null = null;

  // ── Lit 集成说明 ──
  // 骨架(style/.p-*/弹窗/toast/ovl)由 _build() 用 innerHTML **一次性**建好, 之后各面板由
  // 独立的 render() 提交模板 —— **不**使用 LitElement 自己的模板渲染。所以这里覆写
  // createRenderRoot(): 手动 open 模式 shadow root(与原实现一致), 并把 Lit 的 update() 置空
  // —— 免得 LitElement 的首次异步 update 往我们亲手建好的 shadow DOM 里插入模板标记 /
  // 写 nothing, 破坏那套结构。render() 仅作占位(永不被调用)。
  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this._ensureShadow();
  }
  protected update(): void {
    /* no-op: 本卡不使用 Lit 模板渲染(见上方说明) */
  }
  render() {
    /* no-op: 本卡不使用 Lit 模板渲染 */
    return nothing;
  }

  /** 确保 open 模式 shadow root 已挂载(幂等)。HA 会先 setConfig 再连接元素, 那时
   *  Lit 还没调 createRenderRoot, this.shadowRoot 为 null —— 这里兜住, 免得 _build 抛错
   *  ("Cannot set properties of null")被 HA 当成「配置错误」。 */
  private _ensureShadow(): ShadowRoot {
    return this.shadowRoot || this.attachShadow({ mode: "open" });
  }

  /** 从卡片选择器添加时: 自动带上探测到的 device(没有就只给 type)。 */
  static getStubConfig(hass: HomeAssistant) {
    const base = { type: "custom:leapmotor-control" };
    if (!hass || !hass.callWS) return base;
    return Promise.all([
      hass.callWS({ type: "config/entity_registry/list" }),
    ]).then(function (res) {
      const ents = (res[0] || []) as RegistryEntity[];
      const ids: string[] = [];
      for (const e of ents) {
        if (e && e.platform === "leapmotor" && e.device_id && ids.indexOf(e.device_id) < 0) {
          ids.push(e.device_id);
        }
      }
      if (ids.length !== 1) return base;
      // 不把当时的设备名写死进卡片配置(config.name) —— 那会让之后"改标题/改设备名"
      // 看起来永远没反应。标题默认动态跟随设备名, 双击标题还能在本机自定义(见 _startTitleEdit)。
      return { type: "custom:leapmotor-control", device: ids[0] };
    }).catch(function () {
      return base;
    });
  }

  setConfig(config: LovelaceCardConfig) {
    // 不抛异常: 配置不对就在卡片上给提示, 否则 HA 只会显示一张"配置错误"卡片
    this._config = {
      device: "", name: "", entities: null, show: null,
      compact: false, tire_range: null,
      ...(config || {}),
    };
    const show = this._config.show;
    if (Array.isArray(show)) {
      this._show = show.map(function (x) { return String(x).trim(); }).filter(Boolean);
    } else if (typeof show === "string" && show) {
      this._show = show.split(",").map(function (x) { return x.trim(); }).filter(Boolean);
    } else {
      this._show = null;
    }
    this._overrides = {};
    const ents = this._config.entities;
    if (ents && typeof ents === "object") {
      for (const k in ents) {
        if (Object.prototype.hasOwnProperty.call(ents, k) && KEY_NAMES[k] && ents[k]) {
          this._overrides[k] = String(ents[k]);
        }
      }
    }
    // 配置变了就重新解析(注册表本身不重查)
    if (this._registryState !== "idle") this._resolveIndex();
    // 配置重应用只更新面板，保持 WebGL iframe 和根事件监听不变。
    this._render();
  }

  set hass(hass: HomeAssistant) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._hass) return;
    // HA 的主题变化会通过新的 hass 更新卡片，但不会触发本机风格事件。
    // 明暗参与 glass / brutalist 等 token 计算，因此在这里同步重涂宿主变量。
    const dark = isDark(hass);
    if (this._appearanceDark !== dark) {
      this._appearanceDark = dark;
      applyAppearance(this, dark);
    }
    if (this._registryState === "idle") this._loadRegistry();
    else if (first) this._resolveIndex();
    // ── 重启窗口自愈 ──
    // HA 刚重启时实体注册表的 WS 可能还没就绪 → 读注册表失败 → 退化成"按名字猜";
    // 若此时 hass.states 也是空的, 卡片就一个实体都解析不出来, 界面上只剩
    // 「还没找到这辆车的实体」——**而且不会自己恢复**(原来只在首次 hass 解析一次),
    // 界面上只剩提示、点什么都没反应, 得手动刷新页面才好(实测: 部署重启后出现过)。
    // 所以:一个实体都没解析出来时, 隔 10 秒重试一次, 最多 30 次(~5 分钟)后放弃。
    if (this._indexCount() === 0) this._retryRegistry();
    this._scheduleRender();
  }
  // 与 trips/energy 保持一致:有 setter 就给 getter —— 否则 `card.hass` 读出来是
  // undefined(原型上只挂了 setter), 任何读它的代码(含测试/HA 侧包装)都拿不到状态。
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  /** 解析不到任何实体时的注册表重试(节流 + 上限, 免得永远空转)。 */
  private _retryRegistry(): void {
    if (this._registryState === "loading") return;      // 正在读, 别叠加
    const now = Date.now();
    if (now < this._regRetryAt) return;                 // 节流 10s
    if (this._regRetries >= 30) return;                 // 约 5 分钟后放弃(卡片上已有提示)
    this._regRetryAt = now + 10000;
    this._regRetries += 1;
    this._loadRegistry();
  }

  /** 合并同一帧里的多次 hass 更新, 避免每个实体状态变化都重画一遍卡片 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _scheduleRender() {
    if (this._raf) return;
    const run = () => {
      this._raf = 0;
      this._render();
    };
    if (typeof requestAnimationFrame === "function") this._raf = requestAnimationFrame(run);
    else this._raf = setTimeout(run, 16) as unknown as number;
  }

  getCardSize() {
    if (this._config && this._config.compact) return 8;
    return 14;
  }

  // ── 实体注册表(只查一次, 缓存在实例上) ──
  private async _loadRegistry() {
    const hass = this._hass;
    this._registryState = "loading";
    if (!hass || !hass.callWS) {
      this._registryState = "failed";
      this._hint = "当前环境读不到实体注册表, 已按实体名/后缀猜测; 可在卡片配置 entities 里手工指定。";
      this._resolveIndex();
      this._render();
      return;
    }
    try {
      const res = await Promise.all([
        hass.callWS({ type: "config/entity_registry/list" }),
        hass.callWS({ type: "config/device_registry/list" }),
      ]);
      const ents = res[0];
      const devs = res[1];
      if (!Array.isArray(ents) || !Array.isArray(devs)) throw new Error("注册表返回格式不对");
      this._registry = { entities: ents, devices: devs };
      this._registryState = "done";
      this._hint = "";
    } catch (err) {
      this._registry = null;
      this._registryState = "failed";
      this._hint = "读取实体注册表失败(需要管理员权限或较新的 HA), 已按实体名/后缀猜测; 可在卡片配置 entities 里手工指定。";
    }
    this._resolveIndex();
    this._render();
  }

  /** 建索引: translation_key → entity_id(注册表可用时最稳; 否则退化为猜) */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _resolveIndex() {
    const cfg: LovelaceCardConfig = this._config || ({} as LovelaceCardConfig);
    this._index = {};
    this._guessed = false;
    this._candidates = [];
    this._device = "";
    this._deviceName = "";
    this._model = "";
    this._devMsg = "";
    for (const k in this._overrides) this._index[k] = this._overrides[k];
    const hass = this._hass;
    if (!hass) return;

    const reg = this._registry;
    if (reg) {
      const ents: RegistryEntity[] = [];
      for (const e of reg.entities) {
        if (e && e.platform === "leapmotor" && e.entity_id && !e.disabled_by) ents.push(e);
      }
      if (ents.length) {
        const devName: Record<string, string> = {};
        const devModel: Record<string, string> = {}; // 车型(设备注册表 model 字段, 集成把 car_type 放在这)
        for (const d of reg.devices) {
          if (!d || !d.id) continue;
          devName[d.id] = d.name_by_user || d.name || d.id;
          devModel[d.id] = d.model || "";
        }
        const byDev: Record<string, RegistryEntity[]> = {};
        const devIds: string[] = [];
        for (const e of ents) {
          const d = e.device_id || "";
          if (!byDev[d]) { byDev[d] = []; devIds.push(d); }
          byDev[d].push(e);
        }
        // ── 选设备 ──
        const want = String(cfg.device || this._picked || "");
        let devId = "";
        if (want) {
          if (want.indexOf(".") >= 0) { // 填的是 entity_id
            for (const e of ents) {
              if (e.entity_id === want) { devId = e.device_id || ""; break; }
            }
            if (!devId) { // 也允许填 unique_id 前缀(VIN)
              for (const e of ents) {
                if (String(e.unique_id || "").indexOf(want + "_") === 0) {
                  devId = e.device_id || "";
                  break;
                }
              }
            }
          } else if (byDev[want]) {
            devId = want;
          } else {
            for (const d of devIds) {
              if (devName[d] === want) { devId = d; break; }
            }
          }
          if (!devId) this._devMsg = "配置的 device 没找到: " + want;
        }
        if (!devId && devIds.length === 1) devId = devIds[0];
        if (devId) {
          this._device = devId;
          this._deviceName = devName[devId] || "";
          this._model = devModel[devId] || "";
          for (const e of ents) {
            if (e.device_id !== devId) continue;
            const k = e.translation_key || "";
            if (k && !this._index[k]) this._index[k] = e.entity_id as string;
          }
          this._fillByName(ents, devId); // 老实体没有 translation_key 时按名字补
        } else if (devIds.length > 1) {
          for (const d of devIds) {
            this._candidates.push({ id: d, name: devName[d] || d, count: (byDev[d] || []).length });
          }
          this._devMsg = "发现多辆零跑, 请在卡片配置里填 device(或点下面选一辆)";
        }
        this._loadFold(); // 设备定下来后再读这一辆车的折叠状态
        this._loadName(); // 再读这一辆车的自定义标题(可能为空)
        this._loadCar3dPrefs(); // 还有这一辆车的车模偏好(颜色/背景/自定义外观图)
        return; // 注册表可用, 不再猜
      }
    }
    // ── 退化: 注册表不可用(老 HA/权限/没有实体) → 按实体名/后缀猜 ──
    this._guessed = true;
    this._guessIndex();
    this._loadFold();
    this._loadName();
    this._loadCar3dPrefs();
    if (this._guessed && !this._hint) {
      this._hint = "读不到实体注册表, 已按实体名/后缀猜测(可能不准, 可在卡片配置 entities 里手工指定)。";
    }
  }

  /** 用实体名补注册表里没有 translation_key 的键(不会覆盖已有索引) */
  private _fillByName(ents: RegistryEntity[], devId: string) {
    const need: string[] = [];
    for (const k of KEYS_BY_LEN) if (!this._index[k] && KEY_NAMES[k]) need.push(k);
    if (!need.length) return;
    for (const e of ents) {
      if (e.device_id !== devId) continue;
      const fname = String(e.original_name || "") + "|" + String(e.name || "");
      for (const k of need) {
        if (this._index[k]) continue;
        const name = KEY_NAMES[k];
        if (fname.indexOf("|" + name) >= 0 || (e.entity_id as string).slice(-(name.length + 1)) === "_" + name) {
          this._index[k] = e.entity_id as string;
        }
      }
    }
  }

  /** 兜底猜测: 先按拼音后缀(长→短), 再按中文名(长→短), 最后按英文键后缀 */
  private _guessIndex() {
    const hass = this._hass;
    if (!hass || !hass.states) return;
    const ids = Object.keys(hass.states);
    const claimed: Record<string, string> = {};
    const domains = "sensor|binary_sensor|lock|climate|switch|number|button|time|text|device_tracker|image";
    const domRe = new RegExp("^(" + domains + ")\\.");
    const candidates = ids.filter(function (id) { return domRe.test(id); });
    // 已由 config.entities 指到实体, 就别被抢走
    for (const k in this._index) claimed[this._index[k]] = k;
    for (const k of KEYS_BY_LEN) {
      if (this._index[k]) continue;
      const suffix = KEY_SUFFIX[k];
      const name = KEY_NAMES[k];
      let hit = "";
      if (suffix) {
        for (const id of candidates) {
          if (claimed[id]) continue;
          if (id.slice(-(suffix.length + 1)) === "_" + suffix) { hit = id; break; }
        }
      }
      if (!hit) {
        for (const id of candidates) {
          if (claimed[id]) continue;
          const st = hass.states[id];
          const fname = String((st && st.attributes && st.attributes.friendly_name) || "");
          if (fname === name || fname.slice(-(name.length + 1)) === " " + name ||
              fname.slice(-name.length) === name) { hit = id; break; }
        }
      }
      if (!hit) {
        for (const id of candidates) {
          if (claimed[id]) continue;
          if (id.slice(-(k.length + 1)) === "_" + k) { hit = id; break; }
        }
      }
      if (hit) {
        this._index[k] = hit;
        claimed[hit] = k;
      }
    }
  }

  // ── 状态读取 ──
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _ent(key: string): HassEntity | null {
    const id = this._index[key];
    if (!id || !this._hass || !this._hass.states) return null;
    return this._hass.states[id] || null;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _entId(key: string): string {
    return this._index[key] || "";
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _val(key: string): string | null {
    const st = this._ent(key);
    if (!st) return null;
    if (st.state === "unknown" || st.state === "unavailable") return null;
    return st.state;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _num(key: string): number | null {
    const v = this._val(key);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _attr(key: string, name: string): any {
    const st = this._ent(key);
    if (!st || !st.attributes) return null;
    const v = st.attributes[name];
    return v == null ? null : v;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _ready(key: string): boolean {
    return this._val(key) != null;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _driving(): boolean {
    return this._val("vehicle_state") === "driving";
  }

  /** 未关项(后备箱 / 车窗) —— 红色胶囊与圆钮告警共用同一份判断。

   * 后备箱: 开关实体的状态位(信号 1281)可靠, **任何时候**都提示;
   * 车窗: 来自「车辆状态」传感器的 `windows_open`(四窗任一 >0); 行驶中开窗是正常的,
   *       所以只在**非行驶**时提示与告警。
   */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _leftOpen(): { trunk: boolean; window: boolean; names: string[]; driving: boolean } {
    const driving = this._driving();
    const reportedTrunk=this._attr("vehicle_state","reported_trunk_open");
    const trunk = typeof reportedTrunk==="boolean"?reportedTrunk:this._val("trunk") === "on";
    const reportedWin=this._attr("vehicle_state","reported_windows_open");
    const win = !driving && (typeof reportedWin==="boolean"?reportedWin:this._attr("vehicle_state", "windows_open")) === true;
    const names: string[] = [];
    if (trunk) names.push("后备箱");
    if (win) names.push("车窗");
    return { trunk: trunk, window: win, names: names, driving: driving };
  }

  /** 四轮里低于 LOW_TIRE_BAR 的轮子(空数组 = 正常 / 这辆车没有胎压数据)。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _lowTires(): { name: string; v: number }[] {
    const out: { name: string; v: number }[] = [];
    for (const d of TIRE_DEFS) {
      const v = this._num(d[0]);
      if (v != null && v < LOW_TIRE_BAR) out.push({ name: d[1], v: v });
    }
    return out;
  }

  /** 是不是增程车。
   *
   *  优先读「续航」实体上的**稳定标记** `reev`(集成按 VIN 记忆的硬件属性, 见
   *  api.resolve_reev): 它不会因为"燃油实体这一刻建没建出来/被删了"而改变。
   *  读不到(旧版集成)才回退到"燃油实体在不在" —— 那个判据是建实体时的快照, 会漏。
   */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _isReev(): boolean {
    const st = this._ent("range");
    const a = st && st.attributes;
    if (a && typeof a.reev === "boolean") return a.reev;
    return !!(this._entId("fuel_level") || this._entId("fuel_range") ||
      this._entId("total_range") || this._entId("fuel_consumption"));
  }

  /** 增程车的"主续航"是油电总续航, 纯电是纯电续航 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _mainRange(): number | null {
    const total = this._num("total_range");
    if (this._isReev() && total != null) return total;
    return this._num("range");
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _indexCount(): number {
    let n = 0;
    for (const k in this._index) if (this._index[k]) n++;
    return n;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _title(): string {
    if (this._customName) return this._customName; // 双击标题自定义的名字最优先(存本机)
    const cfg: LovelaceCardConfig = this._config || ({} as LovelaceCardConfig);
    if (cfg.name) return String(cfg.name);
    return this._deviceName || "零跑";
  }

  /** 驻车照片地址: 优先 image 实体的 entity_picture(走 HA 自己的鉴权), 退回 parking_url */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _photoSrc(): string {
    let src = this._attr("parking", "entity_picture") || "";
    if (!src) {
      const raw = this._val("parking_url");
      if (raw && /^https?:\/\//.test(String(raw))) src = String(raw);
    }
    return src;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _vis(name: string): boolean {
    const cfg: LovelaceCardConfig = this._config || ({} as LovelaceCardConfig);
    // tires 没有独立区块了(并进了车模区); 保留这个分支, compact 时连车模上的胎压开关也一起藏掉
    if (cfg.compact && name === "tires") return false;
    if (this._show && this._show.length) {
      if (this._show.indexOf(name) >= 0) return true;
      // 老配置兼容: 填了 climate 就算同时要了 comfort(老版 climate = 空调 + 前排座椅)
      for (let i = 0; i < this._show.length; i++) {
        if (SHOW_EXTRA[this._show[i]] === name) return true;
      }
      return false;
    }
    return true;
  }

  // ── 折叠状态(按设备 id 存 localStorage) ──
  private _foldStoreKey(): string {
    return "leapmotor-control.fold." + (this._device || this._picked || "nodevice");
  }

  private _loadFold() {
    // 见下方: comfort(座椅与加热)的正文是个弹窗, 绝不从持久化状态里"恢复展开" ——
    // 否则每次打开仪表盘弹窗都会自己弹出来, 遮罩盖住整张卡片(实测踩过)。
    const key = this._foldStoreKey();
    if (this._foldLoaded && this._foldKey === key) return;
    this._foldKey = key;
    this._foldLoaded = true;
    this._collapsed = {};
    let raw = "";
    try {
      raw = window.localStorage.getItem(key) || "";
    } catch (err) {
      raw = "";
    }
    if (!raw) {
      // v4: 本地没有记录 = 用户还没表达过偏好, 默认全部收起(老用户已有记录则尊重它)
      for (const s of SECTIONS) this._collapsed[s] = true;
      return;
    }
    const list = String(raw).split(",");
    let stale = false; // 存里有本版本已经不认的键(见下) → 读完顺手清一次
    for (const s of list) {
      const k = s.trim();
      if (!k) continue;
      if (SECTIONS.indexOf(k) >= 0) this._collapsed[k] = true;
      else stale = true;
    }
    // 1.9.39: "设置"(car3d)不再是折叠卡(改成与充电并排的入口卡 + 弹窗), 老浏览器里
    // 存着的 "car3d" 从此没有意义 —— 上面那句已经把它忽略掉了(老值不会引发任何异常),
    // 这里再把本机存储重写一遍, 免得那个键一直留在用户的 localStorage 里当摆设。
    if (stale) this._saveFold();
    // "座椅与加热"展开时弹的是**弹窗**(见 _renderSeatModal): 弹窗是一次性交互, 不能从
    // 持久化状态里恢复 —— 否则上次开着它、刷新后弹窗自己弹出, 遮罩盖住整张卡片。
    this._collapsed.comfort = true;
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _saveFold() {
    // ⚠️ 只把 comfort(座椅与加热)从**存储**里排除, 别改内存里的 _collapsed ——
    // 保存发生在展开/收起之后, 在这里强改会把刚点开的弹窗立刻按回去(踩过)。
    const list: string[] = [];
    for (const s of SECTIONS) if (s !== "comfort" && this._collapsed[s]) list.push(s);
    try {
      if (list.length) window.localStorage.setItem(this._foldStoreKey(), list.join(","));
      else window.localStorage.removeItem(this._foldStoreKey());
    } catch (err) { /* 存不了就算了 */ }
  }

  // ── 标题自定义名(按设备 id 存 localStorage; 双击标题改; 不改 HA 里的任何名字/实体) ──
  private _nameStoreKey(): string {
    return "leapmotor-control.name." + (this._device || this._picked || "nodevice");
  }

  private _loadName() {
    const key = this._nameStoreKey();
    if (this._nameLoaded && this._nameKey === key) return;
    this._nameKey = key;
    this._nameLoaded = true;
    this._customName = "";
    try {
      this._customName = String(window.localStorage.getItem(key) || "").slice(0, 40);
    } catch (err) { /* 本地存储不可用就算了 */ }
  }

  private _saveName(name: string) {
    this._customName = String(name || "").trim().slice(0, 40);
    try {
      if (this._customName) window.localStorage.setItem(this._nameStoreKey(), this._customName);
      else window.localStorage.removeItem(this._nameStoreKey()); // 清空 = 恢复默认(跟随设备名)
    } catch (err) { /* 同上 */ }
  }

  /** 双击标题 → 变输入框改名: 回车/失焦保存, Esc 取消, 清空恢复默认。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _startTitleEdit() {
    if (this._editingTitle) return;
    const el = this._panels.hero;
    if (!el || !this.shadowRoot!.querySelector(".vname")) return;
    this._editingTitle = true; // 编辑期间 _renderHero 整块跳过, 免得被 hass 推送擦掉
    // hero 已迁到 Lit 模板: **输入框本身就是模板的一个分支**(见 templates.ts 的 heroPanel),
    // 所以这里是"把编辑态画出来", 不再拿 <input> 去 replaceWith(.vname) —— 那样做等于在 Lit
    // 背后抽掉它管着的节点(锚点变孤儿), 收尾时标题就回不来了。
    this._heroLive = true; // 能进到这里说明模板走的是完整布局那一支
    render(heroPanel(this), el);
    const input = this.shadowRoot!.querySelector("input.vnameEdit") as HTMLInputElement | null;
    if (!input) {
      this._editingTitle = false; // 画不出输入框(理论到不了) → 别把 hero 卡在编辑态
      return;
    }
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      this._editingTitle = false;
      if (save) this._saveName(input.value);
      this._renderHero(); // 模板会切回 .vname 那一支
    };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") { ev.preventDefault(); finish(true); }
      else if (ev.key === "Escape") { ev.preventDefault(); finish(false); }
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("click", (ev) => ev.stopPropagation());
    input.addEventListener("dblclick", (ev) => ev.stopPropagation());
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _secOpen(name: string): boolean {
    return !this._collapsed[name];
  }

  // ── 服务调用 ──
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public async _call(domain: string, service: string, data: Record<string, any>, busyKey?: string): Promise<boolean> {
    const key = busyKey || domain + "." + service;
    if (this._busy[key]) return false;
    const hass = this._hass;
    if (!hass || !hass.callService) {
      this._showToast("当前环境不支持调用服务");
      return false;
    }
    this._busy[key] = true;
    this._render();
    try {
      await hass.callService(domain, service, data || {});
      return true;
    } catch (err) {
      const msg = String((err && (err as Error).message) || err || "未知错误");
      this._showToast("操作失败: " + msg.slice(0, 90), "error");
      return false;
    } finally {
      delete this._busy[key];
      this._render();
    }
  }

  private _showToast(msg: string, kind?: string) {
    this._toast = msg;
    this._toastKind = kind || "info";
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = "";
      this._renderToast();
    }, 5000);
    this._renderToast();
  }

  private _renderToast() {
    const el = this._toastEl;
    if (!el) return;
    // class 只能在这一层切(toast 元素本身就是那个浮层), 文字交给 Lit 模板
    el.className = this._toast ? "toast on" + (this._toastKind === "error" ? " err" : "") : "toast";
    render(toastPanel(this._toast), el);
  }

  // ── 渲染 ──
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _render() {
    if (!this._config) return;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    this._loadWrap();
    this._cardEl?.classList.toggle('painting',this._palOpen==='hex'||this._wrapOpen);
    this._cardEl?.style.setProperty('--paint-ext',(this._paintStageExt||0)+'px');
    if (this._hintEl) {
      const msgs: string[] = [];
      if (this._hint) msgs.push(this._hint);
      if (this._devMsg) msgs.push(this._devMsg);
      // 这条是"要动手配置"的诊断提示(不是顺口一提的小字), 所以仍然整句显示, 只是带个 ⓘ 图标
      // (空消息提交空模板 + display:none; 不用 innerHTML)
      this._hintEl.style.display = msgs.length ? "flex" : "none";
      render(hintPanel(msgs.join(" ")), this._hintEl);
    }
    if (!this._hass) return;
    this._loadCar3dInfo(); // 3D 车模现状(本地读盘; 每辆车一次, 失败 30s 后才再问)
    this._renderHero();
    this._renderCarTools(); // 车模下方的小控件行(胎压开关)
    this._renderActions();
    this._renderClimate();
    this._renderLocation();
    this._renderCharging();
    this._renderComfort();
    this._renderSeats();
    this._renderCsDetail();
    this._renderModal();
    this._renderWrap();
    const paintDock=this.shadowRoot!.querySelector<HTMLElement>('.paintDock')!;
    paintDock.hidden=this._palOpen!=='hex';render(this._palOpen==='hex'?palPickerT(this):emptyPanel(),paintDock);
    this._renderFuel();
    this._renderCar3d();
    // 等调色器、动作行等布局全部完成后再量画布，避免退出预览时先量到旧面板高度。
    this._renderCarView();
    this._renderPhoto();
    this._renderToast();
    if (this._open.window) this._placeWin();
    if (this._open.preset) this._placePreset();
    if (this._palOpen) this._placePal();
  }

  /**
   * 车窗气泡贴位: 锚点是「车窗」圆钮自己(不是动作行/卡片中心), 圆钮是第几个、
   * 卡片多宽都不影响 —— 因为是实测 offset 算的, 不依赖 CSS 假设。
   * 竖向: 贴在圆钮下沿 +8px(不遮圆钮那一行, dir="down"); 横向: 先按圆钮居中, 再夹回卡片内,
   * 窄屏时箭头单独跟到圆钮中心, 保证不会飘到气泡外面去。
   */
  private _placeWin() { this._placePop(".actWin", ".winPop", ".p-actions", "down"); }

  /** 空调预设气泡: 与车窗**相反** —— 从预设钮的上沿往上弹(dir="up", 箭头朝下指回钮)。
   *  两者的贴位/夹取/箭头逻辑共用 _placePop, 只有"贴在钮的哪一侧"这个方向不同。 */
  private _placePreset() { this._placePop(".actPreset", ".presetPop", ".p-climate", "up"); }

  /** 取色器面板贴位(贴在触发的彩虹圆下方, 夹回卡片内); 实测写回, 逻辑在 picker.ts。 */
  private _placePal() { placePalPop(this); }

  /** 设置子卡里取色器的开关(与车窗气泡同一套"点外面收起")。
   *  key: "accent" = 卡片配色 · 主题色; "hex" = 车模自定义车漆; "" = 关闭。
   *  面板里每改一次色都即时生效(见 picker.ts), 所以这里只负责开关与把 HSV 初始化成
   *  该落点**当前**的颜色。
   *  ⚠️ **无论状态变没变都重绘一次**: 选色表色 / 回到实车色那两处改完偏好后借它刷界面
   *  (那时取色器多数本来就是关着的, 提前 return 会让界面停在旧颜色上 —— 实测踩过)。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  private _paintOriginal:Car3dPrefs|null=null;
  private _paintStageExt:number|null=null;
  private _wrapPreview:CarWrap|null=null;private _wrapOpen=false;private _wrapData:CarWrap|null=null;private _wrapOriginal:CarWrap|null=null;private _wrapKey='';private _wrapImageSent:Partial<Record<string,string>>={};
  private _loadWrap(){const key='leapmotor-control.wrap.'+(this._device||this._picked||'nodevice');if(this._wrapKey===key)return;this._wrapKey=key;this._wrapOpen=false;try{this._wrapData=readWrap(JSON.parse(localStorage.getItem(key)||'null'))}catch{this._wrapData=null}this._wrapImageSent={};}
  private _previewWrap(value:CarWrap|null,force=false){
    const config:any=value?{version:2,faces:{}}:null;
    if(value)for(const [side,face] of Object.entries(value.faces))if(face){config.faces[side]={...face};if(!force&&face.image===this._wrapImageSent[side])delete config.faces[side].image;}
    this._postCar3d({t:'wrap',value:JSON.stringify(config)});this._wrapImageSent=Object.fromEntries(Object.entries(value?.faces||{}).flatMap(([side,face])=>face?[[side,face.image]]:[]));
  }
  public _showWrap(on:boolean){
    if(on){this._showPal('');this._paintStageExt=this._car3dExt();this._wrapOriginal=readWrap(this._wrapData);this._wrapPreview=readWrap(this._wrapOriginal);this._open.car3d=false;this._open.charge=false;this._open.seats=false;}
    this._wrapOpen=on;if(!on)this._paintStageExt=null;this._render();
  }
  private _renderWrap(){
    const el=this.shadowRoot?.querySelector<HTMLElement>('.wrapDock');if(!el)return;el.hidden=!this._wrapOpen;
    render(this._wrapOpen?html`<leapmotor-car-wrap .value=${this._wrapOriginal} .storageKey=${this._wrapKey} .onPreview=${(v:CarWrap|null)=>{this._wrapPreview=v;this._previewWrap(v)}} .onSave=${(v:CarWrap|null)=>{this._wrapData=readWrap(v);this._wrapPreview=readWrap(v);this._previewWrap(v);this._wrapOpen=false;this._paintStageExt=null;this._open.car3d=true;this._render()}} .onCancel=${()=>{this._previewWrap(this._wrapOriginal);this._wrapOpen=false;this._paintStageExt=null;this._open.car3d=true;this._render()}}></leapmotor-car-wrap>`:html``,el);
  }
  public _finishPaint(apply:boolean){
    if(this._palOpen!=='hex')return;
    if(!apply&&this._paintOriginal)this._car3dPrefs={...this._paintOriginal};
    if(apply)this._saveCar3dPrefs();
    this._paintOriginal=null;this._syncCar3dPaint(true);this._open.car3d=true;this._showPal('');
  }
  public _showPal(key: "" | "accent" | "hex") {
    const next: "" | "accent" | "hex" = key === "accent" || key === "hex" ? key : "";
    if (this._palOpen !== next) {
      if(this._palOpen==='hex'&&this._paintOriginal){this._car3dPrefs={...this._paintOriginal};this._paintOriginal=null;this._syncCar3dPaint(true);}
      if(next==='hex'){this._paintStageExt=this._car3dExt();this._paintOriginal={...this._car3dPrefs};this._open.car3d=false;this._open.seats=false;this._open.charge=false;}
      else this._paintStageExt=null;
      if (next) palInit(this, next);
      this._palOpen = next;
      this._palHexDraft = null;
      this._palDrag = false;
      if(this._palOutside){document.removeEventListener('click',this._palOutside,true);this._palOutside=null;}
      if (next) {
        const self = this;
        this._palOutside = function (ev: Event) {
          const path = ((ev as any).composedPath && (ev as any).composedPath()) || [];
          for (const n of path) {
            if (!n || !n.dataset) continue;
            if (n.dataset.act === "palopen" || n.dataset.act === "palpop") return;
          }
          if(self._palOpen!=='hex')self._showPal("");
        };
        document.addEventListener("click", this._palOutside, true);
      } else if (this._palOutside) {
        document.removeEventListener("click", this._palOutside, true);
        this._palOutside = null;
      }
    }
    this._render();
  }

  /** 把气泡贴到它的圆钮一侧并夹回面板内(窗 = 下方 / 预设 = 上方, 共用这一份)。
   *  dir: "down" = 气泡顶边贴圆钮下沿 +8px; "up" = 气泡底边贴圆钮上沿 -8px(向上弹)。
   *  ⚠️ up 时**必须**把 CSS 里那条兜底的 bottom 清成 auto: 绝对定位元素同时给出 top 与 bottom
   *  且 height: auto 时, 浏览器会按"两者夹住"来解, 气泡会被拉高(见 css.ts 的 .presetPop)。 */
  private _placePop(wrapSel: string, popSel: string, boxSel: string, dir: "up" | "down") {
    const sr = this.shadowRoot;
    if (!sr) return;
    const pop = sr.querySelector(popSel) as HTMLElement | null;
    const wrap = sr.querySelector(wrapSel) as HTMLElement | null;
    const btn = wrap && (wrap.querySelector("button") as HTMLElement | null);
    if (!pop || !wrap || !btn) return;
    const wr = wrap.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    // 气泡比 .actWin 宽得多, 先按卡片内可用宽度封顶, 夹取区间才一定有解
    const box = ((sr.querySelector(boxSel) as HTMLElement | null) || wrap).getBoundingClientRect();
    const pad = 8;
    pop.style.maxWidth = Math.max(box.width - pad * 2, 80) + "px";
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    const cx = br.left - wr.left + br.width / 2; // 圆钮中心(相对 .actWin)
    pop.style.left = "0px";
    pop.style.transform = "none";
    if (dir === "up") {
      pop.style.top = br.top - wr.top - pad - h + "px"; // 气泡底边 = 圆钮上沿 - 8px(向上弹)
      pop.style.bottom = "auto";
    } else {
      pop.style.top = br.bottom - wr.top + pad + "px"; // 圆钮下沿 + 8px(向下弹)
      pop.style.bottom = "auto";
    }
    const lo = box.left - wr.left + pad - w;
    const hi = box.right - wr.left - pad - w;
    const left = lo > hi ? lo : Math.min(Math.max(cx - w / 2, lo), hi);
    pop.style.left = left + "px";
    const aw = 12; // 箭头宽
    const ax = Math.min(Math.max(cx - left - aw / 2, 2), Math.max(w - aw - 2, 2));
    pop.style.setProperty("--winArrow", ax + "px");
  }

  // ── hero: 车名 + 超大续航 + 电量条 + 胶囊 + 锁 + 车辆示意 ──
  private _renderHero() {
    const el = this._panels.hero;
    if (!el) return;
    // ⚠️ 顺序与迁移前一致: 编辑标题时**整块跳过**(连 display/_heroLive 都不动), 免得把输入框擦掉。
    if (this._editingTitle) return;
    // 显示门控与迁移前一致; 隐藏时提交空模板(不碰车模/外观图 —— 它们会探图并 scheduleRender)。
    el.style.display = heroVisible(this) ? "" : "none";
    this._heroLive = heroFull(this); // 只有完整布局那一帧, 车模区才跟着出现(见 _renderCarView)
    render(heroPanel(this), el);
  }

  /** 车模下方小控件行里的「胎压」开关(compact 下没有胎压键 → 整行不出现)。
   *  文案/选中态/动画与原实现一致, 只是从"车模右下角绝对定位"挪到了车模下方。 */
  private _renderCarTools() {
    const el = this._carToolsEl;
    if (!el) return;
    // 与其它面板一致: 交给 Lit 模板(内容没变时 Lit 自己不打补丁), 不再手工拼 innerHTML
    render(carToolsPanel(this), el);
  }

  // ── 四个圆形动作按钮(解锁·上锁 / 后备箱 / 车窗 / 遮阳帘) ──
  private _renderActions() {
    const el = this._panels.actions;
    if (!el) return;
    // 显示门控与迁移前一致; 隐藏时提交空模板(只切 display) —— 理由见 _renderFuel。
    el.style.display = actionsVisible(this) ? "" : "none";
    render(actionsPanel(this), el);
  }

  // ── 空调卡(左半): 大字车内温度 + 风扇; 展开是温度步进 + 预设 ──
  private _renderClimate() {
    const el = this._panels.climate;
    if (!el) return;
    // 显示门控与迁移前一致(_vis("climate") + 有空调实体); 隐藏时也要**照常提交模板**
    // (只是 display:none; 门控不成立时模板自己会返回空) —— 不要用 render(nothing, el)
    // 去"清空", 理由见 _renderFuel。
    el.style.display = climateVisible(this) ? "" : "none";
    render(climatePanel(this), el);
 // 已按最新实体值提交, 回到"能跳过"的状态
  }

  // ── 位置卡(右半): 区域 + 坐标 + 更新时间 + 两个浮动胶囊(背景是驻车照片) ──
  private _renderLocation() {
    const el = this._panels.location;
    if (!el) return;
    // 显示门控与迁移前一致; 隐藏时照常提交模板(只切 display) —— 理由见 _renderFuel。
    // (隐藏那一支在模板里返回空模板, 所以不会顺带调 locBg() 去探驻车照片, 见 templates.ts。)
    el.style.display = locationVisible(this) ? "" : "none";
    render(locationPanel(this), el);

  }

  // ── 充电(入口卡; 正文在弹窗里) ──
  /**
   * 充电: 标题行留在并排的卡片里, 正文由 _renderModal() 铺在弹窗里(与座椅/设置同一套壳)。
   * 收起态只有标题 + 摘要("79% · 未插枪"), 点开才出下面那一整块设置。
   */
  private _renderCharging() {
    const el = this._panels.charging;
    if (!el) return;
    // 显示门控与迁移前一致(_vis("charging") + 有充电相关实体); 隐藏时照常提交模板, 只切
    // display —— 不要用 render(nothing, el) 去"清空", 理由见 _renderFuel。
    el.style.display = chargingVisible(this) ? "" : "none";
    render(chargingPanel(this), el);

  }

  /** 充电块 / 座椅块的正文都已改走弹窗, 这块跨整行的容器不再使用(留空)。 */
  private _renderCsDetail() {
    const el = this._panels.csdetail;
    if (!el) return;
    el.style.display = "none";
    render(emptyPanel(), el);
  }

  /** 弹窗(座椅与加热 / 充电设置 / 设置共用一套壳): 标题 + 正文, 遮罩 + 右上角 ✕。
   *  三个弹窗互斥; 都是一次性交互, **不持久化**(见 _open 的说明)。
   *
   *  ⚠️ 正文这一层: 三支**都是** Lit 模板(cabinPanel / chargeBodyPanel / car3dBodyPanel),
   *  所以让 `.smbody` 里那个 `.secB` 子节点当**唯一宿主**, 三个模板在它里面三选一 ——
   *  也就是绝不再用字符串 innerHTML 去覆盖 Lit 管着的节点(那会让 Lit 记的锚点变成孤儿,
   *  之后再提交模板就报 "insertBefore of null")。宿主只在它不在位时重建
   *  (关弹窗会把它连同旧 Lit 根一起作废; 换一种弹窗也重建, 免得三支模板在同一个 Lit 根上
   *  切换时留下互相干扰的节点 —— 宿主重建即"内容切换时重建宿主")。 */
  private _modalListening = false;
  private _modalReturn:HTMLElement|null=null;
  private _modalKeyboard = (event:KeyboardEvent) => {
    // 共享确认框开着时, Esc 归它(只关最上层) —— 不能让"按 Esc 取消确认"顺手把弹窗也关掉
    if(hasOverlay())return;
    if(event.key==='Escape'){event.preventDefault();this._open.seats=false;this._open.charge=false;this._open.car3d=false;this._showPal('');return;}
    if(event.key!=='Tab'||!this._smodalEl)return;
    const nodes:HTMLElement[]=[];
    const collect=(root:ParentNode)=>{for(const n of root.querySelectorAll<HTMLElement>('*')){if(n.shadowRoot)collect(n.shadowRoot);if(n.matches('button,input,select,textarea,summary,a[href],[tabindex]')&&!n.matches(':disabled')&&n.tabIndex>=0&&n.getClientRects().length)nodes.push(n)}};
    collect(this._smodalEl);let active=this.shadowRoot?.activeElement;while(active?.shadowRoot?.activeElement)active=active.shadowRoot.activeElement;
    if(event.shiftKey&&active===nodes[0]){event.preventDefault();nodes[nodes.length-1]?.focus();}
    else if(!event.shiftKey&&active===nodes[nodes.length-1]){event.preventDefault();nodes[0]?.focus();}
  };
  private _placeModal() {
    this._smodalEl?.style.removeProperty('top');
    this._smodalEl?.style.removeProperty('max-height');
  }
  private _watchModal(open: boolean) {
    if (open === this._modalListening) return;
    this._modalListening = open;
    if (open) {
      window.addEventListener('keydown',this._modalKeyboard);
    } else {
      window.removeEventListener('keydown',this._modalKeyboard);
    }
  }
  private _renderModal() {
    if (!this._smaskEl) return;
    const seats = this._open.seats && this._vis("comfort") && cabinAny(this);
    const charge = this._open.charge && chargingVisible(this);
    // 设置弹窗: 门控与卡片本体同一份(car3dVisible = show 白名单)
    const set3d = this._open.car3d && car3dVisible(this);
    const which = seats ? "seats" : charge ? "charge" : set3d ? "car3d" : "";
    const open = !!which;
    const wasOpen=this._smodalEl!.classList.contains('on');
    if(open&&!wasOpen)this._modalReturn=this.shadowRoot?.activeElement as HTMLElement|null;
    this._smaskEl.classList.toggle("on", open);
    this._smodalEl!.classList.toggle("on", open);
    this._watchModal(open && this.isConnected);
    if (!open) {
      this._smbodyEl!.innerHTML = "";
      this._smHost = null;
      if(wasOpen){this._modalReturn?.focus();this._modalReturn=null;}
      return;
    }
    if (this._smtitleEl) {
      this._smtitleEl.textContent = which === "seats" ? "座椅与加热" : which === "charge" ? "充电设置" : "设置";
    }
    let host = this._smHost;
    if (!host || !host.isConnected || host.parentElement !== this._smbodyEl || host.dataset.which !== which) {
      this._smbodyEl!.innerHTML = '<div class="secB"></div>';
      this._smHost = host = this._smbodyEl!.firstElementChild as HTMLElement;
      host.dataset.which = which; // 换弹窗 → 连同旧 Lit 根一起换掉(见函数注释)
    }
    render(which === "seats" ? cabinPanel(this) : which === "charge" ? chargeBodyPanel(this) : car3dBodyPanel(this), host);
    this._placeModal();
    this._smodalEl!.setAttribute('aria-label',this._smtitleEl?.textContent||'车辆设置');
    if(!wasOpen)this._smodalEl!.querySelector<HTMLButtonElement>('.smx')?.focus();
  }

  // ── 座椅与加热: 入口在空调卡的按钮里、正文在弹窗里(见 _renderModal / cabinPanel) ──
  private _renderComfort() {
    // 这个面板位恒为空(留着只是为了 show 配置里写 "comfort" 不报错)
    const el = this._panels.comfort;
    if (!el) return;
    el.style.display = "none";
    render(emptyPanel(), el);
  }

  // ── 后排座椅: v4 起二排/三排都并进了 comfort 的座舱模型(见 cabinPanel)。
  //    这个面板位留着只是为了 show 配置里写 "seats" 不报错, 现在总是空的。 ──
  private _renderSeats() {
    const el = this._panels.seats;
    if (!el) return;
    el.style.display = "none";
    render(emptyPanel(), el);
  }

  // ── 燃油(增程车才有, 可折叠) ──
  private _renderFuel() {
    const el = this._panels.fuel;
    if (!el) return;
    // 显示门控按**数据**而不是"是不是增程": 没有实质燃油数据就不画这一块。
    // (旧写法把 `total_range` 也算作"有数据", 而综合续航所有车都有 —— 纯电车因此
    //  可能画出一个只有"油电总续航"的燃油块。`hasFuelData` 刻意排除了它。)
    // ⚠️ 即使该隐藏, 也**照常渲染模板**、只把整个面板 display:none —— 不要提交 `nothing`
    //    去"清空"面板: 那会让 Lit 的根部件停在空态, 之后再提交模板时内部部件会踩空
    //    (实测: TypeError: Cannot read properties of null (reading 'insertBefore'))。
    //    隐藏的面板看不见内容, 不清理没有副作用。
    el.style.display = fuelVisible(this) ? "" : "none";
    render(fuelPanel(this), el);
  }

  /**
   * 车模区的 3D 画法: 整个车模盒落在 .p-carview 这个**独立容器**里, iframe 挂在其中不再挪窝。
   *
   * 为什么不能继续画在 hero 里: hero 每次状态推送都会重新提交模板, 而 iframe
   * 一旦被摘出文档, 浏览器就销毁重建它的浏览上下文 —— 再挂回去等于整车重新加载。实测(真机
   * 行为的等价实验): 同一个节点 remove 之后再 appendChild, 就算在同一个任务里同步做完, 也会
   * 重新加载; 于是卡片上表现为"每次状态推送闪一下、模型重新下载渲染一遍"。
   * 所以 3D 期间这个容器只搭一次, 每次重绘只换里面的**浮动层**(告警/充电/胎压); 只有 src 真的
   * 变了(换色表里的色号 —— 素材材质是建时定色的)才 setAttribute, 那是**有意**的重载。
   */
  /** 3D 舞台的高度: 约 0.68 × 盒子宽度(宽:高 ≈ 1.47:1)。
   *  车在画面里的**尺寸只跟盒子高度成正比**(查看器垂直 FOV 固定 30°) —— 所以想让车占
   *  总宽六成左右, 关键是盒子够高; 夹在 [210,360], 窄屏/紧凑再收敛一档, 免得手机上
   *  整张卡被一个车模占满屏。 */
  private _car3dStageH(boxW: number): number {
    const w = boxW > 0 ? boxW : 340; // 量不到宽度(首帧/隐藏)时的兜底: 常见列宽
    let lo = 210;
    let hi = 360;
    if (this._narrow) { lo = 190; hi = 320; }
    if (this._config && this._config.compact) { lo = 170; hi = 280; }
    return Math.round(clamp(w * 0.68, lo, hi));
  }

  /** 取景随画布比例缩放。C10 在 300/400px 本地预览中车宽约占可用宽度六成；
   *  h 包含动作行渐隐区域，尺寸未知时用相同构图的兜底值。其它车型比例尚待验证。 */
  private _fitRadius(w: number, h: number): number {
    if (w <= 0 || h <= 0) return 14;
    return Math.round(clamp(10 * ((h + 0.37 * w) / w), 8, 26) * 10) / 10;
  }

  private _car3dRadius(): number {
    const el = this._carViewEl;
    const w = el ? el.clientWidth : 0;
    const h = el ? el.clientHeight : 0;
    if (w > 0 && h > 0) return this._fitRadius(w, h);
    const cw = this._cardEl ? this._cardEl.clientWidth : 0;
    if (cw > 10) {
      const bw = Math.max(cw - 28, 0); // 卡片内边距(左右各 14px)不算进盒子宽度
      return this._fitRadius(bw, this._car3dStageH(bw) + this._car3dExt());
    }
    return 14;
  }

  /** 3D 画面要**多伸出**车区之下: 正好盖到动作行(四个圆钮)的底部 ——
   *  实测值 = 车区底边到 .p-actions 底边的距离(含两处 flex 间距)。 */
  private _car3dExt(): number {
    if((this._palOpen==='hex'||this._wrapOpen)&&this._paintStageExt!=null)return this._paintStageExt;
    const stage = this._heroStageEl;
    const act = this._panels.actions;
    if (!stage || !act) return 0;
    const sb = stage.getBoundingClientRect().bottom;
    const ab = act.getBoundingClientRect().bottom;
    return Math.max(0, Math.round(ab - sb));
  }

  /** 舞台尺寸与取景同步: 3D 时给舞台定高(见 _car3dStageH)并补发 {t:"view"};
   *  退回 2D 时把舞台恢复成"数据在上、车模在下"的普通流式布局。 */
  private _syncStage() {
    const stage = this._heroStageEl;
    const view = this._carViewEl;
    if (!stage || !view) return;
    if (!this._car3dBox) {
      if (stage.classList.contains("stage3d")) {
        stage.classList.remove("stage3d");
        stage.style.height = "";
      }
      return;
    }
    if (!stage.classList.contains("stage3d")) stage.classList.add("stage3d");
    const ink = ["night", "aurora", "blueprint"].includes(car3dBackgroundNow(this)) ? "#f3f6fb" : "#1f2937";
    if (stage.style.getPropertyValue("--c3-ink") !== ink) stage.style.setProperty("--c3-ink", ink);
    const bw = view.clientWidth || (this._cardEl ? Math.max(this._cardEl.clientWidth - 28, 0) : 0);
    let h = this._car3dStageH(bw);
    // 数据层比舞台还高(窄卡 + 长状态文案) → 让舞台跟着长, 免得文字溢出到动作行上;
    // 盒子变高只会让车更大、不影响它在画面里占的宽度比例(radius 按实际比例算)。
    const hero = this._panels.hero;
    if (hero) {
      const need = hero.scrollHeight + 10;
      if (need > h) h = need;
      // 数据层(车名/状态/续航/电量条/胶囊)的高度: 3D 下两块浮层(告警/充电)与胎压读数的
      // "前带"都从它下沿往下排(见 css.ts 的 --c3data)—— 直接贴舞台顶角会压住那些胶囊。
      const dataPx = hero.offsetHeight + "px";
      if (stage.style.getPropertyValue("--c3data") !== dataPx) stage.style.setProperty("--c3data", dataPx);
    }
    if(this._open.tires){
      const layout=tireLayout(this);
      if(layout){
        const bottomInset=Math.max(20,stage.offsetHeight-layout.tireBottom);
        h=Math.max(h,Math.ceil(layout.tireTop+layout.tireHeight*2+40+bottomInset));
      }
    }
    const px = h + "px";
    if (stage.style.height !== px) stage.style.height = px;
    // 画布要伸到四个圆钮之下(渐变也只铺在那一段): --c3ext 由按钮/胎压两行的实际高度决定
    const ext = this._car3dExt();
    const extPx = ext + "px";
    if (stage.style.getPropertyValue("--c3ext") !== extPx) stage.style.setProperty("--c3ext", extPx);
    // 顶部渐隐**只垫在标题那两行上**: 终点取"续航行(.heroMain)的上沿" —— 于是
    // 续航/电量这些数字压在**天空**上(与 App 一样), 再往下到车顶更是干净的;
    // 量不到续航行时退回"数据区高度的一半"。
    const main = hero ? (hero.querySelector(".heroMain") as HTMLElement | null) : null;
    const topLen = main && main.offsetTop > 0
      ? main.offsetTop + 4
      : Math.round((hero ? hero.offsetHeight : 120) * 0.5);
    const topPx = Math.max(topLen, 36) + "px";
    if (stage.style.getPropertyValue("--c3top") !== topPx) stage.style.setProperty("--c3top", topPx);
    if (!this._car3dFrame) return;
    const r = this._car3dRadius();
    if (this._car3dRadiusSent == null || Math.abs(this._car3dRadiusSent - r) > 0.05) {
      this._car3dRadiusSent = r;
      this._postCar3d({ t: "view", radius: r, drop: CAR3D_DROP_PCT }); // 尺寸变了 → 只改取景, 不重载
    }
    // 胎压视角的安全边界跟着实际按钮位置变化, 卡片缩放时同步给 iframe。
    this._syncCar3dPose();
  }

  private _renderCarView() {
    const el = this._carViewEl;
    if (!el) return;
    const on = car3dView(this) && this._heroLive;
    if (!on) {
      if (this._car3dBox) {
        // 退出 3D(换成自定义图/素材失效/列表页): 连 iframe 一起拆; 下次再进来重建 = 重新加载, 是有意的
        this._car3dBox = false;
        this._car3dFrame = null;
        this._car3dReloading = false;
        this._car3dSrc = "";
        this._car3dPaintSent = null;
        this._car3dDock = null;
        this._car3dNightSent = null;
        el.className = "p-carview";
        el.innerHTML = "";
      }
      el.style.display = "none";
      this._syncStage(); // 舞台恢复普通两段式布局
      return;
    }
    if (!this._car3dBox) {
      this._car3dBox = true;
      el.className = "p-carview carModel"; // 尺寸/圆角/裁剪沿用外观图那套盒子样式
      el.innerHTML = '<div class="car3dLoading" role="status" aria-live="polite"><span>正在载入车模</span><i aria-hidden="true"><b></b><b></b><b></b></i></div><div class="carDock"></div>';
      this._car3dDock = el.querySelector(".carDock") as HTMLElement | null;
      this._car3dFrame = null;
      this._car3dSrc = "";
      this._car3dPaintSent = null;
      this._car3dNightSent = null;
      this._car3dRadiusSent = null;
    }
    el.style.display = "";
    this._syncStage(); // 先把舞台的类/高度落定: URL 里的 radius 要按这块盒子的实际尺寸算
    const u = this._car3dUrl();
    if (!this._car3dFrame) {
      // 只在 info.ready 之后建(调用方已保证); 挂进容器后**不再挪动**
      const f = document.createElement("iframe");
      f.className = "car3dFrame";
      f.setAttribute("title", "3D 车模");
      f.setAttribute("loading", "eager");
      f.setAttribute("allow", "fullscreen");
      f.setAttribute("src", u.url);
      el.classList.add("loading3d");
      el.dataset.loadLabel = "正在载入车模…";
      el.insertBefore(f, el.firstChild);
      this._car3dFrame = f;
      this._car3dSrc = u.key;
      this._car3dPaintSent = null;
      this._car3dRadiusSent = u.radius; // URL 里已经带了, 不必再发一次 view
      this._car3dSyncTries = 0;
      this._syncCar3dSoon();
    } else if (u.key !== this._car3dSrc) {
      this._car3dSrc = u.key; // 车型/素材参数变化才重载，换色只更新材质。
      this._car3dPaintSent = null;
      this._car3dFrame.setAttribute("src", u.url);
      el.classList.add("loading3d");
      el.dataset.loadLabel = "正在载入车模…";
      this._car3dNightSent = null;
      this._car3dRadiusSent = u.radius;
      this._car3dSyncTries = 0;
      this._syncCar3dSoon();
    } else {
      // 主题从浅切深/深切浅: 只发消息, **不重载**(重载会重新加载模型)
      const background = car3dBackgroundNow(this);
      if (this._car3dBackgroundSent !== background) {
        this._postCar3d({ t: "background", name: background });
        this._car3dBackgroundSent = background;
        this._car3dSyncTries = 0; // 用户刚切的这一次: 允许重新累计重试次数
      }
    }
    this._syncCar3dPose();
    this._syncCar3dPaint();
    // 浮动层(告警/充电/胎压)走 Lit 模板 —— 与 2D hero 的车模盒**同一份**(carDocksPanel);
    // ⚠️ 只换 .carDock 的内容: iframe 与 .p-carview 本身一行都没动(见上面的说明)。
    if (this._car3dDock) render(carDocksPanel(this, true), this._car3dDock);
    this._syncStage(); // 量得到真实尺寸了: 尺寸变了就补一条 view(见函数注释)
  }

  /** iframe 的 URL, 以及**重载键**(key)。
   *
   *  始终用实车色号初始化素材，以便恢复原始车漆。
   *  预设色、自定义色、背景与取景都通过消息更新，不参与重载键。 */
  private _car3dUrl(): { url: string; key: string; radius: number } {
    const info = this._car3d;
    const p = (info && info.model_param) || {};
    const base = String((info && info.base_url) || "/leapmotor-card/car3d/view.html");
    const q: string[] = [];
    q.push("v=" + String(info?.asset_version || 8));
    const car = String(p.carType || (info && info.car_type) || "");
    if (car) q.push("car=" + encodeURIComponent(car));
    if (p.year != null && p.year !== "") q.push("year=" + encodeURIComponent(String(p.year)));
    if (p.carTypeCode) q.push("trim=" + encodeURIComponent(String(p.carTypeCode))); // 版型名是中文
    const tsp = car3dAutoTsp(this);
    if (tsp) q.push("color=" + encodeURIComponent(tsp));
    if (p.seat != null && p.seat !== "") q.push("seat=" + encodeURIComponent(String(p.seat)));
    if (Array.isArray(info?.preload) && info.preload.length) {
      q.push("preload=" + encodeURIComponent(JSON.stringify(info.preload)));
    }
    for (const [key, value] of [["roof", p.roofColor], ["sdk", p.sdkVersion], ["theme", p.theme], ["alias", p.alias]]) {
      if (value != null && value !== "") q.push(key + "=" + encodeURIComponent(String(value)));
    }
    const key = base + "?" + q.join("&");
    const radius = this._car3dRadius();
    return {
      key: key,
      radius: radius,
      // bg / radius 都只影响"初始状态", 不进 key: 它们变了走消息(daynight / view), 不重载。
      // bg=night 还有一个用处: 包装页会先把画布藏住等夜空就绪, 于是夜里打开不会先闪一下白天。
      url: key + "&bg=" + car3dBackgroundNow(this)
        + "&radius=" + radius + "&drop=" + CAR3D_DROP_PCT,
    };
  }

  /** 标题栏刷新钮只重载 3D 查看器, 不会触发车况接口或资源下载。 */
  public _onCar3dRefresh(): void {
    const frame = this._car3dFrame;
    if (!frame || this._car3dReloading) return;
    const url = this._car3dUrl();
    this._car3dReloading = true;
    this._car3dSrc = url.key; // 保持稳定重载键, 后续普通状态重绘不会重复刷新
    this._car3dPaintSent = null;
    this._car3dNightSent = null;
    this._car3dRadiusSent = url.radius;
    this._car3dSyncTries = 0;
    if (this._carViewEl) {
      this._carViewEl.classList.add("loading3d");
      this._carViewEl.dataset.loadLabel = "正在刷新车模…";
    }
    frame.setAttribute("src", url.url + "&refresh=" + Date.now());
    this._scheduleRender();
  }

  /** 给包装页发一条消息(窗口还没建好/已销毁就安静跳过 —— 那说明这一帧用不上)。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _postCar3d(msg: Record<string, string | number>): void {
    const f = this._car3dFrame;
    if (!f) return;
    try {
      const w = f.contentWindow;
      if (w) w.postMessage(msg, new URL(f.src, location.href).origin);
    } catch (err) { /* 忽略: 下一步还会再同步 */ }
  }

  /** 整车就绪(或兜底超时)之后同步一次背景 + 车漆。
   *  包装页按 bg= 自己设过一次, 这里再发一遍是双保险; 查看器是**按需渲染**的, 早于材质
   *  就绪的消息会石沉大海, 所以 full 与 1.5s 兜底两条路都要走一遍。 */
  private _syncCar3d() {
    if (!this._car3dFrame) return;
    this._previewWrap(this._wrapOpen?this._wrapPreview:this._wrapData,true);
    const background = car3dBackgroundNow(this);
    this._postCar3d({ t: "background", name: background });
    this._car3dBackgroundSent = background;
    this._syncCar3dPose(true);
    this._syncCar3dPaint(true);
    // 取景也再报一次: 查看器整车加载完会自己重取一次景, 我们按盒子比例算的值要盖回去
    const r = this._car3dRadius();
    this._car3dRadiusSent = r;
    this._postCar3d({ t: "view", radius: r, drop: CAR3D_DROP_PCT });
  }

  private _syncCar3dPaint(force = false) {
    if (!this._car3dFrame) return;
    const hex = car3dHexNow(this);
    if (!force && hex === this._car3dPaintSent) return;
    this._car3dPaintSent = hex;
    this._postCar3d({ t: "paint", hex });
  }

  private _syncCar3dPose(force = false) {
    if (!this._car3dFrame) return;
    const pose = vehiclePose(this);
    const key = JSON.stringify(pose);
    if (!force && key === this._car3dPoseSent) return;
    this._car3dPoseSent = key;
    this._postCar3d(pose);
  }

  /** 兜底/重试都用它: 延迟一会儿再同步一次(默认 1.5s; ack 说"还没就绪"时用短一些的间隔)。 */
  private _syncCar3dSoon(delay?: number) {
    if (this._car3dSyncTimer) clearTimeout(this._car3dSyncTimer);
    this._car3dSyncTimer = setTimeout(() => {
      this._car3dSyncTimer = null;
      this._syncCar3d();
    }, delay == null ? CAR3D_SYNC_MS : delay);
  }

  /** 包装页回消息(只认自己那个 iframe 的窗口)。 */
  private _onCar3dMsg = (ev: MessageEvent) => {
    const f = this._car3dFrame;
    if (!f || ev.source !== f.contentWindow) return;
    const d = ev.data as { t?: string; msg?: string; of?: string; ok?: boolean; points?:string; opacity?:number; available?:boolean } | null;
    if (!d || typeof d !== "object" || typeof d.t !== "string") return;
    if(d.t==='tires'){
      const pads=this._carViewEl?.querySelector<HTMLElement>('.tirePads');
      if(!pads||!this._open.tires)return;
      if(d.available===false){pads.removeAttribute('data-projected');return;}
      try{
        const points=JSON.parse(d.points||'null');
        const keys=['tire_fl','tire_fr','tire_rl','tire_rr'];
        if(!Array.isArray(points)||points.length!==4||new Set(points.map(p=>p?.key)).size!==4||
          !points.every(p=>p&&keys.includes(p.key)&&Number.isFinite(p.x)&&Number.isFinite(p.y)))return;
        for(const p of points){
          const el=pads.querySelector<HTMLElement>('[data-tire="'+p.key+'"]');
          el?.style.setProperty('--tire-x',p.x+'%');el?.style.setProperty('--tire-y',p.y+'%');
        }
        pads.style.setProperty('--tire-opacity',String(Number.isFinite(d.opacity)?clamp(d.opacity!,0,1):1));
        pads.setAttribute('data-projected','');
      }catch{}return;
    }
    if(d.t==='ack'&&d.of==='wrap'&&d.ok===false){this._showToast('当前车模未能应用车衣，请检查图片或材质支持','error');return;}
    if (d.t === "ready") {
      this._carViewEl?.classList.remove("loading3d");
      this._car3dReloading = false;
      this._scheduleRender();
    } else if (d.t === "full") {
      this._car3dReloading = false;
      if (this._car3dViewErr) this._car3dViewErr = "";
      this._car3dSyncTries = 0;
      this._syncCar3d();
    } else if (d.t === "err") {
      this._car3dReloading = false;
      this._car3dViewErr = String(d.msg || "查看器加载失败").slice(0, 120);
      if (this._carViewEl) this._carViewEl.dataset.loadLabel = "车模暂不可用 · 请查看设置";
      this._scheduleRender();
    } else if (d.t === "ack" && d.of === "background" && d.ok === false) {
      // 天空材质还没建起来(模型还在加载) → 稍后再发, 别让"切了没反应"拖到整车就绪
      this._car3dNightSent = null;
      if (this._car3dSyncTries < 8) {
        this._car3dSyncTries += 1;
        this._syncCar3dSoon(400);
      }
    }
  };

  /** 3D 车模现状: 纯本地读盘(不联网)。每辆车(field 里记着是替哪辆问的)只问一次;
   *  失败 30s 后才再试 —— 否则老 HA/权限不足时会每来一次状态推送就打一枪。 */
  private _loadCar3dInfo() {
    const hass = this._hass;
    if (!hass || !hass.callWS || this._car3dLoading) return;
    const dev = this._device || this._picked || "";
    if (this._car3dDev === dev || Date.now() < this._car3dRetryAt) return;
    if (this._car3dDev !== dev) this._car3d = null; // 换了辆车: 旧车的现状作废
    this._car3dDev = dev;
    this._car3dLoading = true;
    hass.callWS<Car3dInfo>({ type: CAR3D_INFO_WS }).then((info) => {
      this._car3dLoading = false;
      this._car3d = info && typeof info === "object" ? info : null;
      if (this._car3d && this._car3d.ready === true) this._car3dErr = "";
      this._scheduleRender();
    }).catch(() => {
      this._car3dLoading = false;
      this._car3dDev = null; // 允许以后再试(节流见上)
      this._car3dRetryAt = Date.now() + 30000;
    });
  }

  /** 用户进入 2D 配置时按需读取公开商城目录, 不下载 3D 素材包。 */
  public _loadCar2dPictures(force = false) {
    const hass = this._hass;
    const device = this._device || this._picked || "";
    const loadKey = device || "market-catalog";
    if (!hass?.callWS || this._marketCatalogLoading || this._marketPicturesLoading) return;
    if (!force && this._marketPicturesAskedDevice === loadKey) return;
    const prefsKey = this._car3dPrefsStoreKey();
    this._marketPicturesAskedDevice = loadKey;
    this._marketCatalogLoading = true;
    this._marketPicturesLoading = true;
    this._marketPicturesError = "";
    this._marketModels = [];
    this._marketVariants = [];
    this._marketActual = null;
    this._marketSelectionReq += 1;
    this._scheduleRender();
    const catalogRequest = hass.callWS<{ models?: Car3dMarketModel[]; reason?: string }>(
      { type: CAR3D_MARKET_CATALOG_WS });
    const actualRequest: Promise<{
      pictures?: Car3dMarketPicture[];
      actual_color?: string;
      model?: string;
      year?: string | number;
      energy?: string;
      edition?: string;
      model_id?: string;
      error?: string;
    }> = device ? hass.callWS({ type: CAR3D_MARKET_PICTURES_WS, device_id: device }) : Promise.resolve({});
    Promise.allSettled([catalogRequest, actualRequest]).then(([catalogReply, actualReply]) => {
      if (this._car3dPrefsStoreKey() !== prefsKey) return;
      this._marketCatalogLoading = false;
      const catalog = catalogReply.status === "fulfilled" ? catalogReply.value : null;
      this._marketModels = Array.isArray(catalog?.models)
        ? catalog.models.filter((item) => item && typeof item.name === "string" && item.name.trim())
        : [];
      const actual = actualReply.status === "fulfilled" ? actualReply.value : null;
      this._marketActual = actual ? {
        model: String(actual.model || ""), year: String(actual.year || ""),
        energy: String(actual.energy || ""), edition: String(actual.edition || ""),
        model_id: String(actual.model_id || ""), color: String(actual.actual_color || ""),
      } : null;
      this._marketPictures = this._safeMarketPictures(actual?.pictures);
      this._marketPicturesLoading = false;

      if (!this._marketModels.length) {
        this._marketPicturesError = String(catalog?.reason || "商城车型目录暂时无法读取");
        if (!this._marketPictures.length && actual?.error) this._marketPicturesError = String(actual.error);
        this._render();
        return;
      }
      const wantedModel = this._car3dPrefs.market2dModel || this._marketActual?.model || this._car3d?.model_param?.carType || "";
      const model = this._marketModels.find((item) => item.name.toLocaleLowerCase() === wantedModel.toLocaleLowerCase())
        || this._marketModels[0];
      this._marketSelectedModel = model.name;
      this._render();
      this._loadCar2dVariants(model.name);
    }).catch((err: unknown) => {
      if (this._car3dPrefsStoreKey() !== prefsKey) return;
      this._marketCatalogLoading = false;
      this._marketPicturesLoading = false;
      this._marketPicturesError = String(err instanceof Error ? err.message : "商城车型暂时无法读取");
      this._render();
    });
  }

  private _safeMarketPictures(value: unknown): Car3dMarketPicture[] {
    return Array.isArray(value)
      ? value.flatMap((item) => {
          const row = item as Car3dMarketPicture | null;
          const url = row && safeMarketPictureUrl(row.url);
          return row && typeof row.color === "string" && url ? [{ color: row.color, url }] : [];
        })
      : [];
  }

  private _loadCar2dVariants(model: string) {
    const hass = this._hass;
    if (!hass?.callWS || !model) return;
    const request = ++this._marketSelectionReq;
    const prefsKey = this._car3dPrefsStoreKey();
    this._marketSelectedModel = model;
    this._marketSelectedYear = "";
    this._marketVariants = [];
    this._marketSelectedVariant = "";
    this._marketVariantsLoading = true;
    this._marketPicturesLoading = true;
    this._marketPicturesError = "";
    this._render();
    hass.callWS<{ variants?: Car3dMarketVariant[]; reason?: string }>(
      { type: CAR3D_MARKET_VARIANTS_WS, model }).then((result) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketVariantsLoading = false;
      this._marketVariants = Array.isArray(result?.variants)
        ? result.variants.filter((item) => item && item.id && Number(item.year) >= MIN_MARKET_YEAR && item.energy && item.edition)
        : [];
      const savedModel = this._car3dPrefs.market2dModel === model;
      const savedYear = savedModel && Number(this._car3dPrefs.market2dYear) >= MIN_MARKET_YEAR
        ? String(this._car3dPrefs.market2dYear) : "";
      const saved = savedModel
        ? this._marketVariants.find((item) => item.id === this._car3dPrefs.market2dModelId)
          || this._marketVariants.find((item) => item.year === savedYear
            && item.energy === this._car3dPrefs.market2dEnergy && item.edition === this._car3dPrefs.market2dEdition)
          || this._marketVariants.find((item) => item.year === savedYear)
        : undefined;
      const actual = this._marketActual?.model.toLocaleLowerCase() === model.toLocaleLowerCase()
        ? this._marketVariants.find((item) => item.year === this._marketActual?.year
          && item.energy === this._marketActual?.energy && item.edition === this._marketActual?.edition)
        : undefined;
      const variant = saved || (savedYear ? undefined : actual || this._marketVariants[0]);
      if (!variant) {
        const actualModel = this._marketActual?.model.toLocaleLowerCase() === model.toLocaleLowerCase();
        const unavailableYear = savedYear
          || (actualModel ? String(this._marketActual?.year || "") : "")
          || this._marketVariants[0]?.year
          || String(new Date().getFullYear());
        this._loadCar2dYearVariants(unavailableYear);
        return;
      }
      this._marketSelectedYear = variant.year;
      this._marketSelectedVariant = variant.id;
      this._render();
      this._loadCar2dVariantPictures(variant);
    }).catch((err: unknown) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketVariantsLoading = false;
      this._marketPicturesLoading = false;
      this._marketPicturesError = String(err instanceof Error ? err.message : "车型配置暂时无法读取");
      this._render();
    });
  }

  public _selectCar2dModel(model: string) {
    if (!model || model === this._marketSelectedModel || !this._marketModels.some((item) => item.name === model)) return;
    this._car3dPrefs.market2dModel = model;
    delete this._car3dPrefs.market2dModelId;
    delete this._car3dPrefs.market2dYear;
    delete this._car3dPrefs.market2dEnergy;
    delete this._car3dPrefs.market2dEdition;
    delete this._car3dPrefs.market2dColor;
    delete this._car3dPrefs.market2dUrl;
    this._saveCar3dPrefs();
    this._marketSelectedYear = "";
    this._loadCar2dVariants(model);
  }

  public _selectCar2dVariant(id: string) {
    const variant = this._marketVariants.find((item) => item.id === id && item.year === this._marketSelectedYear);
    if (variant) this._loadCar2dVariantPictures(variant);
  }

  public _selectCar2dYear(year: string) {
    const numericYear = Number(year);
    const latest = Math.max(new Date().getFullYear(), ...this._marketVariants.map((item) => Number(item.year) || 0));
    if (!Number.isInteger(numericYear) || numericYear < MIN_MARKET_YEAR || numericYear > latest
      || (year === this._marketSelectedYear && this._marketSelectedVariant)) return;
    this._marketSelectedYear = year;
    const variants = this._marketVariants.filter((item) => item.year === year);
    if (!variants.length) {
      this._loadCar2dYearVariants(year);
      return;
    }
    const saved = this._car3dPrefs.market2dModel === this._marketSelectedModel
      ? variants.find((item) => item.id === this._car3dPrefs.market2dModelId)
        || variants.find((item) => item.energy === this._car3dPrefs.market2dEnergy
          && item.edition === this._car3dPrefs.market2dEdition)
      : undefined;
    const actual = this._marketActual?.model.toLocaleLowerCase() === this._marketSelectedModel.toLocaleLowerCase()
      ? variants.find((item) => item.year === this._marketActual?.year
        && item.energy === this._marketActual?.energy && item.edition === this._marketActual?.edition)
      : undefined;
    this._loadCar2dVariantPictures(saved || actual || variants[0]);
  }

  private _loadCar2dYearVariants(year: string) {
    const hass = this._hass;
    const model = this._marketSelectedModel;
    if (!hass?.callWS || !model) {
      this._setCar2dYearUnavailable(year);
      return;
    }
    const request = ++this._marketSelectionReq;
    const prefsKey = this._car3dPrefsStoreKey();
    this._marketSelectedYear = year;
    this._marketSelectedVariant = "";
    this._marketVariantsLoading = true;
    this._marketPicturesLoading = true;
    this._marketPictures = [];
    this._marketPicturesError = "";
    this._render();
    hass.callWS<{ variants?: Car3dMarketVariant[]; reason?: string }>({
      type: CAR3D_MARKET_VARIANTS_WS,
      model,
      year,
    }).then((result) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketVariantsLoading = false;
      const discovered = Array.isArray(result?.variants)
        ? result.variants.filter((item) => item && item.id && item.year === year && item.energy && item.edition)
        : [];
      const merged = new Map(this._marketVariants.map((item) => [`${item.year}:${item.id}`, item]));
      discovered.forEach((item) => merged.set(`${item.year}:${item.id}`, item));
      this._marketVariants = [...merged.values()];
      const variants = this._marketVariants.filter((item) => item.year === year);
      if (!variants.length) {
        this._setCar2dYearUnavailable(year);
        return;
      }
      const saved = this._car3dPrefs.market2dModel === model
        ? variants.find((item) => item.id === this._car3dPrefs.market2dModelId)
          || variants.find((item) => item.energy === this._car3dPrefs.market2dEnergy
            && item.edition === this._car3dPrefs.market2dEdition)
        : undefined;
      const actual = this._marketActual?.model.toLocaleLowerCase() === model.toLocaleLowerCase()
        ? variants.find((item) => item.year === this._marketActual?.year
          && item.energy === this._marketActual?.energy && item.edition === this._marketActual?.edition)
        : undefined;
      this._loadCar2dVariantPictures(saved || actual || variants[0]);
    }).catch((err: unknown) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketVariantsLoading = false;
      this._marketPicturesLoading = false;
      this._marketPicturesError = String(err instanceof Error ? err.message : "年款配置暂时无法读取");
      this._render();
    });
  }

  private _setCar2dYearUnavailable(year: string) {
    this._marketSelectionReq += 1;
    this._marketSelectedYear = year;
    this._marketSelectedVariant = "";
    this._marketPictures = [];
    this._marketPicturesLoading = false;
    this._marketPicturesError = "该年款暂无商城配置";
    this._car3dPrefs.market2dModel = this._marketSelectedModel;
    this._car3dPrefs.market2dYear = year;
    delete this._car3dPrefs.market2dModelId;
    delete this._car3dPrefs.market2dEnergy;
    delete this._car3dPrefs.market2dEdition;
    delete this._car3dPrefs.market2dColor;
    delete this._car3dPrefs.market2dUrl;
    this._saveCar3dPrefs();
    this._render();
  }

  private _loadCar2dVariantPictures(variant: Car3dMarketVariant) {
    const hass = this._hass;
    const model = this._marketSelectedModel;
    if (!hass?.callWS || !model || !variant) return;
    const request = ++this._marketSelectionReq;
    const prefsKey = this._car3dPrefsStoreKey();
    const sameVariant = this._car3dPrefs.market2dModel === model
      && this._car3dPrefs.market2dModelId === variant.id;
    if (!sameVariant) {
      delete this._car3dPrefs.market2dColor;
      delete this._car3dPrefs.market2dUrl;
    }
    this._marketSelectedVariant = variant.id;
    this._marketSelectedYear = variant.year;
    this._marketPicturesLoading = true;
    this._marketPicturesError = "";
    this._car3dPrefs.market2dModel = model;
    this._car3dPrefs.market2dModelId = variant.id;
    this._car3dPrefs.market2dYear = variant.year;
    this._car3dPrefs.market2dEnergy = variant.energy;
    this._car3dPrefs.market2dEdition = variant.edition;
    this._saveCar3dPrefs();
    this._render();
    hass.callWS<{
      pictures?: Car3dMarketPicture[];
      actual_color?: string;
      error?: string;
    }>({
      type: CAR3D_MARKET_PICTURES_WS,
      ...((this._device || this._picked) ? { device_id: this._device || this._picked } : {}),
      model,
      year: variant.year,
      energy: variant.energy,
      edition: variant.edition,
      model_id: variant.id,
    }).then((result) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketPicturesLoading = false;
      const pictures = this._safeMarketPictures(result?.pictures);
      this._marketPictures = pictures;
      this._marketPicturesError = pictures.length ? "" : String(result?.error || "该配置没有商城颜色图片");
      const actualSame = this._marketActual?.model.toLocaleLowerCase() === model.toLocaleLowerCase()
        && this._marketActual?.year === variant.year && this._marketActual?.energy === variant.energy
        && this._marketActual?.edition === variant.edition;
      const preferred = this._car3dPrefs.market2dColor || (actualSame ? this._marketActual?.color : "");
      const picture = pictures.find((item) => item.color === preferred) || pictures[0];
      if (picture) {
        this._car3dPrefs.market2dColor = picture.color;
        this._car3dPrefs.market2dUrl = picture.url;
        this._saveCar3dPrefs();
      } else {
        delete this._car3dPrefs.market2dColor;
        delete this._car3dPrefs.market2dUrl;
      }
      this._render();
    }).catch((err: unknown) => {
      if (this._car3dPrefsStoreKey() !== prefsKey || request !== this._marketSelectionReq) return;
      this._marketPicturesLoading = false;
      this._marketPicturesError = String(err instanceof Error ? err.message : "商城颜色暂时无法读取");
      this._render();
    });
  }

  /** 「下载 3D 车模素材」: **唯一**会联网的入口, 只由用户点击触发。
   *  装配在后台跑, 这里拿到"downloading"就开始每 2 秒问一次 info。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _onCar3dDownload() {
    const hass = this._hass;
    if (!hass || !hass.callWS || this._car3dBusy) return;
    this._car3dBusy = true;
    this._car3dErr = "";
    this._car3dViewErr = "";
    this._render();
    hass.callWS<{ state?: string; started?: boolean; error?: string; info?: Car3dInfo }>(
      { type: CAR3D_ENSURE_WS })
      .then((res) => {
        if (res && res.info) {
          this._car3d = res.info;
          this._car3dDev = this._device || this._picked || "";
        }
        if (res && res.error) this._car3dErr = String(res.error).slice(0, 140);
        const st = String((res && res.state) || (res && res.info && res.info.state) || "");
        if (st === "downloading" || String((this._car3d && this._car3d.state) || "") === "downloading") {
          this._startCar3dPoll();
        } else {
          this._car3dBusy = false;
        }
        this._scheduleRender();
      })
      .catch((err: unknown) => {
        this._car3dBusy = false;
        this._car3dErr = String(err instanceof Error ? err.message : err || "请求失败").slice(0, 140);
        this._scheduleRender();
      });
  }

  /** ensure 之后每 2 秒问一次 info, 直到 state 不再是 downloading。
   *  卡片被摘出 DOM 就停(见 disconnectedCallback), 重新连回来后由 _renderCar3d 接着问。
   *  ⚠️ 用 _car3dPolling 而不是"定时器在不在"判重: 定时器在 callWS 往返期间是空的,
   *  这时任何一次重绘都可能再插进一条链, 变成两条链各问各的。 */
  private _startCar3dPoll() {
    if (this._car3dPolling || !this.isConnected) return;
    this._car3dPolling = true;
    this._car3dPollLeft = CAR3D_POLL_MAX;
    this._car3dPollStep();
  }

  private _car3dPollStep() {
    this._car3dPollTimer = setTimeout(() => {
      this._car3dPollTimer = null;
      if (!this.isConnected) return; // 卡片已从 DOM 移除 → 停(disconnectedCallback 已清过状态)
      const hass = this._hass;
      if (!hass || !hass.callWS) {
        this._car3dPolling = false;
        this._car3dBusy = false;
        return;
      }
      hass.callWS<Car3dInfo>({ type: CAR3D_INFO_WS }).then((info) => {
        this._car3d = info && typeof info === "object" ? info : null;
        this._car3dDev = this._device || this._picked || this._car3dDev;
        const st = String((info && info.state) || "");
        if (st === "error") {
          if (info && info.error) this._car3dErr = String(info.error).slice(0, 140);
        } else if (info && info.ready === true) {
          this._car3dErr = ""; // 后来装配好了: 之前的失败小字撤掉
        }
        if (st === "downloading" && this._car3dPollLeft > 0) {
          this._car3dPollLeft -= 1;
          this._car3dPollStep(); // 还在下载 → 接着问
        } else {
          this._car3dPolling = false; // ready / error / idle → 停, 按钮恢复可点
          this._car3dBusy = false;
        }
        this._scheduleRender();
      }).catch(() => {
        this._car3dPolling = false;
        this._car3dBusy = false;
      });
    }, CAR3D_POLL_MS);
  }

  // ── 本机覆盖(车模颜色/背景/自定义外观图; 键带设备 id, 与折叠/标题同一套写法) ──
  private _car3dPrefsStoreKey(): string {
    return "leapmotor-control.car3d." + (this._device || this._picked || "nodevice");
  }

  private _loadCar3dPrefs() {
    const key = this._car3dPrefsStoreKey();
    if (this._car3dPrefsLoaded && this._car3dPrefsKey === key) return;
    if (this._car3dPrefsKey !== key) {
      this._marketPictures = [];
      this._marketPicturesLoading = false;
      this._marketPicturesError = "";
      this._marketModels = [];
      this._marketVariants = [];
      this._marketSelectedModel = "";
      this._marketSelectedVariant = "";
      this._marketCatalogLoading = false;
      this._marketVariantsLoading = false;
      this._marketActual = null;
      this._marketPicturesAskedDevice = "";
      this._marketSelectionReq += 1;
    }
    this._car3dPrefsLoaded = true;
    this._car3dPrefsKey = key;
    this._car3dPrefs = {};
    let raw = "";
    try {
      raw = window.localStorage.getItem(key) || "";
    } catch (err) {
      raw = "";
    }
    if (!raw) return;
    try {
      const o = JSON.parse(raw) as Record<string, unknown>;
      if (!o || typeof o !== "object") return;
      if (typeof o.tsp === "string" && o.tsp) this._car3dPrefs.tsp = o.tsp;
      if (typeof o.hex === "string" && /^#[0-9a-fA-F]{6}$/.test(o.hex)) this._car3dPrefs.hex = o.hex;
      if (typeof o.bg === "string" && CAR3D_BACKGROUNDS.some(([key]) => key === o.bg)) this._car3dPrefs.bg = o.bg;
      if (o.location === "photo" || o.location === "map") this._car3dPrefs.location = o.location;
      if (typeof o.img === "string") this._car3dPrefs.img = o.img;
      if (o.modelView === "2d") this._car3dPrefs.modelView = "2d";
      const market2dScale = Number(o.market2dScale);
      if (Number.isFinite(market2dScale) && market2dScale >= 1 && market2dScale <= 2.5) {
        this._car3dPrefs.market2dScale = market2dScale;
      }
      if (typeof o.market2dColor === "string" && o.market2dColor.length <= 32) this._car3dPrefs.market2dColor = o.market2dColor;
      const marketUrl = safeMarketPictureUrl(o.market2dUrl);
      if (marketUrl) this._car3dPrefs.market2dUrl = marketUrl;
      if (typeof o.market2dModel === "string" && o.market2dModel.length <= 96) this._car3dPrefs.market2dModel = o.market2dModel;
      if (typeof o.market2dModelId === "string" && o.market2dModelId.length <= 96) this._car3dPrefs.market2dModelId = o.market2dModelId;
      if (typeof o.market2dYear === "string" && o.market2dYear.length <= 96) this._car3dPrefs.market2dYear = o.market2dYear;
      if (typeof o.market2dEnergy === "string" && o.market2dEnergy.length <= 96) this._car3dPrefs.market2dEnergy = o.market2dEnergy;
      if (typeof o.market2dEdition === "string" && o.market2dEdition.length <= 96) this._car3dPrefs.market2dEdition = o.market2dEdition;
    } catch (err) { /* 内容坏了就当没存过 */ }
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _saveCar3dPrefs() {
    const o: Record<string, string> = {};
    const p = this._car3dPrefs;
    if (p.tsp) o.tsp = String(p.tsp);
    if (p.hex) o.hex = String(p.hex);
    if (p.bg) o.bg = String(p.bg);
    if (p.location) o.location = p.location;
    if (p.img != null) o.img = String(p.img);
    if (p.modelView === "2d") o.modelView = "2d";
    if (Number.isFinite(p.market2dScale) && p.market2dScale! >= 1 && p.market2dScale! <= 2.5) {
      o.market2dScale = String(p.market2dScale);
    }
    if (p.market2dColor) o.market2dColor = String(p.market2dColor);
    const marketUrl = safeMarketPictureUrl(p.market2dUrl);
    if (marketUrl) o.market2dUrl = marketUrl;
    if (p.market2dModel) o.market2dModel = String(p.market2dModel);
    if (p.market2dModelId) o.market2dModelId = String(p.market2dModelId);
    if (p.market2dYear) o.market2dYear = String(p.market2dYear);
    if (p.market2dEnergy) o.market2dEnergy = String(p.market2dEnergy);
    if (p.market2dEdition) o.market2dEdition = String(p.market2dEdition);
    try {
      if (Object.keys(o).length) window.localStorage.setItem(this._car3dPrefsStoreKey(), JSON.stringify(o));
      else window.localStorage.removeItem(this._car3dPrefsStoreKey());
    } catch (err) { /* 存不了就算了 */ }
  }

  // ── 设置(与「充电」并排的入口卡; 原「车模设置」, 现含卡片配色; 正文在弹窗里) ──
  private _renderCar3d() {
    const el = this._panels.car3d;
    if (!el) return;
    // 显示门控跟随 show 白名单; 3D 状态暂不可读时仍可进入设置与配置高德 Key。
    // 正文那半(卡片配色/颜色/背景/外观图/取色器)由 _renderModal 铺进弹窗。
    // ⚠️ 那个"接着问进度"的自愈副作用留在渲染方法里(模板只负责画): 条件与迁移前一样。
    el.style.display = car3dVisible(this) ? "" : "none";
    if (this._vis("car3d") && this._car3d && String(this._car3d.state) === "downloading") {
      this._startCar3dPoll();
    }
    render(car3dPanel(this), el);
  }

  private _renderPhoto() {
    const el = this._photoEl;
    if (!el) return;
    if (!this._open.photo) {
      // 关掉: 只切 display + 提交空模板(**不清 innerHTML** —— 那会把 Lit 的根部件锚点
      // 抽掉, 下次再打开就报 insertBefore of null, 见 _renderFuel 的说明)。
      if (el.style.display !== "none") el.style.display = "none";
      render(emptyPanel(), el);
      return;
    }
    const src = this._photoSrc();
    // 图片地址没变就别重画(重画会让正在加载的 <img> 从头再来一遍)
    if (el.dataset.src === src && el.style.display !== "none") return;
    this._photoErr = false; // 换了地址 → 清掉上一次的"加载失败"
    el.dataset.src = src;
    el.style.display = "";
    render(photoPanel(this), el);
  }

  /** 图片加载失败(委托): 驻车照片覆盖层里的图挂掉 → 就地换成"加载失败"提示 */
  private _onImgError(ev: Event) {
    const t = ev.target as HTMLElement | null;
    if (!t || t.tagName !== "IMG" || !(t as HTMLElement).classList.contains("ovlImg")) return;
    const el = this._photoEl;
    const box = el && el.querySelector(".ovlBox");
    // ⚠️ 覆盖层现在由 Lit 渲染: 不能再 innerHTML 换内容(会抹掉 Lit 的锚点, 下一次渲染就崩)。
    //    改为置标记 + 重绘, 提示文字由 photoPanel 输出。
    this._photoErr = true;
    this._scheduleRender();
  }

  /** 二次确认(替代 window.confirm): 挂在卡片 shadow root 直下, 跟随当前界面风格。
   *  ⚠️ 不放 .card 里: 玻璃风格给 .card 加了 backdrop-filter, fixed 后代会被缩到卡内。
   *  拿不到 shadow root 时**返回 false**(宁可不做, 也不要在没有确认的情况下发包)。 */
  private _confirm(o: { title: string; message?: string; okText?: string; danger?: boolean }): Promise<boolean> {
    const root = this.shadowRoot;
    if (!root) return Promise.resolve(false);
    return openConfirm({ root: root, title: o.title, message: o.message, okText: o.okText, danger: o.danger });
  }

  /** 车门锁: 解锁与上锁都要二次确认(说清后果); 行驶中直接拒绝。
   *  确认期间车辆可能换车/起步 → 拿到确认后再校验一次, 不拿旧条件发包。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public async _onLock() {
    const id = this._entId("lock");
    if (!id || this._driving()) return;
    const unlock = (this._val("lock") || "unknown") === "locked";
    const ok = await this._confirm({
      title: unlock ? "确定要解锁车门吗?" : "确定要上锁车门吗?",
      message: unlock
        ? "解锁后车门不再上锁, 请确认车内没有遗留物品。"
        : "上锁后需要再次解锁才能进入车内。",
      okText: unlock ? "解锁" : "上锁",
      danger: unlock,
    });
    if (!ok) return;
    const nowId = this._entId("lock");
    if (!nowId || nowId !== id || this._driving()) return;
    this._call("lock", unlock ? "unlock" : "lock", { entity_id: nowId }, "lock");
  }

  /** 后备箱: 开/关都要二次确认(说清后果); 行驶中直接拒绝。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public async _onTrunk(id: string, on: boolean) {
    if (!id || this._driving()) return;
    const ok = await this._confirm({
      title: on ? "确定要关闭后备箱吗?" : "确定要打开后备箱吗?",
      message: on ? "" : "请先确认车尾周围没有行人或障碍物。",
      okText: on ? "关闭" : "打开",
      danger: !on,
    });
    if (!ok) return;
    if (this._driving()) return; // 确认期间起步了就不再发包
    this._call("switch", on ? "turn_off" : "turn_on", { entity_id: id }, "sw:" + id);
  }

  /** 车窗四档气泡: 开的时候在 document 上挂一个捕获阶段的点击监听, 点任何非气泡处就收起 */
  /** 空调预设气泡: 与车窗气泡同一套"点外部收起"的做法。 */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _showPreset(on: boolean) {
    if (this._open.preset === on) return;
    this._open.preset = on;
    if (on) {
      this._showWin(false); // 两个气泡互斥
      const self = this;
      this._presetOutside = function (ev: Event) {
        const path = ((ev as any).composedPath && (ev as any).composedPath()) || [];
        for (const n of path) {
          if (!n || !n.dataset) continue;
          if (n.dataset.act === "presetmenu" || n.dataset.act === "preset") return;
        }
        self._showPreset(false);
      };
      document.addEventListener("click", this._presetOutside, true);
    } else if (this._presetOutside) {
      document.removeEventListener("click", this._presetOutside, true);
      this._presetOutside = null;
    }
    this._render();
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _showWin(on: boolean) {
    if (this._open.window === on) return;
    if (on && this._open.preset) this._showPreset(false); // 两个气泡互斥
    this._open.window = on;
    if (on) {
      const self = this;
      this._winOutside = function (ev: Event) {
        const path = ((ev as any).composedPath && (ev as any).composedPath()) || [];
        for (const n of path) {
          if (!n || !n.dataset) continue;
          if (n.dataset.act === "window" || n.dataset.act === "winstep") return;
        }
        self._showWin(false);
      };
      document.addEventListener("click", this._winOutside, true);
    } else if (this._winOutside) {
      document.removeEventListener("click", this._winOutside, true);
      this._winOutside = null;
    }
    this._render();
  }

  /** 空调卡右下角的风扇: 开↔关(记住上一次开的模式) */
  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _onAcPower() {
    const id = this._entId("ac");
    if (!id) return;
    const st = this._ent("ac");
    const a = (st && st.attributes) || {};
    const modes = Array.isArray(a.hvac_modes) && a.hvac_modes.length
      ? a.hvac_modes : ["off", "cool", "heat", "fan_only"];
    const cur = this._val("ac") || "off";
    let next;
    if (cur && cur !== "off") next = "off";
    else {
      next = this._lastHvac && modes.indexOf(this._lastHvac) >= 0 ? this._lastHvac : "";
      if (!next) {
        for (const m of modes) {
          if (m !== "off") { next = m; break; }
        }
      }
      if (!next) return;
    }
    // 关空调 = 预设结束、待发温度作废(与 climate.py 的 _preset_memo"空调关闭即作废"同一口径;
    // 待发值要撤: 抖动窗口到点的 set_temperature 会把刚关掉的空调又打开)
    if (next === "off") {
      this._lastPreset = null;
      this._dropTempPending();
    }
    this._call("climate", "set_hvac_mode", { entity_id: id, hvac_mode: next }, "hvac");
  }

  /** 温度 ±: **连点合并** —— 点一次先把目标温度记进"本地待发值"并乐观重绘(± 不再被禁用),
   *  抖动窗口(TEMP_DEBOUNCE_MS)到期只把**最后一次**的值发出去。云端有风控: 窗口内只发一次,
   *  发完用户又点了就再起一个窗口(见 _flushTemp)。
   *  @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _onTemp(delta: number) {
    const st = this._ent("ac");
    if (!st) return;
    // 防线(界面已不给入口): 关着时 set_temperature 会被车端当成"开空调", 但实体状态
    // 仍是 off → 界面显示与实际相反。开着才允许调温。
    const cur = String(this._val("ac") || "");
    if (!cur || cur === "off" || cur === "unknown" || cur === "unavailable") return;
    const a = st.attributes || {};
    const stepAttr = Number(a.target_temp_step);
    const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;
    const lo = Number.isFinite(Number(a.min_temp)) ? Number(a.min_temp) : 16;
    const hi = Number.isFinite(Number(a.max_temp)) ? Number(a.max_temp) : 32;
    const now = Date.now();
    // 起点: 有没到期的待发值就接着它叠(连点), 否则从实体设定温度起(车端回报前它可能还是旧值)
    const pend = this._tempPending;
    let base: number;
    if (pend && now <= pend.until) {
      base = pend.temp;
    } else {
      this._tempPending = null;
      this._tempSent = null;
      base = Number(a.temperature);
      if (!Number.isFinite(base)) base = 24;
    }
    const dir = delta > 0 ? 1 : -1;
    const nt = clamp(Math.round((base + dir * step) * 10) / 10, lo, hi);
    if (Math.abs(nt - base) < 0.001) return; // 顶到上下限: 不重复发包
    // 手动调温 = 用户退出了预设 → 本机"刚点过的预设"记忆作废(判定见 templates.ts 的 climatePanel)
    this._lastPreset = null;
    this._tempPending = { temp: nt, until: now + TEMP_PENDING_MS };
    if (this._tempExpiryTimer) clearTimeout(this._tempExpiryTimer);
    const expiry = this._tempPending;
    this._tempExpiryTimer = setTimeout(() => {
      this._tempExpiryTimer = null;
      if (this._tempPending === expiry) {
        this._tempPending = null;
        this._tempSent = null;
        this._render();
      }
    }, TEMP_PENDING_MS);
    this._render(); // 乐观: 数字立刻跟上; ± 保持可用(所以这里不用 _busy["temp"])
    this._armTempFlush();
  }

  /** 起一个抖动窗口: 窗口内再点只会刷新待发值, 到点才发一次。 */
  private _armTempFlush() {
    if (this._tempTimer != null) clearTimeout(this._tempTimer);
    this._tempTimer = setTimeout(() => {
      this._tempTimer = null;
      this._flushTemp();
    }, TEMP_DEBOUNCE_MS);
  }

  /** 抖动窗口到期: 把**最新**的待发温度发出去。三种"不发"的情形:
   *  ①待发值已经交回实体(实体回报同值/超窗, 模板与这里都会释放) ②最近发出去的就是这个值
   *  ③上一发还在路上 → 重新起窗口等它回来(不丢最后一次点击, 也不连发刷云端)。 */
  private _flushTemp() {
    const p = this._tempPending;
    if (!p) return;
    if (Date.now() > p.until) {
      this._tempPending = null;
      this._tempSent = null;
      this._render();
      return;
    }
    if (this._tempSent != null && Math.abs(this._tempSent - p.temp) < 0.001) return;
    if (this._busy["tempSend"]) {
      this._armTempFlush();
      return;
    }
    const id = this._entId("ac");
    if (!id) return;
    this._tempSent = p.temp;
    // busy 键用 "tempSend"(不是 "temp"): ± 按钮读的是 _busy["temp"], 不该被在途请求禁用。
    // 失败(网络/云端)与旧实现一致: 提示 toast; 值由待发窗口顶住, 超窗后交回实体。
    void this._call("climate", "set_temperature", { entity_id: id, temperature: p.temp }, "tempSend")
      .then((ok) => {
        // 失败只回滚这次仍在显示的请求，不能擦掉用户在途期间新点的目标值。
        if (!ok && this._tempPending === p && this._tempSent === p.temp) {
          this._tempPending = null;
          this._tempSent = null;
          if (this._tempExpiryTimer) clearTimeout(this._tempExpiryTimer);
          this._tempExpiryTimer = null;
          this._render();
        }
      });
  }

  /** 放弃"待发温度"(关空调前调用): 抖动窗口到点时会把 set_temperature 补发出去,
   *  若不撤掉, 刚关掉的空调会被这条迟到的命令又打开。
   *  @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _dropTempPending() {
    if (this._tempTimer != null) {
      clearTimeout(this._tempTimer);
      this._tempTimer = null;
    }
    this._tempPending = null;
    this._tempSent = null;
    if (this._tempExpiryTimer != null) {
      clearTimeout(this._tempExpiryTimer);
      this._tempExpiryTimer = null;
    }
  }

  /** @internal 供 render-* / handlers 取用(对应 types.ts 的 ControlCtx); 运行时行为不变 */
  public _onSeat(key: string, delta: number) {
    if (!key) return;
    const id = this._entId(key);
    if (!id) return;
    const cur = this._num(key);
    const base = cur == null ? 0 : clamp(Math.round(cur), 0, 3);
    const next = clamp(base + delta, 0, 3);
    if (delta === 0) {
      this._call("number", "set_value", { entity_id: id, value: (base + 1) % 4 }, "seat:" + key);
      return;
    }
    if (next === base) return; // 到顶/到底就不发包
    this._call("number", "set_value", { entity_id: id, value: next }, "seat:" + key);
  }

  // ── 构建 ──
  private _build() {
    // ⚠️ HA 会在元素尚未连接时先调 setConfig()(校验配置), 那时 Lit 的 createRenderRoot()
    //    还没跑、this.shadowRoot 为 null —— 按需挂载, 免得 .innerHTML 抛错被当成「配置错误」。
    this._ensureShadow();
    this.shadowRoot!.innerHTML = `
      <style>
${CARD_CSS}      </style>
      <div class="card">
        <div class="hint"></div>
        <div class="heroStage">
          <div class="p-hero"></div>
          <div class="p-carview"></div>
          <div class="stageVeil"></div>
        </div>
        <div class="carTools"></div>
        <div class="paintDock" hidden></div>
        <div class="wrapDock" hidden></div>
        <div class="p-actions"></div>
        <div class="cardsRow">
          <div class="p-climate"></div>
          <div class="p-location"></div>
        </div>
        <div class="csRow">
          <div class="p-charging"></div>
          <div class="p-car3d"></div>
          <div class="p-comfort"></div>
          <div class="p-csdetail"></div>
        </div>
        <div class="p-seats"></div>
        <div class="p-fuel"></div>
        <div class="toast"></div>
        <div class="ovl"></div>
      </div>
        <div class="smask" data-act="smclose"></div>
        <div class="smodal" role="dialog" aria-modal="true">
          <div class="smhead"><span class="t"></span>
            <button class="smx" data-act="smclose" title="关闭"><ha-icon icon="mdi:close"></ha-icon></button>
          </div>
          <div class="smbody"></div>
        </div>`;

    this._hintEl = this.shadowRoot!.querySelector(".hint");
    this._toastEl = this.shadowRoot!.querySelector(".toast");
    this._photoEl = this.shadowRoot!.querySelector(".ovl");
    this._smaskEl = this.shadowRoot!.querySelector(".smask");
    this._smodalEl = this.shadowRoot!.querySelector(".smodal");
    this._smbodyEl = this.shadowRoot!.querySelector(".smodal .smbody");
    this._smtitleEl = this.shadowRoot!.querySelector(".smodal .smhead .t");
    // 3D 车模的独立容器: 默认藏起(没 3D 时它一直是空的)
    this._carViewEl = this.shadowRoot!.querySelector(".p-carview") as HTMLElement | null;
    if (this._carViewEl) this._carViewEl.style.display = "none";
    this._heroStageEl = this.shadowRoot!.querySelector(".heroStage") as HTMLElement | null;
    this._carToolsEl = this.shadowRoot!.querySelector(".carTools") as HTMLElement | null;
    this._panels = {};
    for (const p of PANELS) this._panels[p] = this.shadowRoot!.querySelector(".p-" + p) as HTMLElement;
    this._panels.seats.className = "p-seats cont";
    this._panels.climate.className = "p-climate";
    this._panels.location.className = "p-location";
    // 充电/座椅的展开正文不是嵌在各自的卡里, 而是放在这两张卡下面那个跨整行的容器里
    this._panels.csdetail.className = "p-csdetail csDetail";
    this._cardEl = this.shadowRoot!.querySelector(".card");
    this._cardEl!.style.position = "relative";
    this._bindNarrow();
    this.shadowRoot!.addEventListener("click", (ev) => onClick(this, ev));
    this.shadowRoot!.addEventListener("change", (ev) => onChange(this, ev));
    this.shadowRoot!.addEventListener("input", (ev) => onInput(this, ev));
    this.shadowRoot!.addEventListener("dblclick", (ev) => onTitleDblClick(this, ev));
    // 取色器(设置子卡): 拖动 SV 方块 = pointer 三件套(拖动期间指针被方块捕获, 事件仍会经过
    // shadow root); 方向键微调走 keydown; hex 输入框失焦提交走 focusout —— 全在同一处委托。
    this.shadowRoot!.addEventListener("pointerdown", (ev) => onPalPointer(this, ev as PointerEvent, "down"));
    this.shadowRoot!.addEventListener("pointermove", (ev) => onPalPointer(this, ev as PointerEvent, "move"));
    this.shadowRoot!.addEventListener("pointerup", (ev) => onPalPointer(this, ev as PointerEvent, "up"));
    this.shadowRoot!.addEventListener("pointercancel", (ev) => onPalPointer(this, ev as PointerEvent, "up"));
    this.shadowRoot!.addEventListener("keydown", (ev) => onPalKeyDown(this, ev as KeyboardEvent));
    this.shadowRoot!.addEventListener("focusout", (ev) => onPalFocusOut(this, ev as FocusEvent));
    // <img> 的 error **不冒泡**, 所以走捕获阶段委托: 免得每次重绘都往新建的图片节点上挂一个
    // 监听(挂了从不解绑, 节点靠 GC 收尾)。目前只服务驻车照片覆盖层。
    this.shadowRoot!.addEventListener("error", (ev) => this._onImgError(ev), true);
    // 外观(界面风格 + 本机主题色; 六张卡统一): 订阅变化 + 立即涂一次 —— 语义变量写在
    // **宿主元素**上, 继承进 shadow root, 卡内 CSS 只消费 --lm-*(见 lib/appearance.ts)。
    // onChange 里重绘一次: 设置子卡里那排色块圆 / 风格预设的选中态要跟着别的卡片、
    // 别的标签页、以及"预览未应用"的状态刷新。
    bindAppearance(this, { getDark: () => isDark(this._hass), onChange: () => this._scheduleRender() });
    this._appearanceDark = isDark(this._hass);
  }

  /** 3D 包装页的回执挂在 window 上(iframe 的 postMessage 到达这里), 连接期间才需要 */
  connectedCallback() {
    super.connectedCallback();
    window.addEventListener("message", this._onCar3dMsg);
    if (this._smodalEl?.classList.contains("on")) { this._watchModal(true); this._placeModal(); }
    // 重新连回 DOM 时补上外观订阅(_build 只跑一次, 断开时订户已删; bindAppearance 幂等)
    bindAppearance(this, { getDark: () => isDark(this._hass), onChange: () => this._scheduleRender() });
  }

  /** 从 DOM 里摘掉时收尾: 气泡那条 document 监听是全局的, 留着就泄漏了 */
  disconnectedCallback() {
    super.disconnectedCallback();
    window.removeEventListener("message", this._onCar3dMsg);
    this._watchModal(false);
    unbindAppearance(this); // 外观订阅同样只在"连接期间"需要
    // 素材下载的轮询也要停(卡片都从 DOM 里摘掉了, 没人看进度);
    // 下次连回来 _renderCar3d 看到 state 还是 downloading 会接着问。
    if (this._car3dPollTimer) {
      clearTimeout(this._car3dPollTimer);
      this._car3dPollTimer = null;
    }
    this._car3dPolling = false;
    if (this._car3dSyncTimer) {
      clearTimeout(this._car3dSyncTimer);
      this._car3dSyncTimer = null;
    }
    this._car3dBusy = false;
    if (this._winOutside) {
      document.removeEventListener("click", this._winOutside, true);
      this._winOutside = null;
    }
    if (this._presetOutside) {
      document.removeEventListener("click", this._presetOutside, true);
      this._presetOutside = null;
    }
    if (this._palOutside) {
      document.removeEventListener("click", this._palOutside, true);
      this._palOutside = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
    // 温度 ± 的抖动窗口也要停(卡片都摘了, 留着到点还会补发一条 set_temperature)
    if (this._tempTimer) {
      clearTimeout(this._tempTimer);
      this._tempTimer = null;
    }
    if (this._tempExpiryTimer) {
      clearTimeout(this._tempExpiryTimer);
      this._tempExpiryTimer = null;
    }
    if (this._clPendingTimer) {
      clearTimeout(this._clPendingTimer);
      this._clPendingTimer = null;
    }
    if (this._raf) {
      if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(this._raf);
      else clearTimeout(this._raf);
      this._raf = 0;
    }
  }

  /** 卡片宽度 < 420px 时: 两张小卡上下堆叠、圆钮缩小、车辆区变矮 */
  private _bindNarrow() {
    const card = this._cardEl;
    if (!card) return;
    const apply = () => {
      const w = card.clientWidth || 0;
      const narrow = w > 0 && w < 420;
      if (narrow !== this._narrow) {
        this._narrow = narrow;
        card.classList.toggle("narrow", narrow);
      }
      // 3D 舞台的高度/取景都跟着卡片宽度走(见 _car3dStageH / _car3dRadius)
      this._syncStage();
      // 「空调 / 位置」两张并排小卡单独用**更小**的阈值: HA 里常见列宽就是 300~420px,
      // 跟上面 420 一刀切会让它们**经常**上下堆叠, 所以只有真挤不下(每张不足 ~135px)才堆叠。
      const tiny = w > 0 && w < 280;
      if (tiny !== this._tiny) {
        this._tiny = tiny;
        card.classList.toggle("tiny", tiny);
      }
    };
    this._narrow = null;
    this._tiny = null;
    apply();
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(apply);
      this._ro.observe(card);
    }
  }
}

/* ── 注册(带 registry-swap 自愈守卫; 见 src/lib/register.ts) ── */
defineCard("leapmotor-control", LeapmotorControlCard as unknown as CustomElementConstructor);

registerCustomCard({
  type: "leapmotor-control",
  name: "零跑·车辆控制",
  description: "App 风格主界面: 续航/锁/车窗/空调/充电/座椅/燃油/胎压/行程/位置",
  preview: true,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});

banner("零跑·车辆控制", CARD_VERSION);
