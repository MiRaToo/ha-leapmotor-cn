/*
 * 零跑·车辆控制 —— 仿零跑官方 App 观感的车辆控制卡(v2)。
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
 * 界面结构(照官方 App 的信息架构, 常用功能默认收起、少几层)
 * ----------------------------------------------------------------
 *   hero      车名 + 状态更新 / 标题行右侧「行驶中」「充电中」小 pill + 刷新车况
 *             + 超大续航 + 细电量条 + 锁状态胶囊
 *             + 增程车专有的「⚡纯电 / ⛽燃油」双胶囊
 *             + 车模示意图(点右下角小胶囊把四轮胎压叠上来)
 *   actions   四个圆形动作按钮: 解锁·上锁 / 后备箱 / 车窗(弹气泡选四档) / 遮阳帘
 *             (电池预热与刷新车况分别挪进充电块和右上角, 功能一个不少)
 *   climate   左半空调卡: 大字中文模式(或 关)+ 车内温度 + 风扇图标;
 *             展开是居中的温度步进 + 一排三个模式图标按钮
 *   location  右半位置卡: 区域名(不在区域就显示「外出」)+ 坐标 + 更新时间, 背景是驻车照片;
 *             底部「驻车照片」「鸣笛寻车」胶囊 + 一个 ⓘ
 *   charging  充电(上限滑条 / 预约开关 / 起止时间 / 健康充电 / 充电状态 / 电池预热)
 *   comfort   座椅与加热: 座舱俯视模型(方向盘/左右后视镜/前排/二排/三排, 档位用图标表示)
 *   seats     后排座椅 —— v4 起并进上面的座舱模型, 这里只留面板位(兼容 show 配置)
 *   fuel      燃油(增程车才有)
 *   trip      行程摘要
 * charging / comfort / fuel / trip 四个"常用块"标题行可点折叠, **默认全部收起**,
 * 折叠状态存 localStorage(key 带设备 id); 收起时标题行右侧给摘要。
 * 第一次打开(本地还没有记录)时全部收起; 之后尊重用户自己的展开/收起选择。
 *
 * v4 的结构变化
 * -------------
 *   * hero 里不再有「充电中心 ›」胶囊(和下面的充电块重复): 充电状态(未插枪/已插枪/
 *     充电中)挪到标题行, 和「行驶中」并列放在刷新按钮前面。
 *   * 空调模式从两行文字按钮改成「制冷 ❄ / 制热 🔥 / 送风 🌀」三个图标按钮(风扇图标
 *     本身就是开关, 所以没有「关」); 温度步进那一行居中。
 *   * 座椅与加热不再是一列加减按钮, 换成座舱俯视"模型": 方向盘在上中、左右后视镜在
 *     两角、前排左右、二排、三排。档位用图标状态表示(通风 = fan-speed-N 蓝,
 *     加热 = fan-speed-N 红, 关 = 各自的灰色图标), 点图标循环档位。
 *   * 散在卡片里的提示文字收进一个小 ⓘ 图标(title 里放原文, 悬停可见)。
 *   * 配色改成灰-白-灰三层: 外层大卡是灰(--secondary-background-color),
 *     里面的子块是白(--card-background-color), 白块里的按钮/胶囊再压一层浅灰。
 *
 * 视觉规范
 * --------
 * 间距只用 4/8/12/16, 圆角: 大卡 18 / 子块 14 / 胶囊 999 / 圆钮 50%;
 * 子块只给一层很浅的阴影。字号层级: 40(续航) / 20 / 15 / 13 / 12;
 * 颜色只用 HA 主题变量(--card-background-color / --secondary-background-color /
 * --primary-color / --secondary-text-color), 只有语义色(通风蓝、加热红、告警黄/红)
 * 写死, 且都挑了在深浅两种主题下都看得清的值。图标统一 ha-icon(mdi), 只有车模是自制 SVG。
 *
 * 用法
 * ----
 *   type: custom:leapmotor-control
 *   # 全部可选
 *   device: <device_id 或该车任一实体 id>   # 只有一辆车时可省
 *   name: 我的零跑                          # 覆盖标题(默认用车名)
 *   entities: {battery: sensor.xxx, ...}    # 逐项手工覆盖
 *   show: [hero, actions, climate, location, charging, comfort, seats, fuel, tires, trip]
 *          # 兼容老写法: 老版 climate = 空调 + 前排座椅, 填 climate 会同时带上 comfort
 *   compact: false                          # 紧凑模式(不显示胎压/行程)
 *   tire_range: [2.3, 2.8]                  # 可选: 胎压正常区间(bar), 区间外标黄、偏差大标红
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 */

const CARD_VERSION = "1.4.0";

/* 区块顺序(show 配置按这个顺序渲染; 缺键的区块自动隐藏)
 * 注意: 这里没有 tires —— 胎压在 v3 并进了车模区, 但 show 里写 "tires" 仍然被接受(忽略即可)。
 * seats 也一样: v4 起后排并进 comfort 的座舱模型, show 里写 "seats" 仍然被接受。 */
const PANELS = ["hero", "actions", "climate", "location", "charging", "comfort", "csdetail", "seats", "fuel", "trip"];

/* show 的向后兼容: 老配置里的 climate 意思是"空调 + 前排座椅", 新版拆成了
 * climate(空调卡) 和 comfort(座椅与加热), 所以填 climate 时把 comfort 一起带上。 */
const SHOW_EXTRA = { climate: "comfort", ac: "climate" };

/* 可折叠的"常用块"(顺序即页面顺序); key 会拼进 localStorage 的存储键。
 * v4 起默认全部收起(没有本地记录时), 见 _loadFold()。 */
const SECTIONS = ["charging", "comfort", "fuel", "trip"];

/* 已知键 → 中文实体名。注册表不可用(老 HA/权限)时的兜底匹配, 也用于文档/排查。 */
const KEY_NAMES = {
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
};

/* 已知键 → entity_id 拼音后缀(HA 会把中文名转成拼音实体 id; 兜底的第二道猜测) */
const KEY_SUFFIX = {
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
};

/* 键表按"名字/后缀从长到短"排序: 兜底猜测时先认长名, 免得 续航 抢走 燃油续航 的实体 */
const KEYS_BY_LEN = Object.keys(KEY_NAMES).sort(function (a, b) {
  const la = KEY_NAMES[a].length + (KEY_SUFFIX[a] || "").length;
  const lb = KEY_NAMES[b].length + (KEY_SUFFIX[b] || "").length;
  return lb - la;
});

/* 空调模式的显示名(大号字和模式按钮共用中文; 认不出的原样显示) */
const HVAC_LABEL = {
  off: "关", cool: "制冷", heat: "制热", auto: "自动",
  fan_only: "送风", dry: "除湿", heat_cool: "冷暖自动",
};

/* 空调模式 → 图标(模式按钮只画图标, 中文放在 title 上)。
 * 零跑的空调实体只有 off/cool/heat/fan_only 四种, 三个图标刚好覆盖;
 * auto/dry 这类(个别后端会多给)也各配一个, 免得出现没有图形的地方。 */
const HVAC_ICON = {
  cool: "mdi:snowflake", heat: "mdi:fire", fan_only: "mdi:fan-auto",
  auto: "mdi:fan-auto", dry: "mdi:water", heat_cool: "mdi:snowflake-alert",
};

/* 充电状态枚举 → 中文 */
const CHARGE_LABEL = { charging: "充电中", plugged: "已插枪", unplugged: "未插枪" };

/* 座舱俯视模型里的座位: 每个座位最多两个功能(加热 / 通风), 各自 0~3 档。
 * row 决定放在第几排, pos 决定左右, label 是图标下面那行小字的名字;
 * 三排车型只有加热(vent 留空), 缺键的座位/整排都不渲染(纯电 C10 只有前排)。 */
const CABIN_SEATS = [
  { row: "front", pos: "left", label: "主驾", heat: "seat_heat_driver", vent: "seat_vent_driver" },
  { row: "front", pos: "right", label: "副驾", heat: "seat_heat_copilot", vent: "seat_vent_copilot" },
  { row: "rear", pos: "left", label: "二排左", heat: "seat_heat_rear_left", vent: "seat_vent_rear_left" },
  { row: "rear", pos: "right", label: "二排右", heat: "seat_heat_rear_right", vent: "seat_vent_rear_right" },
  { row: "third", pos: "left", label: "三排左", heat: "seat_heat_third_left", vent: "" },
  { row: "third", pos: "right", label: "三排右", heat: "seat_heat_third_right", vent: "" },
];

/* 车窗四档 */
const WINDOW_STEPS = [["window_open", "全开"], ["window_vent", "微开"], ["window_half", "半开"], ["window_close", "关"]];
/* 胎压(俯视: 左前/右前/左后/右后) */
const TIRE_DEFS = [["tire_fl", "左前"], ["tire_fr", "右前"], ["tire_rl", "左后"], ["tire_rr", "右后"]];

/* ── 小工具(不引入任何依赖) ── */

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function pad2(n) {
  return (n < 10 ? "0" : "") + n;
}

/** 数值格式化; 无效值显示 — */
function fmtNum(v, digits, unit) {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return "—";
  const s = n.toFixed(digits == null ? 1 : digits);
  return unit ? s + " " + unit : s;
}

function clampNum(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** 百分比(摘要里紧贴数字, 不留空格) */
function fmtPct(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n) + "%";
}

