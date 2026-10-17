/*
 * 交互动效底座。
 *
 * 与共享控件层(lib/ui/styles.ts)的分工:
 *   * 这里只管**全局基线**: 文字数字对齐、表头分隔线、以及 reduced-motion 的统一停用。
 *   * 具体控件的按压/悬停反馈归控件层 —— 那里的规则读 `--lm-duration-*` 与
 *     `--lm-press-*` 变量, 于是"动效"也成为风格的一部分(粗野主义按下时位移,
 *     极简几乎不动)。
 *
 * ⚠️ 这里**不再**写 `button:active { transform: ... }`: 无差别地覆盖 transform 会与
 *    "用 transform 定位的气泡/滑块"打架(方案 §3「动效」一行点出的组合风险)。按压反馈
 *    统一由控件层按角色给出。
 *
 * ⚠️ 六张卡都是独立 bundle, 字符串 CSS(CARD_CSS / _css())与 Lit `css` 两条注入路径
 *    都要能用, 所以这里是**纯字符串**, 由调用方自行 unsafeCSS 或直接拼接。
 */
export const interactionStyles = `
  :host :is(button, [role="button"], .chip, .pick, .trip, .day):not(:disabled) {
    transition: background-color var(--lm-duration-normal, 180ms) var(--lm-ease, ease),
                color var(--lm-duration-normal, 180ms) var(--lm-ease, ease),
                box-shadow var(--lm-duration-fast, 160ms) var(--lm-ease, ease),
                transform var(--lm-duration-fast, 160ms) var(--lm-ease, ease),
                opacity var(--lm-duration-fast, 160ms) var(--lm-ease, ease);
    -webkit-tap-highlight-color: transparent;
  }
  .card { font-variant-numeric: tabular-nums; }
  .head { padding-bottom: 8px; border-bottom: 1px solid var(--lm-border-color, var(--divider-color,#0001)); }
  .head .title { letter-spacing: .02em; }
  :host :is(button, [role="button"], .chip, a[href]):focus-visible,
  input:focus-visible, select:focus-visible, textarea:focus-visible {
    outline: 2px solid var(--lm-accent, var(--primary-color,#03a9f4));
    outline-offset: var(--lm-focus-offset, 3px);
  }
  @media (hover:hover) {
    :host :is(button, [role="button"]):hover:not(:disabled):not([aria-pressed="true"]):not(.on) { opacity: .88; }
  }
  @media (prefers-reduced-motion:reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; }
  }
`;
