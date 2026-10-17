/*
 * 语义变量层(semantic tokens) —— 五张零跑卡片共享的**视觉接口**。
 *
 * 为什么是变量而不是"每张卡各写一套样式": 六张卡分别打包成自包含 JS, 共享源码会被
 * 各自内联一份, 所以"统一"只能靠**同一组变量名 + 同一组角色类名**来达成, 不能靠
 * 运行时共享模块。预设(见 presets.ts)只改这组变量的值, 各卡 CSS 只消费这组变量,
 * 于是"换风格"= 换一次变量, 不需要为每个预设复制业务模板。
 *
 * 变量的落点是**卡片宿主元素**的 inline style(见 appearance.ts 的 applyAppearance):
 * CSS 自定义属性会继承进 shadow root, 卡内 CSS 一个字节不用改就能跟着变; 同时
 * 不写 document 根节点, 不会影响 HA 里的其它卡片。
 *
 * 约定:
 *   * 变量名一律 `--lm-*`; HA 变量只出现在**这里的默认值**里, 卡内 CSS 不直接消费
 *     HA 颜色(否则预设就管不到它们了)。
 *   * 只给"角色"造变量(表面/文字/强调/边界/圆角/阴影/动效/尺寸), 不给每个业务
 *     选择器各造一个。业务语义色(加热红/通风蓝/告警)与数据系列色是**语义**, 不随
 *     风格改变含义。
 */

/** 一个变量名 → CSS 值。值可以是 `var(...)` 引用(在 shadow 里按使用处解析)。 */
export type TokenMap = Readonly<Record<string, string>>;

/** 变量前缀。 */
export const LM_TOKEN_PREFIX = "--lm-";

/**
 * 基础语义变量(风格无关的默认值)。
 *
 * 全部从 HA 主题变量派生 → 明暗、HA 主题色、卡片背景都继续跟随站点主题;
 * 用户的"自定义主题色"仍走 palette.ts 写 `--primary-color` 那条老路(见那里的说明),
 * 这里只是把同一批颜色**换个名字**提供给共享控件层。
 */
