/*
 * 零跑·车辆控制卡 —— 顶层类型、模块级常量与共享上下文接口。
 *
 * 原来都在 src/cards/control.ts 顶部; 这次拆分只是"搬家", 内容逐字未改。
 * ControlCtx 描述被 render-*.ts / handlers.ts 取用的卡片成员(其余仍是私有实现)。
 */
import type { HomeAssistant, HassEntity, LovelaceCardConfig } from "../../types/hass";
import { CARD_VERSIONS } from "../../lib/version";

export const CARD_VERSION = CARD_VERSIONS.control;

/* C10 本地浏览器 300/400px 验证：把车身移到信息区下方，车轮留在动作行上方。
 * 包装页按取景半径换算位移；正值下移，不是逐像素的屏幕偏移。其它车型尚待实车复核。 */
export const CAR3D_DROP_PCT = 20;

/* 区块顺序(show 配置按这个顺序渲染; 缺键的区块自动隐藏)
 * 注意: 这里没有 tires —— 胎压在 v3 并进了车模区, 但 show 里写 "tires" 仍然被接受(忽略即可)。
 * seats 也一样: v4 起后排并进 comfort 的座舱模型, show 里写 "seats" 仍然被接受。 */
export const PANELS = ["hero", "actions", "climate", "location", "charging", "comfort", "csdetail", "seats", "fuel", "car3d"];

/* show 的向后兼容: 老配置里的 climate 意思是"空调 + 前排座椅", 新版拆成了
 * climate(空调卡) 和 comfort(座椅与加热), 所以填 climate 时把 comfort 一起带上。 */
export const SHOW_EXTRA: Record<string, string> = { climate: "comfort", ac: "climate" };

/* 可折叠的"常用块"(顺序即页面顺序); key 会拼进 localStorage 的存储键。
 * 现在只剩「燃油」——「充电」「座椅与加热」早就改成弹窗入口, 1.9.39 起「设置」(car3d)
 * 也从"就地展开的折叠卡"改成与充电并排的**入口卡 + 弹窗**(见 _open.car3d / _renderModal),
 * 于是它不再进这张表: 折叠态里不再有 car3d 这个键, 老浏览器里存的 "car3d" 由 _loadFold 清掉。 */
export const SECTIONS = ["fuel"];

/* 已知键 → 中文实体名。注册表不可用(老 HA/权限)时的兜底匹配, 也用于文档/排查。 */
export const KEY_NAMES: Record<string, string> = {
  lock: "车门锁", ac: "空调",
  trunk: "后备箱", sunshade: "遮阳帘", steering_heat: "方向盘加热",
  mirror_heat: "后视镜加热", healthy_charge: "健康充电", charge_book: "预约充电",
  charge_limit: "充电上限",
  seat_heat_driver: "主驾座椅加热", seat_heat_copilot: "副驾座椅加热",
  seat_vent_driver: "主驾座椅通风", seat_vent_copilot: "副驾座椅通风",
  seat_heat_rear_left: "二排左座椅加热", seat_heat_rear_right: "二排右座椅加热",
  seat_vent_rear_left: "二排左座椅通风", seat_vent_rear_right: "二排右座椅通风",
  seat_heat_third_left: "三排左座椅加热", seat_heat_third_right: "三排右座椅加热",
  find: "寻车鸣笛", window_open: "车窗-全开", window_vent: "车窗-微开",
  window_half: "车窗-半开", window_close: "车窗-关",
  preheat_on: "电池预热-开", preheat_off: "电池预热-关", refresh_state: "刷新车况",
  battery: "电量", range: "续航", charging_state: "充电状态", vehicle_state: "车辆状态",
  state_updated: "状态更新时间", interior_temp: "车内温度",
  tire_fl: "胎压-左前", tire_fr: "胎压-右前", tire_rl: "胎压-左后", tire_rr: "胎压-右后",
  total_mileage: "总里程", mileage_7d: "近7天里程", energy_7d: "近7天能耗",
  hundred_km_ec: "百公里能耗", energy_rank: "能耗排名", delivery_days: "交付天数",
  fuel_level: "剩余燃油", fuel_range: "燃油续航", total_range: "油电总续航",
  fuel_consumption: "油耗", last_trip: "最近行程", trip_track: "行程轨迹",
  trip_stats: "行程统计", parking_url: "驻车照片地址", charge_config: "充电配置",
  last_result: "最近指令回执", session: "会话状态",
  charge_start: "预约充电-开始", charge_end: "预约充电-结束",
  tracker: "车辆位置", parking: "驻车照片", raw_cmd: "原始指令(cmdId)",
  car_picture: "车辆外观图",
};

