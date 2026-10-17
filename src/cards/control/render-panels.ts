/*
 * 零跑·车辆控制卡 —— 各面板(actions/climate/location/charging/comfort/seats/fuel)的 HTML 片段
 *
 * 从 src/cards/control.ts 原样搬出的方法: 只把接收者 this 换成第一个参数 ctx,
 * 调同类搬出的函数时改为直接调用并补传 ctx; 字符串/类名/data-* 属性/文案一律未改。
 */
import { fmtNum, fmtPct, fmtDur } from "../../lib/format";
import { chgInfo } from "./render-hero";
import { CABIN_SEATS } from "./types";
import type { HassEntity } from "../../types/hass";
import type { ControlCtx } from "./types";

/** 增程车的续航三件套: 大数字是总续航, 下面两个小胶囊分别是纯电/燃油; 纯电车返回空 */
/** 这辆车**当下有没有实质燃油数据** —— 显示层的门控(与"是不是增程"分开)。
 *
 *  为什么显示层不直接看 `_isReev()`: "是不是增程"是能力判定(建不建那 4 个实体),
 *  而"画不画燃油块/燃油胶囊"应该看**有没有值可画**。这样即使判定出错, 用户也看不到
 *  假数据 —— 显示层只画真有数据的东西。
 *  ⚠️ 刻意**不含 `total_range`**: 综合续航是所有车都有的(纯电车 = 纯电续航),
 *  拿它当触发条件会把纯电也算成"有燃油数据"。
 */
export function hasFuelData(ctx: ControlCtx): boolean {
  const lvl = ctx._num("fuel_level");
  const fr = ctx._num("fuel_range");
  const fc = ctx._num("fuel_consumption");
  return (lvl != null && lvl > 0) || (fr != null && fr > 0) || (fc != null && fc > 0);
}

/** 空调快捷预设(与集成 climate 实体的 preset 名称一致): 极速降温 / 极速升温 / 快速除味 / 风挡除霜。 */
export function acPresets(ctx: ControlCtx): { val: string; ip?: string; mdi?: string }[] {
  return [
    { val: "极速降温", ip: "snow" },
    { val: "极速升温", ip: "fire" },
    { val: "快速除味", ip: "whirlwind" },
    { val: "风挡除霜", mdi: "car-defrost-front" }, // 语义最贴切的仍是这个 mdi, 保留
  ];
}
export function zoneLabel(states: Record<string, HassEntity>, state: string): string {
  const s = String(state == null ? "" : state);
  if (!s || s === "unknown" || s === "unavailable") return "";
  if (s === "not_home") return "";
  const direct = states["zone." + s];
  if (direct && direct.attributes && direct.attributes.friendly_name) {
    return direct.attributes.friendly_name;
  }
  const ids = Object.keys(states);
  for (const id of ids) {
    if (id.indexOf("zone.") !== 0) continue;
    const a = states[id].attributes || {};
    if (String(a.friendly_name) === s) return s;
  }
  if (s === "home") return "家"; // 连 zone.home 都没有(极少见)时的兜底
  return s;
}

/** 位置卡背景图(驻车照片)。
 *  background-image 加载失败不会报错、也不会留裂图, 所以先用 Image() 探一次:
 *  探到能显示才把地址交给 CSS, 探不到就静默退回纯色底。 */
export function locBg(ctx: ControlCtx): string {
  const src = ctx._photoSrc();
  if (!src) {
    ctx._locBgSrc = "";
    ctx._locBgOk = "";
    return "";
  }
  if (src === ctx._locBgSrc && ctx._locBgOk) {
    return ctx._locBgOk === "ok" ? src : "";
  }
  if (src !== ctx._locBgSrc) {
    ctx._locBgSrc = src;
    ctx._locBgOk = "";
    const self = ctx;
    const probe = new Image();
    probe.onload = function () {
      if (self._locBgSrc !== src) return;
      self._locBgOk = "ok";
      self._scheduleRender();
    };
    probe.onerror = function () {
      if (self._locBgSrc !== src) return;
      self._locBgOk = "bad";
      self._scheduleRender();
    };
    probe.src = src;
    return "";
  }
  return ctx._locBgOk === "ok" ? src : "";
}

/** 这辆车有没有"充电设置"可谈(有任一相关实体才画充电卡)。 */
export function hasChargingBlock(ctx: ControlCtx): boolean {
  return ["battery", "charging_state", "charge_limit", "charge_book", "charge_start",
    "charge_end", "healthy_charge", "preheat_on", "preheat_off"].some((k) => ctx._entId(k));
}
export function sumCharging(ctx: ControlCtx): string {
  const soc = ctx._num("battery");
  const chg = chgInfo(ctx);
  const m = Number(ctx._attr("charging_state", "remaining_minutes"));
  const parts: string[] = [];
  if (soc != null) parts.push(fmtPct(soc));
  if (chg && chg.mode === "charging") {
    const d = fmtDur(m);
    parts.push(d ? "剩余 " + d : "充电中");
  } else if (chg) {
    parts.push(chg.text);
  }
  return parts.join(" · ");
}
export function cabinAny(ctx: ControlCtx): boolean {
  for (const s of CABIN_SEATS) {
    if ((s.heat && ctx._entId(s.heat)) || (s.vent && ctx._entId(s.vent))) return true;
  }
  return !!(ctx._entId("steering_heat") || ctx._entId("mirror_heat"));
}
export function is7Seat(ctx: ControlCtx): boolean {
  return !!(ctx._entId("seat_heat_third_left") || ctx._entId("seat_heat_third_right"));
}
export function sumFuel(ctx: ControlCtx): string {
  const parts: string[] = [];
  const lvl = ctx._num("fuel_level");
  const fr = ctx._num("fuel_range");
  // 与 _renderFuel 同一口径: 只列**有值**的项(0 不列 —— 收起态的摘要不该写"0%")
  if (lvl != null && lvl > 0) parts.push(fmtPct(lvl));
  if (fr != null && fr > 0) parts.push(fmtNum(fr, 0, "km"));
  return parts.join(" · ");
}
