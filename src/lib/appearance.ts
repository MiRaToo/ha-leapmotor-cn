/*
 * 外观偏好(界面风格) —— 与本机主题色并列的第二个**本机**设置。
 *
 * 数据流(方案 §5.1):
 *   本机偏好 + HA 明暗 → 卡片宿主上的 --lm-* 变量 → 共享控件层 → 各卡布局
 *
 * 存储:
 *   * `leapmotor.appearance = { version: 1, style: "soft" }` —— 版本化, 未知值回落 soft。
 *   * 主题色继续用**原来的** `leapmotor.palette` 键(见 palette.ts), 不更名不清空。
 *
 * 广播:
 *   * 同页: window 自定义事件 `leapmotor:appearance`(六张卡立即重涂);
 *   * 跨标签页: storage 事件。
 *
 * ⚠️ 六张卡是**五个独立 bundle**, 各带一份本模块的副本 —— 模块级变量不是全页单例。
 *    所以"当前页正在预览哪套风格"这份状态挂在 window 上(`__leapmotorAppearanceV1`),
 *    否则点预览时只有控车卡会变, 另外四张不动。
 *
 * ⚠️ localStorage 不可写时(隐私模式等)**本页仍然可切换**: 内存快照先改, 存储尽力而为,
 *    广播照样派发。旧的 palette.ts 在这一点上是有缺口的(存失败时事件不带内容, 订阅端
 *    重新读存储会读回旧值) —— 新偏好层用"事件 + window 快照"补齐, 不依赖重新读存储。
 */

import { applyPalette, PALETTE_EVENT, PALETTE_KEY } from "./palette";
import { DEFAULT_STYLE, isStyleId, resolveTokens, type StyleId } from "./ui/presets";
import { applyTokens } from "./ui/tokens";

/** localStorage 键(全局单一, 不按设备)。 */
export const APPEARANCE_KEY = "leapmotor.appearance";

/** 风格变更广播事件名(同页)。 */
export const APPEARANCE_EVENT = "leapmotor:appearance";

/** 变量/属性的载具键: 卡片宿主元素上的 `data-lm-style`。 */
export const STYLE_ATTR = "data-lm-style";

const VERSION = 1;

export interface Appearance {
  style: StyleId;
}

interface PageState {
  /** 已持久化的风格(可能因为存储不可写而只存在于内存)。 */
  style: StyleId;
  /** 正在预览的风格; null = 没有预览。 */
  preview: StyleId | null;
}

/** 挂 window 的共享状态键(五个 bundle 共用一份)。 */
const PAGE_KEY = "__leapmotorAppearanceV1";

function readStored(): StyleId {
  let raw = "";
  try {
    raw = window.localStorage.getItem(APPEARANCE_KEY) || "";
  } catch (err) {
    return DEFAULT_STYLE; // 本地存储不可用
  }
  if (!raw) return DEFAULT_STYLE;
  try {
    const o = JSON.parse(raw) as Record<string, unknown> | null;
    if (!o || typeof o !== "object") return DEFAULT_STYLE;
    // 版本不认识就回默认(未来版本可以在这里做迁移)
    if (o.version != null && Number(o.version) !== VERSION) return DEFAULT_STYLE;
    return isStyleId(o.style) ? o.style : DEFAULT_STYLE;
  } catch (err) {
    return DEFAULT_STYLE; // 内容坏了当没存过
  }
}

function persist(style: StyleId): void {
  try {
    if (style === DEFAULT_STYLE) window.localStorage.removeItem(APPEARANCE_KEY);
    else
      window.localStorage.setItem(
        APPEARANCE_KEY,
        JSON.stringify({ version: VERSION, style: style })
      );
  } catch (err) {
    /* 存不了也照样在本页生效(见文件头说明) */
  }
}

function state(): PageState {
  const w = window as unknown as Record<string, unknown>;
  let s = w[PAGE_KEY] as PageState | undefined;
  if (!s) {
    s = { style: readStored(), preview: null };
    try {
      w[PAGE_KEY] = s;
    } catch (err) {
      /* 挂不上就每次重建 —— 退化成"只有本卡立即生效" */
    }
  }
  return s;
}

function emit(): void {
  try {
    window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT));
  } catch (err) {
    /* 环境不支持 CustomEvent 就算了 */
  }
}

/** 已持久化的风格(不含未提交的预览)。 */
export function readAppearance(): Appearance {
  return { style: state().style };
}

