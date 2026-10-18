/*
 * 零跑·车辆控制卡 —— **Lit 模板化的面板**(C 档: 逐面板从"拼字符串 + innerHTML"迁到 Lit 模板)
 *
 * 为什么要迁: 每个面板原来是"算一整段 HTML 字符串 → _setPanel 整块换 innerHTML",
 * 于是每次状态推送都会重建节点 —— 焦点、输入草稿、滚动位置都得靠补丁去救, 而且手工拼
 * 字符串一旦漏个闭合标签就会把结构弄乱(hero 历史上踩过)。改成 Lit 模板后:
 *   * 结构由模板保证(不会再有闭合标签错位);
 *   * Lit 只更新**变化的那部分**, 输入框/焦点/滚动天然不受影响;
 *   * 文本插值自动转义, 不必逐个 `esc()`。
 *
 * 迁移纪律(与 .refactor-baseline/MIGRATION-CONTRACT.md 一致):
 *   * `data-act/data-entity/data-on/data-key/data-delta/data-sec` 的值与类名**原样保留**
 *     (它们既是 _onClick 的分发依据, 也是 tools/card-smoke.mjs 的断言对象);
 *   * CSS 一个字节不动(仍在 control/index.ts 的 <style> 里, 不用 static styles);
 *   * 模板里的空白要当心: 元素之间的换行会变成文本节点, inline 排版下可能多出间距 ——
 *     写的时候与原来的字符串拼接对齐(该连着就写在同一行), 靠"旧/新产物同一面板 innerHTML
 *     逐字比对 + 截图逐像素比对"兜底。
 */
import { html, nothing, type TemplateResult } from "lit";
import { live } from "lit/directives/live.js";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import { clamp } from "../../lib/dom";
import { fmtNum, fmtPct, relTime } from "../../lib/format";
import { ipIcon } from "../../lib/icons";
import { readPalette } from "../../lib/palette";
import { effectiveStyle, isPreviewing, readAppearance } from "../../lib/appearance";
import { PRESETS, resolveTokens } from "../../lib/ui/presets";
import { isDark } from "../../lib/theme";
import { carMarker } from "../../lib/car-marker";
import { project, wgs84ToGcj02, tileUrl, TILE_SOURCES } from "../../lib/geo";
import { boltIcon, car3dView, car3dBgPref, car3dColors, car3dSelTsp, car3dStateText, chgInfo, chgPower, customCarImg, isCharging, isFastCharging, rangeSubline, sumCar3d, tireCorners, tireRange, warnItems } from "./render-hero";
import { palPickerT } from "./picker";
import { acPresets, cabinAny, hasChargingBlock, hasFuelData, is7Seat, locBg, sumCharging, sumFuel, zoneLabel } from "./render-panels";
import { CAR_IMG_BASE, CAR_IMG_RETRY_MS, CABIN_IMG, CABIN_SEATS, CHARGE_TIP, TIRE_DEFS, WINDOW_STEPS, CAR3D_BACKGROUNDS } from "./types";
import type { ControlCtx } from "./types";
import './vehicle-tools';

/** 燃油(增程)面板。显示门控与口径与迁移前完全一致(见 index.ts 的 _renderFuel)。 */
export function fuelPanel(ctx: ControlCtx): TemplateResult {
  const lvl = ctx._num("fuel_level");
  const fr = ctx._num("fuel_range");
  const tr = ctx._num("total_range");
  const fc = ctx._num("fuel_consumption");
  const open = ctx._secOpen("fuel");
  const pct = lvl != null && lvl > 0 ? clamp(lvl, 0, 100) : null;
  const liters = pct != null ? ctx._attr("fuel_level", "燃油量_L") : null;
  const kv: [string, string][] = [];
  if (fr != null && fr > 0) kv.push(["燃油续航", fmtNum(fr, 0, "km")]);
  if (tr != null) kv.push(["油电总续航", fmtNum(tr, 0, "km")]);
  if (fc != null) {
    let v = fmtNum(fc, 1, "L/100km");
    const ec = ctx._attr("fuel_consumption", "电耗_kwh_100km");
    if (ec != null) v += " · 电耗 " + fmtNum(ec, 1, "kWh/100km");
    kv.push(["油耗", v]);
  }
  return html`<section class="sec"><button class="foldH" data-act="fold" data-sec="fuel" aria-expanded="${open
    ? "true"
    : "false"}"><span class="foldT">燃油</span><span class="foldS">${sumFuel(ctx)}</span><ha-icon class="foldC ico" icon="mdi:chevron-down"></ha-icon></button>${
    open
      ? html`<div class="secB">${
          kv.length
            ? html`<div class="kvs">${kv.map(
                (r) => html`<div class="kv"><span class="kvL">${r[0]}</span><span class="kvV">${r[1]}</span></div>`,
              )}</div>`
            : nothing
        }${
          pct != null
            ? html`<div class="fuelMeter"><div class="fuelHead"><span class="fuelV">${fmtPct(pct)}</span><span class="rowV">油量</span></div><i class="bar fuel"><b style="width:${pct.toFixed(
                1,
              )}%"></b></i>${
                liters != null ? html`<div class="subline">${fmtNum(liters, 1, "L")}</div>` : nothing
              }</div>`
            : nothing
        }</div>`
      : nothing
  }</section>`;
}

/** 面板是否该出现在卡片上(与 index.ts 的 _renderFuel 同一个判据) */
export function fuelVisible(ctx: ControlCtx): boolean {
  return ctx._vis("fuel") && hasFuelData(ctx);
}

/* ── 充电(卡片本体 + 弹窗里的"充电设置"正文) ────────────────────────────────
 * 卡片本体(`.p-charging`)只是一个折叠入口(= 标题行 + 摘要 + 箭头), 点它弹「充电设置」;
 * 详情正文由 chargeBodyPanel 提供, 渲染进弹窗那层 `.secB`(见 index.ts 的 _renderModal),
 * 口径/顺序与迁移前的 chargeBody 逐字等价:
 *   健康充电 → 充电上限(滑条) → 预约充电 → 起止时间 → 电池预热。
 */

/** 充电卡的显示门控(与迁移前 _renderCharging / _renderModal 同一个判据) */
export function chargingVisible(ctx: ControlCtx): boolean {
  return ctx._vis("charging") && hasChargingBlock(ctx);
}

/** 充电卡本体: 一行摘要 + 箭头; 点它走 data-act="chargemenu"(弹窗, 不是内联展开)。 */
export function chargingPanel(ctx: ControlCtx): TemplateResult {
  return html`<section class="sec"><button class="foldH" data-act="chargemenu" aria-expanded="${ctx._open.charge
    ? "true"
    : "false"}" title="充电设置(健康充电 / 充电上限 / 预约 / 起止时间 / 电池预热)"><span class="foldT">充电</span><span class="foldS">${sumCharging(
    ctx,
  )}</span><ha-icon class="foldC ico" icon="mdi:chevron-down"></ha-icon></button></section>`;
}

/** 保留开关语义；受理后显示待确认，最终以车端状态为准。 */
function togChipT(ctx: ControlCtx, key: string, label: string): TemplateResult {
  const id = ctx._entId(key);
  const on = ctx._val(key) === "on";
  const busy = !!ctx._busy["sw:" + id];
  const pending = !!ctx._attr(key, "pending_confirmation");
  const unconfirmed = ctx._attr(key, "confirmation_status") === "unconfirmed";
  const tip = label + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开") + (pending ? " · 待车端确认" : unconfirmed ? " · 车端未确认" : "");
  return html`<button role="switch" aria-checked=${on} class="togchip${on ? " on" : ""}${pending ? " pending" : ""}${unconfirmed ? " unconfirmed" : ""}" data-act="toggle" data-entity="${id}" data-on="${on
    ? "1"
    : "0"}" aria-label="${tip}" title="${tip}" ?disabled=${busy}><span class="thumb" aria-hidden="true"></span><span class="srOnly">${pending ? "待车端确认" : unconfirmed ? "车端未确认" : on ? "已开" : "已关"}</span></button>`;
}

/** 一个「起止时间」小框(左侧小标签 + time 输入)。
 *  ⚠️ `value` 既绑属性(与迁移前的字符串产物逐字一致)又绑 `.value`(live()):
 *  live() 比的是**控件当前值**, 于是用户改过时间 / 拖过滑条之后, 下一次状态推送会把
 *  控件拉回实体值 —— 与旧的"整块重画"同一观感(滑杆那条有冒烟断言兜着)。 */
function timeBoxT(ctx: ControlCtx, key: string, label: string): TemplateResult | typeof nothing {
  const id = ctx._entId(key);
  if (!id) return nothing;
  const raw = ctx._val(key) || "";
  const hm = String(raw).slice(0, 5);
  return html`<span class="timeBox"><span class="rowL2">${label}</span><input class="tinput" type="time" data-act="time" data-entity="${id}" value="${hm}" .value=${live(
    hm,
  )}></span>`;
}

/** 弹窗里的「充电设置」正文。
 *
 *  ⚠️ 这里**自带一层 `.secB`** —— 迁移前的 chargeBody 就是自带一层, 而 _renderModal 外面
 *  又包了一层(历史遗留的两层壳)。两层都要留着: 少一层就少一份 `.secB` 的
 *  `padding-top: 4px` 与 gap, 观感会变(结构等价验收就是逐字比这个)。 */
