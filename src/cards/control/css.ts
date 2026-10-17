/*
 * 零跑·车辆控制卡 —— 卡片样式(原 _build() 里内联的那段 <style> 正文)。
 *
 * 子块与控件使用无边框、轻量阴影；颜色跟随 HA 主题。
 * 充电、设置与座椅采用与电价设置一致的全页遮罩，正文独立滚动。
 */
import { interactionStyles } from "../../lib/motion";
import { uiStyles } from "../../lib/ui/styles";
export const CARD_CSS = `${interactionStyles}        /* 配色: 与「零跑·行程浏览」卡片同一套视觉语言 —— 大卡白底, 里面的子块
           (充电/座椅/燃油/行程/空调/位置/车模)也是白底, 靠**一层阴影**跟大卡分开 ——
           1.9.39 起不再画 1px 灰边框: 子块与圆钮/胶囊按钮都改成"浮起来"的写法,
           与卡片内弹窗(.smodal: 无边框 + 一层投影)同一套语言(用户拍板: 要"浮"不要"框")。
           子块里的小控件(状态胶囊/开关/滑条槽/座舱按钮)才压一层浅灰底, 于是"白卡 → 白子块 → 浅灰控件"。
           深浅两种主题都靠 HA 变量自适应。
           圆角体系也跟行程卡对齐: 大卡 12(同行程卡) / 子块 14 / 胶囊 999 / 圆钮 50%。
           只有语义色(通风蓝/加热红/告警)写死, 且都挑了在白底和浅灰底上都能看清的值。 */
        :host { display: block; }
        /* 所有宽高都按 border-box 算: 加 1px 边框时尺寸不会跳 */
        * { box-sizing: border-box; }
        .card {
          /* 照片、提示与车模叠层的定位基准。全页设置弹窗位于卡片外。 */
          position: relative;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
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
        /* 语义色(白底/浅灰底上都看得清) */
        .info { color: var(--secondary-text-color, #6b7280); cursor: help; }
        /* ── 子块统一长相: 白底 + **只有一层阴影**(与卡片内弹窗 .smodal 同一套语言: 不描边) ──
           四个圆钮(.circ)也走这一套 —— 只是圆角是 50%, 激活时整颗点成主题色。
           ⚠️ 阴影取值是"按弹窗那套缩放"的: 弹窗 0 10px 34px / .4(它浮在遮罩上, 要更强的投影),
           卡内子块与按钮 0 1px 4px / .16(同一族: 轻微向下偏移与柔和投影, 无边框)。
           实测(浅/深两套截图 A/B): 直接用弹窗的字面值会在每颗圆钮外圈糊一圈黑边, 显脏;
           按比例缩一档之后"浮起来"的观感一致, 又不抢内容。
           1.9.40 起再收小一档(.22 → .16): 白底子块/按钮在浅色卡面上仍能看出边界, 深色
           主题下也不会糊成一团 —— 用户要的是"阴影调小一点", 不是去掉阴影。
           ⚠️ 车模(.carModel)**不在**这一组: 它直接放在卡片背景上(无底/无框/无阴影)。 */
        .sec, .half, .pick, .circ {
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          /* ⚠️ border: 0 不能省: 按钮的 UA 默认样式是 2px outset 描边, 上一条规则把 1px 自己
             那条换掉之后, 不写这一句就会露出浏览器默认的那圈**黑边**(实测: 圆钮/胶囊全变描边)。 */
          border: 0;
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
        }
        /* ── 纯展示的小控件(提示条 / 状态胶囊 / 输入框): 浅灰底 + 一圈灰边 ──
           ⚠️ 这一组**故意保留** 1px 描边: 它们是"贴在别的面上的小标签"(车模上的胎压读数、
           状态胶囊、提示条), 本身就小、再压阴影会显脏; 描边在这里是"读出边界"的必需品。
           1.9.39 的"只留阴影"只覆盖**子块与按钮**(见上面两组规则)。 */
        .hint, .pill, .rchip, .winPop, .cabConsole, .kvchip, .tP, .toast {
          background: var(--secondary-background-color, #e7eaed);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        }
        /* ── 可点的小按钮: 白底(卡片同款) + 与子块同款阴影(1.9.39 起不描边) ──
           交互统一: hover 淡蓝, 选中/语义态保持各自的颜色(见各处 .on/.armed/.vent/.heat 规则) ── */
        .toolBtn, .chip, .winOpt, .fanBtn, .floatPill, .cabBtn,
        .pickRow {
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 0; /* 同上: 挡掉按钮的 UA 默认 2px outset 描边 */
          box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
          transition: background .15s ease;
        }
        /* hover 淡蓝: 选中态(.on/.armed/.vent/.heat)与禁用态除外 */
        .toolBtn:not([disabled]):hover,
        .chip:not(.on):not([disabled]):hover, .winOpt:not([disabled]):hover,
        .fanBtn:not(.on):not([disabled]):hover, .floatPill:not([disabled]):hover,
        .cabBtn:not(.on):not(.vent):not(.heat):not([disabled]):hover,
        .pickRow:not([disabled]):hover, .circ:not(.on):not([disabled]):hover {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
        }
        .hint {
          padding: 8px 12px; border-radius: var(--lm-radius-section, 14px); font-size: 12px;
          align-items: flex-start; gap: 6px;
        }
        .hint .info { flex: none; margin-top: 1px; }
        /* ── 内层卡片: 白底 + 一层阴影(见上面的分组规则; 1.9.39 起不描边) ── */
        .sec { border-radius: var(--lm-radius-section, 14px); padding: 12px 14px; }
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
        /* ── hero:左栏(车名/状态更新/续航) + 右栏(状态胶囊/刷新/锁) ──
           布局要点(都是为了"续航行不被挤动" + "胶囊尽量一行"):
           * 红色告警**不在这里**(停在车模右上角, 见 .warnDock) —— 它数量会变,
             放在标题行会把续航行顶下去(实测位移 38px);
           * 右栏 1.9.39 起改**横排 + 允许换行**(row + wrap + 右对齐): 「已驻车 / 未插枪」
             并在一行, 「车门已上锁」放不下时换到第二行(两个上锁态胶囊这样排更像 App 的角标列);
           * 右栏 flex-shrink: 1(不再是 0 0 auto) —— 不收缩时它会坚持按 max-content 要宽度,
             .heroTop 只好整块把它换到下一行, 内部的 wrap 就永远轮不到;
             现在由它自己按可用宽度折行(胶囊仍 white-space: nowrap, 只整颗换行, 不在胶囊内折);
           * .heroTop 允许 wrap —— 万一 340px 下真放不下(超长充电文案), 整块右栏换到
             下一行(那时拿满整卡宽度, 仍然一行), 而不是把胶囊压成两行;
           * 左栏 basis 用 0 + min-width: min-content —— 否则**长车名**会撑大左栏的
             假设宽度→右栏被判定放不下→胶囊提前换行(实测 12 字车名就会触发)。 */
        .heroTop { display: flex; align-items: flex-start; gap: 10px; flex-wrap: wrap; }
        .heroLeft { flex: 1 1 0; min-width: min-content; }
        .heroRight { flex: 0 1 auto; display: flex; flex-direction: row; flex-wrap: wrap;
          align-items: center; justify-content: flex-end; gap: 6px; min-width: 0;
          /* ⚠️ max-width 50% 是"让它自己折行"的关键: 右栏若不封顶, 它作为 flex 项的假设宽度
             就是三颗胶囊排一行的 max-content(实测 265px), 塞不进标题行 → .heroTop 会把**整块**
             右栏换到第二行(顶着半个卡宽、也不再贴右缘, 实测过)。
             封顶之后它留在右上角、自己按可用宽度折行: 常见 384px 列宽下 = 「已驻车 / 未插枪」
             一行 + 「车门已上锁」一行(实测胶囊对 130px ✓ 放得下), 而左栏仍留 168px ——
             「状态更新 · 14 小时前」这类长文案 + 刷新钮要 ~133px, 刚好不折(60% 时左栏只剩
             132px, 那行会被折成两行, 实测对比过)。列很宽(>530px)时三颗仍可排成一行。 */
          max-width: 50%; }
        .heroRight .pill { white-space: nowrap; }
        .vnameRow { display:flex; align-items:center; gap:8px; min-width:0; }
        .vname { flex:1; min-width:0; font-size: 20px; font-weight: 600; line-height: 1.2; }
        .car3dRefresh { width:26px; height:26px; }
        .car3dRefresh ha-icon { --mdc-icon-size:16px; }
        .car3dRefresh.spinning ha-icon { animation: car3dRefreshSpin 900ms linear infinite; }
        @keyframes car3dRefreshSpin { to { transform: rotate(360deg); } }
        @media(prefers-reduced-motion:reduce) { .car3dRefresh.spinning ha-icon { animation:none; } }
        /* 双击标题改名时的输入框(样式跟标题一致, 只多一圈主题色描边) */
        .vnameEdit {
          font: inherit; font-size: 20px; font-weight: 600; line-height: 1.2;
          width: 100%; min-width: 0; box-sizing: border-box;
          padding: 0 6px; margin: -3px -6px;
          color: inherit; background: var(--lm-surface-control, var(--card-background-color, #fff));
          border: 1px solid var(--primary-color, #03a9f4); border-radius: var(--lm-radius-control, 8px); outline: none;
        }
        /* 「状态更新 · 刚刚」这行 + 紧随其后的刷新钮(同一行, 钮与这行小字等高) */
        .subRow { display: flex; align-items: center; gap: 6px; margin-top: 2px; min-width: 0; }
        .vsub { font-size: 12px; opacity: .62; }
        /* 白卡上的小圆钮(刷新车况): 底色/阴影走上面的"可点小按钮"组, 这里只管尺寸 */
        .toolBtn {
          width: 27px; height: 27px; border-radius: 50%; display: inline-flex;
          align-items: center; justify-content: center; padding: 0; flex: none;
          color: var(--secondary-text-color, #6b7280);
        }
        /* 紧跟「状态更新」那行的刷新钮: 去掉底/边/阴影, 高度压到与 12px 小字齐平 */
        .toolBtn.sub {
          width: 15px; height: 15px; border: 0; box-shadow: none; background: transparent;
          opacity: .85;
        }
        .toolBtn.sub svg { display: block; }
        .toolBtn:active { transform: scale(.94); }
        /* 续航行只放续航(锁在右栏) —— 这一行的位置与胶囊数量无关 */
        .heroMain { display: flex; align-items: flex-end; gap: 12px; margin-top: 12px; }
        /* ⚠️ min-width 必须是 max-content:原样式 min-width: 0 允许收缩到 0,
           flex 于是认为"放得下"、不换行, 直接把大数字挤到溢出(实测: 412km 被塞进 44px 宽的容器)。 */
        .rangeBig { flex: 1; min-width: max-content; }
        .rn { font-size: 40px; font-weight: 600; line-height: 1.05; letter-spacing: -.5px; }
        .rn i { font-style: normal; font-size: 15px; font-weight: 500; margin-left: 4px; opacity: .75; }
        .powerMeterRow { display:flex; align-items:center; gap:8px; width:100%; margin-top:7px; }
        .socRow { margin-top:8px; }
        .powerMeterLabel { display:flex; align-items:center; gap:5px; flex:0 0 76px; width:76px;
          min-width:76px; overflow:hidden; font-size:12px; opacity:.74; white-space:nowrap; }
        .powerMeterLabel ha-icon { --mdc-icon-size:15px; flex:none; }
        .fuelLabel ha-icon { color:var(--warning-color,#f39a32); }
        /* 电量与燃油共享同一剩余轨道宽度，避免燃油条被全局 .bar.fuel 拉长。 */
        .powerMeterRow .bar, .powerMeterRow .bar.fuel { flex:1 1 0; width:auto; min-width:0; }
        .powerMeterRow .bar.fuel b { background:var(--warning-color,#f39a32); }
        .bar {
          flex: 1; height: 6px; border-radius: 3px; display: block; overflow: hidden;
          background: var(--divider-color, rgba(127,127,127,.3));
        }
        /* 电量条基础色 = 绿(原来蓝); 低于 30% 黄 / 15% 红 —— 低电警告**压过**基础色 */
        .bar b {
          display: block; height: 100%; border-radius: 3px; position: relative; overflow: hidden;
          background: var(--success-color, #43a047); transition: width .4s ease;
        }
        .bar b.low { background: var(--warning-color, #ffa600); }
        .bar b.crit { background: var(--error-color, #db4437); }
        /* 充电中: 一条亮带从左往右扫过已充部分(系统开了"减少动态"就不动) */
        .bar.charging b::after {
          content: ""; position: absolute; inset: 0; transform: translateX(-100%);
          background: linear-gradient(90deg, transparent 0%, rgba(255,255,255,.85) 45%, transparent 90%);
          animation: chgShine 1.6s linear infinite;
        }
        @keyframes chgShine { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
        @media (prefers-reduced-motion: reduce) { .bar.charging b::after { animation: none; opacity: 0; } }
        .bar.fuel { flex: none; width: 100%; }
        .bar.fuel b { background: var(--warning-color, #ffa600); }
        .pill {
          padding: 6px 12px; border-radius: var(--lm-radius-badge, 999px); font-size: 12px;
          color: var(--secondary-text-color, #666); white-space: nowrap;
        }
        .pill.warn { background: var(--warning-color, #ffa600); border-color: transparent; }
        .pill.chg { background: var(--success-color, #43a047); border-color: transparent; }
        .pill.parked { background: var(--success-color, #43a047); border-color: transparent; }
        .pill.plug { background: var(--error-color, #db4437); border-color: transparent; }
        .pill.err { background: var(--error-color, #db4437); border-color: transparent; }
        .heroSub { margin-top: 8px; }
        /* 增程车: 总续航下面的「⚡纯电 / ⛽燃油」两个小胶囊 */
        .rangeChips { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; }
        .rchip {
          display: inline-flex; align-items: center; gap: 4px; padding: 6px 12px;
          border-radius: var(--lm-radius-badge, 999px); font-size: 13px; white-space: nowrap;
          color: var(--secondary-text-color, #666);
        }
        .rchip b { font-size: 15px; font-weight: 600; color: var(--primary-text-color, #222); }
        .rchip.ev ha-icon { color: #00bcd4; }
        .rchip.fuel ha-icon { color: var(--warning-color, #ffa600); }
        /* ── 车模区(车辆区的主图; 整块可点, 预留车模视图) ── */
        /* 车模直接放在卡片背景上(无底/无框/无阴影; 已从上面的"子块"分组里移出)。
           圆角与 overflow: hidden 留着 —— 胎压标签/告警停靠区要贴边不溢出。 */
        .carModel {
          position: relative; margin-top: 12px; border-radius: var(--lm-radius-section, 14px); overflow: hidden;
          height: 200px; padding: 10px 0; box-sizing: border-box;
          display: flex; align-items: center; justify-content: center;
          cursor: pointer;
        }
        /* 底部要给「胎压」小胶囊留一条出来, 没这个按钮就不用留 */
        .carModel.hasTire { padding: 10px 0 34px; }
        .card.narrow .carModel { height: 160px; padding: 4px 0; }
        .card.narrow .carModel.hasTire { padding: 4px 0 30px; }
        /* 整车展示图以 contain 保证原始比例。无素材时不绘制车图。 */
        .carImg { width: 100%; height: 100%; object-fit: contain; }
        /* ── 车模左侧的充电状态块 ──
           绝对定位(不占宽度 → 出现/展开都不挤动车模); **top 锚定**而不是垂直居中:
           这样收起↔展开时"左上角"不动, 只向下长(实测两态 dx/dy 完全一致)。
           收起态 = 图标 + 「慢充中/快充中」(不显示功率); 展开态 = 同款白框里补电压/电流/功率/剩余。
           两态都是"白底 + 灰框", 点开是同一个块**扩充**, 不是换了个东西。 */
        /* 左上角(与右上角的告警停靠区对称); top 定值 → 收起↔展开**左上角不动**, 只向下长。
           3D 时上缘那一条(0 ~ --c3data)被 hero 数据占着(车名/续航/胶囊)—— 见下面
           stage3d 那条规则: 改贴到**数据层下沿**的空档。
           max-width 收窄: 展开态别伸进"左列胎压读数让开后的位置"(见 .tirePads.hasChg)。 */
        .chgDock {
          position: absolute; left: 10px; top: 10px; z-index: 3; max-width: 122px;
          display: flex; flex-direction: column; align-items: flex-start;
        }
        .chgBtn, .chgPanel {
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
          color: var(--success-color, #43a047); border-radius: var(--lm-radius-control, 12px);
          font: inherit; text-align: left; cursor: pointer;
        }
        .chgBtn {
          display: inline-flex; align-items: center; gap: 5px; padding: 6px 11px;
          font-size: 12.5px; font-weight: 600; white-space: nowrap;
        }
        .chgPanel {
          display: flex; flex-direction: column; align-items: flex-start; gap: 5px;
          padding: 7px 10px 9px;
        }
        .chgPanel .top {
          display: flex; align-items: center; gap: 5px;
          font-size: 12.5px; font-weight: 600;
        }
        .chgPanel .kv {
          display: flex; gap: 6px; font-size: 11px; font-weight: 400;
          color: var(--secondary-text-color, #6b7280);
        }
        .chgPanel .kv b {
          color: var(--primary-text-color, #212121); font-weight: 600; font-size: 12px;
          font-variant-numeric: tabular-nums;
        }
        .chgPanel .rem {
          font-size: 10.5px; font-weight: 400;
          color: var(--secondary-text-color, #6b7280); opacity: .85;
        }
        /* 展开态标题行右侧那个小箭头: 极简(无边框无底色), 只是"可收起"的提示 */
        .chgMin {
          margin-left: 2px; display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280); opacity: .8; font-size: 10px; line-height: 1;
        }
        /* 充电闪电图标: 中性色按主题换(绿色渐变填充在 _boltIcon 里, 不随主题变) */
        /* 闪电的中性色跟随主题文字色(浅色主题=深、深色主题=亮) —— 原稿的深色
           在深色卡上会看不见; 绿色渐变填充不随主题变。 */
        .card {
          --bolt-outline: var(--primary-text-color, #334155);
          --bolt-fill: var(--primary-text-color, #1e293b);
        }
        .bolt { width: 17px; height: 17px; flex: none; display: block; }
        /* ── 车模右上角的告警停靠区(胎压偏低 / 未关) ──
           收起态 = 一颗红色「!」(多于一条时带条数角标); 展开态 = 逐条红色胶囊 + 「收起」。
           为什么停在这里: 告警数量会变(0~2 条), 若放标题行会把「续航行」顶下去(实测 38px)。 */
        .warnDock {
          position: absolute; right: 10px; top: 10px; z-index: 4;
          display: flex; flex-direction: column; align-items: flex-end; gap: 6px;
        }
        /* 展开态与收起态**同一个锚点**: 右缘都停在舞台右上角 10px 处(1.9.39 起不再左移 70px)。
           列表比「!」宽, 让它**向左自然生长**, 整块不横移 —— 这样"点开告警"时那颗「!」的位置
           一动不动(用户报的正是这一点: 展开后胶囊与告警提示对不上)。
           与右侧那列胎压读数的冲突改由**读数让位**解决(见下面 .tirePads.hasWarn):
           只要列表右缘钉在 10px 处, 它左缘必然落在读数那一列里, 靠"收窄列表"是避不开的。
           层级: 告警列表 > 充电块。 */
        .warnDock.open .warnList { max-width: 108px; }
        /* 展开态的胶囊: 允许折行(右对齐) —— 长文案("后备箱、车窗未关")不至于把列表拉成整屏宽 */
        .warnDock.open .pill.err { white-space: normal; text-align: right; }
        .warnBtn {
          position: relative; width: 30px; height: 30px; padding: 0; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center;
          background: var(--error-color, #db4437); color: #fff; font-weight: 700;
          font-size: 17px; line-height: 1; border: 0; cursor: pointer;
          box-shadow: 0 1px 4px rgba(0, 0, 0, .3);
        }
        .warnBtn:active { transform: scale(.94); }
        .warnBtn .cnt {
          position: absolute; right: -3px; top: -3px; min-width: 15px; height: 15px;
          padding: 0 3px; border-radius: var(--lm-radius-badge, 999px); background: #fff;
          color: var(--error-color, #db4437); font-size: 10px; font-weight: 700;
          line-height: 15px; text-align: center; box-shadow: 0 1px 2px rgba(0, 0, 0, .25);
        }
        .warnList { display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
        /* 展开态的胶囊浮在车图上, 加一层阴影压住底下的车漆, 保证可读 */
        .warnList .pill.err { box-shadow: 0 1px 4px rgba(0, 0, 0, .28); }
        .warnCollapse {
          font: inherit; font-size: 11px; padding: 3px 9px; border-radius: var(--lm-radius-badge, 999px); cursor: pointer;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          color: var(--secondary-text-color, #6b7280);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 1px 3px rgba(0, 0, 0, .16);
        }
        /* 胎压开关(在车模下方的 .carTools 行里): **纯图标** —— 无边框、无底色、无胶囊。
           图标用公开的 mdi:gauge(20px), 常态次级文字色, 选中(显示读数)时主题色。
           命中区做到 32×32, 用负 margin 抵掉多出来的 6px → 这一行的高度保持不变。 */
        .tireTgl {
          width: 32px; height: 32px; margin: -3px 0; padding: 0; flex: none;
          border: 0; background: transparent; box-shadow: none; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280);
          transition: color .15s ease, transform .12s ease;
        }
        .tireTgl:not([disabled]):hover { color: var(--primary-text-color, #212121); }
        .tireTgl.on { color: var(--primary-color, #03a9f4); }
        .tireTgl:active { transform: scale(.94); }
        /* 车模上的四个轮压数据点(俯视方位: 左前/右前/左后/右后)。
           读数层铺满整个"车辆区": 2D 时就是车模盒, 3D 时被夹到**舞台本身**(见下面的 .stage3d 那条)。
           四颗读数落在"前/后两条带"里、左右各自贴边 —— ⚠️ 不再用四角 top/bottom: 8px 死定位:
           那样在 3D 里后两颗会掉出舞台(实测 top 293 > 舞台底 264), 压到下面的四个圆钮行上。 */
        .tirePads { position: absolute; inset: 0; pointer-events: none; }
        .tirePads .tP { pointer-events: auto; }
        .tP {
          position: absolute; display: inline-flex; flex-direction: column; align-items: center;
          padding: 3px 8px; border-radius: 10px; font-size: 11px; line-height: 1.2;
          min-width: 54px; max-width: 64px;
        }
        .tP i { font-style: normal; opacity: .6; white-space: nowrap; }
        .tP b { font-size: 13px; font-weight: 600; }
        /* 2D(车模盒 200px 高, 窄屏 160): 前带 bottom 55 / 后带 bottom 11 —— 两条带天然落在盒内 */
        .tP.a { left: 8px; bottom: 55px; }
        .tP.b { right: 8px; bottom: 55px; }
        .tP.c { left: 8px; bottom: 11px; }
        .tP.d { right: 8px; bottom: 11px; }
        /* 充电块占着左侧那一条(x 8..~120): 充电中左列读数让开它(右移一个身位, 见 carDocksPanel 的 .hasChg) */
        .tirePads.hasChg .tP.a, .tirePads.hasChg .tP.c { left: 132px; }
        /* 告警列表展开时: **3D 下右列读数让开它**(左移一个身位, 见 carDocksPanel 的 .hasWarn) ——
           告警块自己钉在舞台右缘 10px 不动(见上面 .warnDock.open), 冲突由读数让位解决。
           2D 车模盒里告警在上、读数在下(两条带 bottom 55/11), 本来就撞不上, 所以只给 3D 这条。 */
        .heroStage.stage3d .tirePads.hasWarn .tP.b, .heroStage.stage3d .tirePads.hasWarn .tP.d { right: 132px; }
        /* 超区间/标红只改边框色(不再用 inset 描边) */
        .tP.warn { border-color: var(--warning-color, #ffa600); }
        .tP.warn b { color: var(--warning-color, #ffa600); }
        .tP.bad { border-color: var(--error-color, #db4437); }
        .tP.bad b { color: var(--error-color, #db4437); }
        /* ── 四个圆形动作按钮(白底圆钮 + 一层阴影, 打开时整颗点成主题色) ── */
        .acts { display: flex; gap: 8px; max-width: 560px; }
        .act { flex: 1; display: flex; flex-direction: column; align-items: center; gap: 8px; min-width: 0; }
        .circ {
          width: 56px; height: 56px; border-radius: 50%; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          transition: transform .12s ease, background .15s ease;
        }
        .card.narrow .circ { width: 48px; height: 48px; }
        .circ:active { transform: scale(.94); }
        /* 「已开/已锁/已解锁」用主题色把整颗圆钮点出来 */
        .circ.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        /* 未关告警: **只是把圆钮那一圈描边换成红色**(图标/文字颜色都不动)。
           —— 蓝底、红图标、红文字都试过: 与红胶囊叠在一起信息重复, 反而看不清重点。
           做法: 只挂 .warn(不能写成 .circ.on.warn: 车窗告警时气泡是关着的, 不会有 .on)。
           ⚠️ 1.9.39 起圆钮不再有 1px 边框(改成只有阴影), 这圈红描边改用 **inset 阴影**画:
           细(2px)/不撑大尺寸, 也不像外阴影那样盖住相邻元素 —— 与旧 border 写法观感一致。 */
        .circ.warn { box-shadow: inset 0 0 0 2px var(--error-color, #db4437), 0 1px 4px rgba(0, 0, 0, .16); }
        .actL { font-size: 13px; opacity: .8; white-space: nowrap; }
        /* 车窗四档: 悬浮气泡(absolute + z-index, 不撑高动作行、也不压住圆钮自己)
           具体的 left/top/箭头位置由 _placeWin() 按「车窗」圆钮实测后写回 inline style,
           下面的值只是 JS 跑之前的兜底(等于旧版: 相对整行居中) */
        .actWin { position: relative; }
        /* 「预设」钮 + 「座椅」钮并排在这层里(见 _hvacModes): 两者的间距由这里的 gap 决定 ——
           这层若是块级, 两颗钮就只靠行内空白排, 会**贴在一起**(实测 0px)且底边错开(基线对齐)。 */
        .actPreset { position: relative; display: inline-flex; align-items: center; gap: 12px; }
        /* 空调预设气泡: 纵向四条(与车窗气泡同款观感, 只是竖排) —— 1.9.39 起**向上展开**:
           从预设钮的**上沿**往上弹, 箭头朝下指回那颗钮(下面的 top/bottom 只是 JS 贴位前的
           兜底 = 向上; 真实位置由 _placePop(..., "up") 实测写回)。
           ⚠️ 同一张卡里的**车窗气泡是向下**的(.winPop): 两者共用 _placePop, 方向由参数区分,
           不要顺手把车窗那条也改了。 */
        .presetPop {
          position: absolute; top: auto; bottom: calc(100% + 8px); left: 50%; transform: translateX(-50%);
          box-sizing: border-box; z-index: 7; display: flex; flex-direction: column; gap: 4px;
          padding: 6px; min-width: 132px; border-radius: var(--lm-radius-section, 14px);
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 4px 14px rgba(0,0,0,.22);
        }
        /* 小箭头朝下指回预设钮(夹取后气泡不再正对它, 位置由 --winArrow 带过去) */
        .presetPop::after {
          content: ""; position: absolute; bottom: -6px; left: var(--winArrow, calc(50% - 6px));
          width: 12px; height: 12px; transform: rotate(45deg);
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border-right: 1px solid var(--divider-color, rgba(0,0,0,.09));
          border-bottom: 1px solid var(--divider-color, rgba(0,0,0,.09));
        }
        .presetOpt {
          display: flex; align-items: center; gap: 8px; width: 100%;
          padding: 8px 10px; border-radius: 10px; cursor: pointer;
          font: inherit; font-size: 13px; text-align: left;
          color: var(--primary-text-color, #212121);
          border: 1px solid transparent; background: transparent; box-shadow: none;
          white-space: nowrap;
        }
        .presetOpt:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .presetOpt.on {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
          border-color: transparent; font-weight: 600;
        }
        .presetOpt.on:hover { background: var(--primary-color, #03a9f4); filter: brightness(1.08); }
        .presetOpt:active { transform: scale(.97); }
        .winPop {
          position: absolute; top: calc(100% + 8px); left: 50%; transform: translateX(-50%);
          box-sizing: border-box; z-index: 6; display: flex; gap: 6px; padding: 8px;
          border-radius: var(--lm-radius-badge, 999px);
          box-shadow: 0 4px 14px rgba(0,0,0,.22);
          white-space: nowrap;
        }
        /* 小箭头指回上面的圆钮(夹取后气泡不再正对它, 位置由 --winArrow 带过去) */
        .winPop::before {
          content: ""; position: absolute; top: -6px; left: var(--winArrow, calc(50% - 6px));
          width: 12px; height: 12px; transform: rotate(45deg);
          background: var(--secondary-background-color, #e7eaed);
          border-left: 1px solid var(--divider-color, rgba(0,0,0,.09));
          border-top: 1px solid var(--divider-color, rgba(0,0,0,.09));
        }
        .winOpt {
          position: relative; padding: 6px 12px; border-radius: var(--lm-radius-badge, 999px); font-size: 13px;
          display: inline-flex; align-items: center; gap: 4px;
        }
        .winOpt:active { transform: scale(.96); }
        /* 白子块里的按钮/胶囊: 白底 + 一层阴影(与子块同款; 1.9.39 起不描边) —— hover 淡蓝 / 选中主题蓝 */
        .chip {
          padding: 8px 14px; border-radius: var(--lm-radius-badge, 999px); font-size: 13px;
        }
        /* 选中态: 淡主题色底 + 主题色文字 —— 与充电子卡的轻量开关同一套"简约"语言,
           不再用整块实心主题色(实心太抢眼, 且与色块圆的"圆环选中态"不是一套)。
           (1.9.39 起胶囊按钮不描边了, 那一圈"略深描边"随之去掉: 底色 + 文字色已足够区分。) */
        .chip.on { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
          color: var(--primary-color, #03a9f4); }
        /* 温度: 大号数字 + 底部「车内」小标(标明这是车内实测温度)。
           小标走 translateY 下移 —— transform 不改布局, 所以它不会把这一行撑高、也就不会挤走开关钮。 */
        .acTemp { font-size: 32px; font-weight: 600; line-height: 1.1; letter-spacing: -.5px; }
        .acTemp i { font-style: normal; font-size: 15px; font-weight: 500; margin-left: 2px; opacity: .75; }
        .acTag {
          display: inline-flex; align-items: center; margin-left: 6px;
          transform: translateY(5px); padding: 1px 8px;
          border-radius: var(--lm-radius-badge, 999px); font-size: 11px; font-weight: 500;
          color: var(--secondary-text-color, #6b7280);
          background: var(--secondary-background-color, #e7eaed);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        }
        /* 空调模式按钮: 简洁的圆形图标钮(不再是拉满一排的胶囊)。
           ⚠️ 必须允许换行 + 自身可收缩: 个别后端给 5 个模式(auto/dry)时,
           一排 5 × 42px 放不下会**溢出卡片压住邻卡**(实测: 连邻卡的点击都被挡)。
           间距这里只对"多个圆钮直接并排"生效; 现在钮都包在 .actPreset 里, 见那层的 gap。 */
        .modes { display: flex; flex-wrap: wrap; gap: 10px; justify-content: center; min-width: 0; }
        .mi {
          width: 36px; height: 36px; padding: 0; border-radius: 50%; flex: none;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .mi ha-icon { --mdc-icon-size: 19px; }
        .mi:not(.on) { color: var(--secondary-text-color, #6b7280); }
        /* ── 两张并排的小卡 ── */
        .cardsRow { display: flex; gap: 10px; align-items: stretch; container-type: inline-size; }
        /* 只有 <280px 才堆叠(见 _bindNarrow 的 tiny); 常见列宽下始终左右并排 */
        .card.tiny .cardsRow { flex-direction: column; }
        .p-climate, .p-location { flex: 1; min-width: 0; position: relative; aspect-ratio: 1; }
        .p-climate > .sec, .p-location > .sec { position: absolute; inset: 0; min-width: 0; margin: 0; }
        .half {
          display: flex; flex-direction: column; gap: 12px;
          border-radius: var(--lm-radius-section, 14px); padding: 12px 14px;
        }
        /* 空调卡头部(只有空调卡用): 温度块在左, 开关钮**恒定在右上角**。
           开关钮绝对定位钉住 + 右侧留出它的位置: 不管卡片多窄、温度那块的文字怎么换行,
           它都不会被挤到第二行去(此前窄卡片下会被"车内"小标撑出的宽度顶下去)。 */
        .halfH { display: flex; align-items: flex-start; gap: 8px; flex-wrap: wrap;
          position: relative; padding-right: 44px; }
        .halfId { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
        .bigTxt { font-size: 32px; font-weight: 600; line-height: 1.1; letter-spacing: -.5px; }
        .bigTxt.sm { font-size: 20px; }
        .halfS { font-size: 12px; opacity: .62; }
        .fanBtn {
          position: absolute; top: 0; right: 0;
          width: 36px; height: 36px; border-radius: 50%; padding: 0;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280);
        }
        .fanBtn.on { background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff); }
        /* 开着的时候持续转 —— 一眼看出"风在吹"; 系统开了"减少动态"就不转 */
        .fanBtn.on ha-icon { animation: fanSpin 1.8s linear infinite; }
        @keyframes fanSpin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .fanBtn.on ha-icon { animation: none; } }
        .floatRow { display: flex; gap: 8px; margin-top: auto; align-items: center; }
        .floatPill {
          display: inline-flex; align-items: center; justify-content: center; padding: 0;
          width: 36px; height: 36px; border-radius: var(--lm-radius-control, 12px);
        }
        /* ⓘ 靠右贴在胶囊行末尾 */
        .locInfo { margin-left: auto; }
        /* 位置卡拿驻车照片当背景: 半透明遮罩保证文字仍然读得清; 没有照片就退回纯色底 */
        .p-location .loc { overflow: hidden; }
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
        .locMap { position: absolute; inset: 0; overflow: hidden; background: var(--secondary-background-color,#e8edf1); }
        .locTiles { position: absolute; inset: 0; }
        .locTiles img { position: absolute; width: 256px; height: 256px; max-width: none; }
        .locMap.dark .locTiles { filter: invert(1) hue-rotate(180deg) brightness(.85); }
        .locCar { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); }
        .locCar svg { width: 24px; height: 24px; filter: drop-shadow(0 2px 3px #0003); }
        .hasMap .halfId { align-self: flex-start; max-width: 100%; color: #1f2937; text-shadow: 0 1px 3px #fff,0 0 7px #fff; }
        .hasMap:has(.locMap.dark) .halfId { color: #f3f6fb; text-shadow: 0 1px 3px #000,0 0 7px #000; }
        .hasMap .halfS.dim { display: none; }
        .hasMap .bigTxt.sm { font-size: 16px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
        .hasMap .halfS { font-size: 10px; }
        .half { padding: 10px; gap: 6px; }
        .climateSquare { background: linear-gradient(145deg,rgba(var(--rgb-primary-color,3,169,244),.07),transparent 70%),var(--lm-surface-control, var(--card-background-color,#fff)); }
        .climateSquare .halfH { flex:none; }
        .climateSquare .acBody { flex:1;justify-content:center; gap:clamp(6px,3cqi,18px); padding-bottom:clamp(0px,3cqi,18px); }
        .climateSquare .tempBox { gap: 2px; min-height: 34px; }
        .climateSquare .step { width: 30px; height: 34px; font-size: 20px; }
        .climateSquare .tval { width: 54px; font-size: 19px; }
        .climateSquare .modes { justify-content: center; }
        .climateSquare .acTemp { font-size: 26px; }
        /* ⚠️ 右栏那颗紧凑状态胶囊(.heroRight .pill)的长相**已整行搬进共享控件层**
           (见 src/lib/ui/styles.ts 的「信息胶囊」一节)。原来是"前面写一套 .pill、后面再用
           .heroRight .pill 覆盖一遍"的两层写法 —— 只改前一条根本不生效, 已按方案合并到唯一一处。 */
        .rangeBig{position:relative;}.rangeBig:has(.liveBig){display:flex;align-items:baseline;column-gap:18px;flex-wrap:wrap;}.rangeBig:has(.liveBig) .powerMeterRow{flex-basis:100%;width:100%;}.liveBig{display:inline-flex;align-items:baseline;gap:4px;white-space:nowrap;}.liveBig b{font-size:36px;font-weight:650;letter-spacing:-.04em;}.liveBig i{font-size:11px;font-style:normal;}.liveBig small{font-size:9px;border-radius:5px;padding:2px 4px;box-shadow:0 1px 5px #0002;}.liveBig.charging{color:#16956a;}.heroTop:has(.liveBig) .heroLeft{flex-basis:100%;}.heroTop:has(.liveBig){flex-wrap:wrap;}.heroTop:has(.liveBig) .heroRight{margin-left:auto;}
        .heroTop:has(.liveBig){position:relative;display:block;}.heroTop:has(.liveBig) .heroRight{position:absolute;right:0;top:0;margin-left:0;max-width:52%;}.heroTop:has(.liveBig) .heroLeft :is(.vnameRow,.subRow){max-width:calc(100% - 145px);}.heroTop:has(.liveBig) .heroMain{padding-top:10px;}
        .heroRight .pill::before { content: ""; width: 5px; height: 5px; border-radius: 50%; background: currentColor; }
        .stage3d .heroMain, .stage3d .heroSub { color: var(--c3-ink); }
        .card.narrow .vname { font-size: 18px; }
        .smodal.on, .smask.on, .palPop, .presetPop, .winPop, .ovlBox { animation: panelIn 160ms ease both; }
        @keyframes panelIn { from { opacity: 0; } to { opacity: 1; } }
        .car3dLoading { display:none; position:absolute; z-index:3; left:50%; top:62%; transform:translate(-50%,-50%); align-items:center; gap:9px; padding:9px 13px; border:var(--lm-floating-border,1px solid var(--divider-color,#0002)); border-radius:var(--lm-radius-control,12px); background:var(--lm-surface-floating,var(--card-background-color,#fff)); color:var(--primary-text-color,#222); box-shadow:var(--lm-shadow-floating,0 5px 18px #0002); font-size:12px; white-space:nowrap; pointer-events:none; }
        .loading3d .car3dLoading { display:flex; }
        .car3dLoading i { display:inline-flex; align-items:center; gap:3px; font-style:normal; }
        .car3dLoading b { width:5px; height:5px; border-radius:50%; background:var(--lm-accent,var(--primary-color,#03a9f4)); opacity:.35; animation:car3dDots 1s ease-in-out infinite; }
        .car3dLoading b:nth-child(2) { animation-delay:160ms; }
        .car3dLoading b:nth-child(3) { animation-delay:320ms; }
        @keyframes car3dDots { 0%,60%,100% { opacity:.3; transform:translateY(0) scale(.85); } 30% { opacity:1; transform:translateY(-3px) scale(1); } }
        @media(prefers-reduced-motion:reduce) { .car3dLoading b { animation:none; opacity:.75; } }
        .locIn .halfS { overflow-wrap: anywhere; }
        @container (max-width: 320px) {
          .half { padding: 7px; gap: 3px; }
          .climateSquare .acTemp { font-size: 22px; }
          .climateSquare .halfH { padding-right: 30px; }
          .climateSquare .fanBtn { width: 28px; height: 28px; }
          .climateSquare .acBody { gap: 2px; }
          .climateSquare .mi { width: 28px; height: 28px; padding: 0; }
          .climateSquare .tempBox { min-height: 30px; }
          .climateSquare .step { width: 24px; height: 30px; }
          .climateSquare .tval { width: 46px; font-size: 17px; }
          .floatPill { width: 30px; height: 30px; border-radius: 10px; }
        }
        .acBody { display: flex; flex-direction: column; gap: 12px; }
        /* 温度步进整行居中: 两个按钮一样大、温度数字固定宽度 */
        /* min-height 与 ± 按钮(40px)同高: 空调关着时(没有 ±)模式圆钮也不会往上跳 */
        /* 温度行: min-height 与 ± 同高; 数字固定宽度 + 整行居中 —— 关着时 ± 被藏掉,
           数字仍落在同一个位置(不靠"设定"之类的占位文字撑版面) */
        .tempBox { display: flex; align-items: center; gap: 8px; justify-content: center; min-height: 40px; }
        /* 温度 ±: 极简无框(只剩符号), hover 把符号点成主题蓝 */
        .step {
          width: 40px; height: 40px; border: none; background: transparent;
          border-radius: 50%; font-size: 24px; line-height: 1; flex: none;
          color: var(--primary-text-color, #212121);
        }
        .step:hover:not([disabled]) { color: var(--primary-color, #03a9f4); }
        .step:active { transform: scale(.94); }
        .tval { font-size: 20px; font-weight: 600; width: 64px; flex: none; text-align: center; }
        .tval i { font-style: normal; font-size: 12px; opacity: .6; }
        /* 温度位上的「图标 + 模式名」(快速除味 / 风挡除霜): 比 20px 的温度数字低一档 ——
           它是这一行的主信息(要看得清), 但不抢车内温度大字的注意力(次级文字色 + 中黑字重)。
           宽度不锁 64px: 模式名(4 个字)加图标比"24.5℃"宽, 让它自然撑开、整行仍居中。 */
        .tempBox .tpr {
          display: inline-flex; align-items: center; gap: 6px; min-height: 40px;
          font-size: 14px; font-weight: 600; color: var(--secondary-text-color, #6b7280);
        }
        .tempBox .tpr ha-icon { --mdc-icon-size: 18px; flex: none; }
        /* ── 充电 / 设置: 左右并排的两张**入口卡**(各占一半, 点开各自弹窗) ──
           与上面「空调 / 位置」(.cardsRow)同一套: 只有 <280px(.card.tiny) 才退回上下堆叠。 */
        .csRow { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; align-items: stretch; }
        .card.tiny .csRow { grid-template-columns: 1fr; }
        .csRow > * { min-width: 0; }
        /* ⚠️ .sec 嵌在 .p-charging / .p-car3d 里面, **不是** .csRow 的直接子元素 ——
           原来写成 .csRow > .sec 谁也匹配不到, 于是"没有摘要的那张卡"真的矮一截、标题也跟着错位。
           现在两层都撑满, 并让内容垂直居中: 两张卡等高、标题同高。 */
        .csRow > .p-charging, .csRow > .p-car3d { height: 100%; }
        .csRow > .p-charging > .sec, .csRow > .p-car3d > .sec {
          height: 100%; box-sizing: border-box;
          display: flex; flex-direction: column; justify-content: center;
        }
        .csDetail { grid-column: 1 / -1; }
        /* 并排的两张卡只有半幅宽, 标题和摘要挤一行放不下 —— 摘要换到标题下面一行,
           箭头仍在右上角竖着居中(和折叠块"标题+摘要"的读法一致)。 */
        .csRow .foldH {
          display: grid; grid-template-columns: minmax(0, 1fr) auto;
          grid-template-areas: "t c" "s c"; align-items: center; column-gap: 6px;
          width: 100%;
        }
        .csRow .foldT { grid-area: t; }
        .csRow .foldS {
          grid-area: s; margin-left: 0; text-align: left; padding-left: 0;
          /* 半幅宽放不下一整行摘要(座椅那种"主驾加热3 · 副驾加热1 · …"), 允许折到第二行,
             最多两行 —— grid 拉伸会让两张卡保持等高 */
          white-space: normal; overflow: hidden;
          display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
          /* 摘要为空(例如座椅全关)时也占住这一行, 否则两张卡的标题会一高一低 */
          min-height: 15px;
        }
        .csRow .foldC { grid-area: c; align-self: center; }
        /* 窄到堆叠(<280px .tiny)宽度又够了 —— 标题和摘要回到原来的一行式排版
           (并排的常见列宽下不适用: 半幅宽放不下, 仍走上面的两行 grid) */
        .card.tiny .csRow .foldH { display: flex; align-items: center; gap: 8px; }
        .card.tiny .csRow .foldS {
          display: block; margin-left: auto; text-align: right; padding-left: 8px;
          white-space: nowrap;
        }
        /* 充电设置: 一行一个设置项 —— 左边「图标 + 标签」/ 右边控件, 行与行之间一条细分隔线 */
        .cList { display: flex; flex-direction: column; }
        .cRow { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 10px 0; box-sizing: border-box; }
        .cRow + .cRow { border-top: 1px solid var(--divider-color, rgba(0,0,0,.08)); }
        /* 设置项左侧那颗小图标: 18px(和其它行的图标一个量级), 次级文字色, 与文字垂直居中 */
        .cIC {
          --mdc-icon-size: 18px;
          flex: none; align-self: center;
          color: var(--secondary-text-color, #6b7280);
        }
        .cL { font-size: 12.5px; flex: none; min-width: 62px; color: var(--secondary-text-color, #6b7280); }
        .cC { margin-left: auto; display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
        .cC .rng { flex: 1 1 120px; min-width: 110px; }
        .cV { font-size: 12px; font-weight: 600; min-width: 38px; text-align: right; opacity: .75; }
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
        /* 底图配色变量 + 类(取自视觉底图; 浅色默认 / .dark 跟随 HA 主题) */
        /* ── 座舱俯视模型(位图底图 + 绝对定位的座位控件) ── */
        /* 底图是 5座/7座 × 浅/深 四张位图(见 CABIN_IMG); 用 aspect-ratio 锁住 720x964 比例 */
        .cabin {
          position: relative; width: 100%; max-width: 340px;
          margin-left: auto; margin-right: auto; aspect-ratio: 720 / 964;
          border-radius: var(--lm-radius-section, 14px); overflow: hidden;
        }
        .cabMap { position: absolute; inset: 0; overflow: hidden;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff))); }
        /* 最上层: 用**卡片底色**从边缘往内渐隐(浅色主题=白), 让底图淡出到背景色而不是半透明 */
        .cabFade {
          position: absolute; inset: 0; z-index: 2; pointer-events: none;
          background: radial-gradient(122% 122% at 50% 50%,
            transparent 46%, var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff))) 90%);
        }
        /* 底层: 同一张图放大 + 模糊, 给边缘一层"虚化"过渡(模糊图与背景的边界) */
        .cabBlur {
          position: absolute; inset: -26%; background-size: cover; background-position: center;
          filter: blur(54px); transform: scale(1.26);
          -webkit-mask-image: radial-gradient(140% 140% at 50% 50%, #000 34%, transparent 100%);
          mask-image: radial-gradient(140% 140% at 50% 50%, #000 34%, transparent 100%);
        }
        /* 上层: 清晰图, 用**较大**的径向渐变把四周渐隐 —— 边缘露出下面的模糊层 */
        .cabBg { position: absolute; inset: 0; display: block; width: 100%; height: 100%;
          object-fit: cover; object-position: center;
          /* 较大的渐变空间: 中心清晰 → 边缘长距离渐隐, 露出下面的模糊层 */
          /* 渐变空间大: 中心 6% 起就开始过渡, 40% 半透, 76% 起全透 —— 模糊延伸到外侧座位 */
          -webkit-mask-image: radial-gradient(126% 126% at 50% 50%, #000 6%, rgba(0,0,0,.45) 40%, transparent 76%);
          mask-image: radial-gradient(126% 126% at 50% 50%, #000 6%, rgba(0,0,0,.45) 40%, transparent 76%); }
        .cabPos { position: absolute; z-index: 3; transform: translate(-50%, -50%); display: flex; justify-content: center; }
        .cabCell { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 0; }
        .cabIco { display: flex; gap: 4px; }
        .cabBtn {
          width: 38px; height: 38px; border-radius: var(--lm-radius-section, 14px); padding: 0; flex: none;
          display: inline-flex; align-items: center; justify-content: center;
          color: var(--secondary-text-color, #6b7280);
          opacity: .8;                     /* 按钮不透明度 80% */
          transition: transform .12s ease, opacity .15s ease;
        }
        .cabBtn:active { opacity: 1; }
        .cabBtn:active { transform: scale(.94); }
        /* IconPark 内联图标: 跟随 currentColor 与字号, 与 ha-icon 同尺寸观感 */
        .ip { display: inline-block; vertical-align: middle; flex: none; }
        /* 状态用**颜色**表示(不再有文字): 加热类=红, 通风=蓝且图标转动 */
        .cabBtn.heat.on, .cabBtn.sw.on { color: #e53935; }
        .cabBtn.vent.on { color: #29b6f6; }
        @keyframes cabspin { to { transform: rotate(360deg); } }
        .cabBtn.spin ha-icon { animation: cabspin 1.1s linear infinite; }
        .cabBtn.compact { width: 30px; height: 30px; border-radius: 10px; }
        /* 全页遮罩与电价设置使用相同布局；仅正文滚动，关闭按钮始终可见。 */
        .smask { position: fixed; inset: 0; z-index: 1000; display: none;
          background: #0006; }
        .smask.on { display: block; }
        .smodal {
          position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); z-index: 1001;
          display: none; width: min(460px, calc(100vw - 32px)); max-height: 85dvh; overflow: hidden;
          box-sizing: border-box; padding: 0; border-radius: var(--lm-radius-overlay, 18px); font-size:13px; line-height:1.55;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          color: var(--primary-text-color, #212121);
          box-shadow: var(--lm-shadow-dialog, 0 8px 30px #0003);
        }
        .smodal.on { display: flex; flex-direction:column; }
        .smbody { overflow:auto; min-height:0; overscroll-behavior:contain; padding:0 16px 16px; }
        .smhead { display: flex; align-items: center; gap: 8px; padding:16px; flex:none; }
        .smhead .smx { margin-left:auto; }
        .capTable { margin-top:12px;padding-top:10px;border-top:1px solid var(--divider-color,#0001); }
        .capTable summary { font-weight:600;cursor:pointer; }
        .capRow { display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 0;font-size:11px; }
        .capRow .status { padding:3px 6px;border-radius:6px;background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5)); }
        .capRow .pending { color:#d99117; }.capRow .available { color:#15956d; }
        .card .carModel.noModel { height:0;min-height:0;padding:0;box-shadow:none;background:none; }
        .card .carModel.noModel:has(.chgDock,.warnDock) { height:80px; }
        .card .carModel.noModel:has(.tirePads) { height:110px; }
        .smhead .t { font-weight: 600; font-size: 15px; }
        .smhead .mir { flex: 1; display: flex; justify-content: flex-end; gap: 6px; }
        .smx {
          width: 30px; height: 30px; padding: 0; border-radius: 50%; flex: none;
          border:0; background:var(--lm-surface-control, var(--card-background-color,#fff)); color:inherit; box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);
          display: inline-flex; align-items: center; justify-content: center;
        }
        .smx ha-icon { width: 18px; height: 18px; --mdc-icon-size: 18px; }
        .cabLbl {
          font-size: 10px; line-height: 1.3; opacity: .72; max-width: 100%;
          text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
        }
        /* ── 开关 ── */
        /* 与预约重复、续充、预热使用同一套轻量滑动开关。 */
        .togchip {
          position:relative; width:36px; height:20px; padding:0; border-radius:var(--lm-radius-badge, 999px);
          background:var(--lm-surface-inset, var(--secondary-background-color,#eef1f5)); border:0;
          box-shadow:inset 0 1px 3px #0003; flex:none;
        }
        .togchip .thumb { position:absolute;left:3px;top:3px;width:14px;height:14px;border-radius:50%;background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:0 1px 3px #0003;transition:transform 160ms ease,background 160ms ease; }
        .togchip.on .thumb { transform:translateX(16px);background:var(--primary-color,#03a9f4); }
        @media(prefers-reduced-motion:reduce){.togchip .thumb,.p-carview .car3dFrame{transition:none;}}
        .togchip.pending { opacity:.65; }.togchip:disabled { opacity:.45; }
        .srOnly { position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap; }
        /* 充电上限滑条: 细轨(3px) + 小圆 knob; 数值在右侧用小字(.cV) */
        .rng {
          flex: 1; min-width: 120px; height: 18px; margin: 0;
          background: transparent; accent-color: var(--primary-color, #03a9f4);
          -webkit-appearance: none; appearance: none;
        }
        .rng::-webkit-slider-runnable-track {
          height: 3px; border-radius: 2px; background: var(--divider-color, rgba(0, 0, 0, .2));
        }
        .rng::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; width: 14px; height: 14px; margin-top: -5.5px;
          border-radius: 50%; border: 0; background: var(--primary-color, #03a9f4);
        }
        .rng::-moz-range-track { height: 3px; border-radius: 2px; background: var(--divider-color, rgba(0, 0, 0, .2)); }
        .rng::-moz-range-thumb {
          width: 14px; height: 14px; border-radius: 50%; border: 0; background: var(--primary-color, #03a9f4);
        }
        .rng:disabled { opacity: .45; cursor: not-allowed; }
        /* ── 小分段控件(电池预热 开/关): 细描边一整条, 段之间一条竖线, 选中段淡主题色 ── */
        .seg2 {
          display: inline-flex; align-items: stretch; overflow: hidden; border-radius: var(--lm-radius-control, 9px);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .12));
        }
        .segB {
          font: inherit; font-size: 12.5px; line-height: 1; padding: 6px 14px; min-width: 44px;
          background: transparent; border: 0; color: var(--secondary-text-color, #6b7280);
          transition: background .15s ease, color .15s ease;
        }
        .segB + .segB { border-left: 1px solid var(--divider-color, rgba(0, 0, 0, .12)); }
        .segB:not([disabled]):hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .08); }
        .segB.on { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); color: var(--primary-color, #03a9f4); }
        .segB.busy { opacity: .6; }
        .cNote { font-size: 11px; opacity: .62; margin: 2px 0 0 30px; }
        .tinput {
          font: inherit; font-size: 12px; color: inherit; padding: 8px;
          border-radius: var(--lm-radius-control, 8px); background: var(--lm-surface-inset, var(--secondary-background-color,#eef1f5));
          border: 0; box-shadow:inset 0 1px 3px #0001;
        }
        .timeBox { display: inline-flex; align-items: center; gap: 6px; }
        .kvchip {
          padding: 4px 10px; border-radius: var(--lm-radius-badge, 999px); font-size: 12px;
          white-space: nowrap; background:var(--lm-surface-control, var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);border:0;
        }
        .kvchip.on {
          background: var(--lm-surface-control, var(--card-background-color,#fff)); color: var(--success-color, #43a047);
          border-color: rgba(67, 160, 71, .38);
        }
        .kvchip.plug {
          background: var(--lm-surface-control, var(--card-background-color,#fff)); color: var(--error-color, #db4437);
          border-color: rgba(219, 68, 55, .38);
        }
        .fuelHead { display: flex; align-items: baseline; gap: 8px; }
        .fuelV { font-size: 24px; font-weight: 600; }
        /* ── 多车候选 / 提示 / toast ── */
        .pick { padding: 16px; border-radius: var(--lm-radius-section, 14px); }
        .pickT { font-size: 15px; font-weight: 600; }
        .pickS { font-size: 12px; opacity: .7; margin-top: 4px; }
        .pickS code {
          font-size: 11px; background: var(--secondary-background-color, #e7eaed);
          padding: 0 4px; border-radius: 5px;
        }
        .pickRow {
          display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
          width: 100%; margin-top: 8px; padding: 10px 12px; border-radius: var(--lm-radius-section, 14px); text-align: left;
        }
        .pickRow b { font-size: 13px; }
        .pickRow span { font-size: 11px; opacity: .6; word-break: break-all; }
        .toast { display: none; padding: 8px 12px; border-radius: var(--lm-radius-section, 14px); font-size: 12px; }
        .toast.on { display: block; }
        .toast.err { color: var(--error-color, #db4437); }
        /* ── 照片覆盖层 ── */
        .ovl {
          position: absolute; inset: 0; z-index: 5; border-radius: var(--ha-card-border-radius, 12px);
          background: rgba(0,0,0,.72); display: flex; align-items: center; justify-content: center;
          padding: 16px; box-sizing: border-box;
        }
        .ovlBox { position: relative; width: 100%; display: flex; justify-content: center; }
        .ovlImg { display: block; width: auto; height: auto; max-width: 100%; max-height: 70vh; border-radius: var(--lm-radius-section, 14px); }
        .ovlNone { padding: 32px; color: #fff; font-size: 13px; text-align: center; }
        .ovlX {
          position: absolute; top: 0; right: 0; width: 32px; height: 32px; border-radius: 50%;
          border: none; display: inline-flex; align-items: center; justify-content: center;
          background: rgba(0,0,0,.45); color: #fff;
        }
        /* ── hero 舞台: 2D 时是"数据在上、车模在下"的老两段式, 3D 时车模当整块背景、数据叠上去 ── */
        /* 两段式的外层: gap 12px 等价于原来 .carModel 的 margin-top(车模与数据行之间的间距) */
        .heroStage {
          display: flex; flex-direction: column; gap: 12px;
          /* 3D 背景与卡片使用同一张玻璃面。section 另有透明度，叠在 iframe 和 card 上会
             形成双重 alpha，导致车顶淡入/卡片顶部之间出现色带。 */
          --c3fade: var(--lm-surface-card, var(--ha-card-background, var(--card-background-color, #fff)));
        }
        /* 3D 舞台: 高度由 JS 按卡片宽度给(.stage3d 上的 inline height);
           车模盒绝对定位铺满整块(背景层), 数据层 .p-hero 压在上面。 */
        .heroStage.stage3d { position: relative; display: block; gap: 0; margin-inline: -14px; }
        .heroStage.stage3d .p-hero { margin-inline: 14px; }
        /* 3D 画布**伸到车区之下、盖住四个圆钮那一片**(高度 = 100% + --c3ext, 由 JS 量出),
           于是按钮行是浮在车模场景上的(像 App 那样); 画面下缘的淡出也只铺在这段伸出区里 ——
           车轮在车区之内, 永远不会被渐变盖到。 */
        .heroStage.stage3d .p-carview {
          position: absolute; left: 0; top: 0; width: 100%;
          height: calc(100% + var(--c3ext, 0px));
          /* 不给整个舞台铺半透明色块: 它会在舞台顶部露出一条直角边, 且与 iframe 内的
             车景分两次合成。顶部与卡片间的衔接只由下方 veil 渐显完成。 */
          border-radius: var(--ha-card-border-radius, 12px); background: transparent;
        }
        /* 淡出只作用于 iframe(画布): 下缘溶进卡片底色; 起点=伸出区上沿, 即车区底边 */
        .heroStage.stage3d .p-carview iframe.car3dFrame {
          -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0, #000 40px, #000 calc(100% - var(--c3ext, 0px)), rgba(0,0,0,0) 100%);
          mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0, #000 40px, #000 calc(100% - var(--c3ext, 0px)), rgba(0,0,0,0) 100%);
        }
        /* 按钮行浮在场景之上(它们是 .heroStage 的**后续兄弟**, 给定位才能压住绝对定位的画布) */
        .heroStage.stage3d ~ .carTools, .heroStage.stage3d ~ .p-actions { position: relative; z-index: 2; }
        /* 数据层: 不吃指针事件(空白处的拖动要能穿到车模上), 可点的控件再各自收回来 */
        .heroStage.stage3d .p-hero {
          position: relative; z-index: 2; box-sizing: border-box;
          pointer-events: none;
        }
        .heroStage.stage3d .p-hero button, .heroStage.stage3d .p-hero .vname,
        .heroStage.stage3d .p-hero .pill,
        .heroStage.stage3d .p-hero .rchip, .heroStage.stage3d .p-hero .toolBtn { pointer-events: auto; }
        /* 车模区上缘用 veil 轻垫数据层、下缘淡出到透明(同一玻璃 token, 不铺不透明底色):
           顶边从 alpha=0 渐显, 消掉 iframe/舞台与卡片之间的直角色带; 下缘让场景自然收尾。
           两层都画在同一个容器里(background-image 两层 + 各自 size/position), 不额外多节点。 */
        .stageVeil { display: none; }
        /* 顶部给数据层垫一层(续航/电量压在天空上时更清楚); **长度只到数据区下沿** ——
           --c3top 由 JS 按 .p-hero 的实测高度设(px), 所以从标题到电量条淡完就结束,
           下面的天空与车顶保持原样。**底部不铺渐变**: 下缘淡出交给上面 iframe 的 mask,
           且只落在按钮区(车轮不受影响)。 */
        .heroStage.stage3d .stageVeil {
          display: block; position: absolute; left: 0; top: 0; width: 100%; z-index: 1;
          pointer-events: none; height: calc(100% + var(--c3ext, 0px));
          background-image: linear-gradient(180deg, transparent 0, var(--c3fade) 30px, var(--c3fade) 42%, transparent 100%);
          background-size: 100% var(--c3top, 45%);
          background-position: top; background-repeat: no-repeat;
        }
        /* 车模下方的小控件行(现在只有「胎压」开关): 从车模盒里挪出来, 免得压住车。
           它是 .card 的直接子项 —— 与车模之间由 .card 的 flex gap(12px) 自动留白 */
        .carTools { display: flex; justify-content: flex-end; align-items: center; gap: 8px; }
        .carTools:empty { display: none; }
        /* 3D 舞台里, 舞台的上缘那一条(0 ~ --c3data)是数据层(车名/状态/续航/电量条/胶囊) */
        /* 充电块与告警块: 贴**数据层下沿**那条空档 —— 直接贴舞台顶角会压住「已驻车/未插枪」
           胶囊与「车门已上锁」(实测它们占着 x229-356 / y0-113)。--c3data 由 JS 实测写回。 */
        /* 告警/充电块停在**车辆区右上/左上**那一带: 纵向锚在数据层下沿(--c3data) ——
           舞台的绝对右上角被"已驻车/未插枪/车门已上锁"三个状态胶囊占着, 且顶部还有一层
           渐隐(会把告警洗淡); 实测把胶囊下移让位又会压到右前胎压读数, 所以停在车顶右上更合适。 */
        .heroStage.stage3d .chgDock, .heroStage.stage3d .warnDock { top: calc(var(--c3data, 123px) - 2px); }
        /* 读数层夹回**舞台**矩形: 画布比舞台高 --c3ext(伸出到四个圆钮那一段), 不夹就会掉出去 */
        .heroStage.stage3d .tirePads { bottom: var(--c3ext, 0px); }
        /* 前/后两条带: 数据层下沿 + 告警位/间距; min() 兜住"数据层变高"(长车名/实时续航小字)时不越界 */
        .heroStage.stage3d .tP.a, .heroStage.stage3d .tP.b {
          bottom: auto;
          top: min(calc(var(--c3data, 123px) + 32px), calc(100% - 88px));
        }
        .heroStage.stage3d .tP.c, .heroStage.stage3d .tP.d {
          bottom: auto;
          top: min(calc(var(--c3data, 123px) + 76px), calc(100% - 43px));
        }
        .heroStage.stage3d .tirePads[data-projected]{bottom:0;}.heroStage.stage3d .tirePads[data-projected] .tP{left:var(--tire-x);top:var(--tire-y);right:auto;bottom:auto;transform:translate(-50%,-50%);text-align:center;}
        /* ── 3D 车模(hero 车辆区的第二种画法) ──
           3D 时整个车模盒落在这个**独立容器**里, 而不是继续画在 .p-hero 里:
           hero 每次状态推送都整块换 innerHTML, iframe 被摘出文档就会销毁重建浏览上下文
           (= 整车重新加载)。容器只在进入 3D 时搭一次, iframe 挂进去后不再挪动。
           ⚠️ margin-top 归零: 外层 .heroStage 的 gap(12px)已经等价于 .carModel 原来的
           margin-top, 不归零的话车模与上面那行之间会平白多出 12px。 */
        .p-carview { margin-top: 0; }
        .p-carview .car3dFrame {
          position: absolute; inset: 0; width: 100%; height: 100%;
          border: 0; display: block; background: transparent; opacity:1; transition:opacity 160ms ease;
        }
        .loading3d iframe.car3dFrame { opacity:0; }
        /* 浮动层(告警/充电/胎压)与 iframe 同层: 容器整块不吃指针事件(否则挡住了拖动旋转),
           只有里面的按钮/小卡自己要回来。
           ⚠️ .tirePads 是 1.9.38 起**铺满整个车辆区**的定位层, 这里**不能**给它
           pointer-events: auto(那会把车模的"拖动旋转"整块吃掉)—— 读数自己那份
           ".tirePads .tP { pointer-events: auto }" 已经够用。 */
        .p-carview .carDock { position: absolute; inset: 0; z-index: 1; pointer-events: none; }
        .p-carview .carDock .warnDock, .p-carview .carDock .chgDock,
        .p-carview .carDock .tireTgl { pointer-events: auto; }
        /* 标题旁的「3D」小标(选了自定义外观图就不给) */
        .tag3d {
          display: inline-flex; align-items: center; vertical-align: middle;
          margin-left: 6px; padding: 1px 7px; border-radius: var(--lm-radius-badge, 999px);
          font-size: 10.5px; font-weight: 600; letter-spacing: .30px;
          color: var(--secondary-text-color, #6b7280);
          background: var(--secondary-background-color, #e7eaed);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        }
        /* ── 大圆色块(卡片配色 · 主题色 / 车模颜色) ──
           直径 42px + 名字在圆下方小字; 选中态 = **圆环**(主题色 2px 外圈 + 一圈卡片底色留白),
           不是整块填充。末尾那颗"彩虹圆"(conic-gradient)点开取色器。 */
        .cRow.palRC { align-items: flex-start; }
        .cRow.palRC .cC { flex: 1 1 100%; margin-left: 0; justify-content: flex-start; gap: 8px 12px; }
        .palDot {
          display: flex; flex-direction: column; align-items: center; gap: 6px;
          padding: 2px 0 0; background: none; border: 0; box-shadow: none; cursor: pointer;
        }
        .pcSw {
          width: 42px; height: 42px; border-radius: 50%; flex: none; display: block;
          border: 1px solid rgba(127, 127, 127, .35); box-sizing: border-box;
          transition: transform .12s ease, filter .15s ease;
        }
        .palDot.on .pcSw {
          box-shadow: 0 0 0 2px var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff))),
                      0 0 0 4px var(--primary-color, #03a9f4);
        }
        .pcName { font-size: 11px; line-height: 1.2; white-space: nowrap; color: var(--secondary-text-color, #6b7280); }
        /* 「跟随主题」那颗: 斜杠 = "不覆盖"(用卡片底色的斜线表示) */
        .pcSw.auto {
          background: linear-gradient(135deg, transparent 44%, var(--divider-color, rgba(127, 127, 127, .5)) 44%,
            var(--divider-color, rgba(127, 127, 127, .5)) 56%, transparent 56%),
            var(--secondary-background-color, #e7eaed);
        }
        /* 「自定义」那颗: 彩虹圆(conic-gradient) —— 点它打开取色器面板 */
        .pcSw.rainbow { background: conic-gradient(from -90deg, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00); }
        .palDot:not([disabled]):hover .pcSw { filter: brightness(1.06); }
        .palDot:active .pcSw { transform: scale(.96); }
        /* 「回到实车色」: 纯文字钮(无底无边, 与圆环并列) */
        .chip.txt {
          padding: 4px 8px; border: 0; box-shadow: none; background: transparent;
          color: var(--primary-color, #03a9f4); font-size: 12.5px;
        }
        .chip.txt:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .10); }
        .car3dUrl { flex: 1 1 150px; min-width: 0; }

        /* ── 取色器面板(设置子卡里那颗彩虹圆点开; 位置由 index.ts 的 _placePal 实测写回) ── */
        .palPop {
          position: absolute; z-index: 30; width: 268px; box-sizing: border-box;
          padding: 10px; border-radius: var(--lm-radius-section, 14px); display: flex; flex-direction: column; gap: 10px;
          background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          box-shadow: 0 6px 20px rgba(0, 0, 0, .24);
        }
        .painting :is(.p-actions,.cardsRow,.csRow,.p-fuel,.carTools){display:none;}
        .wrapDock[hidden]{display:none;}.wrapDock{display:flex;justify-content:center;}
        .painting .heroStage { margin-bottom:var(--paint-ext,0px); }
        .paintDock[hidden]{display:none;}.paintDock{display:flex;justify-content:center;min-width:0;}
        .paintDock .palPop{position:relative;width:min(100%,280px);left:auto;top:auto;border:0;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);}
        .paintActions{display:flex;justify-content:flex-end;gap:10px;}.paintActions button{border:0;border-radius:var(--lm-radius-control, 9px);padding:7px 14px;background:var(--lm-surface-control, var(--card-background-color,#fff));color:inherit;box-shadow:var(--lm-shadow-control, 0 1px 4px #0002);}.paintActions button:last-child{color:var(--primary-color,#03a9f4);}
        /* ① SV 方块(左上白 → 右上纯色 → 左下黑; 渐变由模板按当前色相铺) + 圆环手柄 */
        .palSV {
          position: relative; width: 100%; height: 130px; border-radius: 10px;
          cursor: crosshair; touch-action: none; outline: none;
        }
        .palSV:focus-visible { box-shadow: 0 0 0 2px var(--primary-color, #03a9f4); }
        .palPick {
          position: absolute; width: 16px; height: 16px; border-radius: 50%; pointer-events: none;
          transform: translate(-50%, -50%); border: 2px solid #fff; box-sizing: border-box;
          box-shadow: 0 0 0 1px rgba(0, 0, 0, .45);
        }
        /* ② 彩虹色相滑条(原生 range: 天生支持方向键) + 圆形手柄 */
        .palHue {
          -webkit-appearance: none; appearance: none; width: 100%; height: 14px; margin: 0;
          border-radius: 7px; background: linear-gradient(to right, #f00, #ff0, #0f0, #0ff, #00f, #f0f, #f00);
        }
        .palHue::-webkit-slider-thumb {
          -webkit-appearance: none; appearance: none; width: 16px; height: 16px; border-radius: 50%;
          background: #fff; border: 1px solid rgba(0, 0, 0, .35); box-shadow: 0 1px 3px rgba(0, 0, 0, .4);
        }
        .palHue::-moz-range-thumb {
          width: 16px; height: 16px; border-radius: 50%; background: #fff; border: 1px solid rgba(0, 0, 0, .35);
        }
        /* ③ 底部一行: 预览色块 + hex 输入框 + 「100 %」 + 「hex ⌄」 + 吸管(不支持 EyeDropper 时整颗不画) */
        .palBar { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
        .palPrev {
          width: 24px; height: 24px; border-radius: var(--lm-radius-control, 8px); flex: none; box-sizing: border-box;
          border: 1px solid rgba(127, 127, 127, .35);
        }
        .palHex {
          font: inherit; font-size: 12px; letter-spacing: .4px; width: 74px; flex: none;
          padding: 4px 6px; border-radius: var(--lm-radius-control, 8px); text-align: center; color: inherit;
          background: var(--secondary-background-color, #e7eaed); border: 1px solid transparent;
        }
        .palHex:focus { outline: none; border-color: var(--primary-color, #03a9f4); }
        .palPct, .palFmt {
          display: inline-flex; align-items: center; gap: 1px; font-size: 11px; line-height: 1;
          padding: 4px 6px; border-radius: var(--lm-radius-control, 8px); white-space: nowrap;
          color: var(--secondary-text-color, #6b7280);
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
        }
        .palPct b { font-weight: 600; }
        .palPct i { font-style: normal; opacity: .7; }
        .palEye {
          margin-left: auto; width: 28px; height: 28px; padding: 0; flex: none; border-radius: 50%;
          display: inline-flex; align-items: center; justify-content: center; border: 0;
          background: transparent; color: var(--secondary-text-color, #6b7280); cursor: pointer;
        }
        .palEye:hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); color: var(--primary-color, #03a9f4); }
        ha-icon.xs { --mdc-icon-size: 13px; }

        /* ── 可横向拖动浏览的风格预览卡 ── */
        .cRow.styleRC .cC { flex: 1 1 100%; min-width: 0; margin-left: 0; display: flex; flex-direction: column; align-items: stretch; gap: 10px; }
        .stylePicker { display: flex; box-sizing:border-box; width: 100%; max-width: 100%; gap: 11px; overflow-x: auto; overflow-y: hidden; padding: 7px 12px 12px; scroll-padding-inline:12px; scroll-snap-type: x proximity; overscroll-behavior-x: contain; -webkit-overflow-scrolling:touch; scrollbar-width: thin; touch-action: pan-x pan-y; cursor: grab; }
        .stylePicker:active { cursor: grabbing; }
        .styleChoice { display: flex; flex: 0 0 clamp(168px, 66vw, 188px); height: 158px; min-width: 0; flex-direction: column; align-items: stretch; gap: 8px; padding: 9px; text-align: left; color: inherit; background: var(--lm-surface-control, var(--card-background-color, #fff)); border: 1px solid var(--lm-border-color, var(--divider-color, #0002)); border-radius: var(--lm-radius-control, 10px); box-shadow: var(--lm-shadow-control, 0 1px 4px #0002); cursor: pointer; scroll-snap-align: start; }
        .styleChoice:hover { border-color: var(--lm-accent, var(--primary-color, #03a9f4)); }
        .styleChoice.on { outline: 2px solid var(--lm-accent, var(--primary-color, #03a9f4)); outline-offset: 1px; }
        .styleChoice:focus-visible { outline: 3px solid var(--lm-accent, var(--primary-color, #03a9f4)); outline-offset: 2px; }
        .stylePreview { display: flex; height: 95px; min-height: 95px; flex-direction: column; gap: 4px; box-sizing: border-box; padding: 5px; overflow: hidden; color: var(--lm-text, inherit); background: var(--lm-surface-card, var(--card-background-color, #fff)); background-image: var(--lm-surface-pattern, none); border: var(--lm-card-border, 1px solid var(--lm-border-color, #0002)); border-radius: var(--lm-radius-card, 9px); box-shadow: var(--lm-shadow-card, none); -webkit-backdrop-filter: var(--lm-blur-card, none); backdrop-filter: var(--lm-blur-card, none); pointer-events: none; }
        .stylePreviewTop { display: flex; align-items: center; justify-content: space-between; gap: 4px; font-size: 8px; line-height: 1; }
        .stylePreviewTop .pill { padding: 2px 5px; font-size: 7px; }
        .stylePreviewPanel.sec { display: flex; min-height: 0; flex: 1; flex-direction: column; gap: 1px; padding: 4px 6px; border-radius: var(--lm-radius-section, 6px); }
        .stylePreviewPanel small { color: var(--lm-text-secondary, var(--secondary-text-color, #6b7280)); font-size: 7px; line-height: 1.1; }
        .stylePreviewPanel b { font-size: 12px; line-height: 1.1; }
        .stylePreviewPanel em { font-size: 7px; font-style: normal; font-weight: 500; }
        .stylePreviewMeter { display: block; height: 3px; margin-top: 2px; overflow: hidden; border-radius: 99px; background: var(--lm-surface-inset, #e7eaed); }
        .stylePreviewMeter i { display: block; width: 72%; height: 100%; border-radius: inherit; background: var(--lm-accent, var(--primary-color, #03a9f4)); }
        .stylePreviewActions { display: flex; align-items: center; gap: 4px; }
        .stylePreviewActions .chip { padding: 2px 7px; border-radius: var(--lm-radius-control, 6px); font-size: 7px; line-height: 1.2; }
        .stylePreviewActions .toolBtn { width: 18px; height: 16px; min-height: 0; padding: 0; border-radius: var(--lm-radius-control, 6px); display: inline-flex; align-items: center; justify-content: center; font-size: 9px; line-height: 1; }
        .styleChoiceText { min-width: 0; display: flex; flex: 1; flex-direction: column; gap: 3px; }
        .styleChoiceText b { font-size: 12px; line-height: 1.2; }
        .styleChoiceText small { color: var(--lm-text-secondary, var(--secondary-text-color, #6b7280)); font-size: 10px; line-height: 1.25; }
        .styleActions { display: inline-flex; align-items: center; gap: 8px; margin-left: auto; flex-wrap: wrap; }
        .styleNow { font-size: 11px; color: var(--secondary-text-color, #6b7280); }
        .styleNow b { color: var(--primary-color, #03a9f4); font-weight: 600; }

/* ── 共享控件层(六张卡共用同一份; 必须放在**最后**: 同特异度下由它定稿) ──
   角色映射与变量说明见 src/lib/ui/styles.ts。 */
${uiStyles}
`;