export function baseTokens(): TokenMap {
  return {
    // ── 表面 ──
    // 子块/浮层默认与卡片同色(现状: 白卡 → 白子块 → 浅灰控件), 靠阴影或描边分层。
    "--lm-surface-card": "var(--ha-card-background, var(--card-background-color, #fff))",
    "--lm-surface-section": "var(--ha-card-background, var(--card-background-color, #fff))",
    // 抬起型控件(圆钮/胶囊按钮/图标钮)的表面。soft 下与子块同色, 靠一层更小的阴影分层。
    "--lm-surface-control": "var(--ha-card-background, var(--card-background-color, #fff))",
    "--lm-surface-inset": "var(--secondary-background-color, #e7eaed)",
    "--lm-surface-floating": "var(--ha-card-background, var(--card-background-color, #fff))",
    // 装饰底纹默认关闭; 仅需要装饰的预设覆盖, 由卡片外壳和对应预览消费。
    "--lm-surface-pattern": "none",
    // 材质: 只有"卡片"和"浮层"允许模糊 —— 每个小标签都建模糊层会明显掉帧
    //(见方案 §6「玻璃风格需要额外控制」)。
    "--lm-blur-card": "none",
    "--lm-blur-floating": "none",

    // ── 文字 ──
    "--lm-text": "var(--primary-text-color, #212121)",
    "--lm-text-secondary": "var(--secondary-text-color, #6b7280)",
    "--lm-on-accent": "var(--text-primary-color, #fff)",

    // ── 强调色(用户自定义主题色的落点) ──
    "--lm-accent": "var(--primary-color, #03a9f4)",
    "--lm-rgb-accent": "var(--rgb-primary-color, 3, 169, 244)",
    "--lm-accent-soft": "rgba(var(--rgb-primary-color, 3, 169, 244), .12)",
    "--lm-accent-faint": "rgba(var(--rgb-primary-color, 3, 169, 244), .08)",

    // ── 业务语义色(风格变化不改变含义) ──
    "--lm-success": "var(--success-color, #43a047)",
    "--lm-warning": "var(--warning-color, #ffa600)",
    "--lm-error": "var(--error-color, #db4437)",
    "--lm-pending": "#d99117",
    "--lm-heat": "#e53935",
    "--lm-vent": "#29b6f6",

    // ── 数据系列色(曲线/图例/坐标文字/系列开关必须用同一组) ──
    "--lm-series-distance": "#03a9f4",
    "--lm-series-consumption": "#ffa600",
    "--lm-series-efficiency": "#43a047",
    "--lm-series-fuel": "#ff7043",
    "--lm-series-charge": "#7e57c2",
    "--lm-series-cost": "#26a69a",

    // ── 边界 ──
    // 描边是**分角色**的: 卡片/子块/抬起型控件默认不描边(现状"要浮不要框"),
    // 只读小标签(胶囊/提示条)保留 1px —— 它们太小, 再压阴影会显脏。
    "--lm-border-color": "var(--divider-color, rgba(0, 0, 0, .09))",
    "--lm-border-strong": "var(--divider-color, rgba(0, 0, 0, .18))",
    "--lm-hairline": "1px solid var(--lm-border-color)",
    "--lm-card-border": "0",
    "--lm-section-border": "0",
    "--lm-control-border": "0",
    "--lm-inset-border": "1px solid var(--lm-border-color)",
    "--lm-floating-border": "1px solid var(--lm-border-color)",
    // 分隔线(列表行之间/弹窗头部与操作区): 0 = 不画。极简与粗野主义会打开它。
    "--lm-section-rule": "0",

    // ── 表单 ──
    "--lm-field-border": "0",
    "--lm-field-shadow": "inset 0 1px 3px rgba(0, 0, 0, .06)",

    // ── 开关与滑条 ──
    "--lm-track-off": "var(--secondary-background-color, #eef1f5)",
    "--lm-track-shadow": "inset 0 1px 3px rgba(0, 0, 0, .2)",
    "--lm-knob": "var(--card-background-color, #fff)",
    "--lm-knob-shadow": "0 1px 3px rgba(0, 0, 0, .2)",

    // ── 弹窗遮罩与焦点 ──
    "--lm-mask": "rgba(0, 0, 0, .4)",
    "--lm-focus-offset": "3px",

    // ── 圆角(shape 变体不在这里: 圆形按钮/开关滑块/滑动底板保持各自形状) ──
    "--lm-radius-card": "var(--ha-card-border-radius, 12px)",
    "--lm-radius-section": "14px",
    "--lm-radius-control": "10px",
    "--lm-radius-badge": "999px",
    "--lm-radius-badge-sm": "11px",
    "--lm-radius-overlay": "18px",

    // ── 阴影(分层: 控件 < 子块 < 浮层 < 弹窗) ──
    "--lm-shadow-card": "none",
    "--lm-shadow-section": "0 1px 4px rgba(0, 0, 0, .16)",
    "--lm-shadow-control": "0 1px 4px rgba(0, 0, 0, .16)",
    "--lm-shadow-floating": "0 4px 14px rgba(0, 0, 0, .22)",
    "--lm-shadow-dialog": "0 8px 30px rgba(0, 0, 0, .3)",

    // ── 动效(reduced-motion 由 motion.ts 统一接管) ──
    "--lm-duration-fast": "120ms",
    "--lm-duration-normal": "180ms",
    "--lm-ease": "ease",
    // 按下反馈: 缩放 + 位移。粗野主义用位移(硬阴影跟着走), 其余用缩放。
    "--lm-press-scale": ".95",
    "--lm-press-shift": "0px",

    // ── 尺寸(首期跨风格保持稳定: 换风格不该让整页重新排版) ──
    "--lm-control-height": "32px",
    "--lm-control-height-sm": "27px",
    "--lm-icon-size": "20px",
    "--lm-space-1": "4px",
    "--lm-space-2": "8px",
    "--lm-space-3": "12px",
    "--lm-space-4": "16px",
  };
}

/** 每个元素记一份"我写过哪些变量", 便于精确撤销(重连/换风格时不残留旧预设的值)。 */
const APPLIED = new WeakMap<HTMLElement, string[]>();

/** 把一组变量写到元素 inline style 上(覆盖同名变量, 不动其它属性)。 */
export function applyTokens(el: HTMLElement, tokens: TokenMap): void {
  const keys = APPLIED.get(el) || [];
  for (const name of Object.keys(tokens)) {
    el.style.setProperty(name, tokens[name]);
    if (keys.indexOf(name) < 0) keys.push(name);
  }
  APPLIED.set(el, keys);
}

/** 撤销 applyTokens 写过的全部变量(元素回到"跟随 HA 主题"的状态)。 */
export function clearTokens(el: HTMLElement): void {
  const keys = APPLIED.get(el);
  if (!keys) return;
  for (const name of keys) el.style.removeProperty(name);
  APPLIED.delete(el);
}