export function chargeBodyPanel(ctx: ControlCtx): TemplateResult {
  const soc = ctx._num("battery");
  const chg = chgInfo(ctx);
  const chips: TemplateResult[] = [];
  if (soc != null) chips.push(html`<span class="kvchip">${"电量 " + fmtNum(soc, 0, "%")}</span>`);
  if (chg) {
    chips.push(html`<span class="kvchip${chg.mode === "charging"
      ? " on"
      : chg.mode === "plugged"
        ? " plug"
        : ""}">${chg.text}</span>`);
  }
  // ⚠️ 功率要取绝对值: 车端**充电时电流是负的**(实测本车 -9.1 A / 688.7 V ≈ 6.3 kW),
  //    原来判 `kw > 0` 会让这个数字永不出现。
  const p = chgPower(ctx);
  if (chg && chg.mode === "charging" && p) {
    chips.push(html`<span class="kvchip">${fmtNum(p.kw, 1, "kW")}</span>`);
  }

  // ── 设置项: 一行一个, 左边「图标 + 标签」/ 右边控件(App 那种清爽版式) ──
  // 每行左侧那颗图标是纯装饰(功能说明在标签文字里), 用次级文字色, 不抢控件的注意力。
  const rows: TemplateResult[] = [];

  // ① 健康充电(只留开关本身, 不写任何"延长寿命/有利于电池"之类的说明文字)
  if (ctx._entId("healthy_charge")) {
    rows.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:battery-heart-variant"></ha-icon><span class="cL">健康充电</span><span class="cC">${togChipT(
      ctx,
      "healthy_charge",
      "健康充电",
    )}</span></div>`);
  }
  // ② 充电上限(number, 50~100)
  const clId = ctx._entId("charge_limit");
  if (clId) {
    const st = ctx._ent("charge_limit");
    const a = (st && st.attributes) || {};
    const v = Number(st && st.state);
    const lo = Number.isFinite(Number(a.min)) ? Number(a.min) : 50;
    const hi = Number.isFinite(Number(a.max)) ? Number(a.max) : 100;
    const sAttr = Number(a.step);
    const step = Number.isFinite(sAttr) && sAttr > 0 ? sAttr : 5;
    let val = Number.isFinite(v) ? clamp(v, lo, hi) : lo;
    // 乐观值: 改完上限后车端写库有延迟, 实体状态还没更新 —— 期间滑杆停在本地新值,
    // 一旦实体报出同一个值(或超过窗口)就交回实体(见 _onChange 的 charge_limit 分支)。
    const pend = ctx._clPending;
    if (pend) {
      if (pend.id !== clId || Date.now() > pend.until) ctx._clPending = null;
      else if (Number.isFinite(v) && Math.abs(v - pend.value) < 0.001) ctx._clPending = null;
      else val = clamp(pend.value, lo, hi);
    }
    const busy = !!ctx._busy["cl:" + clId];
    // 健康充电开启时, 云端不接受充电上限修改 → 直接禁用(并说清原因)
    const healthyOn = ctx._val("healthy_charge") === "on";
    const clTip = healthyOn ? "健康充电开启时不生效（先关闭健康充电）" : "充电上限";
    rows.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:battery-charging-80"></ha-icon><span class="cL">充电上限</span><span class="cC"><input class="rng" type="range" data-act="charge_limit" data-entity="${clId}" min="${lo}" max="${hi}" step="${step}" value="${val}" .value=${live(
      String(val),
    )} title="${clTip}" ?disabled=${busy || healthyOn}><span class="cV">${fmtNum(ctx._clPreview ?? val, 0, "%")}</span></span></div>`);
    if (healthyOn) {
      rows.push(html`<div class="cNote">健康充电开启时不生效，请先关闭健康充电</div>`);
    }
  }
  // ③ 预约充电开关
  if (ctx._entId("charge_book")) {
    rows.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:calendar-clock"></ha-icon><span class="cL">预约充电</span><span class="cC">${togChipT(
      ctx,
      "charge_book",
      "预约充电",
    )}</span></div>`);
  }
  // ④ 起始 / 结束时间
  if (ctx._val("charge_book")==="on" && (ctx._entId("charge_start") || ctx._entId("charge_end"))) {
    rows.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:clock-outline"></ha-icon><span class="cL">起止时间</span><span class="cC">${timeBoxT(
      ctx,
      "charge_start",
      "开始",
    )}${timeBoxT(ctx, "charge_end", "结束")}</span></div>`);
  }
  return html`<div class="secB">${chips.length
    ? html`<div class="chips">${chips}</div>`
    : nothing}<div class="cList">${rows}</div><leapmotor-vehicle-tools .hass=${ctx._hass} .entityId=${ctx._entId('vehicle_state')||ctx._entId('battery')} .chargeEnabled=${ctx._val("charge_book")==="on"} section="schedule"></leapmotor-vehicle-tools></div>`;
}

/* ── 空调卡(左半) ───────────────────────────────────────────────────── */

/** 空调卡的显示门控(与迁移前 _renderClimate 同一个判据) */
export function climateVisible(ctx: ControlCtx): boolean {
  return ctx._vis("climate") && !!ctx._entId("ac");
}

/** 空调卡: 大字车内温度 + 「车内」角标 + 风扇钮(开关); 下面一行温度(开着才给 ±)
 *  与一排预设入口; 预设气泡打开时在 `.actPreset` 里多画一列四颗(由 index.ts 的
 *  _placePreset 事后量位置)。
 *  ⚠️ 隐藏时提交**空模板**(而不是整块不画): 这样 Lit 的根部件始终停在一个真的模板上,
 *  不会被 display:none 之外的东西破坏(见 index.ts 的 _renderClimate 与 _renderFuel 的注释)。 */

/* 除味/除霜在温度位上换成「图标 + 模式名」(它们是"现在在做什么"的主信息)。
 * 图标用公开的 MDI 名字; 极速降温/升温那两项仍沿用 LO/HI(与 App 的数字规格一致)。 */
const AC_FACE_MDI: Record<string, string> = {
  "快速除味": "spray",
  "风挡除霜": "car-defrost-front",
};

export function climatePanel(ctx: ControlCtx): TemplateResult {
  if (!climateVisible(ctx)) return html``;
  const st = ctx._ent("ac");
  const a = (st && st.attributes) || {};
  const ready = ctx._ready("ac");
  const mode = ready ? String(st!.state) : "";
  const on = !!mode && mode !== "off" && mode !== "unknown" && mode !== "unavailable";
  const interior = ctx._num("interior_temp") != null
    ? ctx._num("interior_temp")
    : (a.current_temperature != null ? Number(a.current_temperature) : null);

  // v1.6 收起态: 不再摆"开/关/制冷"大字, 只留一个简洁的温度 + 角标胶囊标明它是
  // **车内实测温度**。温度与模式**常态展开**(不再点击收起/展开)。
  const hasInterior = interior != null && Number.isFinite(interior);

  const t = Number(a.temperature);
  const stepAttr = Number(a.target_temp_step);
  const step = Number.isFinite(stepAttr) && stepAttr > 0 ? stepAttr : 1;

  // 温度显示值: 有"本地待发值"(刚连点 ±、实体还没回报)就顶住它, 与充电上限 _clPending 同一口径 ——
  // 实体报出同一个值、或超过窗口, 就交回实体(见 index.ts 的 _onTemp 与 _flushTemp)。
  const tp = ctx._tempPending;
  if (tp) {
    if (Date.now() > tp.until) ctx._tempPending = null;
    else if (Number.isFinite(t) && Math.abs(t - tp.temp) < 0.001) ctx._tempPending = null;
  }
  const tShow = ctx._tempPending ? ctx._tempPending.temp : t;

  // 当前生效的预设: 实体的 preset_mode 非空 → 以它为准(HA 里"无预设"的写法 "none" 按空算);
  // 否则用"用户最近点过的那颗"的本机记忆兜底 —— 车端对极速降温/升温/除味**不回报状态**,
  // 只认 preset_mode 会让温度区显示成温度数字(用户实测: 极速降温时显示 16.0℃ 而不是 LO)。
  // 记忆的失效条件(与下面三处清理配合): ①实体报出**别的**预设 → 作废(以车端为准);
  // ②超过 PRESET_MEMO_MS(30 分钟) → 过期; ③用户手动调温/切模式/关空调 → 清掉(见 index.ts 与 handlers.ts)。
  const pAttr = String(ctx._attr("ac", "preset_mode") || "").trim();
  const memo = ctx._lastPreset;
  if (memo && (Date.now() > memo.until || (pAttr && pAttr !== memo.val))) ctx._lastPreset = null;
  const pNow = pAttr && pAttr.toLowerCase() !== "none"
    ? pAttr
    : ctx._lastPreset ? ctx._lastPreset.val : "";
  // 预设只在"空调开着"时算数(关着还把残留的预设画成 LO 会很怪); 认不出的预设值按
  // 普通模式处理: 显示设定温度 + ±。
  const presetNow = on ? pNow : "";
  const loHi = presetNow === "极速降温" ? "LO" : presetNow === "极速升温" ? "HI" : "";
  const faceIco = !loHi && presetNow ? AC_FACE_MDI[presetNow] || "" : "";
  // ± 只在"单纯开着"(没有生效中的预设)时给 —— 预设自带固定温度, 改温度会与预设打架。
  // 开着却没有 ± 的那几支(LO/HI/除味/除霜)由上面的 presetNow 决定。
  const steppable = on && !presetNow;

  // 预设入口圆钮只负责"弹出四个预设气泡", 不表示任何开关状态(不做变色);
  // 当前生效的预设在气泡里点亮。
  // 「座椅与加热」入口则与预设按钮并排(从原来的折叠卡挪过来, 点开弹窗)。
  const seatBtn = ctx._vis("comfort") && cabinAny(ctx)
    ? html`<button class="chip mi${ctx._open.seats ? " on" : ""}" data-act="seatmenu" aria-label="座椅与加热" title="座椅与加热(座舱模型: 方向盘 / 后视镜 / 各排座椅)"><ha-icon class="ico" icon="mdi:car-seat-heater"></ha-icon></button>`
    : nothing;
  const presetBtn = html`<div class="modes"><div class="actPreset"><button class="chip mi" data-act="presetmenu" aria-label="空调预设" title="空调预设：极速降温 / 极速升温 / 快速除味 / 风挡除霜" ?disabled=${!ctx._ready(
    "ac",
  )}>${unsafeSVG(ipIcon("settingConfig", 20))}</button>${ctx._open.preset
    ? // 四个预设互斥: 同一时刻最多一个生效(车端信号 + 本地记忆, 见 climate 实体的 preset_mode);
      // 生效的那个实心主题色点亮, 空调关闭/车端报别的预设时全部熄灭。
      html`<div class="presetPop" role="menu">${acPresets(ctx).map(
        (q) => html`<button class="presetOpt${pNow === q.val ? " on" : ""}" data-act="preset" data-val="${q.val}" title="${q.val}">${q.ip
          ? unsafeSVG(ipIcon(q.ip, 18))
          : html`<ha-icon class="ico" icon="mdi:${q.mdi}"></ha-icon>`}<span>${q.val}</span></button>`,
      )}</div>`
    : nothing}${seatBtn}</div></div>`;

  return html`<section class="half sec climateSquare"><div class="halfH"><div class="halfId"><span class="acTemp">${hasInterior
    ? fmtNum(interior, 1)
    : "—"}<i>℃</i><span class="acTag">车内</span></span>${ready
    ? nothing
    : html`<span class="halfS">空调不可用</span>`}</div><button class="fanBtn${on ? " on" : ""}" data-act="acpower" title="${on
    ? "点击关闭空调"
    : "点击开启空调"}" ?disabled=${!ready || !!ctx._busy["hvac"]}><ha-icon class="ico" icon="mdi:fan"></ha-icon></button></div><div class="acBody"><div class="tempBox">${steppable
    ? html`<button class="step" data-act="temp" data-delta="${"-" + step}" title="降低 ${step} 度" ?disabled=${!ready}>−</button>`
    : nothing}${loHi
    ? html`<span class="tval" title="${presetNow + "：设定 " + (loHi === "LO" ? 18 : 32) + "℃"}">${loHi}</span>`
    : faceIco
      ? html`<span class="tpr" title="${presetNow + "：预设生效中"}"><ha-icon icon="mdi:${faceIco}"></ha-icon>${presetNow}</span>`
      : html`<span class="tval">${Number.isFinite(tShow) ? fmtNum(tShow, 1) : "—"}<i>℃</i></span>`}${steppable
    ? html`<button class="step" data-act="temp" data-delta="${step}" title="升高 ${step} 度" ?disabled=${!ready}>＋</button>`
    : nothing}</div>${presetBtn}</div></section>`;
}