/** 本页**实际生效**的风格(预览优先)。 */
export function effectiveStyle(): StyleId {
  const s = state();
  return s.preview || s.style;
}

/** 是否处在"改了但没应用"的预览态。 */
export function isPreviewing(): boolean {
  return !!state().preview;
}

/** 进入/切换预览(不写存储, 只在本页生效)。 */
export function previewStyle(id: StyleId): void {
  const s = state();
  const next: StyleId = isStyleId(id) ? id : DEFAULT_STYLE;
  if (next === s.style) {
    // 预选回"已保存的那一套"= 没有未应用的改动
    if (!s.preview) return;
    s.preview = null;
  } else if (s.preview === next) {
    return;
  } else {
    s.preview = next;
  }
  emit();
}

/** 应用预览: 持久化 + 广播(跨标签页由 storage 事件自然跟上)。 */
export function commitPreview(): void {
  const s = state();
  if (!s.preview) return;
  s.style = s.preview;
  s.preview = null;
  persist(s.style);
  emit();
}

/** 取消预览: 回到进入预览之前的那一套(不需要动存储)。 */
export function cancelPreview(): void {
  const s = state();
  if (!s.preview) return;
  s.preview = null;
  emit();
}

/** 直接设置并持久化(不经过预览; 供无预览流程的入口使用)。 */
export function setStyle(id: StyleId): void {
  const s = state();
  const next: StyleId = isStyleId(id) ? id : DEFAULT_STYLE;
  s.style = next;
  s.preview = null;
  persist(next);
  emit();
}

/**
 * 订阅外观变化(风格 + 主题色 + 本标签页/其它标签页)。
 * 返回取消订阅的函数。
 */
export function watchAppearance(cb: () => void): () => void {
  const onEv = () => cb();
  const onStorage = (ev: StorageEvent) => {
    // key === null 是 clear() 造成的
    if (!ev || ev.key == null || ev.key === APPEARANCE_KEY) {
      // 别的标签页改了风格 → 重新读存储进本页快照(预览作废)
      const s = state();
      s.style = readStored();
      s.preview = null;
      cb();
      return;
    }
    if (ev.key === PALETTE_KEY) cb();
  };
  window.addEventListener(APPEARANCE_EVENT, onEv);
  window.addEventListener(PALETTE_EVENT, onEv);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(APPEARANCE_EVENT, onEv);
    window.removeEventListener(PALETTE_EVENT, onEv);
    window.removeEventListener("storage", onStorage);
  };
}

/**
 * 把当前风格与主题色写到**宿主元素**上:
 *   * `--lm-*` 语义变量(预设只改这一组值) → 继承进 shadow root, 卡内 CSS 跟着变;
 *   * `data-lm-style` 属性 → 少数需要按风格分支的 CSS 用得上;
 *   * `--primary-color` / `--rgb-primary-color` → 沿用 palette.ts 的老路。
 * 明暗是预设值的输入(玻璃的透明度、粗野主义的墨色都跟明暗有关), 所以由调用方传入。
 */
export function applyAppearance(el: HTMLElement, dark: boolean): void {
  const id = effectiveStyle();
  applyTokens(el, resolveTokens(id, { dark: !!dark }));
  try {
    el.setAttribute(STYLE_ATTR, id);
  } catch (err) {
    /* 老浏览器就算了 */
  }
  applyPalette(el);
}

interface BindOptions {
  /** 当前是否深色主题(每次重涂都要重新问一次 —— 预设值跟明暗有关)。 */
  getDark: () => boolean;
  /** 重涂之后额外要做的事(通常是重绘本卡, 让设置里的选中态跟上)。 */
  onChange?: () => void;
}

/* 每个宿主只维护一份订阅(重连 DOM / 重复 _build 都不叠加)。 */
const SUBS = new WeakMap<HTMLElement, () => void>();

/** 卡片接线(幂等): 订阅外观变化 + 立即涂一次。 */
export function bindAppearance(el: HTMLElement, opts: BindOptions): void {
  if (SUBS.has(el)) return;
  SUBS.set(
    el,
    watchAppearance(() => {
      applyAppearance(el, opts.getDark());
      if (opts.onChange) opts.onChange();
    })
  );
  applyAppearance(el, opts.getDark());
}

/** 取消订阅(disconnectedCallback 里调)。 */
export function unbindAppearance(el: HTMLElement): void {
  const off = SUBS.get(el);
  if (off) {
    off();
    SUBS.delete(el);
  }
}
