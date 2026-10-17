/*
 * 零跑·车辆控制卡 —— hero 车模区(车模图 / 浮动层 / 胎压 / 充电块 / 3D 车模展示层)
 *
 * 从 src/cards/control.ts 原样搬出的方法: 只把接收者 this 换成第一个参数 ctx,
 * 调同类搬出的函数时改为直接调用并补传 ctx; 字符串/类名/data-* 属性/文案一律未改。
 */
import { fmtNum } from "../../lib/format";
import { isDark } from "../../lib/theme";
import type { ChargeInfo, Car3dColor, Car3dColorEff, Car3dInfo, Car3dPrefs } from "./types";
import { CAR_IMG_BASE, CAR_IMG_TOP, BOLT_PATH, CHARGE_LABEL, CAR3D_BACKGROUNDS } from "./types";
import type { ControlCtx } from "./types";
export function tireCorners(ctx: ControlCtx): string[] {
  const slug = String(ctx._carImgSrc || "")
    .slice(CAR_IMG_BASE.length).replace(/\.png$/, "");
  if (ctx._carImgOk === "ok" && CAR_IMG_TOP[slug]) return ["c", "a", "d", "b"];
  return ["a", "b", "c", "d"];
}
export function warnItems(ctx: ControlCtx): { text: string; tip: string }[] {
  const out: { text: string; tip: string }[] = [];
  const low = ctx._lowTires();
  if (low.length) {
    out.push({
      text: "胎压偏低",
      tip: "偏低: " + low.map((x) => x.name + " " + fmtNum(x.v, 2, "bar")).join(" · "),
    });
  }
  // 后备箱 / 车窗没关: 合成一条(不可点击, 用下方圆钮去关)
  const open = ctx._leftOpen();
  if (open.names.length) {
    out.push({
      text: open.names.join("、") + "未关",
      tip: "未关: " + open.names.join("、") +
        "(用下面的圆钮关闭; 车窗在行驶中不算未关提示)",
    });
  }
  return out;
}
export function rangeSubline(ctx: ControlCtx): string {
  if (ctx._isReev()) return "";
  const live = ctx._attr("range", "live_range");
  const main = ctx._num("range");
  if (live != null && main != null && Number(live) !== Number(main)) {
    return "实时续航 " + fmtNum(live, 0, "km");
  }
  return "";
}

export function chgInfo(ctx: ControlCtx): ChargeInfo | null {
  const st = ctx._val("charging_state");
  if (!st) return null;
  let txt = CHARGE_LABEL[st] || st;
  const m = Number(ctx._attr("charging_state", "remaining_minutes"));
  if (st === "charging" && Number.isFinite(m) && m > 0) {
    txt += " · 剩 " + (m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? (m % 60) + " 分" : "") : m + " 分");
  }
  return { text: txt, mode: st === "charging" ? "charging" : st === "plugged" ? "plugged" : "unplugged" };
}

/** 正在充电(只有这一种状态才显示车模左侧的充电块与条上流光)。 */
export function isCharging(ctx: ControlCtx): boolean {
  return ctx._val("charging_state") === "charging";
}

/** 充电实时电参数: 电压 V / 电流 A / 功率 kW。
 *
 * ⚠️ 车端**充电时电流是负的**(实测本车: 电压 688.7 V / 电流 -9.1 A, 与 7kW 慢充的
 * 6.3 kW 相符), 所以功率取 |V×A| —— 直接判 `V*A > 0` 会让数字永不显示。
 */
export function chgPower(ctx: ControlCtx): { v: number; a: number; kw: number } | null {
  const v = Number(ctx._attr("battery", "charging_voltage"));
  const a = Number(ctx._attr("battery", "charging_current"));
  if (!Number.isFinite(v) || !Number.isFinite(a) || v <= 0) return null;
  const kw = Math.abs(v * a) / 1000;
  return { v, a, kw };
}