/* 已知键 → entity_id 拼音后缀(HA 会把中文名转成拼音实体 id; 兜底的第二道猜测) */
export const KEY_SUFFIX: Record<string, string> = {
  lock: "che_men_suo", ac: "kong_tiao",
  trunk: "hou_bei_xiang", sunshade: "zhe_yang_lian",
  steering_heat: "fang_xiang_pan_jia_re", mirror_heat: "hou_shi_jing_jia_re",
  healthy_charge: "jian_kang_chong_dian", charge_book: "yu_yue_chong_dian",
  charge_limit: "chong_dian_shang_xian",
  seat_heat_driver: "zhu_jia_zuo_yi_jia_re", seat_heat_copilot: "fu_jia_zuo_yi_jia_re",
  seat_vent_driver: "zhu_jia_zuo_yi_tong_feng", seat_vent_copilot: "fu_jia_zuo_yi_tong_feng",
  seat_heat_rear_left: "er_pai_zuo_zuo_yi_jia_re", seat_heat_rear_right: "er_pai_you_zuo_yi_jia_re",
  seat_vent_rear_left: "er_pai_zuo_zuo_yi_tong_feng", seat_vent_rear_right: "er_pai_you_zuo_yi_tong_feng",
  seat_heat_third_left: "san_pai_zuo_zuo_yi_jia_re", seat_heat_third_right: "san_pai_you_zuo_yi_jia_re",
  find: "xun_che_ming_di", window_open: "che_chuang_quan_kai",
  window_vent: "che_chuang_wei_kai", window_half: "che_chuang_ban_kai",
  window_close: "che_chuang_guan",
  preheat_on: "dian_chi_yu_re_kai", preheat_off: "dian_chi_yu_re_guan",
  refresh_state: "shua_xin_che_kuang",
  battery: "dian_liang", range: "xu_hang", charging_state: "chong_dian_zhuang_tai",
  vehicle_state: "che_liang_zhuang_tai", state_updated: "zhuang_tai_geng_xin_shi_jian",
  interior_temp: "che_nei_wen_du",
  tire_fl: "tai_ya_zuo_qian", tire_fr: "tai_ya_you_qian",
  tire_rl: "tai_ya_zuo_hou", tire_rr: "tai_ya_you_hou",
  total_mileage: "zong_li_cheng", mileage_7d: "jin_7tian_li_cheng",
  energy_7d: "jin_7tian_neng_hao", hundred_km_ec: "bai_gong_li_neng_hao",
  energy_rank: "neng_hao_pai_ming", delivery_days: "jiao_fu_tian_shu",
  fuel_level: "sheng_yu_ran_you", fuel_range: "ran_you_xu_hang",
  total_range: "you_dian_zong_xu_hang", fuel_consumption: "you_hao",
  last_trip: "zui_jin_xing_cheng", trip_track: "xing_cheng_gui_ji",
  trip_stats: "xing_cheng_tong_ji", parking_url: "zhu_che_zhao_pian_di_zhi",
  charge_config: "chong_dian_pei_zhi", last_result: "zui_jin_zhi_ling_hui_zhi",
  session: "hui_hua_zhuang_tai",
  charge_start: "yu_yue_chong_dian_kai_shi", charge_end: "yu_yue_chong_dian_jie_shu",
  tracker: "che_liang_wei_zhi", parking: "zhu_che_zhao_pian",
  raw_cmd: "yuan_shi_zhi_ling_cmdid",
  car_picture: "che_liang_wai_guan_tu",
};

/* 键表按"名字/后缀从长到短"排序: 兜底猜测时先认长名, 免得 续航 抢走 燃油续航 的实体 */
export const KEYS_BY_LEN = Object.keys(KEY_NAMES).sort(function (a, b) {
  const la = KEY_NAMES[a].length + (KEY_SUFFIX[a] || "").length;
  const lb = KEY_NAMES[b].length + (KEY_SUFFIX[b] || "").length;
  return lb - la;
});

/* 空调模式的显示名(大号字和模式按钮共用中文; 认不出的原样显示) */
export const HVAC_LABEL: Record<string, string> = {
  off: "关", cool: "制冷", heat: "制热", auto: "自动",
  fan_only: "送风", dry: "除湿", heat_cool: "冷暖自动",
};