/* ── 位置卡(右半) ───────────────────────────────────────────────────── */

/** 位置卡的显示门控(与迁移前 _renderLocation 同一个判据) */
export function locationVisible(ctx: ControlCtx): boolean {
  return ctx._vis("location") && !!(ctx._ent("tracker") || ctx._entId("parking") || ctx._entId("find"));
}

/** 位置卡: 区域名(不在区域就显示「外出」)+ 坐标 + 更新时间, 背景是驻车照片;
 *  底部「驻车照片」「鸣笛寻车」胶囊 + 一个 ⓘ。
 *  ⚠️ 隐藏时提交空模板: 这样既不会读到不存在的实体, 也**不会**顺带调用 locBg()
 *  (它会真的去探一次驻车照片的地址 —— 那块卡不画的时候不该发这个请求)。 */
function locationMode(ctx: ControlCtx): "map" | "photo" {
  return ctx._car3dPrefs.location || (ctx._config?.parking_display === "photo" ? "photo" : "map");
}

function locationMap(ctx: ControlCtx, lat: number, lon: number): TemplateResult {
  const system = String(ctx._attr("tracker", "coordinate_system") || "WGS-84").toUpperCase().replace(/-/g, "");
  const point = system === "GCJ02" ? [lat, lon] : wgs84ToGcj02(lat, lon);
  const [x, y] = project(point[0], point[1], 16);
  const tx = Math.floor(x / 256), ty = Math.floor(y / 256);
  const tiles: TemplateResult[] = [];
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const url = tileUrl(String(ctx._config?.tiles || TILE_SOURCES.vector), 16, tx + dx, ty + dy);
    tiles.push(html`<img src=${url} alt="" loading="lazy" decoding="async" style="left:calc(50% + ${((tx + dx) * 256 - x).toFixed(1)}px);top:calc(50% + ${((ty + dy) * 256 - y).toFixed(1)}px)">`);
  }
  return html`<div class="locMap${isDark(ctx._hass) ? " dark" : ""}" aria-hidden="true"><div class="locTiles">${tiles}</div><span class="locCar">${unsafeSVG(carMarker())}</span></div>`;
}

export function locationPanel(ctx: ControlCtx): TemplateResult {
  if (!locationVisible(ctx)) return html``;
  const st = ctx._ent("tracker");
  const driving = ctx._driving();
  const a = (st && st.attributes) || {};
  const lat = a.latitude == null ? NaN : Number(a.latitude);
  const lon = a.longitude == null ? NaN : Number(a.longitude);
  const zone = zoneLabel((ctx._hass && ctx._hass.states) || {}, st ? st.state : "");
  // 时间显示"这张照片是什么时候拿到的" —— 用驻车照片的 upload_time(车端拍照/上传时刻)。
  // 不能用 tracker.last_updated: 每轮轮询都会刷新它, 于是永远显示"刚刚";
  // 照片没换时 upload_time 不变, 时间也就稳定不动。
  const photoAt = ctx._attr("parking_url", "upload_time");
  const mode = locationMode(ctx);
  const rel = relTime(mode === "photo" ? photoAt : ctx._val("state_updated"));
  const hasFix = Number.isFinite(lat) && Number.isFinite(lon) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
  const bg = mode === "photo" ? locBg(ctx) : "";
  // 不在任何区域里 → 「外出」(在区域内才显示区域名)
  const findId = ctx._entId("find");
  const fBusy = !!ctx._busy["btn:" + findId];
  // 背景图: 只有探到能显示(locBg 返回地址)才铺 style 与遮罩 —— 与迁移前的字符串一致
  // (style 属性整条在不需要时不存在; 属性值里的 url("…") 用真引号, 与 &quot; 解出来的一样)。
  const bgStyle = bg ? `background-image:url("${bg}")` : nothing;
  return html`<section class="half sec loc${bg
    ? " hasBg"
    : ""}${mode === "map" && hasFix ? " hasMap" : ""}" style=${bgStyle}>${mode === "map" && hasFix ? locationMap(ctx, lat, lon) : nothing}${bg
    ? html`<i class="locVeil"></i>`
    : nothing}<div class="locIn"><div class="halfId"><span class="bigTxt sm">${zone ||
  (hasFix ? "外出" : "位置未知")}</span><span class="halfS">${mode === "photo" ? (bg ? "驻车照片" : "暂无驻车照片") : hasFix
    ? "车辆位置"
    : "没有定位信息"}</span>${rel ? html`<span class="halfS dim">${rel}</span>` : nothing}</div><div class="floatRow">${ctx._entId(
    "parking",
  ) || ctx._entId("parking_url")
    ? html`<button class="floatPill" data-act="photo" aria-label="查看驻车照片" title="查看驻车照片"><ha-icon class="ico" icon="mdi:camera-outline"></ha-icon></button>`
    : nothing}${findId
    ? html`<button class="floatPill" data-act="press" data-entity="${findId}" aria-label="${fBusy ? "鸣笛中" : "鸣笛寻车"}" title="${driving
        ? "行驶中已禁用"
        : "鸣笛寻车"}" ?disabled=${driving || fBusy}><ha-icon class="ico" icon="${fBusy ? "mdi:timer-sand" : "mdi:volume-high"}"></ha-icon></button>`
    : nothing}</div></div></section>`;
}

/* ── hero(车头那一大块) ───────────────────────────────────────────────── */

/** hero 是否该出现(与迁移前 _renderHero 同一个判据) */
export function heroVisible(ctx: ControlCtx): boolean {
  return ctx._vis("hero");
}

/** 这一帧 hero 画的是**完整布局**吗(只有完整布局才跟着画车模; 见 index.ts 的 _heroLive)。
 *  "多设备候选"与"还没解析出实体"两种退化态只画一张提示卡, 不算完整布局。 */
export function heroFull(ctx: ControlCtx): boolean {
  return heroVisible(ctx) && !(!ctx._device && ctx._candidates.length) && ctx._indexCount() > 0;
}

/** 增程车燃油条: 与电量条共用同一左侧标签列及半宽轨道。 */
function fuelMeterT(ctx: ControlCtx): TemplateResult | typeof nothing {
  if (!ctx._isReev()) return nothing;
  const rawRange = ctx._attr("total_range", "燃油续航_km");
  const range = rawRange != null ? Number(rawRange) : ctx._num("fuel_range");
  if (range == null || !Number.isFinite(range) || range <= 0) return nothing;
  const level = ctx._num("fuel_level");
  const pct = level == null ? 0 : clamp(level, 0, 100);
  return html`<div class="powerMeterRow fuelMeterRow"><span class="powerMeterLabel fuelLabel"><ha-icon icon="mdi:gas-station"></ha-icon><span>${fmtNum(range, 0)} km</span></span><i class="bar powerBar fuel"><b style="width:${pct.toFixed(1)}%"></b></i></div>`;
}

/** 车模主图: 先探针、确认能加载才上屏(与同时序的 _locBg 同一套做法)。
 *  (迁移前的字符串版 carImg() 已随 C 档收尾删除 —— 这里是唯一实现。)
 *  ⚠️ 这段有副作用(会起 Image 探针并在结果回来时 _scheduleRender), 所以只在 hero 真画的时候调。 */
function carImgT(ctx: ControlCtx): TemplateResult | typeof nothing {
  const customSrc = customCarImg(ctx);
  const marketSrc = ctx._car3dPrefs.modelView === "2d" ? ctx._car3dPrefs.market2dUrl || "" : "";
  const vehicleSrc = ctx._attr("car_picture", "entity_picture") || "";
  const preferredSrc = customSrc || marketSrc || vehicleSrc;
  const fallbackSrc = !customSrc && marketSrc ? vehicleSrc : "";
  const apiFailed = preferredSrc && ctx._carImgApiFailedSrc === preferredSrc &&
    Date.now() < ctx._carImgRetryAt;
  const src = preferredSrc && !apiFailed ? preferredSrc : fallbackSrc;
  if (!src) {
    ctx._carImgSrc = "";
    ctx._carImgOk = "";
    return nothing;
  }
  let probeNeeded = src !== ctx._carImgSrc;
  if (src === ctx._carImgSrc && ctx._carImgOk) {
    return ctx._carImgOk === "ok"
      ? html`<img class="carImg" src="${src}" alt="车辆外观">`
      : nothing;
  }
  if (src !== ctx._carImgSrc) {
    ctx._carImgSrc = src;
    ctx._carImgOk = "";
    ctx._carImgRetryAt = 0;
    probeNeeded = true;
  }
  if (probeNeeded) {
    const self = ctx;
    const probe = new Image();
    probe.onload = function () {
      if (self._carImgSrc !== src) return;
      self._carImgOk = "ok";
      if (src === preferredSrc) {
        self._carImgApiFailedSrc = "";
        self._carImgRetryAt = 0;
      }
      self._scheduleRender();
    };
    probe.onerror = function () {
      if (self._carImgSrc !== src) return;
      if (src === preferredSrc) {
        self._carImgApiFailedSrc = src;
        self._carImgRetryAt = Date.now() + CAR_IMG_RETRY_MS;
        self._carImgSrc = "";
        self._carImgOk = "";
      } else {
        self._carImgOk = "bad";
      }
      self._scheduleRender();
    };
    probe.src = src;
    return nothing;
  }
  return ctx._carImgOk === "ok"
    ? html`<img class="carImg" src="${src}" alt="车辆外观">`
    : nothing;
}

/** 车模角上的一个轮压小卡片(超区间标黄/标红)。
 *  (迁移前的字符串版 tirePad() 已随 C 档收尾删除 —— 这里是唯一实现。) */
function tirePadT(ctx: ControlCtx, def: [string, string], corner: string): TemplateResult {
  const key = def[0];
  const v = ctx._num(key);
  const alarm = ctx._attr(key, "alarm");
  const range = tireRange(ctx, key);
  let cls = "";
  if (alarm === true || alarm === 1 || alarm === "1") cls = " bad";
  else if (range && v != null) {
    if (v < range[0] || v > range[1]) cls = " warn";
    if (v < range[0] - 0.3 || v > range[1] + 0.3) cls = " bad";
  }
  const kpa = ctx._attr(key, "kpa");
  const tip = def[1] + " 胎压 " + (v == null ? "—" : fmtNum(v, 2, "bar")) +
    (kpa != null ? " (" + kpa + " kPa)" : "") + (range ? " · 正常 " + range[0] + "~" + range[1] : "");
  return html`<span class="tP ${corner}${cls}" data-tire=${key} title="${tip}"><i>${def[1]}</i><b>${v == null
    ? "—"
    : fmtNum(v, 2)}</b></span>`;
}

/** 车模左侧的充电状态块(只在"充电中"出现)。
 *  (迁移前的字符串版 chgDock() 已随 C 档收尾删除 —— 2D 车模盒与 3D 浮动层都用这一份。) */
function chgDockT(ctx: ControlCtx): TemplateResult | typeof nothing {
  if (!isCharging(ctx)) return nothing;
  const fast = isFastCharging(ctx);
  const label = fast ? "快充中" : "慢充中";
  const icon = unsafeSVG(boltIcon(ctx, fast, 17)); // 图标 SVG → 走 unsafeSVG
  if (!ctx._chgOpen) {
    // 收起态: 只有图标 + 「慢充中/快充中」(**不显示功率**)
    return html`<div class="chgDock"><button class="chgBtn" data-act="chgtoggle" aria-expanded="false" title="${label +
    "(点一下看电压/电流/功率)"}">${icon}<span>${label}</span></button></div>`;
  }
  // 展开态: 整块也是一个按钮(点哪儿都收起); 标题行右侧那个小箭头是"收起"的视觉提示
  const p = chgPower(ctx);
  const m = Number(ctx._attr("charging_state", "remaining_minutes"));
  const rem = Number.isFinite(m) && m > 0
    ? "剩余 " + (m >= 60 ? Math.floor(m / 60) + " 小时" + (m % 60 ? (m % 60) + " 分" : "") : m + " 分")
    : "";
  const kv = p
    ? html`<span class="kv">电压 <b>${p.v.toFixed(1)}</b> V</span><span class="kv">电流 <b>${Math.abs(
        p.a,
      ).toFixed(1)}</b> A</span><span class="kv">功率 <b>${p.kw.toFixed(1)}</b> kW</span>`
    : nothing;
  return html`<div class="chgDock"><button class="chgPanel" data-act="chgtoggle" aria-expanded="true" title="点一下收起"><span class="top">${icon}<span>${label}</span><span class="chgMin" aria-hidden="true">▴</span></span>${kv}${rem
    ? html`<span class="rem">${rem}</span>`
    : nothing}</button></div>`;
}