/** 充电图标: 描边 + 半透明底填 + **底部 75% 的绿色渐变**。
 *
 *  · 中性色(描边/底填)走 CSS 变量 `--bolt-outline/--bolt-fill` —— 原稿是深色,
 *    在深色主题的卡上会看不见, 所以按主题换(绿色渐变原样不动);
 *  · 快充 = 同款闪电 + **右下角同色的 F**(F = Fast);
 *  · 渐变/裁剪的 id 必须**每次唯一**: 同一个 shadow root 里可以同时存在多个图标,
 *    id 撞车会让后一个引用到前一个的渐变(实测: 图标会变成透明或颜色错)。
 */
export function boltIcon(ctx: ControlCtx, fast: boolean, size = 17): string {
  const u = "b" + (++ctx._boltUid);
  const body =
    '<defs><linearGradient id="g' + u + '" x1="0%" y1="100%" x2="0%" y2="0%">' +
    '<stop offset="0%" stop-color="#059669"/><stop offset="100%" stop-color="#34d399"/>' +
    "</linearGradient>" +
    '<clipPath id="c' + u + '"><rect x="0" y="25" width="100" height="75"/></clipPath></defs>' +
    '<path d="' + BOLT_PATH + '" stroke="var(--bolt-outline, #334155)" stroke-width="6"' +
    ' stroke-linejoin="round" fill="var(--bolt-fill, #1e293b)" fill-opacity=".4"/>' +
    '<g clip-path="url(#c' + u + ')">' +
    '<path d="' + BOLT_PATH + '" fill="url(#g' + u + ')" stroke="#10b981" stroke-width="2"' +
    ' stroke-linejoin="round"/></g>' +
    (fast
      ? '<text x="79" y="99" font-size="44" font-weight="700" text-anchor="middle"' +
        ' fill="#10b981" font-family="system-ui, sans-serif"' +
        ' font-style="italic"' +
        // 斜体:字体自带斜体面就用它;没有时浏览器会合成斜体。再叠一个 skew 保证
        // "斜"这件事与字体无关(实测 system-ui 在部分环境下没有斜体面)。
        ' transform="translate(79,99) skewX(-14) rotate(6) translate(-79,-99)">F</text>'
      : "");
  return '<svg class="bolt" viewBox="0 0 100 100" width="' + size + '" height="' + size +
    '" fill="none" xmlns="http://www.w3.org/2000/svg">' + body + "</svg>";
}
export function isFastCharging(ctx: ControlCtx): boolean {
  const v = ctx._attr("charging_state", "dc_connected");
  return v === true || v === 1 || v === "1";
}

// ══ 3D 车模(hero 的车辆区 + 最底下的「设置」子卡) ══════════════════
//
// hero 的车辆区三选一(优先级从高到低):
//   ① 自定义外观图(本机覆盖 → 集成选项 car3d_image): 还是 <img>, 走 _carImg 的老路;
//   ② 3D: info.ready=true → .p-carview 里的 iframe(可拖动旋转);
//   ③ 素材没装配: 官方整车展示图；无素材则隐藏车图, 不联网、不报错。
// 只有 ensure 会联网, 且**只由用户点按钮**触发(见 _onCar3dDownload)。

/** 车模区此刻画 3D 吗: 素材就绪 + 没被自定义外观图顶掉。
 *  自定义图**验证失败**时退回 3D(见 _carImgBad) —— 否则那张图一直在探针里打转, 车模区是空的。 */
export function car3dView(ctx: ControlCtx): boolean {
  const info = ctx._car3d;
  if (!info || info.ready !== true) return false;
  const custom = customCarImg(ctx);
  if (custom && !carImgBad(ctx, custom)) return false;
  return true;
}

/** 该地址是否正处在"验证失败"的退避窗口里(_carImg 失败时记的)。 */
export function carImgBad(ctx: ControlCtx, src: string): boolean {
  return !!src && ctx._carImgApiFailedSrc === src && Date.now() < ctx._carImgRetryAt;
}