/* 充电状态枚举 → 中文 */
export const CHARGE_LABEL: Record<string, string> = { charging: "充电中", plugged: "已插枪", unplugged: "未插枪" };

/* 三种充电状态的颜色语义 + 悬停说明:
   charging = 绿(正常补能中) · plugged = 红(插着枪却没充电: 可能是预约/已充满/桩没供电, 提醒看一眼)
   · unplugged = 灰(中性)。见 _renderHero 的 .pill.chg/.plug 与充电块里的 .kvchip。 */
export const CHARGE_TIP: Record<string, string> = {
  charging: "正在充电",
  plugged: "已插枪但未在充电(可能是预约充电 / 已充满 / 充电桩未供电)",
  unplugged: "充电枪未插",
};

/* ── IconPark 图标(内联 SVG; 选自 IconPark, 48×48 描边风格) ─────────────
 * 颜色走 currentColor(跟随文字/主题色), 线宽统一 4/48 → 视觉与 ha-icon 一致。
 * 用 ipIcon(name, size) 取用; 未收录的语义继续用 ha-icon 的 mdi。 */

/* 座舱俯视位图底图: 5座/7座 × 浅色/深色 四张(www/carimg/cabinN_theme.jpg),
 * 由 _cabin() 按"HA 主题 + 是否 7 座"挑选。控件按下面的百分位坐标叠到各座位上。 */
/* 座舱俯视 **位图** 底图: 5座/7座 × 浅色/深色 四张(www/carimg/, 已裁掉多余留白),
 * 由 _cabin() 按"HA 主题 + 是否 7 座"挑图。每张自带 ar(宽高比) 与 pos(控件百分位坐标;
 * 坐标是**裁图后**重新换算的, 随裁剪而变化, 所以四张各存一份)。 */
export const CABIN_IMG: Record<string, Record<string, CabinThemeImg>> = {
  "5": {
    light: { src: "cabin5_light.jpg", ar: 0.6802, pos: { "steer": [25.0, 27.0], "seat-front-left": [30.0, 50.0], "seat-front-right": [70.0, 50.0], "seat-rear-1": [30.0, 82.0], "seat-rear-3": [70.0, 82.0] } },
    dark: { src: "cabin5_dark.jpg", ar: 0.6765, pos: { "steer": [19.6, 24.1], "seat-front-left": [25.7, 49.3], "seat-front-right": [74.0, 49.3], "seat-rear-1": [25.7, 84.3], "seat-rear-3": [74.0, 84.3] } },
  },
  "7": {
    light: { src: "cabin7_light.jpg", ar: 0.5345, pos: { "steer": [15.2, 20.3], "seat-front-left": [21.0, 36.9], "seat-front-right": [79.0, 36.9], "seat-rear-1": [21.0, 63.9], "seat-rear-3": [79.0, 63.9], "seat-third-left": [21.0, 88.8], "seat-third-right": [79.0, 88.8] } },
    dark: { src: "cabin7_dark.jpg", ar: 0.5135, pos: { "steer": [12.1, 19.1], "seat-front-left": [18.4, 36.4], "seat-front-right": [81.4, 36.4], "seat-rear-1": [18.4, 64.6], "seat-rear-3": [81.4, 64.6], "seat-third-left": [18.4, 90.6], "seat-third-right": [81.4, 90.6] } },
  },
};

export interface CabinThemeImg {
  src: string;
  ar: number;
  pos: Record<string, [number, number]>;
}

/* 座舱俯视模型里的座位: 每个座位最多两个功能(加热 / 通风), 各自 0~3 档。
 * row 决定放在第几排, pos 决定左右, label 是图标下面那行小字的名字;
 * 三排车型只有加热(vent 留空), 缺键的座位/整排都不渲染(纯电 C10 只有前排)。 */
export const CABIN_SEATS: CabinSeat[] = [
  { row: "front", pos: "left", label: "主驾", heat: "seat_heat_driver", vent: "seat_vent_driver" },
  { row: "front", pos: "right", label: "副驾", heat: "seat_heat_copilot", vent: "seat_vent_copilot" },
  { row: "rear", pos: "left", label: "二排左", heat: "seat_heat_rear_left", vent: "seat_vent_rear_left" },
  { row: "rear", pos: "right", label: "二排右", heat: "seat_heat_rear_right", vent: "seat_vent_rear_right" },
  { row: "third", pos: "left", label: "三排左", heat: "seat_heat_third_left", vent: "" },
  { row: "third", pos: "right", label: "三排右", heat: "seat_heat_third_right", vent: "" },
];

