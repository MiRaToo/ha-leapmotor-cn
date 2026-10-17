// HA 主题工具。
import type { HomeAssistant } from "../types/hass";

/** 当前是否深色主题。 */
export function isDark(hass: HomeAssistant | null | undefined): boolean {
  return !!(hass && hass.themes && hass.themes.darkMode);
}

/** 底图样式归一化(容忍大小写/空格; 未知值回落到路网图)。auto = 随 HA 主题。 */
export function normMapStyle(v: unknown): "auto" | "vector" | "satellite" | "dark" {
  const s = String(v == null ? "" : v)
    .trim()
    .toLowerCase();
  if (s === "auto" || s === "自动") return "auto";
  if (s === "satellite" || s === "sat" || s === "卫星") return "satellite";
  if (s === "dark" || s === "深色" || s === "night" || s === "暗黑") return "dark";
  return "vector";
}

/** 实际生效的底图: auto → HA 深色主题时用深色, 否则路网。 */
export function effMapStyle(
  style: string | undefined,
  hass: HomeAssistant | null | undefined
): "vector" | "satellite" | "dark" {
  const s = style || "auto";
  if (s !== "auto") return s as "vector" | "satellite" | "dark";
  return isDark(hass) ? "dark" : "vector";
}
