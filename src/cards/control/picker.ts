/*
 * 零跑·车辆控制 —— 自绘取色器(「设置」弹窗里两行色块的"彩虹圆"点开后那块面板)。
 *
 * 为什么不引第三方: 这里只需要"挑一个 `#rrggbb`", 自绘一小块就够(不新增依赖):
 *   ① SV 方块(左上白 → 右上纯色 → 左下黑) + **圆环形**手柄;
 *   ② 彩虹色相滑条(原生 `input[type=range]`, 天生支持方向键微调) + 圆形手柄;
 *   ③ 底部一行: 预览小色块 + hex 输入框 + 「100 %」(不透明度, 本卡固定 100%) +
 *      「hex ⌄」(格式) + 吸管按钮(**浏览器没有 `window.EyeDropper` 时不渲染它**)。
 * 结构与交互参考了素材自带的 3D 查看器 bundle 里内嵌的 Pickr(`.pcr-app`), 但是**自己写的一份紧凑实现**。
 *
 * 交互(全部即时生效, 没有"应用"按钮):
 *   * SV 方块: 按下/拖动改饱和度与明度; 聚焦后方向键微调(←→ 饱和度, ↑↓ 明度);
 *   * 色相滑条: 原生 range 的 input 事件 + 方向键(左右键 ±1°);
 *   * hex 输入框: 回车 / 失焦应用(非法输入还原成当前色);
 *   * 面板点外面关闭(与车窗/预设气泡同一套, 见 index.ts 的 _showPal)。
 *
 * ⚠️ 面板颜色的真源是 **HSV**(`_palH/_palS/_palV`), 不是 hex: 拖到最暗(v=0)或最浅(s=0)时
 *    hex 会把色相丢掉, 用 hex 当状态的话手柄会自己跳回 0°(Pickr 之类的实现也都要留一份 hsv)。
 */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { clamp } from "../../lib/dom";
import { readPalette, writePalette } from "../../lib/palette";
import { car3dHexShown } from "./render-hero";
import type { ControlCtx } from "./types";

/** 取色器的两个落点: `accent` = 卡片配色 · 主题色; `hex` = 车模自定义车漆。 */
export type PalTarget = "accent" | "hex";

/** 「跟随主题」时取色器里显示/起始的兜底色 = HA 主题里 `--primary-color` 的默认值。 */
export const PAL_FALLBACK = "#03a9f4";

/* ── #rrggbb ↔ HSV ── */

/** `#rrggbb` → `{h:0~360, s:0~1, v:0~1}`(认不出当黑色)。 */
export function hexToHsv(hex: string): { h: number; s: number; v: number } {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(String(hex || "").trim());
  const n = m ? parseInt(m[1], 16) : 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d > 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h: h, s: mx > 0 ? d / mx : 0, v: mx };
}