/** 车模右上角的告警停靠区(没有告警就完全不出现)。
 *  (迁移前的字符串版 warnDock() 已随 C 档收尾删除 —— 2D 车模盒与 3D 浮动层都用这一份。) */
function warnDockT(ctx: ControlCtx): TemplateResult | typeof nothing {
  const items = warnItems(ctx);
  if (!items.length) return nothing;
  if (!ctx._warnOpen) {
    const tip = items.length + " 条告警:" + items.map((x) => x.text).join("、") + "(点一下展开)";
    return html`<div class="warnDock"><button class="warnBtn" data-act="warntoggle" title="${tip}" aria-expanded="false" aria-label="${tip}">!${items.length >
    1
      ? html`<span class="cnt">${items.length}</span>`
      : nothing}</button></div>`;
  }
  const list = items.map((it) => html`<span class="pill err" title="${it.tip}">${it.text}</span>`);
  // ⚠️ 展开态多一个 .open: 列表比「!」宽/高, 贴位与"让开右侧胎压读数那一列"都靠它(见 css.ts)
  return html`<div class="warnDock open"><div class="warnList">${list}<button class="warnCollapse" data-act="warntoggle" title="收起为红色「!」">收起 ▴</button></div></div>`;
}

/** 车模盒里的浮动层(充电块 + 告警 + 打开胎压时的四角读数)。
 *  2D 车模盒(.p-hero 里)与 3D 的浮动层(.p-carview 里的 .carDock)**共用这一份** ——
 *  迁移途中曾是"字符串版给 3D、另抄一份模板给 2D", C 档收尾时已合并。 */
export function carDocksPanel(ctx: ControlCtx): TemplateResult {
  const present = TIRE_DEFS.filter((d) => ctx._entId(d[0]));
  const on = present.length && ctx._vis("tires") && ctx._open.tires;
  const corners = tireCorners(ctx);
  // 充电块占着左侧那一条(见 css.ts): 充电中给读数层加 .hasChg, 左列读数让开它。
  // 告警列表展开时同理给 .hasWarn: 3D 下右列读数让开它(告警块自己钉在舞台右缘 10px 不动)。
  const pads = on
    ? html`<div class="tirePads${isCharging(ctx) ? " hasChg" : ""}${ctx._warnOpen
      ? " hasWarn"
      : ""}">${present.slice(0, 4).map((d, i) => tirePadT(ctx, d, corners[i]))}</div>`
    : nothing;
  return html`${chgDockT(ctx)}${warnDockT(ctx)}${pads}`;
}

/** 车模示意图 + 车模角上的充电/告警浮层(胎压**开关**在车模下方的 .carTools 行里)。
 *  (迁移前的字符串版 carModel() 已随 C 档收尾删除 —— 这里是唯一实现。) */
function carModelT(ctx: ControlCtx): TemplateResult {
  const image = carImgT(ctx);
  const model2d = ctx._car3dPrefs.modelView === "2d" ? " model2d" : "";
  const savedScale = Number(ctx._car3dPrefs.market2dScale);
  const imageScale = Number.isFinite(savedScale) && savedScale >= 1 && savedScale <= 2.5 ? savedScale : 1.5;
  return html`<div class="carModel${model2d}${ctx._carImgOk === "ok" ? "" : " noModel"}" style=${model2d ? `--lm-car-2d-image-scale:${imageScale}` : ""}>${image}${carDocksPanel(ctx)}</div>`;
}

/** hero 本体: 车名(双击可改) + 状态更新 + 刷新钮 + 超大续航 + 电量条 + 右栏胶囊与锁 + 车模示意图。
 *  三种退化态(关掉 hero / 多设备候选 / 还没解析出实体)与完整布局互斥;
 *  **只有完整布局**那支会碰车模与外观图(它们会探图、会 scheduleRender)。
 *  ⛔ 3D 生效时这里**不画**车模盒: 它整块在 .p-carview 里(见 index.ts 的 _renderCarView)。 */
export function heroPanel(ctx: ControlCtx): TemplateResult {
  if (!heroVisible(ctx)) return html``;
  if (!ctx._device && ctx._candidates.length) {
    // 多辆车: 列出候选让用户挑(此时还没定设备)
    const rows = ctx._candidates.map(
      (c) => html`<button class="pickRow" data-act="pickdev" data-val="${c.id}"><b>${c.name}</b><span>${c.count +
      " 个实体 · " +
      c.id}</span></button>`,
    );
    return html`<div class="pick"><div class="pickT">发现多辆零跑</div><div class="pickS">请在卡片配置里填 <code>device</code>, 或点下面选一辆:</div>${rows}</div>`;
  }
  if (!ctx._indexCount()) {
    const msg = ctx._registryState === "loading"
      ? "正在读取实体注册表…"
      : (ctx._devMsg || "还没找到这辆车的实体(等集成连上后会自动出现; 也可以在卡片配置 entities 里手工指定)");
    return html`<div class="pick"><div class="pickT">零跑·车辆控制</div><div class="pickS">${msg}</div></div>`;
  }

  const soc = ctx._num("battery");
  const rangeMain = ctx._mainRange();
  const driving = ctx._driving();
  const isReev = ctx._isReev();
  // 左栏 = 车名 + 能源条 + 续航; 右栏 = 状态胶囊 + 锁
  // (红色告警类另有去处: 车模右上角, 见 warnDockT —— 它们不参与这里的布局)
  // 胶囊配色按含义: 行驶中橙 / 已驻车绿 / 未插灰 / 已插枪未充电红 / 充电中绿
  const chg = chgInfo(ctx);
  const vstate = ctx._val("vehicle_state");
  const rightPills: (TemplateResult | typeof nothing)[] = [];
  if (driving) rightPills.push(html`<span class="pill warn">行驶中</span>`);
  else if (vstate === "parked") rightPills.push(html`<span class="pill parked">已驻车</span>`);
  if (chg) {
    const cls = chg.mode === "charging" ? " chg" : chg.mode === "plugged" ? " plug" : " unplug";
    rightPills.push(html`<span class="pill${cls}" title="${CHARGE_TIP[chg.mode] ||
    "充电状态"}">${chg.text}</span>`);
  }
  // 3D 模式时用刷新图标代替文字胶囊; 只重载查看器, 不触发车况刷新。
  const car3dRefresh = car3dView(ctx)
    ? html`<button class="toolBtn car3dRefresh${ctx._car3dReloading ? " spinning" : ""}" data-act="car3drefresh" title="刷新 3D 车模" aria-label="刷新 3D 车模" ?disabled=${ctx._car3dReloading}><ha-icon icon="mdi:refresh"></ha-icon></button>`
    : nothing;
  // 标题: 正常态是 .vname(双击可改); 改名编辑中换成输入框(**同一个位置**)
  const name = ctx._editingTitle
    ? html`<input class="vnameEdit" type="text" maxlength="40" .value=${live(
        ctx._title(),
      )} title="回车保存 · Esc 取消 · 清空则恢复默认名" placeholder="${ctx._deviceName || "车辆名称"}">`
    : html`<div class="vname" title="双击可改车辆名称">${ctx._title()}</div>`;

  const batteryMeter = soc != null
    ? (() => {
        const s = clamp(soc, 0, 100);
        return html`<div class="powerMeterRow socRow"><span class="powerMeterLabel"><ha-icon icon="mdi:battery"></ha-icon><span>${fmtNum(soc, 0)}%</span></span><i class="bar powerBar${isCharging(ctx) ? " charging" : ""}"><b class="${s <= 15 ? "crit" : s <= 30 ? "low" : ""}" style="width:${s.toFixed(1)}%"></b></i></div>`;
      })()
    : nothing;
  // 纯电车的实时续航小字
  const sub = soc != null && !isReev ? rangeSubline(ctx) : "";
  const rawSpeed=ctx._attr('vehicle_state','speed'),speed=rawSpeed==null?null:Number(rawSpeed),power=chgPower(ctx);
  const dc=ctx._attr('charging_state','dc_connected');
  const pendingCommands=(ctx._attr("vehicle_state","pending_commands")||[]) as string[];
  const unconfirmedCommands=(ctx._attr("vehicle_state","unconfirmed_commands")||[]) as string[];
  const hasPending=pendingCommands.length>0;
  const liveMetric=driving?html`<span class="liveBig" aria-label="车速"><b>${fmtNum(speed!=null&&Number.isFinite(speed)?speed:null,0)}</b><i>km/h</i></span>`:isCharging(ctx)?html`<span class="liveBig charging" aria-label="充电功率"><b>${fmtNum(power?.kw??null,1)}</b><i>kW <small>${dc===true||dc===1||dc==='1'?'DC':dc===false||dc===0||dc==='0'?'AC':'充电'}</small></i></span>`:nothing;
  return html`<div class="heroTop"><div class="heroLeft"><div class="vnameRow">${name}${car3dRefresh}</div><div class="heroMain"><div class="rangeBig">${batteryMeter}${fuelMeterT(ctx)}<span class="rn">${fmtNum(
    rangeMain,
    0,
  )}<i>km</i></span>${liveMetric}</div></div></div><div class="heroRight">${rightPills}${hasPending?html`<span class="pill pending" title="请求已受理，等待车端采样确认">待车端确认</span>`:nothing}${unconfirmedCommands.length?html`<span class="pill pending" title="请求已受理，但三分钟内未收到匹配的车端状态；请核对车辆实际状态">车端未确认</span>`:nothing}</div></div>${sub
    ? html`<div class="subline heroSub">${sub}</div>`
    : nothing}${car3dView(ctx) ? nothing : carModelT(ctx)}`;
}