/** 各种时间(秒/毫秒时间戳、ISO 字符串)→ 毫秒; 解析不出返回 null */
function parseTs(v) {
  if (v == null || v === "" || v === "unknown" || v === "unavailable") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const s = String(v);
  if (/^[0-9]+(\.[0-9]+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "3 分钟前" 这类相对时间 */
function relTime(v) {
  const ms = parseTs(v);
  if (ms == null) return "";
  const d = Date.now() - ms;
  if (!Number.isFinite(d)) return "";
  if (d < 0) return "刚刚";
  const s = Math.round(d / 1000);
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.round(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.round(h / 24) + " 天前";
}

/** "HH:MM" 形式的时间文案(datetime 字符串/时间戳都能吃) */
function fmtClock(v) {
  const ms = parseTs(v);
  if (ms == null) return "";
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 分钟数 → "2h10m" / "42min"(折叠态摘要用) */
function fmtDur(min) {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "";
  const mi = Math.round(m);
  if (mi < 60) return mi + "min";
  const h = Math.floor(mi / 60);
  const r = mi % 60;
  return h + "h" + (r ? pad2(r) + "m" : "");
}

/** device_tracker 的状态(是"区域名")→ 可读区域名; 不在任何区域里返回空串(卡片自己显示"外出") */
function zoneLabel(states, state) {
  const s = String(state == null ? "" : state);
  if (!s || s === "unknown" || s === "unavailable") return "";
  if (s === "not_home") return "";
  const direct = states["zone." + s];
  if (direct && direct.attributes && direct.attributes.friendly_name) {
    return direct.attributes.friendly_name;
  }
  const ids = Object.keys(states);
  for (const id of ids) {
    if (id.indexOf("zone.") !== 0) continue;
    const a = states[id].attributes || {};
    if (String(a.friendly_name) === s) return s;
  }
  if (s === "home") return "家";     // 连 zone.home 都没有(极少见)时的兜底
  return s;
}

/* 车模示意图(车辆区的主图): 车头朝左的侧视剪影 —— 车身 + 车顶玻璃 + 腰线门缝 + 后视镜
 * + 两个轮子 + 地面投影。全用主题色低透明度, 深浅色主题都能看;
 * 将来接真车模(3D 渲染图)时, 只要换掉这一个常量就行。 */
const CAR_SVG =
  '<svg class="carSvg" viewBox="0 0 400 140" preserveAspectRatio="xMidYMid meet" aria-hidden="true">' +
  '<ellipse class="carShadow" cx="200" cy="126" rx="172" ry="7"/>' +
  // 车身主体
  '<path class="carBody" d="M18 112 L18 92 C18 83 27 78 44 76 L118 68 ' +
  'C143 42 168 32 200 32 L250 32 C283 35 306 50 325 69 L372 76 ' +
  'C385 78 392 84 392 93 L392 112 C392 117 388 120 382 120 L28 120 ' +
  'C22 120 18 117 18 112 Z"/>' +
  // 车顶玻璃(前风挡 + 后风挡)
  '<path class="carWin" d="M141 64 C161 45 180 39 201 39 L249 39 ' +
  'C276 42 295 54 312 68 Z"/>' +
  // B 柱 + 腰线 + 前后门缝
  '<path class="carLine" d="M206 39 L207 66"/>' +
  '<path class="carLine" d="M27 95 L374 95"/>' +
  '<path class="carLine" d="M120 70 L118 116"/>' +
  '<path class="carLine" d="M262 40 L266 116"/>' +
  // 后视镜
  '<path class="carMirror" d="M126 68 L110 71 C105 72 105 78 111 79 L126 77 Z"/>' +
  '<circle class="carTyre" cx="110" cy="116" r="18"/>' +
  '<circle class="carHub" cx="110" cy="116" r="8"/>' +
  '<circle class="carTyre" cx="316" cy="116" r="18"/>' +
  '<circle class="carHub" cx="316" cy="116" r="8"/>' +
  "</svg>";

class LeapmotorControlCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._hass = null;
    this._config = null;
    this._show = null;           // 配置 show 解析后的数组(或 null = 全显示)
    // 实体注册表(只查一次, 缓存在实例上)
    this._registry = null;       // {entities, devices}
    this._registryState = "idle";// idle / loading / done / failed
    this._hint = "";             // 顶部提示(退化模式等)
    this._devMsg = "";           // 设备选择提示
    this._device = "";           // 解析出的 device_id
    this._deviceName = "";       // 设备名(标题默认用它)
    this._candidates = [];       // 多辆车时的候选
    this._picked = "";           // 用户在卡片上临时点选的 device_id
    this._overrides = {};        // config.entities 手工覆盖
this._index = {};            // translation_key → entity_id
    this._guessed = false;       // 索引是否来自"猜"(用于提示)
    // 交互状态
    this._busy = {};             // 键 → true(调用进行中)
    this._toast = "";
    this._toastKind = "info";
    this._toastTimer = null;
    this._raf = 0;
    // v2 的界面状态
    this._collapsed = {};        // 区块名 → true(localStorage 里持久化)
    this._foldLoaded = false;    // 是否已经按设备 id 读过 localStorage
    this._open = { climate: true, window: false, photo: false, tires: false };  // 页内展开态
    this._winOutside = null;      // 车窗气泡打开时挂的 document 点击监听(点外部关气泡)
    this._locBgSrc = "";         // 位置卡背景图: 当前在验证的地址
    this._locBgOk = "";          // 位置卡背景图: 验证结果(ok / 其它=失败)
    this._narrow = false;        // 卡片宽度 < 420px(两卡改上下堆叠)
    this._ro = null;
  }

  /** 从卡片选择器添加时: 自动带上探测到的 device(没有就只给 type)。 */
  static getStubConfig(hass) {
    const base = { type: "custom:leapmotor-control" };
    if (!hass || !hass.callWS) return base;
    return Promise.all([
      hass.callWS({ type: "config/entity_registry/list" }),
      hass.callWS({ type: "config/device_registry/list" }),
    ]).then(function (res) {
      const ents = res[0] || [];
      const devs = res[1] || [];
      const ids = [];
      for (const e of ents) {
        if (e && e.platform === "leapmotor" && e.device_id && ids.indexOf(e.device_id) < 0) {
          ids.push(e.device_id);
        }
      }
      if (ids.length !== 1) return base;
      let name = "";
      for (const d of devs) {
        if (d && d.id === ids[0]) name = d.name_by_user || d.name || "";
      }
      const out = { type: "custom:leapmotor-control", device: ids[0] };
      if (name) out.name = name;
      return out;
    }).catch(function () {
      return base;
    });
  }

  setConfig(config) {
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
    this._built = false;
    this._render();
  }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._hass) return;
    if (this._registryState === "idle") this._loadRegistry();
    else if (first) this._resolveIndex();
    this._scheduleRender();
  }

  /** 合并同一帧里的多次 hass 更新, 避免每个实体状态变化都重画一遍卡片 */
  _scheduleRender() {
    if (this._raf) return;
    const run = () => {
      this._raf = 0;
      this._render();
    };
    if (typeof requestAnimationFrame === "function") this._raf = requestAnimationFrame(run);
    else this._raf = setTimeout(run, 16);
  }

  getCardSize() {
    if (this._config && this._config.compact) return 8;
    return 14;
  }

  // ── 实体注册表(只查一次, 缓存在实例上) ──
  async _loadRegistry() {
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
  _resolveIndex() {
    const cfg = this._config || {};
    this._index = {};
    this._guessed = false;
    this._candidates = [];
    this._device = "";
    this._deviceName = "";
    this._devMsg = "";
    for (const k in this._overrides) this._index[k] = this._overrides[k];
    const hass = this._hass;
    if (!hass) return;

    const reg = this._registry;
    if (reg) {
      const ents = [];
      for (const e of reg.entities) {
        if (e && e.platform === "leapmotor" && e.entity_id && !e.disabled_by) ents.push(e);
      }
      if (ents.length) {
        const devName = {};
        for (const d of reg.devices) {
          if (d && d.id) devName[d.id] = d.name_by_user || d.name || d.id;
        }
        const byDev = {};
        const devIds = [];
        for (const e of ents) {
          const d = e.device_id || "";
          if (!byDev[d]) { byDev[d] = []; devIds.push(d); }
          byDev[d].push(e);
        }
        // ── 选设备 ──
        const want = String(cfg.device || this._picked || "");
        let devId = "";
        if (want) {
          if (want.indexOf(".") >= 0) {                 // 填的是 entity_id
            for (const e of ents) {
              if (e.entity_id === want) { devId = e.device_id || ""; break; }
            }
            if (!devId) {                                // 也允许填 unique_id 前缀(VIN)
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
          for (const e of ents) {
            if (e.device_id !== devId) continue;
            const k = e.translation_key || "";
            if (k && !this._index[k]) this._index[k] = e.entity_id;
          }
          this._fillByName(ents, devId);                 // 老实体没有 translation_key 时按名字补
        } else if (devIds.length > 1) {
          for (const d of devIds) {
            this._candidates.push({ id: d, name: devName[d] || d, count: (byDev[d] || []).length });
          }
          this._devMsg = "发现多辆零跑, 请在卡片配置里填 device(或点下面选一辆)";
        }
        this._loadFold();                                // 设备定下来后再读这一辆车的折叠状态
        return;                                          // 注册表可用, 不再猜
      }
    }
    // ── 退化: 注册表不可用(老 HA/权限/没有实体) → 按实体名/后缀猜 ──
    this._guessed = true;
    this._guessIndex();
    this._loadFold();
    if (this._guessed && !this._hint) {
      this._hint = "读不到实体注册表, 已按实体名/后缀猜测(可能不准, 可在卡片配置 entities 里手工指定)。";
    }
  }

  /** 用实体名补注册表里没有 translation_key 的键(不会覆盖已有索引) */
  _fillByName(ents, devId) {
    const need = [];
    for (const k of KEYS_BY_LEN) if (!this._index[k] && KEY_NAMES[k]) need.push(k);
    if (!need.length) return;
    for (const e of ents) {
      if (e.device_id !== devId) continue;
      const fname = String(e.original_name || "") + "|" + String(e.name || "");
      for (const k of need) {
        if (this._index[k]) continue;
        const name = KEY_NAMES[k];
        if (fname.indexOf("|" + name) >= 0 || e.entity_id.slice(-(name.length + 1)) === "_" + name) {
          this._index[k] = e.entity_id;
        }
      }
    }
  }

  /** 兜底猜测: 先按拼音后缀(长→短), 再按中文名(长→短), 最后按英文键后缀 */
  _guessIndex() {
    const hass = this._hass;
    if (!hass || !hass.states) return;
    const ids = Object.keys(hass.states);
    const claimed = {};
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
  _ent(key) {
    const id = this._index[key];
    if (!id || !this._hass || !this._hass.states) return null;
    return this._hass.states[id] || null;
  }

  _entId(key) {
    return this._index[key] || "";
  }

  _val(key) {
    const st = this._ent(key);
    if (!st) return null;
    if (st.state === "unknown" || st.state === "unavailable") return null;
    return st.state;
  }

  _num(key) {
    const v = this._val(key);
    if (v == null || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  _attr(key, name) {
    const st = this._ent(key);
    if (!st || !st.attributes) return null;
    const v = st.attributes[name];
    return v == null ? null : v;
  }

  _ready(key) {
    return this._val(key) != null;
  }

  _driving() {
    return this._val("vehicle_state") === "driving";
  }

  _isReev() {
    return !!(this._entId("fuel_level") || this._entId("fuel_range") ||
      this._entId("total_range") || this._entId("fuel_consumption"));
  }

  /** 增程车的"主续航"是油电总续航, 纯电是纯电续航 */
  _mainRange() {
    const total = this._num("total_range");
    if (this._isReev() && total != null) return total;
    return this._num("range");
  }

  _indexCount() {
    let n = 0;
    for (const k in this._index) if (this._index[k]) n++;
    return n;
  }

  _title() {
    const cfg = this._config || {};
    if (cfg.name) return String(cfg.name);
    return this._deviceName || "零跑";
  }

  /** 驻车照片地址: 优先 image 实体的 entity_picture(走 HA 自己的鉴权), 退回 parking_url */
  _photoSrc() {
    let src = this._attr("parking", "entity_picture") || "";
    if (!src) {
      const raw = this._val("parking_url");
      if (raw && /^https?:\/\//.test(String(raw))) src = String(raw);
    }
    return src;
  }

  _vis(name) {
    const cfg = this._config || {};
    // tires 没有独立区块了(并进了车模区); 保留这个分支, compact 时连车模上的胎压开关也一起藏掉
    if (cfg.compact && (name === "tires" || name === "trip")) return false;
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
  _foldStoreKey() {
    return "leapmotor-control.fold." + (this._device || this._picked || "nodevice");
  }

  _loadFold() {
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
    for (const s of list) {
      if (SECTIONS.indexOf(s.trim()) >= 0) this._collapsed[s.trim()] = true;
    }
  }

  _saveFold() {
    const list = [];
    for (const s of SECTIONS) if (this._collapsed[s]) list.push(s);
    try {
      if (list.length) window.localStorage.setItem(this._foldStoreKey(), list.join(","));
      else window.localStorage.removeItem(this._foldStoreKey());
    } catch (err) {
      /* 存不了就算了, 只是这次会话里不记住 */
    }
  }

  _secOpen(name) {
    return !this._collapsed[name];
  }

  /** 可折叠区块的标题行(右侧是摘要, 后面跟一个会转的箭头) */
  _foldHead(name, title, summary) {
    const open = this._secOpen(name);
    return '<button class="foldH" data-act="fold" data-sec="' + name + '"' +
      ' aria-expanded="' + (open ? "true" : "false") + '">' +
      '<span class="foldT">' + esc(title) + "</span>" +
      '<span class="foldS">' + esc(summary) + "</span>" +
      '<ha-icon class="foldC ico" icon="mdi:chevron-down"></ha-icon></button>';
  }

  // ── 服务调用 ──
  async _call(domain, service, data, busyKey) {
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
      const msg = String((err && err.message) || err || "未知错误");
      this._showToast("操作失败: " + msg.slice(0, 90), "error");
      return false;
    } finally {
      delete this._busy[key];
      this._render();
    }
  }

  _showToast(msg, kind) {
    this._toast = msg;
    this._toastKind = kind || "info";
    if (this._toastTimer) clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => {
      this._toast = "";
      this._renderToast();
    }, 5000);
    this._renderToast();
  }

  _renderToast() {
    const el = this._toastEl;
    if (!el) return;
    if (!this._toast) {
      el.className = "toast";
      el.textContent = "";
      return;
    }
    el.className = "toast on" + (this._toastKind === "error" ? " err" : "");
    el.textContent = this._toast;
  }

  // ── 渲染 ──
  _render() {
    if (!this._config) return;
    if (!this._built) {
      this._build();
      this._built = true;
    }
    if (this._hintEl) {
      const msgs = [];
      if (this._hint) msgs.push(this._hint);
      if (this._devMsg) msgs.push(this._devMsg);
      // 这条是"要动手配置"的诊断提示(不是顺口一提的小字), 所以仍然整句显示, 只是带个 ⓘ 图标
      this._hintEl.innerHTML = msgs.length
        ? this._info("" + (msgs.join(" ")), "hintIco") + "<span></span>" : "";
      const span = this._hintEl.querySelector("span");
      if (span) span.textContent = msgs.join(" ");
      this._hintEl.style.display = msgs.length ? "flex" : "none";
    }
    if (!this._hass) return;
    this._renderHero();
    this._renderActions();
    this._renderClimate();
    this._renderLocation();
    this._renderCharging();
    this._renderComfort();
    this._renderSeats();
    this._renderCsDetail();
    this._renderFuel();
    this._renderTrip();
    this._renderPhoto();
    this._renderToast();
    if (this._open.window) this._placeWin();
  }

  /**
   * 车窗气泡贴位: 锚点是「车窗」圆钮自己(不是动作行/卡片中心), 圆钮是第几个、
   * 卡片多宽都不影响 —— 因为是实测 offset 算的, 不依赖 CSS 假设。
   * 竖向: 贴在圆钮下沿 +8px(不遮圆钮那一行); 横向: 先按圆钮居中, 再夹回卡片内,
   * 窄屏时箭头单独跟到圆钮中心, 保证不会飘到气泡外面去。
   */
  _placeWin() {
    const sr = this.shadowRoot;
    if (!sr) return;
    const pop = sr.querySelector(".winPop");
    const wrap = sr.querySelector(".actWin");
    const btn = wrap && wrap.querySelector(".circ");
    if (!pop || !wrap || !btn) return;
    const wr = wrap.getBoundingClientRect();
    const br = btn.getBoundingClientRect();
    // 气泡比 .actWin 宽得多, 先按卡片内可用宽度封顶, 夹取区间才一定有解
    const box = (sr.querySelector(".p-actions") || wrap).getBoundingClientRect();
    const pad = 8;
    pop.style.maxWidth = Math.max(box.width - pad * 2, 80) + "px";
    const w = pop.offsetWidth;
    const cx = br.left - wr.left + br.width / 2;      // 圆钮中心(相对 .actWin)
    pop.style.top = br.bottom - wr.top + pad + "px";   // 圆钮下方 8px
    pop.style.left = "0px";
    pop.style.transform = "none";
    const lo = box.left - wr.left + pad - w;
    const hi = box.right - wr.left - pad - w;
    const left = lo > hi ? lo : Math.min(Math.max(cx - w / 2, lo), hi);
    pop.style.left = left + "px";
    const aw = 12;                                     // 箭头宽
    const ax = Math.min(Math.max(cx - left - aw / 2, 2), Math.max(w - aw - 2, 2));
    pop.style.setProperty("--winArrow", ax + "px");
  }

  /** 只换内容、不重建节点; 若焦点在面板里(比如正在填时间), 换完把焦点还回去 */
  _setPanel(name, html, cls) {
    const el = this._panels[name];
    if (!el) return;
    if (cls != null) el.className = cls;
    if (!html) {
      if (el.style.display !== "none") {
        el.style.display = "none";
        el.innerHTML = "";
      }
      return;
    }
    const active = this.shadowRoot.activeElement;
    let keep = "";
    if (active && el.contains(active) && active.dataset && active.dataset.act) {
      const keepParts = ['[data-act="' + active.dataset.act + '"]'];
      if (active.dataset.entity) keepParts.push('[data-entity="' + active.dataset.entity + '"]');
      else if (active.dataset.key) keepParts.push('[data-key="' + active.dataset.key + '"]');
      else if (active.dataset.delta) keepParts.push('[data-delta="' + active.dataset.delta + '"]');
      else if (active.dataset.sec) keepParts.push('[data-sec="' + active.dataset.sec + '"]');
      keep = keepParts.join("");
    }
    el.style.display = "";
    el.innerHTML = html;
    if (keep) {
      const n = el.querySelector(keep);
      if (n && n.focus) n.focus();
    }
  }

  _dis(cond) {
    return cond ? " disabled" : "";
  }

  /**
   * 一个 ⓘ 提示: 整句提示收进 title(鼠标悬停才看得到), 界面上只留一个小图标。
   * v4 起所有这类"顺口提一句"的提示都用它, 不再散着写一整行小字。
   */
  _info(text, cls) {
    return '<ha-icon class="ico sm info' + (cls ? " " + cls : "") +
      '" icon="mdi:information-outline" title="' + esc(text) + '"></ha-icon>';
  }

  // ── hero: 车名 + 超大续航 + 电量条 + 胶囊 + 锁 + 车辆示意 ──
  _renderHero() {
    if (!this._vis("hero")) return this._setPanel("hero", "");
    const hass = this._hass || { states: {} };
    if (!this._device && this._candidates.length) {
      let h = '<div class="pick"><div class="pickT">发现多辆零跑</div>' +
        '<div class="pickS">请在卡片配置里填 <code>device</code>, 或点下面选一辆:</div>';
      for (const c of this._candidates) {
        h += '<button class="pickRow" data-act="pickdev" data-val="' + esc(c.id) + '">' +
          "<b>" + esc(c.name) + "</b><span>" + c.count + " 个实体 · " + esc(c.id) + "</span></button>";
      }
      return this._setPanel("hero", h + "</div>");
    }
    if (!this._indexCount()) {
      const msg = this._registryState === "loading"
        ? "正在读取实体注册表…"
        : (this._devMsg || "还没找到这辆车的实体(等集成连上后会自动出现; 也可以在卡片配置 entities 里手工指定)");
      return this._setPanel("hero", '<div class="pick"><div class="pickT">零跑·车辆控制</div>' +
        '<div class="pickS">' + esc(msg) + "</div></div>");
    }

    const soc = this._num("battery");
    const rangeMain = this._mainRange();
    const driving = this._driving();
    const isReev = this._isReev();
    const updated = relTime(this._val("state_updated"));
    const refreshId = this._entId("refresh_state");
    const rBusy = !!this._busy["btn:" + refreshId];

    // ── 标题行: 车名 + 状态更新 + 右上角小 pill(行驶中 / 充电状态) + 刷新车况 ──
    // v4: 「未插枪 / 已插枪 / 充电中」从下面那一行挪到这里, 和「行驶中」并列, 排在刷新按钮前面
    const chg = this._chgInfo();
    let h = '<div class="heroHead"><div class="heroId"><div class="vname">' + esc(this._title()) + "</div>" +
      '<div class="vsub">' + (updated ? "状态更新 · " + esc(updated) : "状态更新 · 等待车况") + "</div></div>" +
      '<div class="heroTools">';
    if (driving) h += '<span class="pill warn">行驶中</span>';
    if (chg) h += '<span class="pill' + (chg.on ? " chg" : "") + '" title="充电状态">' + esc(chg.text) + "</span>";
    if (refreshId) {
      h += '<button class="toolBtn" data-act="press" data-entity="' + esc(refreshId) + '"' +
        ' title="刷新车况"' + this._dis(rBusy) + ">" +
        (rBusy ? "…" : '<ha-icon class="ico" icon="mdi:refresh"></ha-icon>') + "</button>";
    }
    h += "</div></div>";

    // ── 主数字 + 锁 ──
    h += '<div class="heroMain"><div class="rangeBig">' +
      '<span class="rn">' + fmtNum(rangeMain, 0) + "<i>km</i></span>" +
      '<div class="socRow"><span class="soc">' + fmtNum(soc, 0) + "<i>%</i></span>";
    if (soc != null) {
      const s = clampNum(soc, 0, 100);
      h += '<i class="bar"><b class="' + (s <= 15 ? "crit" : s <= 30 ? "low" : "") +
        '" style="width:' + s.toFixed(1) + '%"></b></i>';
    } else {
      h += '<i class="bar noc"><b style="width:0%"></b></i>';
    }
    h += "</div></div>";
    h += this._lockHtml(driving);
    h += "</div>";

    // ── 增程车: 总续航下面挂「⚡纯电 / ⛽燃油」两个小胶囊 ──
    if (soc != null) h += this._rangeChips();

    // ── 纯电车的实时续航小字(增程车走上面的双胶囊) ──
    if (soc != null && !isReev) {
      const sub = this._rangeSubline();
      if (sub) h += '<div class="subline heroSub">' + esc(sub) + "</div>";
    }

    // ── 车模区(固定画车模; 驻车照片只走位置卡背景和覆盖层) ──
    h += this._carModel();
    this._setPanel("hero", h);
  }

  /** 增程车的续航三件套: 大数字是总续航, 下面两个小胶囊分别是纯电/燃油; 纯电车返回空 */
  _rangeChips() {
    if (!this._isReev()) return "";
    const evKm = this._attr("total_range", "纯电续航_km");
    const fuKm = this._attr("total_range", "燃油续航_km");
    const ev = evKm != null ? Number(evKm) : this._num("range");
    const fu = fuKm != null ? Number(fuKm) : this._num("fuel_range");
    if (!Number.isFinite(ev) && !Number.isFinite(fu)) return "";
    let h = '<div class="rangeChips">';
    if (Number.isFinite(ev)) {
      h += '<span class="rchip ev"><ha-icon class="ico sm" icon="mdi:flash"></ha-icon>' +
        "纯电 <b>" + fmtNum(ev, 0) + "</b> km</span>";
    }
    if (Number.isFinite(fu)) {
      h += '<span class="rchip fuel"><ha-icon class="ico sm" icon="mdi:gas-station"></ha-icon>' +
        "燃油 <b>" + fmtNum(fu, 0) + "</b> km</span>";
    }
    h += "</div>";
    return h;
  }

  /** 车模示意图 + 右下角「胎压」开关; 打开后四个轮压贴在车模四角(俯视方位) */
  _carModel() {
    const present = TIRE_DEFS.filter((d) => this._entId(d[0]));
    const canTires = present.length && this._vis("tires");
    const on = canTires && this._open.tires;
    // 容器整块可点, 但现在不绑任何动作 —— 留给将来的"车模视图"(3D 旋转/车型详情)
    let h = '<div class="carModel' + (canTires ? " hasTire" : "") + '" data-act="vehicle"' +
      ' role="button" tabindex="0" title="车模视图(预留, 暂时没有动作)">';
    h += CAR_SVG;
    if (canTires) {
      h += '<button class="tireTgl' + (on ? " on" : "") + '" data-act="tires"' +
        ' aria-expanded="' + (on ? "true" : "false") + '" title="' +
        esc(on ? "收起胎压" : "在车模上显示四轮胎压") + '">' +
        '<ha-icon class="ico sm" icon="mdi:gauge"></ha-icon>胎压</button>';
      if (on) {
        h += '<div class="tirePads">';
        const corners = ["a", "b", "c", "d"];   // 左上=左前 右上=右前 左下=左后 右下=右后
        for (let i = 0; i < present.length && i < 4; i++) {
          h += this._tirePad(present[i], corners[i]);
        }
        h += "</div>";
      }
    }
    h += "</div>";
    return h;
  }

  /** 车模角上的一个轮压小卡片(超区间标黄/标红) */
  _tirePad(def, corner) {
    const key = def[0];
    const v = this._num(key);
    const alarm = this._attr(key, "alarm");
    const range = this._tireRange(key);
    let cls = "";
    if (alarm === true || alarm === 1 || alarm === "1") cls = " bad";
    else if (range && v != null) {
      if (v < range[0] || v > range[1]) cls = " warn";
      if (v < range[0] - 0.3 || v > range[1] + 0.3) cls = " bad";
    }
    const kpa = this._attr(key, "kpa");
    const tip = def[1] + " 胎压 " + (v == null ? "—" : fmtNum(v, 2, "bar")) +
      (kpa != null ? " (" + kpa + " kPa)" : "") + (range ? " · 正常 " + range[0] + "~" + range[1] : "");
    return '<span class="tP ' + corner + (cls ? " " + cls : "") + '" title="' + esc(tip) + '">' +
      "<i>" + esc(def[1]) + "</i><b>" + (v == null ? "—" : fmtNum(v, 2)) + "</b></span>";
  }

  /** hero 右上/右侧的锁状态行: 点一下锁/解锁(两条路都要 window.confirm 二次确认), 行驶中禁用 */
  _lockHtml(driving) {
    const id = this._entId("lock");
    if (!id) return '<div class="lockBox"></div>';
    const st = this._val("lock") || "unknown";
    const locked = st === "locked" || st === "locking";
    const busy = !!this._busy["lock"];
    let label;
    if (locked) label = "车门已上锁";
    else if (st === "unknown") label = "上锁状态未知";
    else label = "车门未上锁";
    const tip = driving ? "行驶中已禁用" : locked ? "点一下解锁(会先弹确认)" : "点一下上锁(会先弹确认)";
    // 图标名必须是 MDI 里真有的: car-door-lock / car-door-lock-open
    // (老写法 car-door-locked 在 MDI 里不存在, 界面上是空白)
    const icon = locked ? "mdi:car-door-lock" : "mdi:car-door-lock-open";
    return '<button class="lockBox" data-act="lock"' +
      ' title="' + esc(tip) + '"' + this._dis(driving || busy) + ">" +
      '<ha-icon class="ico" icon="' + icon + '"></ha-icon><span>' + esc(label) + "</span></button>";
  }

  /** 纯电车 hero 里的实时续航小字(增程车走 _rangeChips 的双胶囊) */
  _rangeSubline() {
    if (this._isReev()) return "";
    const live = this._attr("range", "live_range");
    const main = this._num("range");
    if (live != null && main != null && Number(live) !== Number(main)) {
      return "实时续航 " + fmtNum(live, 0, "km");
    }
    return "";
  }

  _chgInfo() {
    const st = this._val("charging_state");
    if (!st) return null;
    let txt = CHARGE_LABEL[st] || st;
    const m = Number(this._attr("charging_state", "remaining_minutes"));
    if (st === "charging" && Number.isFinite(m) && m > 0) {
      txt += " · 剩 " + (m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? (m % 60) + " 分" : "") : m + " 分");
    }
    return { text: txt, on: st === "charging" };
  }

  // ── 四个圆形动作按钮(解锁·上锁 / 后备箱 / 车窗 / 遮阳帘) ──
  _renderActions() {
    if (!this._vis("actions")) return this._setPanel("actions", "");
    const driving = this._driving();
    const self = this;

    const rnd = function (key, icon, label, disabled, title, cls) {
      const id = self._entId(key);
      const busy = !!self._busy["btn:" + id];
      return '<div class="act"><button class="circ' + (cls ? " " + cls : "") + '"' +
        ' data-act="press" data-entity="' + esc(id) + '" title="' + esc(title || label) + '"' +
        self._dis(disabled || busy) + ">" +
        '<ha-icon class="ico lg" icon="' + icon + '"></ha-icon></button>' +
        '<span class="actL">' + esc(label) + "</span></div>";
    };
    const tog = function (key, icon, label, disabled) {
      const id = self._entId(key);
      const on = self._val(key) === "on";
      const busy = !!self._busy["sw:" + id];
      return '<div class="act"><button class="circ' + (on ? " on" : "") + '" data-act="toggle"' +
        ' data-entity="' + esc(id) + '" data-on="' + (on ? "1" : "0") + '"' +
        ' title="' + esc(label + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开")) + '"' +
        self._dis(disabled || busy) + '><ha-icon class="ico lg" icon="' + icon + '"></ha-icon></button>' +
        '<span class="actL">' + esc(label) + "</span></div>";
    };

    let h = '<div class="acts">';
    if (this._entId("lock")) {
      const st = this._val("lock") || "unknown";
      const locked = st === "locked" || st === "locking";
      const busy = !!this._busy["lock"];
      const label = locked ? "解锁" : "上锁";
      const tip = driving ? "行驶中已禁用" : locked ? "解锁(会先弹确认)" : "上锁(会先弹确认)";
      h += '<div class="act"><button class="circ' + (locked ? " on" : "") + '" data-act="lockround"' +
        ' title="' + esc(tip) + '"' + this._dis(driving || busy) + ">" +
        '<ha-icon class="ico lg" icon="' + (locked ? "mdi:car-door-lock" : "mdi:car-door-lock-open") + '"></ha-icon>' +
        '</button><span class="actL">' + esc(label) + "</span></div>";
    }
    // 后备箱: 开/关都要 window.confirm(图标用 car-back, 老写法 car-backup 在 MDI 里不存在)
    if (this._entId("trunk")) {
      const on = this._val("trunk") === "on";
      const id = this._entId("trunk");
      const busy = !!this._busy["sw:" + id];
      h += '<div class="act"><button class="circ' + (on ? " on" : "") + '" data-act="trunk"' +
        ' data-entity="' + esc(id) + '" data-on="' + (on ? "1" : "0") + '"' +
        ' title="' + esc("后备箱" + (on ? ": 已开, 点击关闭(会先弹确认)" : ": 已关, 点击打开(会先弹确认)")) + '"' +
        this._dis(driving || busy) + '><ha-icon class="ico lg" icon="mdi:car-back"></ha-icon></button>' +
        '<span class="actL">后备箱</span></div>';
    }
    // 车窗: 点圆钮弹一个悬浮气泡(不是内联展开, 所以不会把动作行挤高)
    // 图标用 window-open-variant(window-shutter 是卷帘, 语义不对; 卷帘留给遮阳帘)
    const wins = WINDOW_STEPS.filter(function (w) { return self._entId(w[0]); });
    if (wins.length) {
      const open = this._open.window;
      h += '<div class="act actWin"><button class="circ' + (open ? " on" : "") + '" data-act="window"' +
        ' title="车窗四档" aria-expanded="' + (open ? "true" : "false") + '"' +
        this._dis(driving) + '><ha-icon class="ico lg" icon="mdi:window-open-variant"></ha-icon></button>' +
        '<span class="actL">车窗</span>';
      if (open) {
        h += '<div class="winPop" role="menu">';
        for (const w of wins) {
          const id = self._entId(w[0]);
          const busy = !!self._busy["btn:" + id];
          // 三档「开」没有分档图标(窗开度没有对应的图形), 所以只有「关」配一个关着的窗户图标;
          // 少一颗图标气泡才不会宽到夹到卡片边上(_placeWin 的贴位逻辑不动)
          const wIcon = w[1] === "关" ? "mdi:window-closed-variant" : "";
          h += '<button class="winOpt" data-act="winstep" data-entity="' + esc(id) + '"' +
            self._dis(driving || busy) + ' title="' + esc(driving ? "行驶中已禁用" : "车窗" + w[1]) + '">' +
            (wIcon ? '<ha-icon class="ico sm" icon="' + wIcon + '"></ha-icon>' : "") + esc(w[1]) + "</button>";
        }
        h += "</div>";
      }
      h += "</div>";
    }
    if (this._entId("sunshade")) {
      const on = this._val("sunshade") === "on";
      const id = this._entId("sunshade");
      const busy = !!this._busy["sw:" + id];
      h += '<div class="act"><button class="circ' + (on ? " on" : "") + '" data-act="toggle"' +
        ' data-entity="' + esc(id) + '" data-on="' + (on ? "1" : "0") + '"' +
        ' title="' + esc("遮阳帘" + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开")) + '"' +
        this._dis(driving || busy) + '><ha-icon class="ico lg" icon="mdi:window-shutter"></ha-icon></button>' +
        '<span class="actL">遮阳帘</span></div>';
    }
    h += "</div>";
    this._setPanel("actions", h);
  }

  // ── 空调卡(左半): 大字模式/OFF + 车内温度 + 风扇; 展开是温度步进 + 模式 ──
  _renderClimate() {
    if (!this._vis("climate")) return this._setPanel("climate", "");
    const acId = this._entId("ac");
    if (!acId) return this._setPanel("climate", "");
    const st = this._ent("ac");
    const a = (st && st.attributes) || {};
    const ready = this._ready("ac");
    const mode = ready ? String(st.state) : "";
    const on = !!mode && mode !== "off" && mode !== "unknown" && mode !== "unavailable";
    const interior = this._num("interior_temp") != null
      ? this._num("interior_temp")
      : (a.current_temperature != null ? Number(a.current_temperature) : null);
    const open = this._open.climate;

    let h = '<section class="half sec">' +
      '<div class="halfH" data-act="acc" title="点击展开温度与模式">' +
      '<div class="halfId"><span class="bigTxt">' +
      esc(on ? (HVAC_LABEL[mode] || String(mode)) : "关") + "</span>" +
      '<span class="halfS">' + (interior != null && Number.isFinite(interior)
        ? "车内温度 " + fmtNum(interior, 1, "℃") : (ready ? HVAC_LABEL[mode] || mode : "空调不可用")) +
      "</span></div>" +
      '<button class="fanBtn' + (on ? " on" : "") + '" data-act="acpower"' +
      ' title="' + esc(on ? "点击关闭空调" : "点击开启空调") + '"' +
      this._dis(!ready || !!this._busy["hvac"]) + ">" +
      '<ha-icon class="ico" icon="mdi:fan"></ha-icon></button>' +
      "</div>";

    if (open) {
      const t = Number(a.temperature);
      const stepAttr = Number(a.target_temp_step);
      const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;
      // 「关」不列在模式按钮里: 风扇图标本身就是开关, 再放一个「关」是重复的
      const modes = (Array.isArray(a.hvac_modes) && a.hvac_modes.length
        ? a.hvac_modes : ["off", "cool", "heat", "fan_only"]).filter((m) => m !== "off");
      const busy = !!this._busy["temp"];
      // 温度步进整行居中: 两个按钮一样大, 温度数字固定宽度
      h += '<div class="acBody"><div class="tempBox">' +
        '<button class="step" data-act="temp" data-delta="-' + step + '" title="降低 ' + step + ' 度"' +
        this._dis(!ready || busy) + ">−</button>" +
        '<span class="tval">' + (Number.isFinite(t) ? fmtNum(t, 1) : "—") + "<i>℃</i></span>" +
        '<button class="step" data-act="temp" data-delta="' + step + '" title="升高 ' + step + ' 度"' +
        this._dis(!ready || busy) + ">＋</button></div>" +
        // 模式: 一排图标按钮(制冷 ❄ / 制热 🔥 / 送风 🌀), 当前模式用主题色高亮
        '<div class="modes">';
      for (const m of modes) {
        h += '<button class="chip mi' + (m === mode ? " on" : "") + '" data-act="hvac" data-val="' + esc(m) + '"' +
          ' title="' + esc(HVAC_LABEL[m] || m) + '" aria-label="' + esc(HVAC_LABEL[m] || m) + '"' +
          this._dis(!ready || !!this._busy["hvac"]) + ">" +
          '<ha-icon class="ico lg" icon="' + (HVAC_ICON[m] || "mdi:fan") + '"></ha-icon></button>';
      }
      h += "</div></div>";
    }
    h += "</section>";
    this._setPanel("climate", h);
  }

  /** 位置卡背景图(驻车照片)。
   *  background-image 加载失败不会报错、也不会留裂图, 所以先用 Image() 探一次:
   *  探到能显示才把地址交给 CSS, 探不到就静默退回纯色底。 */
  _locBg() {
    const src = this._photoSrc();
    if (!src) {
      this._locBgSrc = "";
      this._locBgOk = "";
      return "";
    }
    if (src === this._locBgSrc && this._locBgOk) {
      return this._locBgOk === "ok" ? src : "";
    }
    if (src !== this._locBgSrc) {
      this._locBgSrc = src;
      this._locBgOk = "";
      const self = this;
      const probe = new Image();
      probe.onload = function () {
        if (self._locBgSrc !== src) return;
        self._locBgOk = "ok";
        self._scheduleRender();
      };
      probe.onerror = function () {
        if (self._locBgSrc !== src) return;
        self._locBgOk = "bad";
        self._scheduleRender();
      };
      probe.src = src;
      return "";
    }
    return this._locBgOk === "ok" ? src : "";
  }

  // ── 位置卡(右半): 区域 + 坐标 + 更新时间 + 两个浮动胶囊(背景是驻车照片) ──
  _renderLocation() {
    if (!this._vis("location")) return this._setPanel("location", "");
    const st = this._ent("tracker");
    const driving = this._driving();
    if (!st && !this._entId("parking") && !this._entId("find")) {
      return this._setPanel("location", "");
    }
    const a = (st && st.attributes) || {};
    const lat = Number(a.latitude);
    const lon = Number(a.longitude);
    const zone = zoneLabel((this._hass && this._hass.states) || {}, st ? st.state : "");
    const rel = relTime((st && st.last_updated) || this._val("state_updated"));
    const hasFix = Number.isFinite(lat) && Number.isFinite(lon);
    const bg = this._locBg();

    // 不在任何区域里 → 「外出」(在区域内才显示区域名)
    let h = '<section class="half sec loc' + (bg ? " hasBg" : "") + '"' +
      (bg ? ' style="background-image:url(&quot;' + esc(bg) + '&quot;)"' : "") + ">";
    if (bg) h += '<i class="locVeil"></i>';
    h += '<div class="locIn"><div class="halfId">' +
      '<span class="bigTxt sm">' + esc(zone || (hasFix ? "外出" : "位置未知")) + "</span>" +
      '<span class="halfS">' + (hasFix ? lat.toFixed(5) + ", " + lon.toFixed(5) : "没有定位信息") + "</span>";
    if (rel) h += '<span class="halfS dim">' + esc(rel) + "</span>";
    h += "</div>";

    // 底部两个浮动胶囊
    const findId = this._entId("find");
    const fBusy = !!this._busy["btn:" + findId];
    h += '<div class="floatRow">';
    if (this._entId("parking") || this._entId("parking_url")) {
      h += '<button class="floatPill" data-act="photo"' +
        ' title="查看驻车照片"><ha-icon class="ico sm" icon="mdi:camera-outline"></ha-icon>驻车照片</button>';
    }
    if (findId) {
      h += '<button class="floatPill" data-act="press" data-entity="' + esc(findId) + '"' +
        ' title="' + esc(driving ? "行驶中已禁用" : "鸣笛寻车") + '"' + this._dis(driving || fBusy) + ">" +
        '<ha-icon class="ico sm" icon="mdi:volume-high"></ha-icon>' + (fBusy ? "鸣笛中…" : "鸣笛寻车") + "</button>";
    }
    // 「地图用另一张卡」这类提示收进 ⓘ(位置卡里最多一个)
    h += this._info("地图请用「零跑·地图」卡片", "locInfo");
    h += "</div></div></section>";
    this._setPanel("location", h);
  }

  // ── 充电(可折叠) ──
  /**
   * 充电: 标题行留在并排的卡片里, 正文由 _renderCsDetail() 铺在两卡下面(跨整行)。
   * 收起态只有标题 + 摘要("79% · 未插枪"), 点开才出下面那一整块设置。
   */
  _renderCharging() {
    if (!this._vis("charging")) return this._setPanel("charging", "");
    const has = ["battery", "charging_state", "charge_limit", "charge_book", "charge_start",
      "charge_end", "healthy_charge", "preheat_on", "preheat_off"].some((k) => this._entId(k));
    if (!has) return this._setPanel("charging", "");
    const h = '<section class="sec">' + this._foldHead("charging", "充电", this._sumCharging()) + "</section>";
    this._setPanel("charging", h);
  }

  /**
   * 「充电 / 座椅与加热」共用一个跨整行的详情容器: 谁展开就把谁的正文放进来。
   * 两张卡互斥 —— 点开一个会把另一个收起来, 不会同时撑开两块(见 _onClick 的 fold 分支)。
   */
  _renderCsDetail() {
    const chg = this._secOpen("charging") && this._vis("charging") &&
      ["battery", "charging_state", "charge_limit", "charge_book", "charge_start",
        "charge_end", "healthy_charge", "preheat_on", "preheat_off"].some((k) => this._entId(k));
    if (chg) return this._setPanel("csdetail", '<section class="sec">' + this._chargeBody() + "</section>");
    if (this._secOpen("comfort") && this._vis("comfort") && this._cabinAny()) {
      return this._setPanel("csdetail", '<section class="sec"><div class="secB">' + this._cabin() + "</div></section>");
    }
    return this._setPanel("csdetail", "");
  }

  /** 充电详情正文(顺序照官方 App: 健康充电 → 充电上限 → 预约 → 起止时间 → 电池预热) */
  _chargeBody() {
    let h = '<div class="secB">';
    const soc = this._num("battery");
    const chg = this._chgInfo();
    const chips = [];
    if (soc != null) chips.push('<span class="kvchip">电量 ' + fmtNum(soc, 0, "%") + "</span>");
    if (chg) chips.push('<span class="kvchip' + (chg.on ? " on" : "") + '">' + esc(chg.text) + "</span>");
    const liveKw = this._attr("battery", "charging_voltage");
    const liveA = this._attr("battery", "charging_current");
    if (chg && chg.on && liveKw != null && liveA != null) {
      const kw = Number(liveKw) * Number(liveA) / 1000;
      if (Number.isFinite(kw) && kw > 0) chips.push('<span class="kvchip">' + fmtNum(kw, 1, "kW") + "</span>");
    }
    if (chips.length) h += '<div class="chips">' + chips.join("") + "</div>";

    // ── 设置项: 一行一个, 标签左 / 控件右(官方 App 那种清爽版式) ──
    h += '<div class="cList">';

    // ① 健康充电(只留开关本身, 不写任何"延长寿命/有利于电池"之类的说明文字)
    if (this._entId("healthy_charge")) {
      h += '<div class="cRow"><span class="cL">健康充电</span><span class="cC">' +
        this._togChip("healthy_charge", "健康充电") + "</span></div>";
    }
    // ② 充电上限(number, 50~100)
    const clId = this._entId("charge_limit");
    if (clId) {
      const st = this._ent("charge_limit");
      const a = (st && st.attributes) || {};
      const v = Number(st && st.state);
      const lo = Number.isFinite(Number(a.min)) ? Number(a.min) : 50;
      const hi = Number.isFinite(Number(a.max)) ? Number(a.max) : 100;
      const sAttr = Number(a.step);
      const step = Number.isFinite(sAttr) && sAttr > 0 ? sAttr : 5;
      const val = Number.isFinite(v) ? clampNum(v, lo, hi) : lo;
      const busy = !!this._busy["cl:" + clId];
      h += '<div class="cRow"><span class="cL">充电上限</span><span class="cC">' +
        '<input class="rng" type="range" data-act="charge_limit" data-entity="' + esc(clId) +
        '" min="' + lo + '" max="' + hi + '" step="' + step + '" value="' + val + '"' +
        this._dis(busy) + ">" +
        '<span class="cV">' + fmtNum(val, 0, "%") + "</span></span></div>";
    }
    // ③ 预约充电开关
    if (this._entId("charge_book")) {
      h += '<div class="cRow"><span class="cL">预约充电</span><span class="cC">' +
        this._togChip("charge_book", "预约充电") + "</span></div>";
    }
    // ④ 起始 / 结束时间
    if (this._entId("charge_start") || this._entId("charge_end")) {
      h += '<div class="cRow"><span class="cL">起止时间</span><span class="cC">';
      h += this._timeRow("charge_start", "开始");
      h += this._timeRow("charge_end", "结束");
      h += "</span></div>";
    }
    // ⑤ 电池预热(旧版在动作行里, 挪进充电设置一起管)
    const pre = [["preheat_on", "开"], ["preheat_off", "关"]].filter((p) => this._entId(p[0]));
    if (pre.length) {
      const driving = this._driving();
      h += '<div class="cRow"><span class="cL">电池预热</span><span class="cC">';
      for (const p of pre) {
        const id = this._entId(p[0]);
        const busy = !!this._busy["btn:" + id];
        h += '<button class="chip" data-act="press" data-entity="' + esc(id) + '"' +
          this._dis(driving || busy) + ' title="' + esc(driving ? "行驶中已禁用" : "电池预热" + p[1]) + '">' +
          (busy ? "…" : p[1]) + "</button>";
      }
      h += "</span></div>";
    }
    h += "</div></div>";
    return h;
  }

  _sumCharging() {
    const soc = this._num("battery");
    const chg = this._chgInfo();
    const m = Number(this._attr("charging_state", "remaining_minutes"));
    const parts = [];
    if (soc != null) parts.push(fmtPct(soc));
    if (chg && chg.on) {
      const d = fmtDur(m);
      parts.push(d ? "剩余 " + d : "充电中");
    } else if (chg) {
      parts.push(chg.text);
    }
    return parts.join(" · ");
  }

  _timeRow(key, label) {
    const id = this._entId(key);
    if (!id) return "";
    const raw = this._val(key) || "";
    const hm = String(raw).slice(0, 5);
    return '<span class="timeBox"><span class="rowL2">' + esc(label) + "</span>" +
      '<input class="tinput" type="time" data-act="time" data-entity="' + esc(id) +
      '" value="' + esc(hm) + '"></span>';
  }

  // ── 座椅与加热: 和「充电」并排成一张卡, 正文同样走跨整行的详情容器 ──
  _renderComfort() {
    if (!this._vis("comfort")) return this._setPanel("comfort", "");
    if (!this._cabinAny()) return this._setPanel("comfort", "");
    const h = '<section class="sec">' + this._foldHead("comfort", "座椅与加热", this._sumSeats()) + "</section>";
    this._setPanel("comfort", h);
  }

  // ── 后排座椅: v4 起二排/三排都并进了 comfort 的座舱模型(纯电 C10 没有后排键, 本来就不显示)。
  //    这个面板位留着只是为了 show 配置里写 "seats" 不报错, 现在总是空的。 ──
  _renderSeats() {
    this._setPanel("seats", "");
  }

  /** 座舱模型有没有内容(没有对应键就整块不渲染) */
  _cabinAny() {
    for (const s of CABIN_SEATS) {
      if ((s.heat && this._entId(s.heat)) || (s.vent && this._entId(s.vent))) return true;
    }
    return !!(this._entId("steering_heat") || this._entId("mirror_heat"));
  }

  /**
   * 座舱俯视图(官方 App 那种): 方向盘在上中, 左右后视镜在左上/右上角,
   * 前排左右各一个(中间是中央扶手位), 下面依次是二排、三排。
   * 缺键的座位/整排都不渲染 —— 纯电 C10 只有前排, C16 才有二/三排。
   */
  _cabin() {
    const stId = this._entId("steering_heat");
    const mirId = this._entId("mirror_heat");
    let h = '<div class="cabin">';
    // ── 顶部: 左后视镜 / 方向盘 / 右后视镜 ──
    if (mirId || stId) {
      h += '<div class="cabRow top">';
      if (mirId) h += this._cabSwitch("mirror_heat", "mirror", "后视镜加热", "左后视镜");
      h += '<div class="cabMid">' + (stId ? this._cabSwitch("steering_heat", "steering", "方向盘加热", "方向盘") : "") + "</div>";
      if (mirId) h += this._cabSwitch("mirror_heat", "mirror", "后视镜加热", "右后视镜");
      h += "</div>";
    }
    // ── 前排 / 二排 / 三排 ──
    for (const r of ["front", "rear", "third"]) {
      const left = this._cabSeatOf(r, "left");
      const right = this._cabSeatOf(r, "right");
      if (!left && !right) continue;                    // 这一排没有键 → 整行不渲染
      h += '<div class="cabRow ' + r + '">';
      h += left || "<span></span>";
      if (r === "front") h += '<div class="cabConsole" title="中央扶手"></div>';
      h += right;
      h += "</div>";
    }
    h += "</div>";
    return h;
  }

  /** 第几排某一侧的座位(没有可点的功能就返回空串) */
  _cabSeatOf(row, pos) {
    for (const s of CABIN_SEATS) {
      if (s.row !== row || s.pos !== pos) continue;
      const heat = s.heat && this._entId(s.heat) ? s.heat : "";
      const vent = s.vent && this._entId(s.vent) ? s.vent : "";
      if (!heat && !vent) return "";
      const driving = this._driving();
      // 加热与通风各一颗图标(都存在时并排), 颜色/图形各自表示自己的档位
      let h = '<div class="cabCell"><div class="cabIco">';
      if (heat) h += this._cabSeatIcon(heat, "heat", s.label + "加热", driving);
      if (vent) h += this._cabSeatIcon(vent, "vent", s.label + "通风", driving);
      h += "</div><span class=\"cabLbl\">" + esc(s.label + " " + this._cabLabel(heat, vent)) + "</span></div>";
      return h;
    }
    return "";
  }

  /**
   * 座位上的一颗功能图标:
   *   通风 关 = fan-off(灰), 1/2/3 档 = fan-speed-1/2/3(蓝, 档位越高亮起的扇叶越多)
   *   加热 关 = car-seat-heater(灰), 1/2/3 档 = fan-speed-1/2/3(红/橙)
   * 点一下 = 档位循环 0→1→2→3→0(number.set_value)
   */
  _cabSeatIcon(key, kind, label, driving) {
    const v = this._num(key);
    const lvl = v == null ? 0 : clampNum(Math.round(v), 0, 3);
    const busy = !!this._busy["seat:" + key];
    const icon = lvl > 0 ? "mdi:fan-speed-" + lvl : (kind === "vent" ? "mdi:fan-off" : "mdi:car-seat-heater");
    const cls = "cabBtn " + kind + (lvl > 0 ? " lv" + lvl : " off");
    const tip = label + " " + lvl + " 档 · 点击循环 0→1→2→3 档";
    return '<button class="' + cls + '" data-act="seatcycle" data-key="' + esc(key) + '"' +
      ' aria-label="' + esc(label + " " + lvl + " 档") + '"' +
      ' title="' + esc(driving ? "行驶中已禁用" : tip) + '"' + this._dis(driving || busy) + ">" +
      '<ha-icon class="ico" icon="' + icon + '"></ha-icon></button>';
  }

  /** 方向盘 / 后视镜: 一个开关(开=红, 关=灰), 点一下开或关 */
  _cabSwitch(key, icon, label, pos) {
    const id = this._entId(key);
    const on = this._val(key) === "on";
    const busy = !!this._busy["sw:" + id];
    const driving = this._driving();
    const tip = label + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开");
    return '<div class="cabCell"><button class="cabBtn sw ' + (on ? "on" : "off") + '" data-act="toggle"' +
      ' data-entity="' + esc(id) + '" data-on="' + (on ? "1" : "0") + '"' +
      ' aria-label="' + esc(label + (on ? " 开" : " 关")) + '"' +
      ' title="' + esc(driving ? "行驶中已禁用" : tip) + '"' + this._dis(driving || busy) + ">" +
      '<ha-icon class="ico" icon="mdi:' + icon + '"></ha-icon></button>' +
      '<span class="cabLbl">' + esc(pos + " " + (on ? "开" : "关")) + "</span></div>";
  }

  /** 座位图标下面那行小字: 「主驾 加热 2 档」/「副驾 加热1·通风2」/「副驾 关」 */
  _cabLabel(heat, vent) {
    const lvl = (key) => {
      if (!key) return 0;
      const v = this._num(key);
      return v == null ? 0 : clampNum(Math.round(v), 0, 3);
    };
    const parts = [];
    const h = lvl(heat);
    const v = lvl(vent);
    if (h > 0) parts.push("加热" + h);
    if (v > 0) parts.push("通风" + v);
    if (!parts.length) return "关";
    if (parts.length === 2) return parts.join("·");     // 两个都开着时用短写法, 小屏也不截断
    return parts[0] + "档";
  }

  /** 折叠态标题右侧的摘要: 列出正在用的档位, 全关时写"全部关闭" */
  _sumSeats() {
    const parts = [];
    for (const s of CABIN_SEATS) {
      const heat = s.heat && this._entId(s.heat) ? s.heat : "";
      const vent = s.vent && this._entId(s.vent) ? s.vent : "";
      const hv = heat ? this._num(heat) : null;
      const vv = vent ? this._num(vent) : null;
      if (hv != null && hv > 0) parts.push(s.label + "加热" + Math.round(hv));
      if (vv != null && vv > 0) parts.push(s.label + "通风" + Math.round(vv));
    }
    if (this._val("steering_heat") === "on") parts.push("方向盘");
    if (this._val("mirror_heat") === "on") parts.push("后视镜");
    return parts.length ? parts.join(" · ") : "全部关闭";
  }

  _togChip(key, label) {
    const id = this._entId(key);
    const on = this._val(key) === "on";
    const busy = !!this._busy["sw:" + id];
    return '<button class="togchip' + (on ? " on" : "") + '" data-act="toggle" data-entity="' + esc(id) +
      '" data-on="' + (on ? "1" : "0") + '"' + this._dis(busy) + ">" + esc(label) +
      "<i>" + (on ? "已开" : "已关") + "</i></button>";
  }

  // ── 燃油(增程车才有, 可折叠) ──
  _renderFuel() {
    if (!this._vis("fuel")) return this._setPanel("fuel", "");
    const lvl = this._num("fuel_level");
    const fr = this._num("fuel_range");
    const tr = this._num("total_range");
    const fc = this._num("fuel_consumption");
    if (lvl == null && fr == null && tr == null && fc == null) return this._setPanel("fuel", "");
    const open = this._secOpen("fuel");
    let h = '<section class="sec">' + this._foldHead("fuel", "燃油", this._sumFuel());
    if (open) {
      h += '<div class="secB">';
      if (lvl != null) {
        const s = clampNum(lvl, 0, 100);
        h += '<div class="fuelHead"><span class="fuelV">' + fmtPct(s) + "</span>" +
          '<span class="rowV">油量</span></div><i class="bar fuel"><b style="width:' + s.toFixed(1) + '%"></b></i>';
        const liters = this._attr("fuel_level", "燃油量_L");
        if (liters != null) h += '<div class="subline">' + fmtNum(liters, 1, "L") + "</div>";
      }
      const kv = [];
      if (fr != null) kv.push(["燃油续航", fmtNum(fr, 0, "km")]);
      if (tr != null) kv.push(["油电总续航", fmtNum(tr, 0, "km")]);
      if (fc != null) {
        let v = fmtNum(fc, 1, "L/100km");
        const ec = this._attr("fuel_consumption", "电耗_kwh_100km");
        if (ec != null) v += " · 电耗 " + fmtNum(ec, 1, "kWh/100km");
        kv.push(["油耗", v]);
      }
      if (kv.length) h += this._kvs(kv);
      h += "</div>";
    }
    h += "</section>";
    this._setPanel("fuel", h);
  }

  _sumFuel() {
    const parts = [];
    const lvl = this._num("fuel_level");
    const fr = this._num("fuel_range");
    if (lvl != null) parts.push(fmtPct(lvl));
    if (fr != null) parts.push(fmtNum(fr, 0, "km"));
    return parts.join(" · ");
  }

  /* v3: 胎压不再单独占一块, 由 hero 里的 _carModel() 画在车模四角(见 _tirePad)。
     show 配置里的 "tires" 键仍然接受(忽略即可), localStorage 里旧存的 tires 会被忽略。 */

  /** 胎压正常区间: 优先卡片配置 tire_range, 没有就用某个胎压实体的 tire_range 属性 */
  _tireRange(key) {
    const use = (t) => {
      if (!t) return null;
      let lo = NaN;
      let hi = NaN;
      if (Array.isArray(t) && t.length >= 2) {
        lo = Number(t[0]);
        hi = Number(t[1]);
      } else if (typeof t === "object") {
        lo = Number(t.min);
        hi = Number(t.max);
      }
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo >= hi) return null;
      return [lo, hi];
    };
    const cfg = this._config ? this._config.tire_range : null;
    return use(cfg) || (key ? use(this._attr(key, "tire_range")) : null);
  }

  // ── 行程摘要(可折叠) ──
  _renderTrip() {
    if (!this._vis("trip")) return this._setPanel("trip", "");
    const trip = this._ent("last_trip");
    const stats = this._ent("trip_stats");
    if (!trip && !stats) return this._setPanel("trip", "");
    const open = this._secOpen("trip");
    let h = '<section class="sec">' + this._foldHead("trip", "行程", this._sumTrip(stats));
    if (open) {
      h += '<div class="secB">';
      h += this._tripCells(trip, stats);
      // 整句提示收进 ⓘ
      h += '<div class="tripTip">' + this._info("完整行程列表 / 轨迹回放用「零跑·行程浏览」卡片") + "</div>";
      h += "</div>";
    }
    h += "</section>";
    this._setPanel("trip", h);
  }

  /**
   * 最近行程的指标网格(2 列 × 3 行): 抄行程卡详情页 .dcell 的排版 —— 小字标签 + 大号数值 + 小字单位。
   * 主数据来自 sensor.*_zui_jin_xing_cheng 的中文属性(里程_km / 时长_分钟 / 耗电_kwh / 百公里能耗_kwh);
   * 这条传感器缺属性时回落到 trip_stats 里的「最近行程」—— 后端把它放在顶层(一个数组, 最近的一段在
   * [0], 键名是英文), 老版本也可能塞在「今日/近7天」里面(中文键), 两种都认。
   * 任何一项取不到就显示 —。这里只放行程本身的指标: 不放电量百分比, 也不放电费。
   */
  _tripCells(trip, stats) {
    const a = (trip && trip.attributes) || {};
    let src = a;
    if (!src["时长_分钟"] && !src["里程_km"] && stats && stats.attributes) {
      const sa = stats.attributes;
      // ① 顶层「最近行程」: 数组(最近一段在 [0])或单个对象
      const top = sa["最近行程"];
      const first = Array.isArray(top) ? top[0] : top;
      // ② 老版本: 塞在「今日」/「近7天」里面
      let nested = null;
      for (const g of ["今日", "近7天"]) {
        const box = sa[g];
        if (box && typeof box === "object" && box["最近行程"]) { nested = box["最近行程"]; break; }
      }
      if (first && typeof first === "object") src = first;
      else if (nested && typeof nested === "object") src = nested;
    }
    const pick = (cn, en) => {
      const v = src[cn] != null ? src[cn] : src[en];
      if (v == null) return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    // 里程: 属性里程_km 优先; 属性没有就用传感器状态(后端里状态本身就是 distance_km)
    let km = pick("里程_km", "distance_km");
    if (km == null && trip) km = this._num("last_trip");
    const durMin = pick("时长_分钟", "duration_min");
    const kwh = pick("耗电_kwh", "energy_kwh");
    const k100 = pick("百公里能耗_kwh", "efficiency");
    const avg = pick("平均速度_kmh", "avg_speed_kmh");
    const t0 = fmtClock(src["开始"] != null ? src["开始"] : src["started_at"]);
    const t1 = fmtClock(src["结束"] != null ? src["结束"] : src["ended_at"]);

    const cells = [
      ["里程", km == null ? null : fmtNum(km, 1, "km")],
      ["耗时", durMin == null ? null : (fmtDur(durMin) || null)],
      ["耗电", kwh == null ? null : fmtNum(kwh, 2, "kWh")],
      ["百公里能耗", k100 == null ? null : fmtNum(k100, 1, "kWh/100km")],
      ["平均速度", avg == null ? null : fmtNum(avg, 0, "km/h")],
      ["时间", (t0 || t1) ? ((t0 || "—") + " → " + (t1 || "—")) : null],
    ];
    let h = '<div class="tgrid">';
    for (const c of cells) {
      const na = c[1] == null;
      // 时间那一格是两个钟点连在一起, 字号收小一号才放得下
      h += '<div class="tcell"><span class="k">' + esc(c[0]) + "</span>" +
        '<span class="v' + (na ? " na" : "") + (c[0] === "时间" ? " sm" : "") + '">' +
        (na ? "—" : esc(c[1])) + "</span></div>";
    }
    return h + "</div>";
  }

  _sumTrip(stats) {
    if (!stats) {
      const km = this._num("last_trip");
      return km == null ? "" : "最近 " + fmtNum(km, 1, "km");
    }
    const today = stats.attributes ? stats.attributes["今日"] : null;
    if (today && typeof today === "object") return "今日 " + fmtNum(today.km, 1, "km");
    return "";
  }

  _kvs(kv) {
    let h = '<div class="kvs">';
    for (const r of kv) {
      h += '<div class="kv"><span class="kvL">' + esc(r[0]) + '</span><span class="kvV">' + esc(r[1]) + "</span></div>";
    }
    return h + "</div>";
  }

  // ── 驻车照片大图覆盖层 ──
  _renderPhoto() {
    const el = this._photoEl;
    if (!el) return;
    if (!this._open.photo) {
      el.style.display = "none";
      el.innerHTML = "";
      return;
    }
    const src = this._photoSrc();
    el.style.display = "";
    el.innerHTML = '<div class="ovlBox" data-act="closep">' +
      (src
        ? '<img class="ovlImg" src="' + esc(src) + '" alt="驻车照片">'
        : '<div class="ovlNone">暂时没有驻车照片</div>') +
      '<button class="ovlX" data-act="closep" title="关闭">' +
      '<ha-icon class="ico sm" icon="mdi:close"></ha-icon></button></div>';
    const img = el.querySelector(".ovlImg");
    if (img) {
      img.addEventListener("error", () => {
        const box = el.querySelector(".ovlBox");
        if (box) box.innerHTML = '<div class="ovlNone">驻车照片加载失败</div>' +
          '<button class="ovlX" data-act="closep" title="关闭"><ha-icon class="ico sm" icon="mdi:close"></ha-icon></button>';
      });
    }
  }

  // ── 交互 ──
  _onClick(ev) {
    const el = ev.target && ev.target.closest ? ev.target.closest("[data-act]") : null;
    if (!el || el.disabled) return;
    const act = el.dataset.act;
    if (act === "lock" || act === "lockround") return this._onLock();
    if (act === "trunk") return this._onTrunk(el.dataset.entity, el.dataset.on === "1");
    if (act === "tires") {
      this._open.tires = !this._open.tires;
      this._render();
      return;
    }
    // 车模容器: 预留将来的"车模视图", 现在按了没反应
    if (act === "vehicle") return;
    if (act === "fold") {
      const sec = el.dataset.sec;
      if (!sec) return;
      if (this._collapsed[sec]) delete this._collapsed[sec];
      else this._collapsed[sec] = true;
      // 「充电」和「座椅与加热」并排成两张卡, 展开一个就把另一个收起来 —— 正文共用跨整行的
      // 详情容器, 两块同时撑开会把版面拉得很长(旧的上下两个块没这个约束)。
      const peer = sec === "charging" ? "comfort" : sec === "comfort" ? "charging" : "";
      if (peer && !this._collapsed[sec]) this._collapsed[peer] = true;
      this._saveFold();
      this._render();
      return;
    }
    if (act === "acc") {
      this._open.climate = !this._open.climate;
      this._render();
      return;
    }
    if (act === "window") {
      this._showWin(!this._open.window);
      return;
    }
    if (act === "winstep") {
      const id = el.dataset.entity;
      this._showWin(false);              // 选完一档自动收起气泡
      if (id) this._call("button", "press", { entity_id: id }, "btn:" + id);
      return;
    }
    if (act === "photo") {
      this._open.photo = true;
      this._render();
      return;
    }
    if (act === "closep") {
      this._open.photo = false;
      this._render();
      return;
    }
    if (act === "press") {
      const id = el.dataset.entity;
      if (id) this._call("button", "press", { entity_id: id }, "btn:" + id);
      return;
    }
    if (act === "toggle") {
      const id = el.dataset.entity;
      if (!id) return;
      const on = el.dataset.on === "1";
      this._call("switch", on ? "turn_off" : "turn_on", { entity_id: id }, "sw:" + id);
      return;
    }
    if (act === "hvac") {
      const id = this._entId("ac");
      if (id) {
        if (el.dataset.val && el.dataset.val !== "off") this._lastHvac = el.dataset.val;
        this._call("climate", "set_hvac_mode", { entity_id: id, hvac_mode: el.dataset.val }, "hvac");
      }
      return;
    }
    if (act === "acpower") return this._onAcPower();
    if (act === "temp") return this._onTemp(Number(el.dataset.delta) || 1);
    if (act === "seat" || act === "seatcycle") {
      return this._onSeat(el.dataset.key, act === "seatcycle" ? 0 : Number(el.dataset.delta) || 0);
    }
    if (act === "pickdev") {
      this._picked = el.dataset.val;
      this._resolveIndex();
      this._scheduleRender();
      return;
    }
  }

  _onChange(ev) {
    const el = ev.target;
    if (!el || !el.dataset) return;
    const act = el.dataset.act;
    if (act === "charge_limit") {
      const id = el.dataset.entity;
      if (!id) return;
      const v = Number(el.value);
      const cur = this._num("charge_limit");
      if (Number.isFinite(v) && (cur == null || Math.abs(cur - v) > 0.001)) {
        this._call("number", "set_value", { entity_id: id, value: v }, "cl:" + id);
      }
      return;
    }
    if (act === "time") {
      const id = el.dataset.entity;
      if (!id) return;
      const v = String(el.value || "");
      if (!/^[0-9]{2}:[0-9]{2}$/.test(v)) return;
      // HA 的 time.set_value 要 "HH:MM:SS"
      this._call("time", "set_value", { entity_id: id, time: v + ":00" }, "time:" + id);
    }
  }

  _onInput(ev) {
    const el = ev.target;
    if (!el || !el.dataset || el.dataset.act !== "charge_limit") return;
    const box = el.parentNode ? el.parentNode.querySelector(".cV") : null;
    if (box) box.textContent = fmtNum(Number(el.value), 0, "%");
  }

  /** 车门锁: 解锁与上锁都要 window.confirm 二次确认(说清后果); 行驶中直接拒绝 */
  _onLock() {
    const id = this._entId("lock");
    if (!id || this._driving()) return;
    const st = this._val("lock") || "unknown";
    if (st === "locked") {
      if (!window.confirm("确定要解锁车门吗?\n解锁后车门不再上锁, 请确认车内没有遗留物品。")) return;
      this._call("lock", "unlock", { entity_id: id }, "lock");
    } else {
      if (!window.confirm("确定要上锁车门吗?\n上锁后需要再次解锁才能进入车内。")) return;
      this._call("lock", "lock", { entity_id: id }, "lock");
    }
  }

  /** 后备箱: 开/关都要 window.confirm 二次确认(说清后果); 行驶中直接拒绝 */
  _onTrunk(id, on) {
    if (!id || this._driving()) return;
    if (on) {
      if (!window.confirm("确定要关闭后备箱吗?")) return;
      this._call("switch", "turn_off", { entity_id: id }, "sw:" + id);
    } else {
      if (!window.confirm("确定要打开后备箱吗?\n请先确认车尾周围没有行人或障碍物。")) return;
      this._call("switch", "turn_on", { entity_id: id }, "sw:" + id);
    }
  }

  /** 车窗四档气泡: 开的时候在 document 上挂一个捕获阶段的点击监听, 点任何非气泡处就收起 */
  _showWin(on) {
    if (this._open.window === on) return;
    this._open.window = on;
    if (on) {
      const self = this;
      this._winOutside = function (ev) {
        const path = (ev.composedPath && ev.composedPath()) || [];
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
  _onAcPower() {
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
    this._call("climate", "set_hvac_mode", { entity_id: id, hvac_mode: next }, "hvac");
  }

  _onTemp(delta) {
    const st = this._ent("ac");
    if (!st) return;
    const a = st.attributes || {};
    const stepAttr = Number(a.target_temp_step);
    const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;
    const lo = Number.isFinite(Number(a.min_temp)) ? Number(a.min_temp) : 16;
    const hi = Number.isFinite(Number(a.max_temp)) ? Number(a.max_temp) : 32;
    let t = Number(a.temperature);
    if (!Number.isFinite(t)) t = 24;
    const dir = delta > 0 ? 1 : -1;
    const nt = clampNum(Math.round((t + dir * step) * 10) / 10, lo, hi);
    this._call("climate", "set_temperature", { entity_id: this._entId("ac"), temperature: nt }, "temp");
  }

  _onSeat(key, delta) {
    if (!key) return;
    const id = this._entId(key);
    if (!id) return;
    const cur = this._num(key);
    const base = cur == null ? 0 : clampNum(Math.round(cur), 0, 3);
    const next = clampNum(base + delta, 0, 3);
    if (delta === 0) {
      this._call("number", "set_value", { entity_id: id, value: (base + 1) % 4 }, "seat:" + key);
      return;
    }
    if (next === base) return;                          // 到顶/到底就不发包
    this._call("number", "set_value", { entity_id: id, value: next }, "seat:" + key);
  }

  // ── 构建 ──
  _build() {
    this.shadowRoot.innerHTML = `
      <style>
        /* v5 配色: 与「零跑·行程浏览」卡片同一套视觉语言 —— 外层大卡白底(同行程卡),
           里面的子块(充电/座椅/燃油/行程/空调/位置)压一层浅灰, 灰块里的按钮再翻回白底,
           于是"白 → 灰 → 白"三层, 深浅两种主题都靠 HA 变量自适应。
           圆角体系也跟行程卡对齐: 大卡 12(同行程卡) / 子块 14 / 胶囊 999 / 圆钮 50%。
           只有语义色(通风蓝/加热红/告警)写死, 且都挑了在白底和灰底上都能看清的值。 */
        :host { display: block; }
        .card {
          background: var(--ha-card-background, var(--card-background-color, #fff));
          color: var(--primary-text-color, #212121);
          border-radius: var(--ha-card-border-radius, 12px);
          padding: 14px; box-sizing: border-box;
          font-size: 13px; line-height: 1.4;
          display: flex; flex-direction: column; gap: 12px;
        }
        button { font: inherit; color: inherit; cursor: pointer; }
        button[disabled] { opacity: .38; cursor: not-allowed; }
        ha-icon { --mdc-icon-size: 20px; display: inline-flex; align-items: center; }
        ha-icon.sm { --mdc-icon-size: 16px; }
        ha-icon.lg { --mdc-icon-size: 24px; }
        .dim { opacity: .62; }
        /* 语义色(白底/深灰底上都看得清) */
        .info { color: var(--secondary-text-color, #6b7280); cursor: help; }
        .hint {
          padding: 8px 12px; border-radius: 14px; font-size: 12px;
          align-items: flex-start; gap: 6px;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .hint .info { flex: none; margin-top: 1px; }
        /* ── 内层卡片(浅灰底, 圆角 14, 一圈很细的内嵌描边 —— 行程卡 .thumb 同一个写法) ── */
        .sec {
          background: var(--secondary-background-color, #e7eaed);
          border-radius: 14px; padding: 12px 14px;
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .secB { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; }
        .subline { font-size: 12px; opacity: .62; }
        .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
        .rowL { font-size: 13px; width: 64px; flex: none; }
        .rowL2 { font-size: 12px; opacity: .7; }
        .rowV { font-size: 13px; font-weight: 600; margin-left: auto; }
        .kvs { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 4px 16px; }
        .kv { display: flex; gap: 8px; min-width: 0; }
        .kvL { opacity: .6; white-space: nowrap; font-size: 12px; }
        .kvV { font-weight: 600; min-width: 0; word-break: break-word; }
        .chips { display: flex; gap: 8px; flex-wrap: wrap; }
        /* ── hero ── */
        .heroHead { display: flex; align-items: flex-start; gap: 8px; }
        .heroId { min-width: 0; }
        .vname { font-size: 20px; font-weight: 600; line-height: 1.2; }
        .vsub { font-size: 12px; opacity: .62; margin-top: 2px; }
        .heroTools {
          margin-left: auto; display: flex; align-items: center; gap: 8px;
          flex-wrap: wrap; justify-content: flex-end; flex: none;
        }
/* 白卡上的小圆钮/胶囊: 压一层浅灰 + 一圈很细的内嵌描边(行程卡 .thumb 同款写法) */
.toolBtn {
          width: 30px; height: 30px; border-radius: 50%; display: inline-flex;
          align-items: center; justify-content: center; padding: 0; flex: none;
          border: none; color: var(--secondary-text-color, #6b7280);
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          transition: background .15s ease, box-shadow .15s ease;
        }
        .toolBtn:hover { background: var(--card-background-color, #fff); box-shadow: 0 1px 3px rgba(0,0,0,.13); }
        .toolBtn:active { transform: scale(.94); }
        .heroMain { display: flex; align-items: flex-end; gap: 12px; margin-top: 12px; }
        .rangeBig { flex: 1; min-width: 0; }
        .rn { font-size: 40px; font-weight: 600; line-height: 1.05; letter-spacing: -.5px; }
        .rn i { font-style: normal; font-size: 15px; font-weight: 500; margin-left: 4px; opacity: .75; }
        .socRow { display: flex; align-items: center; gap: 8px; margin-top: 8px; }
        .soc { font-size: 13px; opacity: .7; white-space: nowrap; }
        .soc i { font-style: normal; margin-left: 1px; }
        .bar {
          flex: 1; height: 6px; border-radius: 3px; display: block; overflow: hidden;
          background: var(--divider-color, rgba(127,127,127,.3));
        }
        .bar b { display: block; height: 100%; border-radius: 3px; background: var(--primary-color, #03a9f4); }
        .bar b.low { background: var(--warning-color, #ffa600); }
        .bar b.crit { background: var(--error-color, #db4437); }
        .bar.fuel { flex: none; width: 100%; }
        .bar.fuel b { background: var(--warning-color, #ffa600); }
        .lockBox {
          display: inline-flex; align-items: center; gap: 6px; padding: 8px 12px;
          border-radius: 999px; font-size: 15px; white-space: nowrap;
          border: none;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .lockBox.armed { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); box-shadow: none; }
        .pill {
          padding: 6px 12px; border-radius: 999px; font-size: 12px;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          color: var(--secondary-text-color, #666); white-space: nowrap;
        }
        .pill.warn { background: var(--warning-color, #ffa600); color: #fff; }
        .pill.chg { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        .heroSub { margin-top: 8px; }
        /* 增程车: 总续航下面的「⚡纯电 / ⛽燃油」两个小胶囊 */
        .rangeChips { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .rchip {
          display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px;
          border-radius: 999px; font-size: 13px; white-space: nowrap;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          color: var(--secondary-text-color, #666);
        }
        .rchip b { font-size: 15px; font-weight: 600; color: var(--primary-text-color, #222); }
        .rchip.ev ha-icon { color: #00bcd4; }
        .rchip.fuel ha-icon { color: var(--warning-color, #ffa600); }
        /* ── 车模区(车辆区的主图; 整块可点, 预留车模视图) ── */
        .carModel {
          position: relative; margin-top: 12px; border-radius: 14px; overflow: hidden;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          height: 200px; padding: 10px 0; box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
        }
        /* 底部要给「胎压」小胶囊留一条出来, 没这个按钮就不用留 */
        .carModel.hasTire { padding: 10px 0 34px; }
        .card.narrow .carModel { height: 160px; padding: 4px 0; }
        .card.narrow .carModel.hasTire { padding: 4px 0 30px; }
        .carSvg { width: 100%; height: 100%; }
        /* 车模改成灰底之后, 描边的整体不透明度要往上抬一档, 否则车太淡看不清轮廓 */
        .carShadow { fill: var(--secondary-text-color, #777); opacity: .16; }
        .carBody { fill: var(--secondary-text-color, #777); opacity: .34; }
        .carWin { fill: var(--secondary-text-color, #777); opacity: .5; }
        .carMirror { fill: var(--secondary-text-color, #777); opacity: .38; }
        .carLine { fill: none; stroke: var(--card-background-color, #fff); stroke-width: 2; opacity: .5; }
        .carTyre { fill: var(--secondary-text-color, #777); opacity: .5; }
        .carHub { fill: var(--card-background-color, #fff); opacity: .85; }
        /* 车模右下角的小胶囊: 胎压开关 */
        .tireTgl {
          position: absolute; left: 50%; bottom: 8px; transform: translateX(-50%);
          display: inline-flex; align-items: center; gap: 4px; padding: 4px 12px;
          border-radius: 999px; font-size: 12px; border: none; white-space: nowrap;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .tireTgl.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        /* 车模四角上的四个轮压数据点(俯视方位: 左前/右前/左后/右后) */
        .tP {
          position: absolute; display: inline-flex; flex-direction: column; align-items: center;
          padding: 3px 8px; border-radius: 10px; font-size: 11px; line-height: 1.2;
          min-width: 54px; background: var(--card-background-color, #fff);
          box-shadow: 0 1px 4px rgba(0,0,0,.2);
        }
        .tP i { font-style: normal; opacity: .6; }
        .tP b { font-size: 13px; font-weight: 600; }
        .tP.a { left: 8px; top: 8px; }
        .tP.b { right: 8px; top: 8px; }
        .tP.c { left: 8px; bottom: 8px; }
        .tP.d { right: 8px; bottom: 8px; }
        .tP.warn { box-shadow: inset 0 0 0 2px var(--warning-color, #ffa600), 0 1px 4px rgba(0,0,0,.2); }
        .tP.warn b { color: var(--warning-color, #ffa600); }
        .tP.bad { box-shadow: inset 0 0 0 2px var(--error-color, #db4437), 0 1px 4px rgba(0,0,0,.2); }
        .tP.bad b { color: var(--error-color, #db4437); }
        /* ── 四个圆形动作按钮(浮在灰卡上的白圆钮) ── */
        .acts { display: flex; gap: 8px; max-width: 560px; }
        .act { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
        .circ {
          width: 56px; height: 56px; border-radius: 50%; border: none; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          transition: transform .12s ease;
        }
        .card.narrow .circ { width: 48px; height: 48px; }
        .circ:active { transform: scale(.94); }
        /* 官方 App 里圆钮都是浅色底, "已开/已锁" 只用一圈主色描边点出来 */
        .circ.on { color: var(--primary-color, #03a9f4); box-shadow: inset 0 0 0 2px var(--primary-color, #03a9f4); }
        .actL { font-size: 13px; opacity: .8; white-space: nowrap; }
        /* 车窗四档: 悬浮气泡(absolute + z-index, 不撑高动作行、也不压住圆钮自己)
           具体的 left/top/箭头位置由 _placeWin() 按「车窗」圆钮实测后写回 inline style,
           下面的值只是 JS 跑之前的兜底(等于旧版: 相对整行居中) */
        .actWin { position: relative; }
        .winPop {
          position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
          box-sizing: border-box; z-index: 6; display: flex; gap: 6px; padding: 8px;
          border-radius: 999px;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: 0 4px 14px rgba(0,0,0,.22), inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          white-space: nowrap;
        }
        /* 小箭头指回上面的圆钮(夹取后气泡不再正对它, 位置由 --winArrow 带过去) */
        .winPop::before {
          content: ""; position: absolute; top: -6px; left: var(--winArrow, calc(50% - 6px));
          width: 12px; height: 12px; transform: rotate(45deg);
          background: var(--secondary-background-color, #e7eaed);
          border-left: 1px solid var(--divider-color, rgba(0,0,0,.08));
          border-top: 1px solid var(--divider-color, rgba(0,0,0,.08));
        }
        .winOpt {
          position: relative; padding: 6px 12px; border-radius: 999px; font-size: 13px;
          display: inline-flex; align-items: center; gap: 4px;
          border: none; background: var(--card-background-color, #fff);
        }
        .winOpt:active { transform: scale(.96); }
        /* 灰块里的按钮/胶囊: 翻回白底, 再压一圈很细的内嵌描边 —— 「白卡 → 灰块 → 白钮」第三层 */
        .chip {
          padding: 8px 14px; border-radius: 999px; font-size: 13px; border: none;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .chip.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        /* 空调模式按钮: 一排三个图标, 当前模式高亮(宽卡片里别拉得太宽) */
        .modes {
          display: flex; gap: 8px; width: 100%; max-width: 320px;
          margin-left: auto; margin-right: auto;
        }
        .mi { padding: 9px 0; flex: 1; display: inline-flex; align-items: center; justify-content: center; }
        .mi:not(.on) { color: var(--secondary-text-color, #6b7280); }
        /* ── 两张并排的小卡 ── */
        .cardsRow { display: flex; gap: 10px; align-items: stretch; }
        .card.narrow .cardsRow { flex-direction: column; }
        .p-climate, .p-location { flex: 1; min-width: 0; display: flex; }
        .p-climate > .sec, .p-location > .sec { flex: 1; }
        .half {
          display: flex; flex-direction: column; gap: 12px;
          background: var(--secondary-background-color, #e7eaed);
          border-radius: 14px; padding: 12px 14px;
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .halfH { display: flex; align-items: flex-end; gap: 8px; cursor: pointer; }
        .halfId { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .bigTxt { font-size: 32px; font-weight: 600; line-height: 1.1; letter-spacing: -.5px; }
        .bigTxt.sm { font-size: 20px; }
        .halfS { font-size: 12px; opacity: .62; }
        .fanBtn {
          margin-left: auto; width: 36px; height: 36px; border-radius: 50%; padding: 0; border: none;
          display: inline-flex; align-items: center; justify-content: center; flex: none;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          color: var(--secondary-text-color, #6b7280);
        }
        .fanBtn.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); box-shadow: none; }
        .floatRow { display: flex; gap: 8px; margin-top: auto; flex-wrap: wrap; align-items: center; }
        .floatPill {
          display: inline-flex; align-items: center; gap: 4px; padding: 8px 12px;
          border-radius: 999px; font-size: 13px; border: none;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        /* ⓘ 靠右贴在胶囊行末尾 */
        .locInfo { margin-left: auto; }
        /* 位置卡拿驻车照片当背景: 半透明遮罩保证文字仍然读得清; 没有照片就退回纯色底 */
        .p-location .loc { position: relative; overflow: hidden; }
        .p-location .loc.hasBg {
          background-size: cover; background-position: center; background-repeat: no-repeat;
        }
        .locVeil {
          position: absolute; inset: 0; display: block;
          background: linear-gradient(180deg, rgba(0,0,0,.52), rgba(0,0,0,.3) 45%, rgba(0,0,0,.55));
        }
        .p-location .loc.hasBg { color: #fff; }
        .p-location .loc.hasBg .halfS { opacity: .85; }
        .p-location .loc.hasBg .halfS.dim { opacity: .7; }
        .p-location .loc.hasBg .floatPill { background: rgba(255,255,255,.92); color: #1c1c1e; }
        .p-location .loc.hasBg .info { color: rgba(255,255,255,.9); }
        .locIn { position: relative; z-index: 1; display: flex; flex-direction: column; gap: 12px; flex: 1; }
        .acBody { display: flex; flex-direction: column; gap: 12px; }
        /* 温度步进整行居中: 两个按钮一样大、温度数字固定宽度 */
        .tempBox { display: flex; align-items: center; gap: 8px; justify-content: center; }
        .step {
          width: 40px; height: 40px; border-radius: 14px; font-size: 18px; line-height: 1; flex: none;
          border: none; background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .step:active { transform: scale(.94); }
        .tval { font-size: 20px; font-weight: 600; width: 64px; flex: none; text-align: center; }
        .tval i { font-style: normal; font-size: 12px; opacity: .6; }
        /* ── 充电 / 座椅与加热: 左右并排两张卡, 展开的详情跨整行铺在下面 ──
           两张卡互斥(点谁展开谁, 另一张自动收起), 窄屏(<420px)退回上下堆叠。 */
        .csRow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: stretch; }
        .card.narrow .csRow { grid-template-columns: 1fr; }
        .csRow > * { min-width: 0; }
        .csRow > .sec { height: 100%; box-sizing: border-box; }
        .csDetail { grid-column: 1 / -1; }
        /* 并排的两张卡只有半幅宽, 标题和摘要挤一行放不下 —— 摘要换到标题下面一行,
           箭头仍在右上角竖着居中(和折叠块"标题+摘要"的读法一致)。 */
        .csRow .foldH {
          display: grid; grid-template-columns: minmax(0, 1fr) auto;
          grid-template-areas: "t c" "s c"; align-items: center; column-gap: 6px;
        }
        .csRow .foldT { grid-area: t; }
        .csRow .foldS {
          grid-area: s; margin-left: 0; text-align: left; padding-left: 0;
          /* 半幅宽放不下一整行摘要(座椅那种"主驾加热3 · 副驾加热1 · …"), 允许折到第二行,
             最多两行 —— grid 拉伸会让两张卡保持等高 */
          white-space: normal; overflow: hidden;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
        }
        .csRow .foldC { grid-area: c; align-self: center; }
        /* 窄屏退回上下堆叠后宽度又够了 —— 标题和摘要回到原来的一行式排版 */
        .card.narrow .csRow .foldH { display: flex; align-items: center; gap: 8px; }
        .card.narrow .csRow .foldS {
          display: block; margin-left: auto; text-align: right; padding-left: 8px;
          white-space: nowrap;
        }
        /* 充电设置: 一行一个设置项 —— 标签在左, 控件在右, 行与行之间一条细分隔线 */
        .cList { display: flex; flex-direction: column; }
        .cRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 9px 0; box-sizing: border-box; }
        .cRow + .cRow { border-top: 1px solid var(--divider-color, rgba(0,0,0,.08)); }
        .cL { font-size: 13px; flex: none; min-width: 68px; }
        .cC { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .cC .rng { flex: 1 1 120px; min-width: 110px; }
        .cV { font-size: 13px; font-weight: 600; min-width: 42px; text-align: right; }
        /* ── 行程指标网格: 抄行程卡详情页 .dcell 的排版(小字标签 + 大号数值 + 小字单位) ── */
        .tgrid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px 8px; }
        .tcell { min-width: 0; }
        .tcell .k { display: block; font-size: 11px; color: var(--secondary-text-color, #6b7280); }
        .tcell .v {
          display: block; font-size: 19px; font-weight: 600; margin-top: 1px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .tcell .v i {
          font-style: normal; font-size: 11px; font-weight: 500; margin-left: 2px;
          color: var(--secondary-text-color, #6b7280);
        }
        .tcell .v.sm { font-size: 15px; }
        .tcell .v.na { color: var(--secondary-text-color, #6b7280); font-weight: 500; }
        /* ── 可折叠的常用块 ── */
        .foldH {
          display: flex; align-items: center; gap: 8px; width: 100%; padding: 0;
          border: none; background: none; text-align: left;
        }
        .foldT { font-size: 15px; font-weight: 600; flex: none; }
        .foldS {
          font-size: 12px; opacity: .62; margin-left: auto; text-align: right;
          min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; padding-left: 8px;
        }
        .foldC { transition: transform .18s ease; opacity: .6; }
        .foldH[aria-expanded="false"] .foldC { transform: rotate(-90deg); }
        /* ── 座舱俯视模型(方向盘/后视镜/前排/二排/三排) ── */
        /* 宽卡片里别贴着左边, 居中更像一台"车" */
        .cabin {
          display: flex; flex-direction: column; gap: 8px;
          max-width: 460px; margin-left: auto; margin-right: auto;
        }
        .cabRow { display: flex; gap: 8px; align-items: flex-start; }
        /* 顶部一行: 左后视镜 / 中间的方向盘 / 右后视镜(两端对齐, 方向盘自然落在中线) */
        .cabRow.top { justify-content: space-between; align-items: flex-start; }
        .cabMid { flex: 1; display: flex; justify-content: center; }
        /* 前排左右各占一边, 中间留出中央扶手位 */
        .cabRow.front > .cabCell { flex: 1; max-width: 152px; }
        .cabConsole {
          width: 34px; flex: none; align-self: stretch; min-height: 44px; border-radius: 10px;
          background: var(--card-background-color, #fff);
          opacity: .55;
        }
        /* 二排 / 三排: 左右各一个 */
        .cabRow.rear > .cabCell, .cabRow.third > .cabCell { flex: 1; max-width: 152px; }
        .cabRow.rear > span, .cabRow.third > span { flex: 1; }
        .cabCell { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
        .cabIco { display: flex; gap: 4px; }
        .cabBtn {
          width: 38px; height: 38px; border-radius: 14px; padding: 0; border: none; flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          color: var(--secondary-text-color, #6b7280);
          transition: transform .12s ease;
        }
        .cabBtn:active { transform: scale(.94); }
        /* 通风蓝 / 加热红, 关着的状态保持灰色 */
        .cabBtn.vent.lv1, .cabBtn.vent.lv2, .cabBtn.vent.lv3 {
          background: rgba(41,182,246,.16); color: #29b6f6;
        }
        .cabBtn.heat.lv1, .cabBtn.heat.lv2, .cabBtn.heat.lv3 {
          background: rgba(255,112,67,.16); color: #ff7043;
        }
        .cabBtn.sw.on { background: rgba(255,112,67,.16); color: #ff7043; }
        .cabLbl {
          font-size: 10px; line-height: 1.3; opacity: .72; max-width: 100%;
          text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        /* ── 开关 / 行程提示 ── */
        .tripTip { display: flex; justify-content: flex-end; }
        .togchip {
          padding: 8px 12px; border-radius: 999px; font-size: 13px; text-align: left;
          border: none; background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .togchip i { font-style: normal; opacity: .55; margin-left: 6px; font-size: 12px; }
        .togchip.on { box-shadow: inset 0 0 0 2px var(--primary-color, #03a9f4); color: var(--primary-color, #03a9f4); }
        .togchip.on i { opacity: .8; }
        .rng { flex: 1; min-width: 120px; accent-color: var(--primary-color, #03a9f4); }
        .tinput {
          font: inherit; font-size: 13px; color: inherit; padding: 6px 8px;
          border: none; border-radius: 14px;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .timeBox { display: inline-flex; align-items: center; gap: 6px; }
        .kvchip {
          padding: 4px 10px; border-radius: 999px; font-size: 12px;
          background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
          white-space: nowrap;
        }
        .kvchip.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        .fuelHead { display: flex; align-items: baseline; gap: 8px; }
        .fuelV { font-size: 24px; font-weight: 600; }
        /* ── 多车候选 / 提示 / toast ── */
        .pick {
          padding: 16px; border-radius: 14px;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .pickT { font-size: 15px; font-weight: 600; }
        .pickS { font-size: 12px; opacity: .7; margin-top: 4px; }
        .pickS code { font-size: 11px; background: var(--card-background-color, #fff); padding: 0 4px; border-radius: 5px; }
        .pickRow {
          display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
          width: 100%; margin-top: 8px; padding: 10px 12px; border-radius: 14px; text-align: left;
          border: none; background: var(--card-background-color, #fff);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .pickRow b { font-size: 13px; }
        .pickRow span { font-size: 11px; opacity: .6; word-break: break-all; }
        .toast {
          display: none; padding: 8px 12px; border-radius: 14px; font-size: 12px;
          background: var(--secondary-background-color, #e7eaed);
          box-shadow: inset 0 0 0 1px var(--divider-color, rgba(0,0,0,.08));
        }
        .toast.on { display: block; }
        .toast.err { color: var(--error-color, #db4437); }
        /* ── 照片覆盖层 ── */
        .ovl {
          position: absolute; inset: 0; z-index: 5; border-radius: var(--ha-card-border-radius, 12px);
          background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center;
          padding: 16px; box-sizing: border-box;
        }
        .ovlBox { position: relative; width: 100%; display: flex; justify-content: center; }
        .ovlImg { display: block; width: auto; height: auto; max-width: 100%; max-height: 70vh; border-radius: 14px; }
        .ovlNone { padding: 32px; color: #fff; font-size: 13px; text-align: center; }
        .ovlX {
          position: absolute; top: 0; right: 0; width: 32px; height: 32px; border-radius: 50%;
          border: none; display: inline-flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,.45); color: #fff;
        }
      </style>
      <div class="card">
        <div class="hint"></div>
        <div class="p-hero"></div>
        <div class="p-actions"></div>
        <div class="cardsRow">
          <div class="p-climate"></div>
          <div class="p-location"></div>
        </div>
        <div class="csRow">
          <div class="p-charging"></div>
          <div class="p-comfort"></div>
          <div class="p-csdetail"></div>
        </div>
        <div class="p-seats"></div>
        <div class="p-fuel"></div>
        <div class="p-trip"></div>
        <div class="toast"></div>
        <div class="ovl"></div>
      </div>`;

    this._hintEl = this.shadowRoot.querySelector(".hint");
    this._toastEl = this.shadowRoot.querySelector(".toast");
    this._photoEl = this.shadowRoot.querySelector(".ovl");
    this._panels = {};
    for (const p of PANELS) this._panels[p] = this.shadowRoot.querySelector(".p-" + p);
    this._panels.seats.className = "p-seats cont";
    this._panels.climate.className = "p-climate";
    this._panels.location.className = "p-location";
    // 充电/座椅的展开正文不是嵌在各自的卡里, 而是放在这两张卡下面那个跨整行的容器里
    this._panels.csdetail.className = "p-csdetail csDetail";
    this._cardEl = this.shadowRoot.querySelector(".card");
    this._cardEl.style.position = "relative";
    this._bindNarrow();
    this.shadowRoot.addEventListener("click", (ev) => this._onClick(ev));
    this.shadowRoot.addEventListener("change", (ev) => this._onChange(ev));
    this.shadowRoot.addEventListener("input", (ev) => this._onInput(ev));
  }

  /** 从 DOM 里摘掉时收尾: 气泡那条 document 监听是全局的, 留着就泄漏了 */
  disconnectedCallback() {
    if (this._winOutside) {
      document.removeEventListener("click", this._winOutside, true);
      this._winOutside = null;
    }
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
    if (this._toastTimer) {
      clearTimeout(this._toastTimer);
      this._toastTimer = null;
    }
  }

  /** 卡片宽度 < 420px 时: 两张小卡上下堆叠、圆钮缩小、车辆区变矮 */
  _bindNarrow() {
    const card = this._cardEl;
    if (!card) return;
    const apply = () => {
      const w = card.clientWidth || 0;
      const narrow = w > 0 && w < 420;
      if (narrow !== this._narrow) {
        this._narrow = narrow;
        card.classList.toggle("narrow", narrow);
      }
    };
    this._narrow = null;
    apply();
    if (typeof ResizeObserver === "function") {
      this._ro = new ResizeObserver(apply);
      this._ro.observe(card);
    }
  }
}

if (!customElements.get("leapmotor-control")) {
  customElements.define("leapmotor-control", LeapmotorControlCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-control")) {
  window.customCards.push({
    type: "leapmotor-control",
    name: "零跑·车辆控制",
    description: "App 风格主界面: 续航/锁/车窗/空调/充电/座椅/燃油/胎压/行程/位置",
    preview: true,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}

console.info(`%c 零跑·车辆控制 ${CARD_VERSION} `, "color:#fff;background:#1e88e5;border-radius:3px");