export interface CabinSeat {
  row: string;
  pos: string;
  label: string;
  heat: string;
  vent: string;
}

/* 车窗四档 */
export const WINDOW_STEPS: [string, string][] = [["window_open", "全开"], ["window_vent", "微开"], ["window_half", "半开"], ["window_close", "关"]];

/* 胎压(俯视: 左前/右前/左后/右后) */
export const TIRE_DEFS: [string, string][] = [["tire_fl", "左前"], ["tire_fr", "右前"], ["tire_rl", "左后"], ["tire_rr", "右后"]];

/* 低于它就在标题行给红色"胎压偏低"胶囊(固定阈值, 与 tire_range 无关; 正常不显示) */
export const LOW_TIRE_BAR = 2.0;

/* ── 车模图(按车型) ──
 * 所有车型优先使用按 VIN 获取的车辆外观图(image.car_picture); 加载失败时使用
 * 官方公开购车素材；不使用旧杂图或 SVG 回退。 */
export const CAR_IMG: Record<string, string> = {
  B10: "b10", C01: "c01", C10: "c10", C11: "c11", C16: "c16", T03: "t",
};

/* 其中这几张是**正俯视**(已转成车头朝左): 胎压标签要按"车左侧在下"重新排角 ——
 * 左前=左下 / 右前=左上 / 左后=右下 / 右后=右上(见 _tireCorners)。
 * 其余是 3/4 视角, 沿用旧的"左上=左前"四角排布。 */
export const CAR_IMG_TOP: Record<string, number> = { c10: 1, c01: 1, t: 1 };

/* 车模图与卡片同一目录(集成的 www/ 被整目录暴露: /leapmotor-card/ 或 /local/leapmotor-card/)。
   用**本模块自身的加载地址**推 base —— 这样卡片从哪个前缀加载, 车模图就走哪个前缀,
   不会出现"卡片从 /local 来、车模图还去 /leapmotor-card 拿"的错配。 */
export const CAR_IMG_BASE = new URL("carimg/", import.meta.url).href;

export const CAR_IMG_RETRY_MS = 5 * 60 * 1000; // 车辆外观图失败后的重试间隔

/* ── 3D 车模(可选) ──
 * 素材(查看器 + 本车模型, 约 15 MB)由集成按需装配到本机(见 custom_components/
 * leapmotor/car3d.py), 装好之后卡片把素材自带的包装页(www/car3d/view.html)挂进车模盒。
 * 卡片这边只有三件事: 读现状(纯本地读盘, 不联网)、按**用户点击**发起装配、把结果挂上去。
 * ⚠️ 只有 ensure 会联网(一次 3 个只读请求, 之后永久本地), 且必须由用户点按钮触发 ——
 * 云端有风控, 打开卡片就自动请求是要出事的。 */
export const CAR3D_INFO_WS = "leapmotor/car3d/info";

export const CAR3D_MARKET_PICTURES_WS = "leapmotor/car3d/market-pictures";
export const CAR3D_MARKET_CATALOG_WS = "leapmotor/car3d/market-catalog";
export const CAR3D_MARKET_VARIANTS_WS = "leapmotor/car3d/market-variants";

export const CAR3D_ENSURE_WS = "leapmotor/car3d/ensure";

export const CAR3D_POLL_MS = 2000; // ensure 后问进度的间隔(装配在后台跑, 只有 info 看得到状态)

export const CAR3D_POLL_MAX = 150; // 轮询上限(2s × 150 ≈ 5 分钟; 后台任务万一丢了不至于一直问)

export const CAR3D_SYNC_MS = 1500; // 整车就绪回调没来时的兜底: 到点自己同步一次背景/车漆
export const CAR3D_BACKGROUNDS: [string, string][] = [
  ["auto", "跟随主题"], ["day", "晴空"], ["night", "星夜"],
  ["studio", "极简展厅"], ["dusk", "落日暖光"], ["aurora", "极光"], ["blueprint", "蓝图"],
];

/* 实体注册表条目(只声明用到的字段) */
export interface RegistryEntity {
  entity_id?: string;
  platform?: string;
  device_id?: string;
  translation_key?: string;
  unique_id?: string;
  disabled_by?: string | null;
  original_name?: string | null;
  name?: string | null;
}

