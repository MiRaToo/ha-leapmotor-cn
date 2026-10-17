// 卡片配色(主题色) —— 六张卡共用的**本机**设置, 只存浏览器 localStorage。
//
// 为什么不用改任何 CSS: 六张卡的强调色全部消费 HA 的主题变量
// (`--primary-color` / `--rgb-primary-color` …), 所以只需把用户
// 选的颜色写到**卡片宿主元素**的 inline style 上覆盖这几个变量 —— CSS 变量会继承进
// shadow root, 卡内所有 `var(--primary-color, …)` 自动跟着变, 零 CSS 改动。
//
// ⚠️ 1.9.38 起**只留 accent(主题色)**: 原来的 `progress`(电量/状态色 → 覆盖
//    `--success-color` 那一行)已整行去掉, 电量条与绿色标签回到主题原色。旧用户本机存的
//    `progress` 字段在 readPalette 里**忽略并顺手清掉**(见那里)。
//
// 存储: 单一 localStorage 键(**全局, 不按设备/不按卡**) —— 一处设置, 六张卡统一生效。
// 广播: 写入时在 window 上派发自定义事件(同页各卡片立即重涂), 并监听 storage 事件
// (其它标签页改的也要跟上)。
//
// ⚠️ `--rgb-primary-color` 的格式是 `"3, 169, 244"`(逗号+空格), **不是** `rgb(...)` ——
//    卡里有 `rgba(var(--rgb-primary-color), .x)` 这类半透明填充, 不同时更新它就不跟着变。

/** localStorage 键(全局单一, 不按设备)。 */
export const PALETTE_KEY = "leapmotor.palette";

/** 配色变更广播事件名(由 writePalette 在 window 上派发)。 */
export const PALETTE_EVENT = "leapmotor:palette";

export interface Palette {
  /** 主题色 → 覆盖 `--primary-color` / `--rgb-primary-color`; 空串 = 不覆盖(跟随主题)。 */
  accent: string;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 只认 `#rrggbb`(大小写归一成小写); 其余一律当"没设"。 */
function normHex(v: unknown): string {
  const s = String(v == null ? "" : v).trim();
  return HEX_RE.test(s) ? s.toLowerCase() : "";
}

/** `#rrggbb` → `"r, g, b"`(HA 的 `--rgb-primary-color` 约定格式)。 */
export function rgbTriplet(hex: string): string {
  const h = normHex(hex) || "#000000";
  const n = parseInt(h.slice(1), 16);
  return ((n >> 16) & 255) + ", " + ((n >> 8) & 255) + ", " + (n & 255);
}

/** 读取本机配色。解析失败 / 缺字段 / 内容坏了都容错(坏值当"没设过")。
 *
 *  ⚠️ 旧版的 `progress` 字段**忽略并顺手清掉**: 只读到它时, 把本机存储改写成
 *  `{accent}`(accent 也没有就整键删掉) —— 否则那个字段会一直留在用户的浏览器里。 */
export function readPalette(): Palette {
  let raw = "";
  try {
    raw = window.localStorage.getItem(PALETTE_KEY) || "";
  } catch (err) {
    return { accent: "" }; // 本地存储不可用
  }
  if (!raw) return { accent: "" };
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return { accent: "" };
    const accent = normHex(o.accent);
    if (Object.prototype.hasOwnProperty.call(o, "progress")) {
      try {
        if (accent) window.localStorage.setItem(PALETTE_KEY, JSON.stringify({ accent: accent }));
        else window.localStorage.removeItem(PALETTE_KEY);
      } catch (err) { /* 清不掉就算了(下次读还是忽略它) */ }
    }
    return { accent: accent };
  } catch (err) {
    return { accent: "" }; // 内容坏了就当没存过
  }
}

/** 写入本机配色(空值 = 恢复"跟随主题", 于是整键删掉) + 广播给同页各卡。 */
export function writePalette(p: Palette): void {
  const accent = normHex(p && p.accent);
  try {
    if (accent) window.localStorage.setItem(PALETTE_KEY, JSON.stringify({ accent: accent }));
    else window.localStorage.removeItem(PALETTE_KEY);
  } catch (err) {
    /* 存不了就算了(仍会广播, 本页即时生效) */
  }
  // 同页广播: 其它卡片(以及别的标签页里的 storage 事件)立即跟着重涂
  try {
    window.dispatchEvent(new CustomEvent(PALETTE_EVENT));
  } catch (err) {
    /* 环境不支持 CustomEvent 就算了 */
  }
}

/** 把配色写到**宿主元素**的 inline style 上(空值 = removeProperty, 回到主题变量)。
 *  变量会继承进 shadow root, 所以卡内 CSS 一个字节都不用改。 */
export function applyPalette(el: HTMLElement): void {
  const p = readPalette();
  if (p.accent) {
    el.style.setProperty("--primary-color", p.accent);
    el.style.setProperty("--rgb-primary-color", rgbTriplet(p.accent));
  } else {
    el.style.removeProperty("--primary-color");
    el.style.removeProperty("--rgb-primary-color");
  }
}

/** 订阅配色变化(同页自定义事件 + 其它标签页的 storage 事件), 触发时调用 cb。
 *  返回取消订阅的函数。 */
export function watchPalette(cb: () => void): () => void {
  const onEv = () => cb();
  const onStorage = (ev: StorageEvent) => {
    // key === null 是 clear() 造成的; 只认自己这把键(其它卡片的偏好不重涂)
    if (!ev || ev.key == null || ev.key === PALETTE_KEY) cb();
  };
  window.addEventListener(PALETTE_EVENT, onEv);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(PALETTE_EVENT, onEv);
    window.removeEventListener("storage", onStorage);
  };
}

/* 每个宿主元素只维护一份订阅(重新连回 DOM / 重复 _build 都不会叠加)。 */
const SUBS = new WeakMap<HTMLElement, () => void>();

/** 卡片接线(幂等): 订阅配色变化 + 立即涂一次。
 *  - 六张卡各自在一次性初始化点(或 connectedCallback)调用;
 *  - 重新连回 DOM 时会再调一次(同一元素只留一个订阅);
 *  - 断开时用 unbindPalette 取消。 */
export function bindPalette(el: HTMLElement, onChange?: () => void): void {
  if (SUBS.has(el)) return;
  SUBS.set(
    el,
    watchPalette(() => {
      applyPalette(el);
      if (onChange) onChange();
    })
  );
  applyPalette(el);
}

/** 取消某元素的配色订阅(disconnectedCallback 里调)。 */
export function unbindPalette(el: HTMLElement): void {
  const off = SUBS.get(el);
  if (off) {
    off();
    SUBS.delete(el);
  }
}
