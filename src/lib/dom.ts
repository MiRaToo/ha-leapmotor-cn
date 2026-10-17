// 通用小工具: HTML 转义、数值钳制、补零。
// 与原实现逐字等价(esc 的转义顺序/字符集必须一致, 否则渲染结果会变)。

/** HTML 转义。文本绑定在 lit 里会自动转义, 但命令式拼 SVG/属性时仍需它。 */
export function esc(s: unknown): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** 两位补零。 */
export function pad2(n: number): string {
  return (n < 10 ? "0" : "") + n;
}

/** 把 v 夹到 [lo, hi]。 */
export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 数值判断: 有限数才认。 */