export interface RegistryDevice {
  id?: string;
  name?: string;
  name_by_user?: string | null;
  model?: string | null;
}

export interface Candidate {
  id: string;
  name: string;
  count: number;
}

export interface ChargeInfo {
  text: string;
  mode: "charging" | "plugged" | "unplugged";
}

export interface ClPending {
  id: string;
  value: number;
  until: number;
}

/* ── 空调温度 ± 的本地"待发值"(连点合并) ──
 * 点一次 ± 先记下目标温度并乐观重绘, 抖动窗口(TEMP_DEBOUNCE_MS)到期只发**最后一次**;
 * 实体回报同一个值或超过 until 就交回实体(与 ClPending 同一套释放口径)。 */
export const TEMP_DEBOUNCE_MS = 400; // 抖动窗口: 窗口内的连点合并成一次 climate.set_temperature

export const TEMP_PENDING_MS = 90000; // 待发值的释放窗口(与充电上限 _clPending 的 90s 一致)

export interface TempPending {
  temp: number;
  until: number;
}

/* ── 空调预设的"本机记忆" ──
 * 车端对极速降温/升温/快速除味**不回报状态**(集成侧 climate.py 也有同一套记忆兜底,
 * 这里再兜一层: 实体一旦报不出 preset_mode, 温度区仍能显示 LO/HI/模式名)。 */
export const PRESET_MEMO_MS = 30 * 60 * 1000; // 记忆窗口: 30 分钟(超时按"预设已结束"处理)

export interface PresetMemo {
  val: string;
  until: number;
}

/* ── 3D 车模的类型(WS `leapmotor/car3d/info` 的返回; 字段都可缺 —— 素材状态本来就是
 *    "有没有", 卡片对缺字段要能照常画) ── */
export interface Car3dColor {
  tsp: number | string;
  name: string;
  hex: string;
}

export interface Car3dModelParam {
  carType?: string;
  year?: number | string;
  carTypeCode?: string;
  colorCode?: number | string;
  seat?: number | string;
  roofColor?: number | string;
  sdkVersion?: string;
  theme?: string;
  alias?: string;
}

export interface Car3dInfo {
  asset_version?: number;
  preload?: string[];
  ready?: boolean;
  car_type?: string;
  year?: number | string;
  model_param?: Car3dModelParam;
  colors?: Car3dColor[];
  options?: {
    car3d_color?: string | null;
    car3d_bg?: string | null;
    car3d_image?: string | null;
  };
  base_url?: string;
  state?: string;
  error?: string;
}

export interface Car3dMarketPicture {
  color: string;
  url: string;
}

export interface Car3dMarketModel {
  name: string;
}

export interface Car3dMarketVariant {
  id: string;
  year: string;
  energy: string;
  edition: string;
}

/* 本机覆盖(存 localStorage, 键带设备 id)。缺字段 = 没设过 → 用集成选项/实车色;
 * img 的 "" 是**明确清掉**(此时集成选项里的默认图也不再顶上来)。 */
export interface Car3dPrefs {
  tsp?: string;
  hex?: string;
  bg?: string;
  img?: string | null;
  location?: "map" | "photo";
  /** 本机强制使用 2D 外观图；未设置时沿用原有的自动 / 3D 行为。 */
  modelView?: "2d";
  /** 2D 模式下选择的官方商城车色与整车渲染图。 */
  market2dColor?: string;
  market2dUrl?: string;
  /** 2D 外观图缩放倍数；缺省为 1.5。 */
  market2dScale?: number;
  market2dModel?: string;
  market2dModelId?: string;
  market2dYear?: string;
  market2dEnergy?: string;
  market2dEdition?: string;
}

/* 当前生效的车漆: tsp=色表色号 / hex=自定义色 / auto=实车色(素材建时定色) */
export interface Car3dColorEff {
  kind: "tsp" | "hex" | "auto";
  value: string;
}

/* 充电闪电的路径(100×100 的路径稿) */
export const BOLT_PATH = "M58 5L20 50H48L42 95L80 50H52L58 5Z";