/** `{h,s,v}` → `#rrggbb`(小写)。 */
export function hsvToHex(h: number, s: number, v: number): string {
  const hh = (((h % 360) + 360) % 360) / 60;
  const ss = clamp(Number(s) || 0, 0, 1);
  const vv = clamp(Number(v) || 0, 0, 1);
  const c = vv * ss;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = vv - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (hh < 1) { r = c; g = x; }
  else if (hh < 2) { r = x; g = c; }
  else if (hh < 3) { g = c; b = x; }
  else if (hh < 4) { g = x; b = c; }
  else if (hh < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const to = (q: number) => Math.round((q + m) * 255).toString(16).padStart(2, "0");
  return "#" + to(r) + to(g) + to(b);
}

/** 面板当前的颜色(由 HSV 现算, 拖到黑/白也不丢色相)。 */
export function palHexNow(ctx: ControlCtx): string {
  return hsvToHex(ctx._palH, ctx._palS, ctx._palV);
}

/** 打开面板: 把 HSV 初始化为该落点**当前**的颜色(主题色没设过就用兜底色)。 */
export function palInit(ctx: ControlCtx, key: PalTarget): void {
  const hex = key === "accent" ? readPalette().accent || PAL_FALLBACK : car3dHexShown(ctx);
  const c = hexToHsv(hex);
  ctx._palH = c.h;
  ctx._palS = c.s;
  ctx._palV = c.v;
}

/** 把面板当前颜色**即时**落到该落点(主题色 → 写本机 + 广播; 车漆 → 写本机 + paint 消息)。 */
export function palApplyColor(ctx: ControlCtx): void {
  const hex = palHexNow(ctx);
  if (ctx._palOpen === "accent") {
    // 写本机 + 在 window 上广播(六张卡立即重涂); 本卡也在广播里被重新渲染
    writePalette({ accent: hex });
    ctx._scheduleRender();
    return;
  }
  if (ctx._palOpen === "hex") {
    ctx._car3dPrefs.hex = hex.toUpperCase();
    delete ctx._car3dPrefs.tsp; // 自定义色生效时把"色表色号"清掉(与旧版「色卡自定义」同一口径)
    // 即时改色走 paint 消息(**不带** URL 参数 → 不会重载模型, 见 index.ts 的 _car3dUrl)
    ctx._postCar3d({ t: "paint", hex: hex.toUpperCase() });
    ctx._scheduleRender();
  }
}

/** hex 文本解析(`#abc` / `abc` / `#aabbcc` 都收); 认不出返回空串。 */
function parseHexText(raw: string): string {
  let s = String(raw || "").trim().toLowerCase();
  if (s.charAt(0) !== "#") s = "#" + s;
  if (/^#[0-9a-f]{3}$/.test(s)) {
    s = "#" + s.charAt(1) + s.charAt(1) + s.charAt(2) + s.charAt(2) + s.charAt(3) + s.charAt(3);
  }
  return /^#[0-9a-f]{6}$/.test(s) ? s : "";
}

/* ── 面板 ── */

/** 吸管按钮: 浏览器没有 `window.EyeDropper` 时**不渲染**(而不是画一个点了没反应的按钮)。 */
function eyeBtnT(): TemplateResult | typeof nothing {
  const has = typeof (window as any).EyeDropper === "function";
  if (!has) return nothing;
  return html`<button class="palEye" data-act="paleye" title="从屏幕上取一个颜色"><ha-icon class="ico sm" icon="mdi:eyedropper"></ha-icon></button>`;
}

/** 取色器面板(绝对定位, 贴在触发的彩虹圆下方; 位置由 index.ts 的 _placePal 实测写回)。 */
export function palPickerT(ctx: ControlCtx): TemplateResult | typeof nothing {
  if (!ctx._palOpen) return nothing;
  const hex = palHexNow(ctx);
  const shown = ctx._palHexDraft != null ? ctx._palHexDraft : hex;
  const hue = Math.round(ctx._palH);
  const svBg = "linear-gradient(to top, #000, rgba(0,0,0,0)), linear-gradient(to right, #fff, hsl(" +
    hue + ",100%,50%))";
  return html`<div class="palPop" data-act="palpop" role="dialog" aria-label="取色器"><div class="palSV" data-act="palsv" tabindex="0" role="slider" aria-label="饱和度与明度(方向键微调)" style="background:${svBg}"><i class="palPick" style="left:${(ctx._palS * 100).toFixed(
    1,
  )}%;top:${((1 - ctx._palV) * 100).toFixed(1)}%"></i></div><input class="palHue" data-act="palhue" type="range" min="0" max="359" step="1" aria-label="色相" value="${hue}" .value=${live(
    String(hue),
  )}><div class="palBar"><i class="palPrev" style="background:${hex}"></i><input class="palHex" data-act="palhexinput" type="text" maxlength="7" spellcheck="false" aria-label="十六进制颜色" value="${shown}" .value=${live(
    shown,
  )}><span class="palPct" title="不透明度固定 100%(本卡片只存 #rrggbb)"><b>100</b><i>%</i></span><span class="palFmt" title="只支持 hex 格式">hex<ha-icon class="ico xs" icon="mdi:chevron-down"></ha-icon></span>${eyeBtnT()}</div>${ctx._palOpen==='hex'?html`<div class="paintActions"><button data-act="paintcancel">返回</button><button data-act="paintconfirm">确定</button></div>`:nothing}</div>`;
}

/* ── 交互 ── */

/** 把指针位置换算成饱和度/明度并即时生效。 */
function setFromPoint(ctx: ControlCtx, el: HTMLElement, x: number, y: number): void {
  const r = el.getBoundingClientRect();
  if (!r.width || !r.height) return; // 量不到尺寸(隐藏/无布局的环境)→ 不动
  ctx._palS = clamp((x - r.left) / r.width, 0, 1);
  ctx._palV = 1 - clamp((y - r.top) / r.height, 0, 1);
  palApplyColor(ctx);
  ctx._scheduleRender();
}

/** 阴影根上的 pointer 委托(down/move/up 三个阶段共用; 拖动期间指针被 SV 方块捕获)。 */
export function onPalPointer(ctx: ControlCtx, ev: PointerEvent, phase: "down" | "move" | "up"): void {
  if (!ctx._palOpen) return;
  const t = ev.target as HTMLElement | null;
  const el = t && t.closest ? (t.closest('[data-act="palsv"]') as HTMLElement | null) : null;
  if (phase === "down") {
    if (!el) return;
    ev.preventDefault();
    ctx._palDrag = true;
    try {
      el.setPointerCapture(ev.pointerId);
    } catch (err) { /* 指针已经没了就算了 */ }
    setFromPoint(ctx, el, ev.clientX, ev.clientY);
    return;
  }
  if (!ctx._palDrag) return;
  if (phase === "move") {
    // 捕获之后事件都发给 SV 方块, 这里用捕获元素自己算(拿不到就退回 event target)
    const box = (el || (ev.target as HTMLElement | null)) as HTMLElement | null;
    if (box && box.getAttribute && box.getAttribute("data-act") === "palsv") {
      setFromPoint(ctx, box, ev.clientX, ev.clientY);
    }
    return;
  }
  ctx._palDrag = false;
}

/** 阴影根上的键盘委托: SV 方块的方向键微调(色相滑条走原生 range 的方向键)、hex 输入框回车提交。 */
export function onPalKeyDown(ctx: ControlCtx, ev: KeyboardEvent): void {
  if (!ctx._palOpen) return;
  const t = ev.target as HTMLElement | null;
  if (!t || !t.dataset) return;
  // hex 输入框: 回车提交(失焦也提交, 见 onPalFocusOut); Esc = 放弃这次输入, 还原成当前色
  if (t.dataset.act === "palhexinput") {
    if (ev.key === "Enter") {
      ev.preventDefault();
      applyHexText(ctx, (t as HTMLInputElement).value);
    } else if (ev.key === "Escape") {
      ev.preventDefault();
      ctx._palHexDraft = null;
      ctx._scheduleRender();
    }
    return;
  }
  if (t.dataset.act !== "palsv") return;
  const step = ev.shiftKey ? 10 : 2; // %
  let hit = true;
  if (ev.key === "ArrowLeft") ctx._palS = clamp(ctx._palS - step / 100, 0, 1);
  else if (ev.key === "ArrowRight") ctx._palS = clamp(ctx._palS + step / 100, 0, 1);
  else if (ev.key === "ArrowUp") ctx._palV = clamp(ctx._palV + step / 100, 0, 1);
  else if (ev.key === "ArrowDown") ctx._palV = clamp(ctx._palV - step / 100, 0, 1);
  else hit = false;
  if (!hit) return;
  ev.preventDefault();
  palApplyColor(ctx);
  ctx._scheduleRender();
}

/** hex 输入框失焦: 与回车同一条路(非法输入还原成当前色)。 */
export function onPalFocusOut(ctx: ControlCtx, ev: FocusEvent): void {
  const t = ev.target as HTMLInputElement | null;
  if (!t || !t.dataset || t.dataset.act !== "palhexinput") return;
  applyHexText(ctx, t.value);
}

/** 回车提交 / 失焦提交共用: 非法就还原(把输入框写回当前色)。 */
export function applyHexText(ctx: ControlCtx, raw: string): void {
  const hex = parseHexText(raw);
  if (hex) {
    const c = hexToHsv(hex);
    ctx._palH = c.h;
    ctx._palS = c.s;
    ctx._palV = c.v;
    ctx._palHexDraft = null;
    palApplyColor(ctx);
  } else {
    ctx._palHexDraft = null; // 非法输入 → 还原
  }
  ctx._scheduleRender();
}

/** 色相滑条的 input 事件(原生 range: 拖动 + 方向键都会来)。 */
export function onPalHue(ctx: ControlCtx, el: HTMLInputElement): void {
  const h = Number(el.value);
  if (!Number.isFinite(h)) return;
  ctx._palH = clamp(h, 0, 359.999);
  palApplyColor(ctx);
  ctx._scheduleRender();
}

/** 吸管(只在浏览器支持 window.EyeDropper 时才可能有这个按钮)。 */
export function onPalEye(ctx: ControlCtx): void {
  const ED = (window as any).EyeDropper;
  if (typeof ED !== "function") return;
  try {
    new ED().open().then((res: { sRGBHex?: string }) => {
      const hex = parseHexText(String((res && res.sRGBHex) || ""));
      if (!hex) return;
      const c = hexToHsv(hex);
      ctx._palH = c.h;
      ctx._palS = c.s;
      ctx._palV = c.v;
      ctx._palHexDraft = null;
      palApplyColor(ctx);
      ctx._scheduleRender();
    }).catch(() => { /* 用户取消(Esc)就算了 */ });
  } catch (err) { /* 取色器打不开就算了 */ }
}

/** 面板贴位: 贴在触发的彩虹圆下方, 并夹回**它所在的盒子**内(太低就翻到圆的上方)。
 *
 *  ⚠️ 定位基准跟着 .palPop 的**定位祖先**走, 不再写死 .card: 1.9.39 起设置正文活在弹窗
 *  (.smodal, position: absolute)里 —— 写死 .card 的话 left/top 会整体偏掉一个弹窗偏移
 *  (面板会飘到弹窗外)。offsetParent 量不到(jsdom 无布局)就退回 .card, 那里本来也会因为
 *  宽度为 0 直接跳过贴位。 */
export function placePalPop(ctx: ControlCtx): void {
  const sr = ctx.shadowRoot;
  if (!sr || !ctx._palOpen) return;
  if(ctx._palOpen==='hex')return; // 车漆调色器在车模下方使用正常文档流。
  const pop = sr.querySelector(".palPop") as HTMLElement | null;
  const anchor = sr.querySelector('[data-act="palopen"][data-key="' + ctx._palOpen + '"]') as HTMLElement | null;
  const card = sr.querySelector(".card") as HTMLElement | null;
  if (!pop || !anchor || !card) return;
  const base = (pop.offsetParent as HTMLElement | null) || card;
  const cb = base.getBoundingClientRect();
  const ab = anchor.getBoundingClientRect();
  if (!cb.width) return; // 无布局的环境(jsdom)不贴位
  const pad = 8;
  pop.style.maxWidth = Math.max(cb.width - pad * 2, 200) + "px";
  const w = pop.offsetWidth || 240;
  const h = pop.offsetHeight || 190;
  const left = Math.min(Math.max(ab.left - cb.left + ab.width / 2 - w / 2, pad), Math.max(cb.width - pad - w, pad));
  let top = ab.bottom - cb.top + pad;
  if (top + h > cb.height - pad) {
    const up = ab.top - cb.top - h - pad;
    top = up >= pad ? up : Math.max(Math.min(cb.height - pad - h, top), pad);
  }
  pop.style.left = left + "px";
  pop.style.top = top + "px";
}