/** 自定义车辆外观图(本机覆盖 → 集成选项默认); 空串 = 没设/已被本机清掉。 */
export function customCarImg(ctx: ControlCtx): string {
  const local = ctx._car3dPrefs.img;
  if (local != null) return String(local).trim(); // 本机存过(含 ""=清掉)就听本机的
  const opt = ctx._car3d && ctx._car3d.options ? ctx._car3d.options.car3d_image : "";
  return String(opt || "").trim();
}

/** 实车色号(车型参数里的 colorCode); 空 = 素材没给。 */
export function car3dAutoTsp(ctx: ControlCtx): string {
  const p = ctx._car3d ? ctx._car3d.model_param : null;
  const cc = p ? p.colorCode : null;
  return cc == null || cc === "" ? "" : String(cc);
}

/** 预设与自定义车漆统一走 paint；空串恢复素材的原始车漆材质。 */
export function car3dHexNow(ctx: ControlCtx): string {
  const eff = car3dColorEff(ctx);
  if (eff.kind === "hex") return eff.value;
  if (eff.kind === "tsp" && eff.value !== car3dAutoTsp(ctx)) {
    return car3dColors(ctx).find(c => String(c.tsp) === eff.value)?.hex || "";
  }
  return "";
}

/** 当前生效的车漆: 本机覆盖 → 集成选项默认(car3d_color: #hex 或色表里的色名) → 实车色。 */
export function car3dColorEff(ctx: ControlCtx): Car3dColorEff {
  const prefs = ctx._car3dPrefs;
  if (prefs.hex && /^#[0-9a-fA-F]{6}$/.test(prefs.hex)) {
    return { kind: "hex", value: prefs.hex.toUpperCase() };
  }
  if (prefs.tsp) return { kind: "tsp", value: String(prefs.tsp) };
  const raw = String((ctx._car3d && ctx._car3d.options && ctx._car3d.options.car3d_color) || "").trim();
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return { kind: "hex", value: raw.toUpperCase() };
  if (raw) {
    for (const c of car3dColors(ctx)) {
      if (c.name === raw) return { kind: "tsp", value: String(c.tsp) };
    }
  }
  return { kind: "auto", value: "" };
}