/* ── 供 render-* / handlers 取用的卡片上下文(成员即类上同名成员, 已在类里改 public) ── */
export interface ControlCtx {
  _attr(key: string, name: string): any;
  _boltUid: number;
  _busy: Record<string, boolean>;
  _candidates: Candidate[];
  _call(domain: string, service: string, data: Record<string, any>, busyKey?: string): Promise<boolean>;
  _car3d: Car3dInfo | null;
  _marketPictures: Car3dMarketPicture[];
  _marketPicturesLoading: boolean;
  _marketPicturesError: string;
  _marketModels: Car3dMarketModel[];
  _marketVariants: Car3dMarketVariant[];
  _marketSelectedModel: string;
  _marketSelectedYear: string;
  _marketSelectedVariant: string;
  _marketCatalogLoading: boolean;
  _marketVariantsLoading: boolean;
  _car3dBusy: boolean;
  _car3dReloading: boolean;
  _car3dErr: string;
  _car3dImgDraft: string | null;
  _car3dNightSent: boolean | null;
  _car3dPrefs: Car3dPrefs;
  _car3dViewErr: string;
  _carImgApiFailedSrc: string;
  _carImgOk: string;
  _carImgRetryAt: number;
  _carImgSrc: string;
  _chgOpen: boolean;
  _clPreview: number | null;
  _clPending: ClPending | null;
  _clPendingTimer: ReturnType<typeof setTimeout> | null;
  _dropTempPending(): void;
  _collapsed: Record<string, boolean>;
  _config: LovelaceCardConfig | null;
  _devMsg: string;
  _device: string;
  _deviceName: string;
  _driving(): boolean;
  _editingTitle: boolean;
  _ent(key: string): HassEntity | null;
  _entId(key: string): string;
  _hass: HomeAssistant | null;
  _indexCount(): number;
  _isReev(): boolean;
  _lastHvac: string;
  /** 空调预设的"本机记忆": 用户最近点过的预设(实体不报 preset_mode 时, 温度区靠它显示) */
  _lastPreset: PresetMemo | null;
  _leftOpen(): { trunk: boolean; window: boolean; names: string[]; driving: boolean };
  _locBgOk: string;
  _locBgSrc: string;
  _lowTires(): { name: string; v: number }[];
  _mainRange(): number | null;
  _model: string;
  _num(key: string): number | null;
  _onAcPower(): void;
  _onCar3dDownload(): void;
  _loadCar2dPictures(force?: boolean): void;
  _selectCar2dModel(model: string): void;
  _selectCar2dYear(year: string): void;
  _selectCar2dVariant(id: string): void;
  _onCar3dRefresh(): void;
  _onLock(): void | Promise<void>;
  _onSeat(key: string, delta: number): void;
  _onTemp(delta: number): void;
  _onTrunk(id: string, on: boolean): void | Promise<void>;
  _open: { climate: boolean; window: boolean; preset: boolean; photo: boolean; tires: boolean; seats: boolean; charge: boolean; car3d: boolean; car2dSettings: boolean };
  /** 设置子卡里的取色器(彩虹圆点开): 开的是哪一颗(""=关 / accent / hex) + 面板当前 HSV */
  _palOpen: "" | "accent" | "hex";
  _palH: number;
  _palS: number;
  _palV: number;
  /** 取色器里 hex 输入框的草稿(打到一半的颜色在下一次状态推送后仍保留) */
  _palHexDraft: string | null;
  /** 取色器是否正在拖动 SV 方块 */
  _palDrag: boolean;
  /** 电池预热分段控件的"本机记忆"(车端不回报预热状态) */
  _preheatSel: string;
  /** 打开/收起设置子卡里的取色器面板(点外面也会关; key 为 "" 即关闭) */
  _showPal(key: "" | "accent" | "hex"): void;
  _finishPaint(apply:boolean):void;
  _photoErr: boolean;
  _photoSrc(): string;
  _picked: string;
  _postCar3d(msg: Record<string, string | number>): void;
  _ready(key: string): boolean;
  _registryState: "idle" | "loading" | "done" | "failed";
  _render(): void;
  _resolveIndex(): void;
  _saveCar3dPrefs(): void;
  _saveFold(): void;
  _scheduleRender(): void;
  _secOpen(name: string): boolean;
  _showWrap(on:boolean):void;
  _showPreset(on: boolean): void;
  _showWin(on: boolean): void;
  _startTitleEdit(): void;
  _tempPending: TempPending | null;
  _title(): string;
  _val(key: string): string | null;
  _vis(name: string): boolean;
  _warnOpen: boolean;
  /** 继承自 LitElement(只读); handlers 用它查面板 DOM */
  readonly shadowRoot: ShadowRoot | null;
}
