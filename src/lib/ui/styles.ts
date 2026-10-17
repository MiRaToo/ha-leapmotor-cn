/*
 * 共享控件层 —— **角色类**与它们的共同外观。
 *
 * 六张卡的 shadow DOM 各自独立, 所以"统一"靠的是: 每张卡都把这段 CSS 注入自己的
 * shadow root(字符串卡直接拼, Lit 卡用 unsafeCSS), 于是同一批角色类在六张卡里
 * 长得一模一样。预设(见 presets.ts)只改变量, 这里只消费变量。
 *
 * 两条关键约定:
 *  1. **每个值都写 fallback**: `var(--lm-x, <现状值>)`。这样即使某张卡还没接上
 *     appearance 绑定, 渲染结果也与改造前逐字一致 —— 迁移可以逐卡进行而不炸。
 *  2. **形状与尺寸不进共享层**: 圆形按钮、开关滑块、滑动底板保持各自的 border-radius /
 *     宽高; 共享层只统一"表面(底色/描边/阴影/过渡)"。统一不等于把圆钮改成方钮。
 *
 * 角色速查(类名 → 角色):
 *   Surface     .card .sec .half .sheet .chartSec .energyStat .chargePlot .daycard
 *               .grp .dinfo .pick .cabin
 *   Control     .toolBtn .chip .winOpt .fanBtn .floatPill .cabBtn .pickRow
 *               .chgBtn .chgPanel .warnCollapse .smx .arw .refresh .stchip
 *               fieldset button(车机工具) .actions button(车衣) .priceBtn
 *   Ghost       .foldH .step .tireTgl .palEye .chip.txt .presetOpt .wopt .segB
 *   Badge       .pill .rchip .kvchip .tag3d .acTag .tP .hint .capRow .status
 *               .palPct .palFmt
 *   Field       .tinput input select textarea(各卡的输入)
 *   Switch      .togchip / input[type=checkbox](车机工具)
 *   Floating    .presetPop .winPop .palPop .winbar .winpop .delpop .expmenu
 *               .chargeTip .tip .toast
 *   Modal       .smodal/.smask .tariffForm/.tariffBackdrop .lm-confirm
 *   Feedback    .hint .toast .lmsg .billNote .cNote .subline .srcNote .ovlNone
 */

