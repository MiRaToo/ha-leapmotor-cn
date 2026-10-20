import type { ControlCtx } from "./types";

/** 读数完整矩形的可用区域，单位与 iframe 的 CSS 像素一致。隐藏的读数仍可测量尺寸。 */
export function tireLayout(ctx: ControlCtx) {
  const root=ctx.shadowRoot,view=root?.querySelector<HTMLElement>('.p-carview'),viewRect=view?.getBoundingClientRect();
  if(!view||!viewRect||viewRect.height<=0)return null;
  const scaleY=(view.clientHeight||viewRect.height)/viewRect.height;
  const visibleRect=(el:HTMLElement|null|undefined)=>{
    if(!el||!el.getClientRects().length)return null;
    const rect=el.getBoundingClientRect();return rect.height>0?rect:null;
  };
  const header=visibleRect(root?.querySelector<HTMLElement>('.p-hero'));
  const docks=[view.querySelector<HTMLElement>('.chgDock'),view.querySelector<HTMLElement>('.warnDock')]
    .map(el=>visibleRect(el)).filter((rect):rect is DOMRect=>!!rect);
  const top=Math.max(64,...[header,...docks].filter((rect):rect is DOMRect=>!!rect)
    .map(rect=>(rect.bottom-viewRect.top)*scaleY+20));
  const lowerControls=[root?.querySelector<HTMLElement>('.carTools'),root?.querySelector<HTMLElement>('.p-actions'),
    ...Array.from(root?.querySelectorAll<HTMLElement>('.p-actions .winPop,.p-actions .presetPop')||[])]
    .map(el=>visibleRect(el)).filter((rect):rect is DOMRect=>!!rect&&rect.bottom>viewRect.top&&rect.top<viewRect.bottom);
  const bottom=lowerControls.length
    ? Math.min(...lowerControls.map(rect=>(rect.top-viewRect.top)*scaleY))-20
    : viewRect.height*scaleY-20;
  const pads=Array.from(view.querySelectorAll<HTMLElement>('.tP'));
  return {tireTop:top,tireBottom:bottom,
    tireWidth:Math.max(64,...pads.map(el=>el.offsetWidth)),tireHeight:Math.max(34,...pads.map(el=>el.offsetHeight))};
}

/** 无信号时保留未知，不把未上报的车窗画成已关。百分比优先，枚举只兜底开/关。 */
export function vehiclePose(ctx: ControlCtx): Record<string, string | number> {
  const out: Record<string, string | number> = { t: "vehicle" };
  const pct = ctx._attr("vehicle_state", "reported_windows_percent") || ctx._attr("vehicle_state", "windows_percent") || {};
  const states = ctx._attr("vehicle_state", "reported_windows_state") || ctx._attr("vehicle_state", "windows_state") || {};
  // 1693~1696 的逐窗顺序未验证，只有四位同开/同关才能用来兜底。
  const flags = ["1", "2", "3", "4"].map((key) => states[key] == null ? NaN : Number(states[key]));
  const uniform = flags.every((v) => Number.isFinite(v) && v >= 0) &&
    flags.every((v) => (v > 0) === (flags[0] > 0)) ? (flags[0] > 0 ? 1 : 0) : null;
  const windows = [["left_front", "lf"], ["right_front", "rf"],
    ["left_rear", "lr"], ["right_rear", "rr"]];
  for (const [name, key] of windows) {
    const value = pct[name];
    const n = value == null || value === "" ? NaN : Number(value);
    // 部分车型百分比信号恒为 0；枚举明确开着时不能被这个 0 覆盖。
    if (Number.isFinite(n) && n > 0 && n <= 100) out[key] = n / 100;
    else if (uniform != null) out[key] = uniform;
    else if (n === 0 && !flags.some((v) => v > 0)) out[key] = 0;
  }
  const trunk = ctx._val("trunk");
  const attr = ctx._attr("vehicle_state", "trunk_open");
  const reported = ctx._attr("vehicle_state", "reported_trunk_open");
  if (typeof reported === "boolean") out.trunk = reported ? 1 : 0;
  else if ((ctx._attr("vehicle_state", "pending_commands") || []).includes("trunk")) { /* 保留未知，不把请求值当实测 */ }
  else if (trunk === "on" || trunk === "off") out.trunk = trunk === "on" ? 1 : 0;
  else if (typeof attr === "boolean") out.trunk = attr ? 1 : 0;
  const speed=ctx._attr('vehicle_state','speed');
  out.speed=ctx._driving()&&speed!=null&&Number.isFinite(Number(speed))?Math.max(0,Math.min(200,Number(speed))):0;
  out.tires=ctx._open.tires?1:0;
  if(ctx._open.tires)Object.assign(out,tireLayout(ctx));
  return out;
}