/** 色表(净化过的: 只认有名字 + #RRGGBB 的条目)。 */
export function car3dColors(ctx: ControlCtx): Car3dColor[] {
  const arr = ctx._car3d ? ctx._car3d.colors : null;
  if (!Array.isArray(arr)) return [];
  const out: Car3dColor[] = [];
  for (const c of arr) {
    if (!c || typeof c !== "object") continue;
    const name = String(c.name || "").trim();
    const hex = String(c.hex || "").trim().toUpperCase();
    if (!name || !/^#[0-9A-F]{6}$/.test(hex)) continue;
    if (c.tsp == null || c.tsp === "") continue;
    out.push({ tsp: c.tsp, name: name, hex: hex });
  }
  return out;
}

/** 当前该选中哪个色表色号(自定义色/无色表 → 空串 = 不选任何 chip)。 */
export function car3dSelTsp(ctx: ControlCtx): string {
  const eff = car3dColorEff(ctx);
  if (eff.kind === "tsp") return eff.value;
  if (eff.kind === "hex") return "";
  return car3dAutoTsp(ctx);
}

/** 背景选择: 本机覆盖 → 集成选项 car3d_bg → auto(跟随主题)。 */
export function car3dBgPref(ctx: ControlCtx): string {
  const local = ctx._car3dPrefs.bg;
  if (CAR3D_BACKGROUNDS.some(([key]) => key === local)) return local!;
  const opt = String((ctx._car3d && ctx._car3d.options && ctx._car3d.options.car3d_bg) || "");
  if (CAR3D_BACKGROUNDS.some(([key]) => key === opt)) return opt;
  return "auto";
}

/** 此刻该白天还是夜晚(auto = 跟 HA 主题深浅)。 */
export function car3dNightNow(ctx: ControlCtx): boolean {
  const bg = car3dBgPref(ctx);
  return ["night", "aurora", "blueprint"].includes(bg) ? true : bg === "auto" ? isDark(ctx._hass) : false;
}
export function car3dBackgroundNow(ctx: ControlCtx): string {
  const bg = car3dBgPref(ctx);
  return bg === "auto" ? (isDark(ctx._hass) ? "night" : "day") : bg;
}
export function car3dHexShown(ctx: ControlCtx): string {
  const eff = car3dColorEff(ctx);
  if (eff.kind === "hex") return eff.value;
  const colors = car3dColors(ctx);
  const sel = car3dSelTsp(ctx);
  for (const c of colors) {
    if (String(c.tsp) === sel) return c.hex;
  }
  return colors.length ? colors[0].hex : "#ffffff";
}
export function car3dStateText(ctx: ControlCtx): string {
  if (ctx._car3dErr) return "素材下载失败: " + ctx._car3dErr;
  if (ctx._car3dViewErr) return "3D 查看器异常: " + ctx._car3dViewErr;
  const info = ctx._car3d;
  if (!info) return "";
  if (String(info.state) === "downloading" || ctx._car3dBusy) {
    return "正在下载 3D 车模素材(约 15 MB, 一次性)…";
  }
  if (String(info.state) === "error") {
    return "素材下载失败: " + String(info.error || "").slice(0, 140);
  }
  // 「云端没有这辆车的 3D 素材」不是故障(云端用 modelType 声明: 只有 2D / 没有素材),
  // 所以不加"失败"前缀 —— 原样显示集成给的说明, 也不用诱导车主反复重试。
  if (String(info.state) === "unsupported") {
    return String(info.error || "云端没有下发 3D 素材").slice(0, 140);
  }
  if (info.ready !== true) return "素材未下载";
  const head = "3D · " + car3dColorLabel(ctx) + " · " + car3dBgLabel(ctx);
  return customCarImg(ctx) ? head + " · 当前显示自定义外观图" : head;
}

/** 当前色的可读名(摘要/状态行共用): 自定义 hex 原样, 色表色 → 名字, 都没有 → 实车色。 */
export function car3dColorLabel(ctx: ControlCtx): string {
  const eff = car3dColorEff(ctx);
  if (eff.kind === "hex") return eff.value;
  const sel = car3dSelTsp(ctx);
  if (sel) {
    for (const c of car3dColors(ctx)) {
      if (String(c.tsp) === sel) return c.name;
    }
    return "色号 " + sel;
  }
  return "实车色";
}

export function car3dBgLabel(ctx: ControlCtx): string {
  const bg = car3dBgPref(ctx);
  return CAR3D_BACKGROUNDS.find(([key]) => key === bg)?.[1] || "跟随主题";
}

export function sumCar3d(ctx: ControlCtx): string {
  if (ctx._car3dErr) return "素材下载失败";
  const info = ctx._car3d;
  if (!info) return "";
  if (String(info.state) === "downloading" || ctx._car3dBusy) return "正在下载素材…";
  if (info.ready !== true) return "素材未下载";
  return car3dColorLabel(ctx) + " · " + car3dBgLabel(ctx);
}

/* v3: 胎压不再单独占一块, 由 hero 里的 _carModel() 画在车模四角(见 _tirePad)。
   show 配置里的 "tires" 键仍然接受(忽略即可), localStorage 里旧存的 tires 会被忽略。 */

/** 胎压正常区间: 优先卡片配置 tire_range, 没有就用某个胎压实体的 tire_range 属性 */
export function tireRange(ctx: ControlCtx, key?: string): number[] | null {
  const use = (t: any): number[] | null => {
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
  const cfg = ctx._config ? ctx._config.tire_range : null;
  return use(cfg) || (key ? use(ctx._attr(key, "tire_range")) : null);
}
