// 俯视车标的中心就是定位点，地图与驻车缩略图共用。
export function carMarker(): string {
  return '<svg viewBox="0 0 48 48" width="48" height="48" aria-hidden="true"><circle cx="24" cy="24" r="21" fill="var(--primary-color,#03a9f4)" stroke="white" stroke-width="3"/><rect x="15" y="9" width="18" height="30" rx="6" fill="white"/><path d="M18 16h12l-1.5 7h-9zM19 29h10l1 5H18z" fill="var(--primary-color,#03a9f4)"/><path d="M13 18v5m22-5v5M18 12h3m6 0h3" stroke="white" stroke-width="2" stroke-linecap="round"/></svg>';
}
