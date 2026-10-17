/*
 * 风格预设(preset) —— 五套"同一批语义变量、不同取值"的映射表。
 *
 * 预设**只改变量**, 不改 DOM、不改类名、不改业务模板。所以"同一套 DOM 覆盖四风格"
 * 是结构上成立的: 任何没被变量覆盖到的硬编码颜色/圆角/阴影, 都会成为漏网之鱼 ——
 * 迁移时逐个改成 var(--lm-*, ...) 就是为了不漏。
 *
 * 五套预设的设计边界(见方案 §6):
 *   glass      半透明表面 + 细亮边 + 有限模糊; 模糊只给卡片与浮层(默认)
 *   soft       轻阴影, 现状方向的统一版
 *   brutalist  实色面 + 粗边 + 硬偏移阴影 + 小圆角; 按下时位移而不是缩放
 *   minimal    实色/轻填充 + 细分隔 + 几乎无阴影 + 克制圆角
 *   memphis    明快色块 + 深色粗线 + 几何趣味, 明暗主题都有独立配色
 *
 * ⚠️ 玻璃表面**不依赖透出的底图**维持文字对比: 底色本身就带足够不透明度, 且不支持
 *    模糊时退化成同一风格的不透明底色(所以这里给的是 rgba, 不是 filter 依赖)。
 */

import { baseTokens, type TokenMap } from "./tokens";

/** 预设 id。挂在卡片宿主的 `data-lm-style` 上, 便于 CSS 里做少量分支。 */
export const STYLE_IDS = ["glass", "soft", "brutalist", "minimal", "memphis"] as const;

export type StyleId = (typeof STYLE_IDS)[number];

/** 缺省风格。未知/坏值一律回落到它。 */
export const DEFAULT_STYLE: StyleId = "glass";

export function isStyleId(v: unknown): v is StyleId {
  return typeof v === "string" && (STYLE_IDS as readonly string[]).indexOf(v) >= 0;
}

export interface PresetInfo {
  id: StyleId;
  label: string;
  hint: string;
}

/** 设置子卡里那一排预设(顺序即展示顺序)。 */
export const PRESETS: readonly PresetInfo[] = [
  { id: "glass", label: "玻璃拟态", hint: "半透明表面与柔和模糊" },
  { id: "soft", label: "轻阴影", hint: "柔和浮起，层次清楚" },
  { id: "brutalist", label: "新粗野主义", hint: "粗描边与硬阴影" },
  { id: "minimal", label: "极简扁平", hint: "轻分隔与克制留白" },
  { id: "memphis", label: "孟菲斯", hint: "明快色块与几何趣味" },
];

/**
 * 预设的变量覆盖(只列被改动的项)。
 *
 * `dark` 影响的是**取值本身**(半透明玻璃、粗野主义的墨色), 所以预设值是明暗的函数;
 * 明暗一变, appearance 的订阅会重新解析并重涂(见 appearance.ts)。
 */
