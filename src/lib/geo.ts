// 地理工具: WGS-84 ↔ GCJ-02 换算、Web 墨卡托投影、高德/OSM 瓦片 URL。
//
// 与 leapmotor-map.js / leapmotor-trips.js 原本各自的实现**同源且逐字等价**
// (map 与 trips 原是两个文件里各存一份完全相同的拷贝; 这里合并成一份)。
// ⚠️ 与 poller/api_client.py 的 _transform_lon 也同源: 改这里要**四处一起改**。
//
// 注意: 经度用 transformLon、纬度用 transformLat —— 是两个**不同**的多项式。
// 历史上曾错误地在经度上复用纬度多项式, 这里保持正确版本。

export const TILE = 256;

const A_GCJ = 6378245.0;
const EE_GCJ = 0.00669342162296594323;

export function outOfChina(lat: number, lon: number): boolean {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

export function transformLat(x: number, y: number): number {
  let r =
    -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r +=
    ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

/** GCJ-02 的**经度**多项式(与 transformLat 是两个不同公式)。 */
export function transformLon(x: number, y: number): number {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r +=
    ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x * Math.PI) / 30.0)) * 2.0) /
    3.0;
  return r;
}

function delta(lat: number, lon: number): [number, number] {
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE_GCJ * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A_GCJ / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [dLat, dLon];
}

/** GCJ-02 → WGS-84(迭代一次压到亚米级)。 */
export function gcj02ToWgs84(lat: number, lon: number): [number, number] {
  if (outOfChina(lat, lon)) return [lat, lon];
  const [dLat, dLon] = delta(lat, lon);
  const wLat = lat - dLat;
  const wLon = lon - dLon;
  const [dLat2, dLon2] = delta(wLat, wLon);
  return [lat - dLat2, lon - dLon2];
}

/** WGS-84 → GCJ-02(国境外原样返回)。 */
export function wgs84ToGcj02(lat: number, lon: number): [number, number] {
  if (outOfChina(lat, lon)) return [lat, lon];
  const [dLat, dLon] = delta(lat, lon);
  return [lat + dLat, lon + dLon];
}

/* 高德瓦片模板。{s} 是 1~4 的负载均衡序号。 */
export const TILE_SOURCES = {
  vector:
    "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  satellite: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
};
/* 高德连不上时回落到 OSM(海外用户/高德故障时至少还能看图) */
export const TILE_FALLBACK = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** 经纬度 → 世界像素坐标(标准 Web 墨卡托, 与高德/OSM 一致)。 */
export function project(lat: number, lon: number, zoom: number): [number, number] {
  const scale = TILE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

export function unproject(x: number, y: number, zoom: number): [number, number] {
  const scale = TILE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lon];
}

/** 两点球面距离(km) —— 用于判断轨迹是否断档。 */
export function haversineKm(a: [number, number], b: [number, number]): number {
  const r = 6371.0088;
  const p1 = (a[0] * Math.PI) / 180;
  const p2 = (b[0] * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((b[1] - a[1]) * Math.PI) / 180;
  const s =
    Math.sin(dp / 2) * Math.sin(dp / 2) + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) * Math.sin(dl / 2);
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** 车速 → 热力图颜色(0~120+ km/h 分段色板)。 */
export function getSpeedColor(speed: unknown, lo: unknown, hi: unknown): string {
  const a = Number.isFinite(Number(lo)) ? Number(lo) : 0;
  const b = Number.isFinite(Number(hi)) && Number(hi) > a ? Number(hi) : 120;
  const t = Math.max(0, Math.min(1, ((Number(speed) || 0) - a) / (b - a)));
  if (t < 0.2) return "#2196f3"; // 蓝
  if (t < 0.45) return "#4caf50"; // 绿
  if (t < 0.7) return "#ffeb3b"; // 黄
  if (t < 0.9) return "#ff9800"; // 橙
  return "#f44336"; // 红
}

/** 按模板拼一个瓦片 URL。 */
export function tileUrl(
  tpl: string,
  z: number,
  x: number,
  y: number
): string {
  const s = ((x + y) % 4) + 1;
  return tpl
    .replace("{s}", String(s))
    .replace("{z}", String(z))
    .replace("{x}", String(x))
    .replace("{y}", String(y));
}

/** 等距抽稀(保留首尾), 给缩略图/叠加模式减负。 */
export function simplify<T>(points: T[], maxN: number): T[] {
  if (!points || points.length <= maxN || maxN < 3) return points || [];
  const step = (points.length - 1) / (maxN - 1);
  const out: T[] = [];
  for (let i = 0; i < maxN; i++) out.push(points[Math.round(i * step)]);
  out[0] = points[0];
  out[out.length - 1] = points[points.length - 1];
  return out;
}
