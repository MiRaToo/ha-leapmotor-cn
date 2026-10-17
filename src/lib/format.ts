// 格式化工具 —— 汇集五张卡里原本各自复制的实现(逐字等价, 不改数值口径)。
import { pad2 } from "./dom";

/** 数值格式化; 无效值显示 —。digits 为空则取 1 位。 */
export function fmtNum(v: unknown, digits?: number, unit?: string): string {
  const n = Number(v);
  if (v == null || v === "" || !Number.isFinite(n)) return "—";
  const s = n.toFixed(digits == null ? 1 : digits);
  return unit ? s + " " + unit : s;
}

/** 里程: 一位小数(官方 App 就是 19.0 km)。 */
export function fmtKm(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return n.toFixed(1);
}

/** 能耗 kWh: 两位小数(去尾零)。 */
export function fmtKwh(v: unknown): string {
  return String(Number(Number(v).toFixed(2)));
}

/** 能耗 kWh(行程口径): 不到 1 kWh 给两位, 否则一位。 */
export function fmtKwhTrip(v: unknown): string {
  const n = Number(v);
  if (v == null || !Number.isFinite(n)) return "—";
  return Math.abs(n) < 1 ? n.toFixed(2) : n.toFixed(1);
}

/** 百分比(摘要里紧贴数字, 不留空格)。 */
export function fmtPct(v: unknown): string {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return Math.round(n) + "%";
}

/** 百分比(一位小数, 用于占比)。 */
export function fmtPct1(v: unknown): number {
  return Math.round(Number(v) * 10) / 10;
}

/** 各种时间(秒/毫秒时间戳、ISO 字符串)→ 毫秒; 解析不出返回 null。 */
export function parseTs(v: unknown): number | null {
  if (v == null || v === "" || v === "unknown" || v === "unavailable") return null;
  if (typeof v === "number") return v > 1e12 ? v : v * 1000;
  const s = String(v);
  if (/^[0-9]+(\.[0-9]+)?$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

/** "3 分钟前" 这类相对时间。 */
export function relTime(v: unknown): string {
  const ms = parseTs(v);
  if (ms == null) return "";
  const d = Date.now() - ms;
  if (!Number.isFinite(d)) return "";
  if (d < 0) return "刚刚";
  const s = Math.round(d / 1000);
  if (s < 60) return "刚刚";
  const m = Math.round(s / 60);
  if (m < 60) return m + " 分钟前";
  const h = Math.round(m / 60);
  if (h < 24) return h + " 小时前";
  return Math.round(h / 24) + " 天前";
}

/** "HH:MM" 形式的时间文案(datetime 字符串/时间戳都能吃)。 */
export function fmtClock(v: unknown): string {
  const ms = parseTs(v);
  if (ms == null) return "";
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

/** 分钟数 → "2h10m" / "42min"(折叠态摘要用)。 */
export function fmtDur(min: unknown): string {
  const m = Number(min);
  if (!Number.isFinite(m) || m <= 0) return "";
  const mi = Math.round(m);
  if (mi < 60) return mi + "min";
  const h = Math.floor(mi / 60);
  const r = mi % 60;
  return h + "h" + (r ? pad2(r) + "m" : "");
}

/** 日期串 → "10月4日"(气泡里用)。 */
export function fmtDayCn(day: unknown): string {
  const p = String(day || "").split("-");
  if (p.length < 3) return String(day || "");
  return parseInt(p[1], 10) + "月" + parseInt(p[2], 10) + "日";
}

/** 日期串 → "10/4"(横轴标签)。 */
export function fmtDayShort(day: unknown): string {
  const p = String(day || "").split("-");
  if (p.length < 3) return String(day || "");
  return parseInt(p[1], 10) + "/" + parseInt(p[2], 10);
}

/** epoch 秒 → "9月21日"。 */
export function fmtDayCnTs(ts: unknown): string {
  const n = Number(ts);
  if (!n) return "";
  const d = new Date(n * 1000);
  return d.getMonth() + 1 + "月" + d.getDate() + "日";
}

/** epoch 秒 → "23:05"(今天)/ "10-04 23:05"(更早)。 */
export function fmtUpdated(ts: unknown): string {
  const n = Number(ts);
  if (!n) return "";
  const d = new Date(n * 1000);
  const hm = pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return hm;
  return d.getMonth() + 1 + "-" + pad2(d.getDate()) + " " + hm;
}

/** 坐标轴刻度取整: 目标 4 段, 步长取 1/2/2.5/5 × 10ⁿ。 */
export function niceAxis(
  maxValue: number,
  targetTicks?: number
): { max: number; step: number; ticks: number[] } {
  const t = Math.max(1, targetTicks || 4);
  let raw = (Number(maxValue) || 0) / t;
  if (!(raw > 0)) raw = 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const m = raw / pow;
  const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 2.5 ? 2.5 : m <= 5 ? 5 : 10;
  const step = s * pow;
  let max = Math.ceil((Number(maxValue) || 0) / step) * step;
  if (!(max > 0)) max = step;
  const ticks: number[] = [];
  for (let v = 0; v <= max + step * 1e-9; v += step) ticks.push(Number(v.toFixed(6)));
  if (ticks.length < 2) ticks.push(Number(max.toFixed(6)));
  return { max, step, ticks };
}

/** 刻度文本。 */
export function fmtTick(v: unknown): string {
  const n = Number(v) || 0;
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : String(Number(n.toFixed(1)));
}