export function presetTokens(id: StyleId, opts: { dark: boolean }): TokenMap {
  const dark = !!opts.dark;
  if (id === "glass") {
    // 半透明表面: 浅色主题用白玻璃, 深色主题用冷灰玻璃。不透明度留得比较足,
    // 这样即使卡片背后是纯色(玻璃效果最弱的情况)文字对比也不会掉。
    return {
      "--lm-surface-card": dark ? "rgba(24, 28, 36, .62)" : "rgba(255, 255, 255, .66)",
      "--lm-surface-section": dark ? "rgba(38, 43, 54, .52)" : "rgba(255, 255, 255, .58)",
      "--lm-surface-control": dark ? "rgba(48, 54, 66, .58)" : "rgba(255, 255, 255, .72)",
      "--lm-surface-inset": dark ? "rgba(255, 255, 255, .10)" : "rgba(255, 255, 255, .48)",
      "--lm-surface-floating": dark ? "rgba(28, 33, 42, .90)" : "rgba(255, 255, 255, .88)",
      "--lm-blur-card": "blur(18px) saturate(150%)",
      "--lm-blur-floating": "blur(20px) saturate(150%)",
      "--lm-card-border": dark
        ? "1px solid rgba(255, 255, 255, .14)"
        : "1px solid rgba(255, 255, 255, .60)",
      "--lm-section-border": dark
        ? "1px solid rgba(255, 255, 255, .10)"
        : "1px solid rgba(255, 255, 255, .50)",
      "--lm-border-color": dark ? "rgba(255, 255, 255, .16)" : "rgba(15, 23, 42, .10)",
      "--lm-inset-border": dark
        ? "1px solid rgba(255, 255, 255, .14)"
        : "1px solid rgba(255, 255, 255, .55)",
      "--lm-floating-border": dark
        ? "1px solid rgba(255, 255, 255, .14)"
        : "1px solid rgba(255, 255, 255, .70)",
      "--lm-radius-card": "18px",
      "--lm-section-rule": "1px solid " + (dark ? "rgba(255, 255, 255, .12)" : "rgba(15, 23, 42, .08)"),
      "--lm-field-border": dark
        ? "1px solid rgba(255, 255, 255, .14)"
        : "1px solid rgba(15, 23, 42, .08)",
      "--lm-field-shadow": "none",
      "--lm-track-shadow": "inset 0 1px 3px rgba(0, 0, 0, .14)",
      "--lm-mask": "rgba(8, 12, 20, .42)",
      "--lm-radius-section": "16px",
      "--lm-radius-control": "12px",
      "--lm-radius-overlay": "20px",
      "--lm-shadow-card": "0 10px 30px rgba(9, 14, 24, .22)",
      "--lm-shadow-section": "0 2px 10px rgba(9, 14, 24, .12)",
      "--lm-shadow-control": "0 1px 6px rgba(9, 14, 24, .14)",
      "--lm-shadow-floating": "0 10px 32px rgba(9, 14, 24, .28)",
      "--lm-shadow-dialog": "0 18px 48px rgba(9, 14, 24, .34)",
      "--lm-duration-normal": "220ms",
    };
  }
  if (id === "brutalist") {
    const ink = dark ? "#f4f4f5" : "#111214";
    return {
      "--lm-surface-card": dark ? "#1b1b1f" : "#ffffff",
      "--lm-surface-section": dark ? "#232327" : "#ffffff",
      "--lm-surface-control": dark ? "#232327" : "#ffffff",
      "--lm-surface-inset": dark ? "#2d2d33" : "#f1f1f2",
      "--lm-surface-floating": dark ? "#232327" : "#ffffff",
      "--lm-border-color": ink,
      "--lm-border-strong": ink,
      "--lm-hairline": "2px solid var(--lm-border-color)",
      "--lm-card-border": "2px solid " + ink,
      "--lm-section-border": "2px solid " + ink,
      "--lm-control-border": "2px solid " + ink,
      "--lm-inset-border": "2px solid " + ink,
      "--lm-floating-border": "2px solid " + ink,
      "--lm-radius-card": "8px",
      "--lm-section-rule": "2px solid " + ink,
      "--lm-field-border": "2px solid " + ink,
      "--lm-field-shadow": "none",
      "--lm-track-off": dark ? "#3a3a41" : "#e4e4e6",
      "--lm-track-shadow": "none",
      "--lm-knob-shadow": "2px 2px 0 " + ink,
      "--lm-mask": "rgba(0, 0, 0, .5)",
      "--lm-radius-section": "8px",
      "--lm-radius-control": "6px",
      "--lm-radius-badge": "6px",
      "--lm-radius-badge-sm": "5px",
      "--lm-radius-overlay": "10px",
      "--lm-shadow-card": "4px 4px 0 " + ink,
      "--lm-shadow-section": "3px 3px 0 " + ink,
      "--lm-shadow-control": "2px 2px 0 " + ink,
      "--lm-shadow-floating": "4px 4px 0 " + ink,
      "--lm-shadow-dialog": "6px 6px 0 " + ink,
      "--lm-duration-fast": "80ms",
      "--lm-duration-normal": "120ms",
      // 粗野主义按"物理按下"的写法: 位移 + 硬阴影变短(由 styles.ts 的按下规则消费)
      "--lm-press-scale": "1",
      "--lm-press-shift": "2px",
    };
  }
  if (id === "minimal") {
    return {
      "--lm-surface-section": dark ? "#1b1b1e" : "#f7f8f9",
      "--lm-surface-control": "var(--ha-card-background, var(--card-background-color, #fff))",
      "--lm-surface-inset": dark ? "#232327" : "#eef0f2",
      "--lm-surface-floating": dark ? "#222226" : "#ffffff",
      "--lm-card-border": "1px solid var(--lm-border-color)",
      "--lm-section-border": "1px solid var(--lm-border-color)",
      "--lm-control-border": "1px solid var(--lm-border-color)",
      "--lm-inset-border": "1px solid var(--lm-border-color)",
      "--lm-floating-border": "1px solid var(--lm-border-color)",
      "--lm-radius-card": "10px",
      "--lm-section-rule": "1px solid var(--lm-border-color)",
      "--lm-field-border": "1px solid var(--lm-border-color)",
      "--lm-field-shadow": "none",
      "--lm-track-shadow": "none",
      "--lm-mask": "rgba(0, 0, 0, .32)",
      "--lm-radius-section": "10px",
      "--lm-radius-control": "8px",
      "--lm-radius-overlay": "14px",
      "--lm-shadow-card": "none",
      "--lm-shadow-section": "none",
      "--lm-shadow-control": "none",
      "--lm-shadow-floating": "0 4px 16px rgba(0, 0, 0, .10)",
      "--lm-shadow-dialog": "0 6px 24px rgba(0, 0, 0, .14)",
      "--lm-duration-normal": "160ms",
      "--lm-press-scale": ".98",
    };
  }
  if (id === "memphis") {
    const ink = dark ? "#f6f0e8" : "#18202d";
    return {
      "--lm-surface-card": dark ? "#202b3c" : "#fff4dc",
      "--lm-surface-section": dark ? "#2c3d4c" : "#e5f1e9",
      "--lm-surface-control": dark ? "#44394e" : "#f8e0df",
      "--lm-surface-inset": dark ? "#263c43" : "#f0e5f1",
      "--lm-surface-floating": dark ? "#2a3949" : "#fff9ed",
      "--lm-surface-pattern": dark
        ? "radial-gradient(circle at 14px 14px, rgba(255, 193, 115, .20) 0 3px, transparent 3.7px), repeating-linear-gradient(135deg, transparent 0 30px, rgba(244, 151, 167, .10) 30px 32px, transparent 32px 58px)"
        : "radial-gradient(circle at 14px 14px, rgba(237, 111, 121, .19) 0 3px, transparent 3.7px), repeating-linear-gradient(135deg, transparent 0 30px, rgba(56, 151, 137, .10) 30px 32px, transparent 32px 58px)",
      "--lm-card-border": `2px solid ${ink}`,
      "--lm-section-border": `2px solid ${ink}`,
      "--lm-control-border": `2px solid ${ink}`,
      "--lm-inset-border": `1px solid ${dark ? "#58657c" : "#d8d0bd"}`,
      "--lm-floating-border": `2px solid ${ink}`,
      "--lm-border-color": dark ? "#65718a" : "#263247",
      "--lm-border-strong": ink,
      "--lm-hairline": `2px solid ${ink}`,
      "--lm-radius-card": "18px",
      "--lm-radius-section": "14px",
      "--lm-radius-control": "10px",
      "--lm-radius-badge": "999px",
      "--lm-radius-overlay": "18px",
      "--lm-section-rule": `2px solid ${dark ? "#65718a" : "#263247"}`,
      "--lm-field-border": `2px solid ${dark ? "#65718a" : "#263247"}`,
      "--lm-field-shadow": "none",
      "--lm-track-off": dark ? "#4a5367" : "#dfd7c5",
      "--lm-track-shadow": "none",
      "--lm-knob-shadow": `2px 2px 0 ${ink}`,
      "--lm-mask": "rgba(8, 13, 24, .46)",
      "--lm-shadow-card": `5px 5px 0 ${dark ? "#0d1724" : "#ed9b75"}`,
      "--lm-shadow-section": `3px 3px 0 ${dark ? "#111b2a" : "#56aa9c"}`,
      "--lm-shadow-control": `2px 2px 0 ${dark ? "#101a28" : "#eebd4e"}`,
      "--lm-shadow-floating": `5px 5px 0 ${dark ? "#111b2a" : "#ed9b75"}`,
      "--lm-shadow-dialog": `7px 7px 0 ${dark ? "#101a28" : "#56aa9c"}`,
      "--lm-duration-fast": "100ms",
      "--lm-duration-normal": "150ms",
      "--lm-press-scale": "1",
      "--lm-press-shift": "2px",
    };
  }
  // soft: 现状方向。变量默认值就是它, 这里只把"必须显式"的两项写清楚,
  // 免得以后有人改 baseTokens 时误以为 soft 有独立取值。
  return {
    "--lm-card-border": "0",
    "--lm-section-border": "0",
    "--lm-control-border": "0",
  };
}

/** 基础默认值 + 预设覆盖 = 实际写到宿主上的那一份变量。 */
export function resolveTokens(id: StyleId, opts: { dark: boolean }): Record<string, string> {
  return Object.assign({}, baseTokens(), presetTokens(id, opts));
}