/* ── 座椅与加热(弹窗正文) ─────────────────────────────────────────────── */

/** 座位上的一颗功能图标(无文字, 靠颜色/动效表示状态):
 *  加热 关=灰 / 开=红; 通风 关=灰(mdi:fan-off) / 开=风扇图标且旋转(蓝)。
 *  点一下 = 档位循环 0→1→2→3→0(number.set_value)。 */
function cabSeatIconT(ctx: ControlCtx, key: string, kind: string, label: string, driving: boolean): TemplateResult {
  const v = ctx._num(key);
  const lvl = v == null ? 0 : clamp(Math.round(v), 0, 3);
  const busy = !!ctx._busy["seat:" + key];
  const on = lvl > 0;
  let icon, cls;
  if (kind === "vent") {
    icon = on ? "mdi:fan" : "mdi:fan-off";
    cls = "cabBtn vent" + (on ? " on spin" : " off");
  } else {
    icon = "mdi:car-seat-heater";
    cls = "cabBtn heat" + (on ? " on" : " off");
  }
  const tip = label + " " + lvl + " 档 · 点击循环 0→1→2→3 档";
  return html`<button class="${cls}" data-act="seatcycle" data-key="${key}" aria-label="${label +
  " " +
  lvl +
  " 档"}" title="${driving ? "行驶中已禁用" : tip}" ?disabled=${driving ||
  busy}><ha-icon class="ico" icon="${icon}"></ha-icon></button>`;
}

/** 第几排某一侧的座位(没有可点的功能就整块不出现)。 */
function cabSeatOfT(ctx: ControlCtx, row: string, pos: string): TemplateResult | typeof nothing {
  for (const s of CABIN_SEATS) {
    if (s.row !== row || s.pos !== pos) continue;
    const heat = s.heat && ctx._entId(s.heat) ? s.heat : "";
    const vent = s.vent && ctx._entId(s.vent) ? s.vent : "";
    if (!heat && !vent) return nothing;
    const driving = ctx._driving();
    const inner = html`${heat ? cabSeatIconT(ctx, heat, "heat", s.label + "加热", driving) : nothing}${vent
      ? cabSeatIconT(ctx, vent, "vent", s.label + "通风", driving)
      : nothing}`;
    return html`<div class="cabCell"><div class="cabIco">${inner}</div></div>`;
  }
  return nothing;
}

/** 方向盘 / 后视镜: 一个开关(开=红, 关=灰), 点一下开或关。 */
function cabSwitchT(ctx: ControlCtx, key: string, icon: string, label: string): TemplateResult {
  const id = ctx._entId(key);
  const on = ctx._val(key) === "on";
  const busy = !!ctx._busy["sw:" + id];
  const driving = ctx._driving();
  const tip = label + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开");
  return html`<div class="cabCell"><button class="cabBtn sw ${on ? "on" : "off"}" data-act="toggle" data-entity="${id}" data-on="${on
    ? "1"
    : "0"}" aria-label="${label + (on ? " 开" : " 关")}" title="${driving
    ? "行驶中已禁用"
    : tip}" ?disabled=${driving ||
  busy}><ha-icon class="ico" icon="mdi:${icon}"></ha-icon></button></div>`;
}

/** 紧凑的图标开关(无文字标签): 后视镜这类放两侧的小按钮用。 */
function cabIconBtnT(ctx: ControlCtx, key: string, icon: string, label: string): TemplateResult {
  const id = ctx._entId(key);
  const on = ctx._val(key) === "on";
  const busy = !!ctx._busy["sw:" + id];
  const driving = ctx._driving();
  const tip = label + (on ? ": 已开, 点击关闭" : ": 已关, 点击打开");
  return html`<button class="cabBtn sw compact ${on
    ? "on"
    : "off"}" data-act="toggle" data-entity="${id}" data-on="${on ? "1" : "0"}" aria-label="${label +
  (on ? " 开" : " 关")}" title="${driving ? "行驶中已禁用" : tip}" ?disabled=${driving ||
  busy}><ha-icon class="ico" icon="mdi:${icon}"></ha-icon></button>`;
}

/** 座舱俯视图: 位图底图(车头朝上: 方向盘/后视镜/前排/二排/三排)作背景, 各排的加热/通风控件
 *  **按底图坐标绝对定位**叠在对应座位上。缺键的排/座位不渲染控件(纯电 C10 只有前排)。
 *  这是弹窗(.smbody > .secB)里的正文, 所以**不自带** .secB(那层壳由 _renderModal 提供)。 */
export function cabinPanel(ctx: ControlCtx): TemplateResult {
  const seats = is7Seat(ctx) ? "7" : "5";
  const dark = isDark(ctx._hass);
  const set = CABIN_IMG[seats] || CABIN_IMG["5"];
  const cfg = set[dark ? "dark" : "light"] || set.light;
  const pos = cfg.pos;
  const url = CAR_IMG_BASE + cfg.src;
  const at = (key: string, inner: TemplateResult | typeof nothing): TemplateResult | typeof nothing => {
    const q = pos[key];
    if (!q || inner === nothing) return nothing;
    return html`<div class="cabPos" style="left:${q[0]}%;top:${q[1]}%">${inner}</div>`;
  };
  const kids: (TemplateResult | typeof nothing)[] = [];
  // 方向盘: 底图上就有方向盘, 按钮叠在它上面
  if (ctx._entId("steering_heat")) {
    kids.push(at("steer", cabSwitchT(ctx, "steering_heat", "steering", "方向盘加热")));
  }
  // 后视镜加热: 放在对应后视镜位置(不用后视镜图片, 所以稍靠内), 左右各一个图标
  if (ctx._entId("mirror_heat")) {
    kids.push(html`<div class="cabPos" style="left:11%;top:13%">${cabIconBtnT(ctx, "mirror_heat", "mirror", "后视镜加热")}</div>`);
    kids.push(html`<div class="cabPos" style="left:89%;top:13%">${cabIconBtnT(ctx, "mirror_heat", "mirror", "后视镜加热")}</div>`);
  }
  kids.push(at("seat-front-left", cabSeatOfT(ctx, "front", "left")));
  kids.push(at("seat-front-right", cabSeatOfT(ctx, "front", "right")));
  kids.push(at("seat-rear-1", cabSeatOfT(ctx, "rear", "left")));
  kids.push(at("seat-rear-3", cabSeatOfT(ctx, "rear", "right")));
  if (seats === "7") {
    kids.push(at("seat-third-left", cabSeatOfT(ctx, "third", "left")));
    kids.push(at("seat-third-right", cabSeatOfT(ctx, "third", "right")));
  }
  return html`<div class="cabin" style="aspect-ratio:${cfg.ar}"><div class="cabMap"><div class="cabBlur" style="background-image:url(${url})"></div><img class="cabBg" alt="座舱" src="${url}"><div class="cabFade"></div></div>${kids}</div>`;
}

/** 一个恒空的面板(comfort / seats 的入口都挪走了, 面板位只为 show 配置兼容留着)。
 *  隐藏面板也**照常提交模板**, 只是它本来就是空的。 */
export function emptyPanel(): TemplateResult {
  return html``;
}

/* ── 设置(卡片本体 .p-car3d; 原「车模设置」) ──────────────────────────
 * 与「充电」并排的那张入口卡: 一行摘要 + 箭头, 点它弹窗(_open.car3d → _renderModal)。
 * 正文由 car3dBodyPanel 提供, 渲染进弹窗那层 .secB(与 chargeBodyPanel / cabinPanel 同一套壳)。
 * (1.9.39 之前它在卡片最底部**就地展开**、折叠态存 localStorage —— 现在不再有折叠态。) */

/** 设置的显示门控; 即使 3D 状态暂不可读, 卡片配色与高德 Key 仍可设置。 */
export function car3dVisible(ctx: ControlCtx): boolean {
  return ctx._vis("car3d");
}

/* ── 卡片配色 + 车模颜色(设置子卡最上面两行; 大圆色块 + 名字, 末尾一颗彩虹圆开取色器) ── */