export const uiStyles = `
/* ═══════════════ 1. 卡片本体 ═══════════════ */
/* ⚠️ backdrop-filter 会让**后代**的 position: fixed 相对本元素定位。六张卡里唯一的
   fixed 元素是电价弹窗(.tariffBackdrop), 它已从 .card 内挪到 shadow root 直下 ——
   新增 fixed 弹窗时必须照做, 否则玻璃风格下全页遮罩会缩成卡片大小。 */
.card {
  background: var(--lm-surface-card, var(--ha-card-background, var(--card-background-color, #fff)));
  background-image: var(--lm-surface-pattern, none);
  color: var(--lm-text, var(--primary-text-color, #212121));
  border-radius: var(--lm-radius-card, var(--ha-card-border-radius, 12px));
  border: var(--lm-card-border, 0);
  box-shadow: var(--lm-shadow-card, none);
  -webkit-backdrop-filter: var(--lm-blur-card, none);
  backdrop-filter: var(--lm-blur-card, none);
}
/* 3D 画面会透出宿主底层; 孟菲斯装饰不叠到透明车景后面。 */
.card:has(.stage3d) { background-image: none; }

/* ═══════════════ 2. 表面: 子块 / 内嵌块 ═══════════════ */
/* 子块默认与卡片同色, 只靠一层阴影分层; 描边由预设决定(极简/粗野主义会打开)。 */
.sec, .half, .sheet, .chartSec, .energyStat, .chargePlot, .daycard, .grp,
.dinfo, .pick, .cabin, .lm-surface {
  background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
  border: var(--lm-section-border, 0);
  box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
}
.sec, .half, .sheet, .daycard, .grp, .dinfo, .pick, .lm-section {
  border-radius: var(--lm-radius-section, 14px);
}
.chartSec, .energyStat, .chargePlot { border-radius: var(--lm-radius-section, 14px); }

/* ═══════════════ 3. 控件: 抬起型(白底 + 小阴影) ═══════════════ */
/* hover 淡蓝, 选中/语义态各自覆盖(见各卡的 .on/.warn/... 规则)。 */
.toolBtn, .chip, .winOpt, .fanBtn, .floatPill, .cabBtn, .pickRow, .chgBtn,
.chgPanel, .warnCollapse, .smx, .arw, .refresh, .stchip, .priceBtn, .circ,
.energyTools button, .chargeCtrls button, .addPeriod, .periodRow button,
.tariffActions button, .sessionPrice button, .paintActions button,
.lm-btn {
  background: var(--lm-surface-control, var(--ha-card-background, var(--card-background-color, #fff)));
  color: inherit;
  border: var(--lm-control-border, 0);
  box-shadow: var(--lm-shadow-control, 0 1px 4px rgba(0, 0, 0, .16));
  transition: background-color var(--lm-duration-fast, 120ms) var(--lm-ease, ease),
              color var(--lm-duration-fast, 120ms) var(--lm-ease, ease),
              box-shadow var(--lm-duration-fast, 120ms) var(--lm-ease, ease),
              transform var(--lm-duration-fast, 120ms) var(--lm-ease, ease);
}
.toolBtn:not([disabled]):hover, .chip:not(.on):not([disabled]):hover,
.winOpt:not([disabled]):hover, .fanBtn:not(.on):not([disabled]):hover,
.floatPill:not([disabled]):hover, .cabBtn:not(.on):not(.vent):not(.heat):not([disabled]):hover,
.pickRow:not([disabled]):hover, .circ:not(.on):not([disabled]):hover,
.arw:not([disabled]):hover, .refresh:not([disabled]):hover, .stchip:not([disabled]):hover,
.energyTools button:not(.on):not([disabled]):hover, .priceBtn:not([disabled]):hover,
.addPeriod:not([disabled]):hover, .tariffActions button:not([disabled]):hover,
.paintActions button:hover, .lm-btn:not([disabled]):hover {
  background-color: var(--lm-accent-soft, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
}
/* 车机工具 / 车衣这两个独立子组件里的原生按钮也走同一档 */
.lm-btn, .lm-btn.lm-regular { min-height: var(--lm-control-height, 32px); }
.lm-btn.lm-compact { min-height: var(--lm-control-height-sm, 27px); padding: 0 8px; font-size: 12px; }

/* ═══════════════ 4. 幽灵控件(透明底, 只在 hover/选中给反馈) ═══════════════ */
.foldH, .step, .tireTgl, .palEye, .chip.txt, .presetOpt, .wopt, .segB,
.energyModes button, .lm-ghost {
  background-color: transparent;
  border: 0;
  box-shadow: none;
}
.foldH:not([disabled]):hover, .step:not([disabled]):hover, .palEye:not([disabled]):hover,
.presetOpt:not(.on):hover, .wopt:not(.on):hover, .segB:not(.on):not([disabled]):hover,
.chip.txt:not([disabled]):hover, .lm-ghost:not([disabled]):hover {
  background-color: var(--lm-accent-faint, rgba(var(--rgb-primary-color, 3, 169, 244), .08));
}
.step:hover:not([disabled]), .palEye:hover, .tireTgl.on { color: var(--lm-accent, var(--primary-color, #03a9f4)); }

/* ═══════════════ 5. 信息胶囊 / 只读小标签 ═══════════════ */
/* 只读: 不加按压反馈、不冒充按钮。三种用途共用同一表面, 只在尺寸与 tone 上分档。 */
.pill, .rchip, .kvchip, .tag3d, .acTag, .hint, .toast, .lm-badge {
  background: var(--lm-surface-inset, var(--secondary-background-color, #e7eaed));
  border: var(--lm-inset-border, 1px solid var(--divider-color, rgba(0, 0, 0, .09)));
  border-radius: var(--lm-radius-badge, 999px);
}
/* 同族的"读数值小标签": 表面同上, 圆角收一档(它们不是胶囊, 是嵌在面板里的读数框) */
.tP, .capRow .status, .palPct, .palFmt {
  background: var(--lm-surface-inset, var(--secondary-background-color, #e7eaed));
  border: var(--lm-inset-border, 1px solid var(--divider-color, rgba(0, 0, 0, .09)));
  border-radius: var(--lm-radius-control, 10px);
}
.tP { border-radius: var(--lm-radius-control, 10px); }
/* 数值摘要档(compact badge): 比状态胶囊小一档, 圆角也收一档 */
.heroRight .pill {
  display: inline-flex; align-items: center; gap: 5px; padding: 5px 9px;
  border-radius: var(--lm-radius-badge-sm, 11px); font-size: 11px; font-weight: 600;
  background: var(--lm-surface-control, var(--ha-card-background, var(--card-background-color, #fff)));
  border: var(--lm-inset-border, 0);
  box-shadow: var(--lm-shadow-control, 0 1px 4px rgba(0, 0, 0, .13));
}
.heroRight .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
/* 语义 tone: 实底胶囊(告警/充电/驻车/未插枪)保持"整颗上色" */
.pill.warn, .pill.chg, .pill.parked, .pill.plug, .pill.err {
  border-color: transparent;
}
.pill.warn { background: var(--lm-warning, var(--warning-color, #ffa600)); color: #201600; }
.pill.chg, .pill.parked { background: var(--lm-success, var(--success-color, #43a047)); color: #071c0e; }
.pill.plug, .pill.err { background: var(--lm-error, var(--error-color, #db4437)); color: #fff; }
.kvchip.on { color: var(--lm-success, var(--success-color, #43a047)); }
.kvchip.plug { color: var(--lm-error, var(--error-color, #db4437)); }
.tP.warn { border-color: var(--lm-warning, var(--warning-color, #ffa600)); }
.tP.warn b { color: var(--lm-warning, var(--warning-color, #ffa600)); }
.tP.bad { border-color: var(--lm-error, var(--error-color, #db4437)); }
.tP.bad b { color: var(--lm-error, var(--error-color, #db4437)); }
.capRow .pending { color: var(--lm-pending, #d99117); }
.capRow .available { color: var(--lm-success, #15956d); }

/* ═══════════════ 6. 可选胶囊 / 分段 / 页签 ═══════════════ */
/* 选中 = **持续状态**(aria-pressed / .on); 与被按下的瞬时反馈区分开。 */
.chip[aria-pressed="true"], .chip.on {
  background-color: var(--lm-accent-soft, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
  color: var(--lm-accent, var(--primary-color, #03a9f4));
}
.segB.on, .wopt.on, .monlab.on {
  background-color: var(--lm-accent-soft, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
  color: var(--lm-accent, var(--primary-color, #03a9f4));
}
.winbar .seg, .seg2 {
  border: var(--lm-hairline, 1px solid var(--divider-color, rgba(0, 0, 0, .09)));
  border-radius: var(--lm-radius-badge, 999px);
  background: var(--lm-surface-control, var(--ha-card-background, var(--card-background-color, #fff)));
  overflow: hidden;
}
.winbar .seg button { border-right: var(--lm-hairline, 1px solid var(--divider-color, rgba(0, 0, 0, .09))); }
.energyModes {
  background: var(--lm-surface-inset, var(--secondary-background-color, #eef1f5));
  border: var(--lm-inset-border, 0);
  border-radius: var(--lm-radius-control, 12px);
}
.energyModes .modeIndicator {
  background: var(--lm-surface-control, var(--card-background-color, #fff));
  box-shadow: var(--lm-shadow-control, 0 1px 4px #0002);
  transition: transform var(--lm-duration-normal, 180ms) var(--lm-ease, ease);
}
/* 系列开关: 启用时整颗点成**数据系列色**(颜色是语义, 不随风格变) */
.chip.series-on { color: #fff; }

/* ═══════════════ 7. 表单控件 ═══════════════ */
.tinput, input[type="text"], input[type="number"], input[type="time"],
input[type="search"], select, textarea, .palHex, .zrad, .lm-field {
  font: inherit;
  color: inherit;
  background: var(--lm-surface-inset, var(--secondary-background-color, #eef1f5));
  border: var(--lm-field-border, 0);
  border-radius: var(--lm-radius-control, 8px);
  box-shadow: var(--lm-field-shadow, inset 0 1px 3px rgba(0, 0, 0, .06));
}
.tinput:focus, input:focus-visible, select:focus-visible, textarea:focus-visible {
  outline: 2px solid var(--lm-accent, var(--primary-color, #03a9f4));
  outline-offset: var(--lm-focus-offset, 3px);
}
.tinput:disabled, input:disabled, select:disabled, textarea:disabled,
fieldset:disabled input, fieldset:disabled select, fieldset:disabled button {
  opacity: .45; cursor: not-allowed;
}
.tinput[aria-invalid="true"], input[aria-invalid="true"] {
  border-color: var(--lm-error, var(--error-color, #db4437));
}
.lm-help { font-size: 11px; color: var(--lm-text-secondary, var(--secondary-text-color, #6b7280)); }
.lm-error { font-size: 11px; color: var(--lm-error, var(--error-color, #db4437)); }

/* ═══════════════ 8. 开关与滑条 ═══════════════ */
/* 轨道/滑块与"开/关/待确认"三态统一; 保留原生 DOM(checkbox)与服务调用。 */
.togchip, input[type="checkbox"].lm-switch {
  background: var(--lm-track-off, var(--secondary-background-color, #eef1f5));
  border: var(--lm-control-border, 0);
  box-shadow: var(--lm-track-shadow, inset 0 1px 3px rgba(0, 0, 0, .2));
  border-radius: 999px;
}
.togchip .thumb, input[type="checkbox"].lm-switch::before {
  background: var(--lm-knob, var(--card-background-color, #fff));
  box-shadow: var(--lm-knob-shadow, 0 1px 3px rgba(0, 0, 0, .2));
  transition: transform var(--lm-duration-normal, 160ms) var(--lm-ease, ease),
              background-color var(--lm-duration-normal, 160ms) var(--lm-ease, ease);
}
.togchip.on .thumb, input[type="checkbox"]:checked::before {
  background: var(--lm-accent, var(--primary-color, #03a9f4));
}
.togchip.pending { opacity: .65; }
.togchip:disabled { opacity: .45; }
.rng, input[type="range"] { accent-color: var(--lm-accent, var(--primary-color, #03a9f4)); }
.rng::-webkit-slider-runnable-track { background: var(--lm-track-off, var(--divider-color, rgba(0, 0, 0, .2))); }
.rng::-webkit-slider-thumb { background: var(--lm-accent, var(--primary-color, #03a9f4)); }
.rng::-moz-range-track { background: var(--lm-track-off, var(--divider-color, rgba(0, 0, 0, .2))); }
.rng::-moz-range-thumb { background: var(--lm-accent, var(--primary-color, #03a9f4)); }
.rng:disabled { opacity: .45; cursor: not-allowed; }

/* ═══════════════ 9. 浮层: 气泡 / 菜单 / 提示 ═══════════════ */
/* 浮层比子块高一档: 描边 + 强投影 + (玻璃风格下)模糊。 */
.presetPop, .winPop, .palPop, .winbar .winpop, .delpop, .expmenu, .chargeTip,
.tip, .cabConsole, .lm-popover {
  background: var(--lm-surface-floating, var(--ha-card-background, var(--card-background-color, #fff)));
  border: var(--lm-floating-border, 1px solid var(--divider-color, rgba(0, 0, 0, .09)));
  border-radius: var(--lm-radius-section, 14px);
  box-shadow: var(--lm-shadow-floating, 0 4px 14px rgba(0, 0, 0, .22));
  -webkit-backdrop-filter: var(--lm-blur-floating, none);
  backdrop-filter: var(--lm-blur-floating, none);
}
/* 气泡的小箭头必须与气泡同底色, 否则风格一换就露馅 */
.presetPop::after { background: var(--lm-surface-floating, var(--ha-card-background, var(--card-background-color, #fff))); }
.winPop::before { background: var(--lm-surface-inset, var(--secondary-background-color, #e7eaed)); }
.winPop { border-radius: var(--lm-radius-badge, 999px); }
.toast {
  background: var(--lm-surface-floating, var(--secondary-background-color, #e7eaed));
  border: var(--lm-floating-border, 1px solid var(--divider-color, rgba(0, 0, 0, .09)));
  box-shadow: var(--lm-shadow-floating, none);
}

/* ═══════════════ 10. 弹窗外壳 ═══════════════ */
.smask, .tariffBackdrop, .lm-confirm-mask { background: var(--lm-mask, rgba(0, 0, 0, .38)); }
.smodal, .tariffForm, .lm-confirm {
  background: var(--lm-surface-floating, var(--ha-card-background, var(--card-background-color, #fff)));
  color: var(--lm-text, var(--primary-text-color, #212121));
  border: var(--lm-floating-border, 0);
  border-radius: var(--lm-radius-overlay, 18px);
  box-shadow: var(--lm-shadow-dialog, 0 8px 30px rgba(0, 0, 0, .3));
  -webkit-backdrop-filter: var(--lm-blur-floating, none);
  backdrop-filter: var(--lm-blur-floating, none);
}
.smbody, .tariffScroll { overscroll-behavior: contain; }
.smhead, .tariffHead { border-bottom: var(--lm-section-rule, 0); }
.tariffActions, .lm-confirm-actions { border-top: var(--lm-section-rule, 1px solid var(--divider-color, rgba(0, 0, 0, .09))); }
.tariffSection, .capTable, .cRow + .cRow, .lwago, .tariffHead { border-top-color: var(--lm-border-color, var(--divider-color, rgba(0, 0, 0, .09))); }

/* ── 共享确认框(替代 window.confirm) ──
   挂在卡片 shadow root 直下(与 .smodal 同层, **不能**放进 .card: 玻璃风格给 .card
   加了 backdrop-filter, 会把它变成 fixed 后代的定位基准)。 */
.lm-confirm-mask { position: fixed; inset: 0; z-index: 1100; display: block; }
.lm-confirm {
  position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1101;
  width: min(360px, calc(100vw - 32px)); box-sizing: border-box;
  display: flex; flex-direction: column; overflow: hidden;
  font-size: 13px; line-height: 1.55;
}
.lm-confirm[hidden], .lm-confirm-mask[hidden] { display: none; }
.lm-confirm-body { padding: 16px 16px 8px; display: flex; flex-direction: column; gap: 6px; }
.lm-confirm-title { margin: 0; font-size: 15px; font-weight: 600; }
.lm-confirm-msg { margin: 0; white-space: pre-line; color: var(--lm-text-secondary, var(--secondary-text-color, #6b7280)); }
.lm-confirm-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 12px 16px; flex: none; }
.lm-confirm-actions button { padding: 7px 14px; border-radius: var(--lm-radius-control, 9px); }
.lm-confirm-ok { color: var(--lm-accent, var(--primary-color, #03a9f4)); font-weight: 600; }
.lm-confirm-ok.lm-danger { color: var(--lm-error, var(--error-color, #db4437)); }
.lm-confirm-ok[disabled] { opacity: .45; cursor: progress; }

/* ═══════════════ 11. 反馈与状态文字 ═══════════════ */
.lmsg, .billNote, .cNote, .subline, .srcNote, .lm-note {
  color: var(--lm-text-secondary, var(--secondary-text-color, #6b7280));
}
.lmsg.err, .billNote.error, .lm-error { color: var(--lm-error, var(--error-color, #db4437)); }
.hint { border-radius: var(--lm-radius-section, 14px); }
/* busy / pending 必须与"真的关掉了"区分开 */
.lm-busy { opacity: .55; cursor: progress; }
.lm-pending { position: relative; }
.lm-pending::after {
  content: ""; position: absolute; inset: 0; border-radius: inherit;
  background: var(--lm-accent-faint, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
  pointer-events: none;
}

/* ═══════════════ 12. 按下反馈 / 焦点 / 减少动态 ═══════════════ */
/* 只动画反馈, 不动画布局。粗野主义用位移(硬阴影跟着走), 其余用缩放。 */
:host :is(button, [role="button"], .chip, .lm-btn):active:not(:disabled):not([role="switch"]) {
  transform: translate(var(--lm-press-shift, 0px), var(--lm-press-shift, 0px))
             scale(var(--lm-press-scale, .95));
}
:host :is(button, [role="button"], input, select, textarea, .lm-field):focus-visible {
  outline: 2px solid var(--lm-accent, var(--primary-color, #03a9f4));
  outline-offset: var(--lm-focus-offset, 3px);
}
@media (prefers-reduced-motion: reduce) {
  :host :is(button, [role="button"], .chip, .lm-btn):active:not(:disabled) { transform: none; }
}

/* ═══════════════ 13. 各卡里"同角色不同类名"的补位 ═══════════════ */
/* 只在这里登记一次, 免得每张卡各自写一套长相。名字保持各卡原样, 不改 DOM。 */
.tchip, .winbar .monlab, .btns button, .panel button, .mbtns button,
.delpop .dpa button, .expmenu button, .addPeriod {
  background: var(--lm-surface-control, var(--ha-card-background, var(--card-background-color, #fff)));
  border: var(--lm-control-border, 0);
  box-shadow: var(--lm-shadow-control, 0 1px 4px rgba(0, 0, 0, .16));
}
.tchip:not(.on):not([disabled]):hover, .winbar .monlab:not(.on):hover,
.btns button:not(.on):hover, .panel button:not(.primary):not(.armed):not(.danger):not([disabled]):hover {
  background-color: var(--lm-accent-soft, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
}
/* 地图信息板 / 围栏表单: 浮层 + 面板内控件 */
.panel { border-radius: var(--lm-radius-control, 10px); }
.panel input, .panel select, .zrow .zrad {
  background: var(--lm-surface-inset, var(--secondary-background-color, #eef1f5));
  border: var(--lm-field-border, 1px solid var(--divider-color, #ccc));
  border-radius: var(--lm-radius-control, 6px);
  box-shadow: var(--lm-field-shadow, none);
  color: inherit;
}
/* 围栏删除确认: 红描边是**语义**, 保留; 只把底色/圆角接进共享层 */
.zrow button.danger { border: 1px solid var(--lm-error, var(--error-color, #db4437)); }

/* ═══════════════ 14. 独立子组件(各自 shadow root, 显式导入本文件) ═══════════════ */
/* 车机工具 / 车衣有**自己的** shadow root: 父卡的 CSS 进不去, 所以它们也导入同一份
   控件层。这里用「:host(元素名)」把"元素选择器"限制在它们身上 —— 直接写裸 button
   选择器会连带命中所有卡片里的按钮。 */
:host(leapmotor-vehicle-tools) button,
:host(leapmotor-car-wrap) button,
:host(leapmotor-car-wrap) select {
  background: var(--lm-surface-control, var(--card-background-color, #fff));
  color: inherit;
  border: var(--lm-control-border, 0);
  box-shadow: var(--lm-shadow-control, 0 1px 4px #0002);
  border-radius: var(--lm-radius-control, 9px);
  transition: background-color var(--lm-duration-fast, 120ms) var(--lm-ease, ease),
              transform var(--lm-duration-fast, 120ms) var(--lm-ease, ease);
}
:host(leapmotor-vehicle-tools) button:not([disabled]):hover,
:host(leapmotor-car-wrap) button:not([disabled]):hover {
  background-color: var(--lm-accent-soft, rgba(var(--rgb-primary-color, 3, 169, 244), .12));
}
:host(leapmotor-vehicle-tools) input,
:host(leapmotor-vehicle-tools) select,
:host(leapmotor-car-wrap) select {
  background: var(--lm-surface-inset, var(--secondary-background-color, #eef1f5));
  color: inherit;
  border: var(--lm-field-border, 0);
  border-radius: var(--lm-radius-control, 8px);
  box-shadow: var(--lm-field-shadow, none);
}
:host(leapmotor-vehicle-tools) input[type="checkbox"] {
  background: var(--lm-track-off, var(--secondary-background-color, #eef1f5));
  border: var(--lm-control-border, 0);
  box-shadow: var(--lm-track-shadow, inset 0 1px 3px #0003);
}
:host(leapmotor-vehicle-tools) input[type="checkbox"]::before {
  background: var(--lm-knob, var(--card-background-color, #fff));
  box-shadow: var(--lm-knob-shadow, 0 1px 3px #0003);
}
:host(leapmotor-vehicle-tools) input[type="checkbox"]:checked::before {
  background: var(--lm-accent, var(--primary-color, #03a9f4));
}
:host(leapmotor-vehicle-tools) .week button { border-radius: var(--lm-radius-control, 9px); }
:host(leapmotor-vehicle-tools) .week .on {
  color: var(--lm-accent, var(--primary-color, #03a9f4));
  border: var(--lm-control-border, 0);
  background: var(--lm-accent-faint, color-mix(in srgb, var(--primary-color, #03a9f4) 7%, var(--card-background-color, #fff)));
  box-shadow: var(--lm-shadow-control, 0 1px 4px #0002);
}
`;

/** 供 Lit 卡使用: 同一份字符串, 名字更直白。 */
export const uiStylesCss = uiStyles;