/** 「卡片配色 · 主题色」一排可选色(与「车模颜色」那行同一套大圆写法)。 */
export const PALETTE_COLORS: [string, string][] = [
  ["#03a9f4", "蓝"], ["#00bcd4", "青"], ["#43a047", "绿"], ["#9c27b0", "紫"],
  ["#e91e63", "粉"], ["#ff9800", "橙"], ["#607d8b", "灰"],
];

/** 一颗大圆色块(名字在圆下方小字)。选中态 = **圆环**(主题色 2px 外圈 + 一圈留白),
 *  不再是以前那种整块胶囊填充 —— 见 css.ts 的 .palDot.on .pcSw。
 *  `hex` 为空 = 用类里的底色(rainbow 用 conic-gradient, auto 用斜杠"无")。 */
function colorDotT(o: {
  act: string;
  key?: string;
  val?: string;
  hex?: string;
  name: string;
  on?: boolean;
  cls?: string;
  title: string;
}): TemplateResult {
  return html`<button class="palDot${o.on ? " on" : ""}" data-act="${o.act}" data-key="${o.key || nothing}" data-val="${o.val != null
    ? o.val
    : nothing}" title="${o.title}"><i class="pcSw${o.cls ? " " + o.cls : ""}" style="${o.hex
    ? "background:" + o.hex
    : nothing}"></i><span class="pcName">${o.name}</span></button>`;
}

/** 末尾那颗"彩虹圆": 点开取色器面板(自定义色从这里进)。 */
function rainbowDotT(key: "accent" | "hex"): TemplateResult {
  return colorDotT({
    act: "palopen",
    key: key,
    name: "自定义",
    cls: "rainbow",
    title: "自定义颜色(打开取色器)",
  });
}

/** 「卡片配色 · 主题色」行: 跟随主题 + 7 颗色块 + 末尾彩虹圆。
 *  点一下**立即生效**(写本机 + 广播, 同页六张卡立刻跟着变), 没有"应用"按钮。 */
function paletteRowT(ctx: ControlCtx): TemplateResult {
  const cur = readPalette().accent;
  const dots = PALETTE_COLORS.map((c) =>
    colorDotT({
      act: "pal",
      key: "accent",
      val: c[0],
      hex: c[0],
      name: c[1],
      on: c[0] === cur,
      title: c[1] + " " + c[0],
    }),
  );
  return html`<div class="cRow palRC"><ha-icon class="cIC" icon="mdi:palette-swatch"></ha-icon><span class="cL">卡片配色 · 主题色</span><span class="cC"><button class="palDot${cur
    ? ""
    : " on"}" data-act="pal" data-key="accent" data-val="" title="回到跟随主题(清除自定义主题色)"><i class="pcSw auto"></i><span class="pcName">跟随主题</span></button>${dots}${rainbowDotT(
    "accent",
  )}</span></div>`;
}

/** 风格预览缩略图的变量快照来自该预设本身, 因此新增 preset 会自动得到同一份样例 UI。 */
function stylePreviewTokens(id: string, dark: boolean): string {
  const tokens = resolveTokens(id as (typeof PRESETS)[number]["id"], { dark });
  return Object.entries(tokens).map(([name, value]) => `${name}:${value}`).join(";");
}

type StyleDrag = { pointerId: number; startX: number; startScroll: number; moved: boolean };
const styleDrags = new WeakMap<HTMLElement, StyleDrag>();

function stylePickerDown(event: PointerEvent): void {
  // 触屏交给浏览器原生横向滚动; JS 拖拽仅服务桌面鼠标, 避免抢占手机滑动手势。
  if (event.pointerType !== "mouse" || event.button !== 0) return;
  const picker = event.currentTarget as HTMLElement;
  styleDrags.set(picker, { pointerId: event.pointerId, startX: event.clientX, startScroll: picker.scrollLeft, moved: false });
}

function stylePickerMove(event: PointerEvent): void {
  const picker = event.currentTarget as HTMLElement;
  const drag = styleDrags.get(picker);
  if (!drag || drag.pointerId !== event.pointerId) return;
  const dx = event.clientX - drag.startX;
  if (!drag.moved && Math.abs(dx) < 7) return;
  if (!drag.moved && picker.hasPointerCapture && !picker.hasPointerCapture(event.pointerId)) {
    try { picker.setPointerCapture(event.pointerId); } catch { /* 鼠标离开时仍可正常滚动 */ }
  }
  drag.moved = true;
  picker.dataset.dragging = "true";
  if (event.pointerType === "mouse") event.preventDefault();
  picker.scrollLeft = drag.startScroll - dx;
}

function stylePickerUp(event: PointerEvent): void {
  const picker = event.currentTarget as HTMLElement;
  const drag = styleDrags.get(picker);
  if (!drag || drag.pointerId !== event.pointerId) return;
  styleDrags.delete(picker);
  if (drag.moved) setTimeout(() => { delete picker.dataset.dragging; }, 0);
}

function stylePickerClick(event: MouseEvent): void {
  const picker = event.currentTarget as HTMLElement;
  if (picker.dataset.dragging !== "true") return;
  event.preventDefault();
  event.stopPropagation();
  delete picker.dataset.dragging;
}

function stylePickerKey(event: KeyboardEvent): void {
  const picker = event.currentTarget as HTMLElement;
  const cards = Array.from(picker.querySelectorAll<HTMLButtonElement>(".styleChoice"));
  const index = cards.indexOf(event.target as HTMLButtonElement);
  if (index < 0 || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? cards.length - 1 : Math.max(0, Math.min(cards.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
  cards.forEach((card, i) => { card.tabIndex = i === nextIndex ? 0 : -1; });
  cards[nextIndex].focus();
  cards[nextIndex].scrollIntoView({ block: "nearest", inline: "nearest" });
}

/**
 * 「界面风格」行: 大型横向预览卡, PRESETS/resolveTokens 是唯一的数据来源。
 *
 * 交互契约(与主题色那行**不同**, 别照抄):
 *   * 点预设 = **只在当前页预览**(写 window 快照 + 广播, 不落 localStorage);
 *   * 「应用到所有卡片」= 持久化 + 广播, 别的标签页也跟着变;
 *   * 「取消」= 回到进入预览之前的那一套(不需要动存储)。
 * 于是"切风格不写存储""预览不会被下一次状态推送冲掉""取消不丢主题色"这三条都成立。
 */
function styleRowT(ctx: ControlCtx): TemplateResult {
  const cur = effectiveStyle();
  const saved = readAppearance().style;
  const changed = isPreviewing();
  const choices = PRESETS.map(
    (p) => html`<button class="styleChoice${p.id === cur ? " on" : ""}" data-act="style" data-val="${p.id}" tabindex="${p.id === cur ? "0" : "-1"}" aria-pressed="${p.id === cur
      ? "true"
      : "false"}" title="${p.label}：${p.hint}"><span class="stylePreview" style="${stylePreviewTokens(p.id, isDark(ctx._hass))}" aria-hidden="true"><span class="stylePreviewTop"><b>车辆概览</b><i class="pill parked">驻车</i></span><span class="stylePreviewPanel sec"><small>剩余续航</small><b>428 <em>km</em></b><i class="stylePreviewMeter"><i></i></i></span><span class="stylePreviewActions"><i class="chip on">驾驶</i><i class="toolBtn">⌁</i></span></span><span class="styleChoiceText"><b>${p.label}</b><small>${p.hint}</small></span></button>`,
  );
  const label = (id: string) => {
    const hit = PRESETS.filter((p) => p.id === id)[0];
    return hit ? hit.label : id;
  };
  const tail = changed
    ? html`<span class="styleActions"><span class="styleNow">预览中 · ${label(
        cur,
      )} 尚未应用</span><button class="chip" data-act="stylecancel">取消</button><button class="chip on" data-act="styleapply">应用到所有卡片</button></span>`
    : html`<span class="styleActions"><span class="styleNow">当前 · <b>${label(saved)}</b></span></span>`;
  return html`<div class="cRow palRC styleRC"><ha-icon class="cIC" icon="mdi:palette-swatch-variant"></ha-icon><span class="cL">界面风格</span><span class="cC"><span class="stylePicker" role="group" aria-label="选择界面风格" @pointerdown=${stylePickerDown} @pointermove=${stylePickerMove} @pointerup=${stylePickerUp} @pointercancel=${stylePickerUp} @click=${stylePickerClick} @keydown=${stylePickerKey}>${choices}</span>${tail}</span></div>`;
}

/** 设置卡本体(与「充电」并排): 一行摘要 + 箭头; 点它走 data-act="car3dmenu"(弹窗, 不是内联展开)。 */
export function car3dPanel(ctx: ControlCtx): TemplateResult {
  if (!car3dVisible(ctx)) return html``;
  return html`<section class="sec"><button class="foldH" data-act="car3dmenu" aria-expanded="${ctx._open.car3d
    ? "true"
    : "false"}" title="设置(界面风格 / 车模显示 / 车模颜色 / 背景 / 外观图)"><span class="foldT">设置</span><span class="foldS">${sumCar3d(
    ctx,
  )}</span><ha-icon class="foldC ico" icon="mdi:chevron-down"></ha-icon></button></section>`;
}

/** 弹窗里的「设置」正文: 卡片配色 / 色表色(车模颜色) / 背景 / 自定义外观图 / 下载素材 / 状态小字。
 *  ⚠️ 这里**不自带** .secB 壳(那层壳由 _renderModal 的宿主提供, 与 cabinPanel 一致)。
 *  ⚠️ 取色器面板(.palPop)也挂在正文后面 —— 它贴的是弹窗里那颗彩虹圆, 关弹窗时要跟着一起消失
 *  (宿主每次重开都会重建, 见 index.ts 的 _renderModal)。
 *  ⚠️ URL 输入框用"属性 + live()"绑定, 并且**接着**用 `_car3dImgDraft` 这个草稿:
 *  用户打到一半的 URL 在下一次状态推送后必须还在(有冒烟断言兜着)。
 *  取色器里的 hex 输入框同理(草稿在 picker.ts / index.ts 的 `_palHexDraft`)。 */
export function car3dBodyPanel(ctx: ControlCtx): TemplateResult {
  if (!car3dVisible(ctx)) return html``;
  const info = ctx._car3d;
  const body: (TemplateResult | typeof nothing)[] = [];
  // 卡片配色排在最上面(先"观感统一", 再是车模那几项)
  body.push(paletteRowT(ctx));
  // 界面风格紧随主题色一行(两者都是"六张卡统一"的本机外观设置, 维度互相独立)
  body.push(styleRowT(ctx));
  const hideCardFrame = readAppearance().hideCardFrame;
  body.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:border-none-variant"></ha-icon><span class="cL">隐藏卡片外框</span><span class="cC"><button role="switch" aria-label="隐藏全部卡片最外层的边框和阴影" aria-checked=${hideCardFrame} class="togchip${hideCardFrame ? " on" : ""}" data-act="hidecardframe" title="去掉最外层边框和阴影，保留内部子卡片效果；本机全部零跑自定义卡片统一生效"><span class="thumb"></span></button></span></div>`);
  const fixed2d = ctx._car3dPrefs.modelView === "2d";
  body.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:car"></ha-icon><span class="cL">车模显示</span><span class="cC"><button class="chip${fixed2d ? "" : " on"}" data-act="car3dviewmode" data-val="auto" aria-pressed=${!fixed2d} title="自动使用可用的 3D 车模">自动 / 3D</button><button class="chip${fixed2d ? " on" : ""}" data-act="car3dviewmode" data-val="2d" aria-pressed=${fixed2d} title="固定显示车辆外观图">仅 2D</button></span></div>`);
  if (fixed2d) body.push(car2dMarketColorRowT(ctx));
  if (info?.ready === true) {
    if (!fixed2d) body.push(car3dColorRowsT(ctx), html`<div class="cRow"><ha-icon class="cIC" icon="mdi:palette-outline"></ha-icon><span class="cL">车衣</span><span class="cC"><button class="chip" data-act="wrapopen" ?disabled=${!car3dView(ctx)}>上传与预览</button></span></div>`, car3dBgRowT(ctx));
  }
  body.push(car3dImageRowT(ctx));
  body.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:map-outline"></ha-icon><span class="cL">驻车背景</span><span class="cC">${([['map', '地图位置'], ['photo', '驻车照片']] as const).map(([key, label]) => html`<button class="chip${locationMode(ctx) === key ? ' on' : ''}" data-act="locationmode" data-val=${key} aria-pressed=${locationMode(ctx) === key}>${label}</button>`)}</span></div>`);
  if ((!info || info.ready !== true) && !customCarImg(ctx)) {
    // 只有"还没装配 + 没选自定义外观图"才给下载入口(选了自定义图就是用不着 3D 了)
    const busy = ctx._car3dBusy || String(info?.state) === "downloading";
    // 云端声明"这辆车没有 3D 素材"(modelType 2/1)时按钮换个说法 —— 不是下载失败,
    // 而是"云端就没给", 想再确认一次仍可点(云端后补了素材就能装上)。
    const unsupported = String(info?.state) === "unsupported";
    body.push(html`<div class="cRow"><ha-icon class="cIC" icon="mdi:cube-outline"></ha-icon><span class="cL">3D 素材</span><span class="cC"><button class="chip" data-act="car3ddl" ?disabled=${busy}>${busy
      ? "正在下载…"
      : unsupported
        ? "重新检查云端素材"
        : "下载 3D 车模素材(约 15 MB, 一次性)"}</button></span></div>`);
  }
  body.push(html`<div class="subline">${car3dStateText(ctx)}</div>`);
  // 取色器面板(绝对定位, 贴在彩虹圆附近; 位置由 index.ts 的 _placePal / picker.ts 实测写回)
  const caps = ctx._attr("vehicle_state", "capabilities") || [];
  body.push(html`<leapmotor-vehicle-tools .hass=${ctx._hass} .entityId=${ctx._entId('vehicle_state')||ctx._entId('battery')} section="media"></leapmotor-vehicle-tools><leapmotor-vehicle-tools .hass=${ctx._hass} .entityId=${ctx._entId('vehicle_state')||ctx._entId('battery')} section="amap"></leapmotor-vehicle-tools>`);
  body.push(html`<details class="capTable"><summary>车型能力与状态</summary>${caps.length?caps.map((c:any)=>html`<div class="capRow" title=${c.detail}><span>${c.name}</span><span class="status ${c.status}">${c.label}</span></div>`):html`<p class="subline">能力数据暂未取得</p>`}<p class="subline">缺信号不代表不支持；指令受理后仍需车端采样确认。</p></details>`);
  return html`${body}${palPickerT(ctx)}`;
}

/** 车模颜色: 色表色一排大圆(名字在圆下方) + 末尾彩虹圆(自定义车漆, 即时 paint) + 「回到实车色」(文字钮)。 */
function car3dColorRowsT(ctx: ControlCtx): TemplateResult {
  const colors = car3dColors(ctx);
  const sel = car3dSelTsp(ctx);
  const dots = colors.length
    ? colors.map((c) =>
        colorDotT({
          act: "car3dcolor",
          val: String(c.tsp),
          hex: c.hex,
          name: c.name,
          on: String(c.tsp) === sel,
          title: c.name + " " + c.hex,
        }),
      )
    : html`<span class="subline">素材里没有色表, 用旁边的彩虹圆自定义</span>`;
  return html`<div class="cRow palRC"><ha-icon class="cIC" icon="mdi:palette"></ha-icon><span class="cL">车模颜色</span><span class="cC">${dots}${rainbowDotT(
    "hex",
  )}<button class="chip txt" data-act="car3dauto" title="清掉车漆覆盖, 回到实车色">回到实车色</button></span></div>`;
}

/** 2D 车色来自公开商城对应年款/版本的整车渲染图, 与车端颜色名精确对应。 */
function car2dMarketColorRowT(ctx: ControlCtx): TemplateResult {
  const custom = customCarImg(ctx);
  const pictures = ctx._marketPictures || [];
  const models = ctx._marketModels || [];
  const variants = ctx._marketVariants || [];
  const selectedVariant = variants.find((item) => item.id === ctx._marketSelectedVariant);
  const latestYear = Math.max(new Date().getFullYear(), 2020, ...variants.map((item) => Number(item.year) || 0));
  const years = Array.from({ length: latestYear - 2020 + 1 }, (_, index) => String(latestYear - index));
  const selectedYear = ctx._marketSelectedYear || selectedVariant?.year || "";
  const savedScale = Number(ctx._car3dPrefs.market2dScale);
  const imageScale = Number.isFinite(savedScale) && savedScale >= 1 && savedScale <= 2.5 ? savedScale : 1.5;
  const yearVariants = selectedYear ? variants.filter((item) => item.year === selectedYear) : [];
  const unavailable = ctx._marketPicturesError;
  const unavailableYear = unavailable === "该年款暂无商城配置" && !!selectedYear && !yearVariants.length;
  const colors = pictures.length
    ? pictures.map((item) => html`<button class="chip${ctx._car3dPrefs.market2dColor === item.color ? " on" : ""}" data-act="car2dcolor" data-val=${item.color} aria-pressed=${ctx._car3dPrefs.market2dColor === item.color} ?disabled=${!!custom}>${item.color}</button>`)
    : nothing;
  const modelSummary = [ctx._car3dPrefs.market2dModel || ctx._marketSelectedModel, selectedYear && `${selectedYear} 款`, ctx._car3dPrefs.market2dColor].filter(Boolean).join(" · ") || "选择车型与颜色";
  return html`<div class="market2dSettings">
    <button class="market2dHeader" data-act="car2dmenu" aria-expanded=${ctx._open.car2dSettings}>
      <ha-icon icon="mdi:palette-outline"></ha-icon><span>2D 外观</span><span class="market2dSummary">${modelSummary}</span>
      <ha-icon class="market2dChevron" icon="mdi:chevron-down"></ha-icon>
    </button>
    ${ctx._open.car2dSettings ? html`<div class="market2dBody">
    <label class="market2dScale"><span class="market2dScaleLabel"><span>车图大小</span><output>${imageScale.toFixed(2)}×</output></span>
      <input type="range" data-act="car2dscale" min="1" max="2.5" step="0.05" aria-label="2D 车图大小" .value=${live(String(imageScale))}>
    </label>
    <div class="market2dPicker">
    ${ctx._marketCatalogLoading ? html`<span class="subline">正在读取商城车型目录…</span>` : models.length ? html`<div class="market2dSelects">
      <label class="market2dField"><span>车型</span><select class="tinput" data-act="car2dmodel" .value=${live(ctx._marketSelectedModel)} ?disabled=${!!custom}><option value="">选择车型</option>${models.map((item) => html`<option value=${item.name}>${item.name}</option>`)}</select></label>
      <label class="market2dField"><span>年款</span><select class="tinput" data-act="car2dyear" .value=${live(selectedYear)} ?disabled=${!!custom || ctx._marketVariantsLoading}><option value="">${ctx._marketVariantsLoading ? "正在读取年款…" : "选择年款"}</option>${years.map((year) => html`<option value=${year}>${year} 款</option>`)}</select></label>
      <label class="market2dField"><span>能源 · 配置</span><select class="tinput" data-act="car2dvariant" .value=${live(ctx._marketSelectedVariant)} ?disabled=${!!custom || ctx._marketVariantsLoading || !yearVariants.length}><option value="">${ctx._marketVariantsLoading ? "正在读取配置…" : unavailableYear ? "该年款暂无可选配置" : "选择能源与配置"}</option>${yearVariants.map((item) => html`<option value=${item.id}>${item.energy} · ${item.edition}</option>`)}</select></label>
    </div>` : nothing}
    ${ctx._marketPicturesLoading && !ctx._marketVariantsLoading ? html`<span class="subline">正在读取该配置的颜色…</span>` : nothing}
    ${unavailable && !ctx._marketPicturesLoading ? html`<div class="market2dError"><span class="subline">${unavailable}</span>${unavailableYear ? nothing : html`<button class="chip" data-act="car2dpictures">重新读取</button>`}</div>` : nothing}
    ${pictures.length ? html`<div class="market2dColors" role="group" aria-label="商城车身颜色">${colors}</div>` : nothing}
    ${models.length ? html`<span class="market2dNote">图片来自商城所选车型配置；选择其他车型时仅改变展示外观。</span>` : nothing}
    ${custom ? html`<span class="subline">清除自定义外观图后，才能显示商城车辆图片</span>` : nothing}
    </div>` : nothing}
  </div>`;
}

/** 背景: 跟随主题 / 白天 / 夜晚(chip 一点立即发 daynight, 不等重绘)。 */
function car3dBgRowT(ctx: ControlCtx): TemplateResult {
  const cur = car3dBgPref(ctx);
  const items = CAR3D_BACKGROUNDS;
  const chips = items.map((it) => html`<button class="chip${cur === it[0]
    ? " on"
    : ""}" data-act="car3dbg" data-val="${it[0]}" aria-pressed=${cur === it[0]
    ? "true"
    : nothing}>${it[1]}</button>`);
  return html`<div class="cRow"><ha-icon class="cIC" icon="mdi:theme-light-dark"></ha-icon><span class="cL">背景</span><span class="cC">${chips}</span></div>`;
}

/** 自定义外观图: 填了它就不用 3D(空白 = 用 3D / 内置外观图)。 */
function car3dImageRowT(ctx: ControlCtx): TemplateResult {
  const draft = ctx._car3dImgDraft;
  const val = draft != null ? draft : customCarImg(ctx);
  return html`<div class="cRow"><ha-icon class="cIC" icon="mdi:image-outline"></ha-icon><span class="cL">自定义外观图</span><span class="cC"><input class="tinput car3dUrl" type="text" data-act="car3dimg" placeholder="/local/my-car.png 或 https://…" value="${val}" .value=${live(
    val,
  )} title="填了它就不显示 3D 车模"><button class="chip" data-act="car3dimgset">应用</button><button class="chip" data-act="car3dimgclr" title="清掉自定义图, 回到 3D">清除</button></span></div>`;
}

/* ── 动作行(.p-actions) ─────────────────────────────────────────────── */

/** 动作行的显示门控(与迁移前 _renderActions 同一个判据) */
export function actionsVisible(ctx: ControlCtx): boolean {
  return ctx._vis("actions");
}

/** 一个圆钮(图标 + 下面的小字): 走 press 的(解锁/后备箱/车窗)用它。 */
function roundBtn(ctx: ControlCtx, key: string, icon: string, label: string, disabled: boolean, title: string, cls?: string): TemplateResult {
  const id = ctx._entId(key);
  const busy = !!ctx._busy["btn:" + id];
  return html`<div class="act"><button class="circ${cls ? " " + cls : ""}" data-act="press" data-entity="${id}" title="${title ||
  label}" ?disabled=${disabled || busy}><ha-icon class="ico lg" icon="${icon}"></ha-icon></button><span class="actL">${label}</span></div>`;
}

/** 一个开关圆钮(开着时主题色点亮)。 */
function toggleRoundBtn(ctx: ControlCtx, key: string, icon: string, label: string, disabled: boolean): TemplateResult {
  const id = ctx._entId(key);
  const on = ctx._val(key) === "on";
  const busy = !!ctx._busy["sw:" + id];
  return html`<div class="act"><button class="circ${on
    ? " on"
    : ""}" data-act="toggle" data-entity="${id}" data-on="${on ? "1" : "0"}" title="${label +
  (on ? ": 已开, 点击关闭" : ": 已关, 点击打开")}" ?disabled=${disabled ||
  busy}><ha-icon class="ico lg" icon="${icon}"></ha-icon></button><span class="actL">${label}</span></div>`;
}

/** 四个圆形动作按钮: 解锁·上锁 / 后备箱 / 车窗(弹四档气泡) / 遮阳帘。
 *  ⚠️ `.winPop` 的位置由 index.ts 的 _placeWin() 事后实测贴上去, 这里只画结构。 */
export function actionsPanel(ctx: ControlCtx): TemplateResult {
  if (!actionsVisible(ctx)) return html``;
  const driving = ctx._driving();
  const btns: (TemplateResult | typeof nothing)[] = [];
  if (ctx._entId("lock")) {
    const st = ctx._val("lock") || "unknown";
    const locked = st === "locked" || st === "locking";
    const label = locked ? "解锁" : "上锁";
    const tip = driving ? "行驶中已禁用" : locked ? "解锁(会先弹确认)" : "上锁(会先弹确认)";
    // 颜色语义: **上锁 = 灰色**(常态, 没什么要注意的); 未上锁才亮起提示
    btns.push(html`<div class="act"><button class="circ${locked
      ? ""
      : " on"}" data-act="lockround" title="${tip}" ?disabled=${driving ||
    !!ctx._busy["lock"]}><ha-icon class="ico lg" icon="${locked
      ? "mdi:car-door-lock"
      : "mdi:car-door-lock-open"}"></ha-icon></button><span class="actL">${label}</span></div>`);
  }
  // 后备箱: 开/关都要 window.confirm(图标用 car-back, 老写法 car-backup 在 MDI 里不存在)
  if (ctx._entId("trunk")) {
    const on = ctx._val("trunk") === "on";
    const id = ctx._entId("trunk");
    const busy = !!ctx._busy["sw:" + id];
    // 开着 = 告警态(白底 + 红描边 + 红图标; 不再叠主题蓝), 文字也变红
    btns.push(html`<div class="act"><button class="circ${on
      ? " warn"
      : ""}" data-act="trunk" data-entity="${id}" data-on="${on ? "1" : "0"}" title="${"后备箱" +
    (on ? ": 已开, 点击关闭(会先弹确认)" : ": 已关, 点击打开(会先弹确认)")}" ?disabled=${driving ||
    busy}><ha-icon class="ico lg" icon="mdi:car-back"></ha-icon></button><span class="actL">后备箱</span></div>`);
  }
  // 车窗: 点圆钮弹一个悬浮气泡(不是内联展开, 所以不会把动作行挤高)
  // 图标用 window-open-variant(window-shutter 是卷帘, 语义不对; 卷帘留给遮阳帘)
  const wins = WINDOW_STEPS.filter((w) => ctx._entId(w[0]));
  if (wins.length) {
    const open = ctx._open.window;
    // 车窗真开着(且非行驶) → 告警态; 只是气泡打开不算
    const winWarn = ctx._leftOpen().window;
    // 不再有主题蓝的"开着/气泡打开"态: 车窗的状态只由告警态表达
    const opts = open
      ? html`<div class="winPop" role="menu">${wins.map((w) => {
          const id = ctx._entId(w[0]);
          const busy = !!ctx._busy["btn:" + id];
          // 三档「开」没有分档图标(窗开度没有对应的图形), 所以只有「关」配一个关着的窗户图标;
          // 少一颗图标气泡才不会宽到夹到卡片边上(_placeWin 的贴位逻辑不动)
          const wIcon = w[1] === "关" ? "mdi:window-closed-variant" : "";
          return html`<button class="winOpt" data-act="winstep" data-entity="${id}" ?disabled=${driving ||
          busy} title="${driving ? "行驶中已禁用" : "车窗" + w[1]}">${wIcon
            ? html`<ha-icon class="ico sm" icon="${wIcon}"></ha-icon>`
            : nothing}${w[1]}</button>`;
        })}</div>`
      : nothing;
    btns.push(html`<div class="act actWin"><button class="circ${winWarn
      ? " warn"
      : ""}" data-act="window" title="${winWarn ? "车窗开着, 点这里选档位关闭" : "车窗四档"}" aria-expanded="${open
      ? "true"
      : "false"}" ?disabled=${driving}><ha-icon class="ico lg" icon="mdi:window-open-variant"></ha-icon></button><span class="actL">车窗</span>${opts}</div>`);
  }
  if (ctx._entId("sunshade")) {
    const on = ctx._val("sunshade") === "on";
    const id = ctx._entId("sunshade");
    const busy = !!ctx._busy["sw:" + id];
    // 遮阳帘"已开"也不再用主题蓝, 而是和后备箱/车窗一样用红描边标出开着的状态
    // (顶部红胶囊不列遮阳帘: 那是"未关"的警示语义, 遮阳帘开着通常是正常的)
    btns.push(html`<div class="act"><button class="circ${on
      ? " warn"
      : ""}" data-act="toggle" data-entity="${id}" data-on="${on ? "1" : "0"}" title="${"遮阳帘" +
    (on ? ": 已开, 点击关闭" : ": 已关, 点击打开")}" ?disabled=${driving ||
    busy}><ha-icon class="ico lg" icon="mdi:window-shutter"></ha-icon></button><span class="actL">遮阳帘</span></div>`);
  }
  return html`<div class="acts">${btns}</div>`;
}

/* ── 驻车照片覆盖层(.ovl) ───────────────────────────────────────────── */

/** 驻车照片大图覆盖层。⚠️ 里面**不要**再挂 error 监听: 图的加载失败走的是 shadowRoot 上
 *  那个**捕获阶段**的唯一一处委托(见 index.ts 的 _onImgError / _build)。 */
export function photoPanel(ctx: ControlCtx): TemplateResult {
  const src = ctx._photoSrc();
  return html`<div class="ovlBox" data-act="closep">${ctx._photoErr
    ? html`<div class="ovlNone">驻车照片加载失败</div>`
    : src
      ? html`<img class="ovlImg" src="${src}" alt="驻车照片">`
      : html`<div class="ovlNone">暂时没有驻车照片</div>`}<button class="ovlX" data-act="closep" title="关闭"><ha-icon class="ico sm" icon="mdi:close"></ha-icon></button></div>`;
}

/* ── 顶部提示(.hint)与 toast ────────────────────────────────────────── */

/** 顶部提示: 一个 ⓘ + 整句说明(标题里那句"要动手配置"的诊断提示)。
 *  空消息 → 空模板(调用方同时把 display 切掉)。 */
export function hintPanel(msg: string): TemplateResult {
  if (!msg) return html``;
  // ⚠️ 消息既进 title(悬停看)又进那个 span(显示整句) —— 迁移前是 info(ctx, msg, "hintIco")
  // 再给 span 赋 textContent, 两处内容一样, 别只写一处。
  return html`<ha-icon class="ico sm info hintIco" icon="mdi:information-outline" title="${msg}"></ha-icon><span>${msg}</span>`;
}

/** toast 的文字(浮层本身的 class 由 index.ts 的 _renderToast 切, 见那里的说明)。 */
export function toastPanel(msg: string): TemplateResult {
  return msg ? html`${msg}` : html``;
}

/** 车模下方那行小控件(目前只有「胎压」开关): 从车模盒里挪出来, 免得压住车与拖动。
 *  没有胎压实体/未开 show 时返回空模板(`.carTools:empty` 由 CSS 收起整行)。 */
export function carToolsPanel(ctx: ControlCtx): TemplateResult {
  const can = TIRE_DEFS.some((d) => ctx._entId(d[0])) && ctx._vis("tires");
  if (!can) return html``;
  const on = ctx._open.tires;
  return html`<button class="tireTgl${on ? " on" : ""}" data-act="tires" aria-expanded="${on
    ? "true"
    : "false"}" aria-label="胎压" title="${on
    ? "收起胎压读数"
    : "在车模上显示四轮胎压"}"><ha-icon icon="mdi:gauge"></ha-icon></button>`;
}
