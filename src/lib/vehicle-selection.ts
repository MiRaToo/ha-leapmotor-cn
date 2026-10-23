import type { HomeAssistant, LovelaceCardConfig } from "../types/hass";

export interface VehicleOption {
  entry_id: string;
  vin: string;
  name: string;
  car_type?: string;
  ownership?: "owner" | "shared" | "unknown";
  device_id?: string;
  tracker_entity_id?: string;
  available: boolean;
}

export interface VehicleSelectionState {
  vehicles: VehicleOption[];
  entryId: string;
  required: boolean;
  locked: boolean;
}

function explicitSelector(config: LovelaceCardConfig | null | undefined): Record<string, string> {
  const c = (config || {}) as Record<string, unknown>;
  for (const key of ["entry_id", "vin", "device_id", "entity_id", "entity"]) {
    const value = String(c[key] || "").trim();
    if (!value) continue;
    const normalized = key === "entity" ? (value.includes(".") ? "entity_id" : "device_id") : key;
    return { [normalized]: value };
  }
  const device = String(c.device || "").trim();
  if (device) {
    if (/^[A-HJ-NPR-Z0-9]{17}$/i.test(device)) return { vin: device };
    return device.includes(".") ? { entity_id: device } : { device_id: device };
  }
  return {};
}

function storageKey(
  card: string,
  config: LovelaceCardConfig | null | undefined,
  element?: HTMLElement,
): string {
  const c = (config || {}) as Record<string, unknown>;
  let identity = String(c.instance_id || c.id || "").trim();
  if (!identity) {
    const siblings = element && typeof document !== "undefined"
      ? Array.from(document.querySelectorAll(element.localName))
      : [];
    const index = element ? Math.max(0, siblings.indexOf(element)) : 0;
    const page = typeof location === "undefined" ? "" : `${location.pathname}${location.search}`;
    identity = `${page}#${index}`;
  }
  return `leapmotor.vehicle.${card}.${identity}`;
}

export async function loadVehicleSelection(
  hass: HomeAssistant | null,
  card: string,
  config: LovelaceCardConfig | null | undefined,
  element?: HTMLElement,
): Promise<VehicleSelectionState> {
  let vehicles: VehicleOption[] = [];
  try {
    if (hass?.callWS) {
      const result = await hass.callWS<{ vehicles?: VehicleOption[] }>({ type: "leapmotor/vehicles/list" });
      vehicles = Array.isArray(result?.vehicles) ? result.vehicles : [];
    }
  } catch {
    // Older integration versions have no vehicle-list command; their one-car
    // cards keep using the existing implicit selector behavior.
  }
  const explicit = explicitSelector(config);
  const configuredEntry = explicit.entry_id || (explicit.vin
    ? vehicles.find((item) => item.vin.toUpperCase() === explicit.vin!.toUpperCase())?.entry_id || ""
    : "");
  if (Object.keys(explicit).length) {
    return { vehicles, entryId: configuredEntry, required: false, locked: true };
  }
  let saved = "";
  try { saved = window.localStorage.getItem(storageKey(card, config, element)) || ""; } catch { /* unavailable */ }
  const available = vehicles.filter((item) => item.available);
  const entryId = (saved && available.some((item) => item.entry_id === saved) ? saved
    : vehicles.length === 1 && available.length === 1 ? available[0].entry_id : "");
  return { vehicles, entryId, required: vehicles.length > 1 && !entryId, locked: false };
}

export function vehicleRequest(
  config: LovelaceCardConfig | null | undefined,
  entryId: string,
): Record<string, string> {
  const explicit = explicitSelector(config);
  return Object.keys(explicit).length ? explicit : entryId ? { entry_id: entryId } : {};
}

export function saveVehicleSelection(
  card: string,
  config: LovelaceCardConfig | null | undefined,
  entryId: string,
  element?: HTMLElement,
): void {
  try {
    const key = storageKey(card, config, element);
    if (entryId) window.localStorage.setItem(key, entryId);
    else window.localStorage.removeItem(key);
  } catch { /* unavailable */ }
}

function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c] || c));
}

export function vehiclePickerHtml(
  vehicles: VehicleOption[],
  entryId: string,
  required: boolean,
  locked = false,
): string {
  if (locked || vehicles.length < 2) return "";
  const options = vehicles.map((item) => `<option value="${escapeHtml(item.entry_id)}"${
    item.entry_id === entryId ? " selected" : ""}${item.available ? "" : " disabled"}>${
    escapeHtml(item.name || `${item.car_type || "零跑"} · ${item.vin.slice(-6)}`)}${
    item.ownership === "shared" ? " · 共享" : item.ownership === "owner" ? " · 自有" : ""}${
    item.available ? "" : "（未加载）"}</option>`).join("");
  return `<label class="lmVehiclePicker${required ? " required" : ""}"><span>车辆</span><select data-lm-vehicle-picker aria-label="选择车辆"><option value=""${entryId ? "" : " selected"}>${required ? "请选择车辆" : "切换车辆"}</option>${options}</select></label>`;
}

export function bindVehiclePicker(
  root: ParentNode,
  callback: (entryId: string) => void,
): void {
  root.querySelector<HTMLSelectElement>("[data-lm-vehicle-picker]")?.addEventListener("change", (event) => {
    callback((event.currentTarget as HTMLSelectElement).value);
  });
}

export const VEHICLE_PICKER_CSS = `
  .lmVehiclePicker{display:inline-flex;align-items:center;gap:7px;color:var(--secondary-text-color,#667085);font-size:12px;min-width:0}
  .lmVehiclePicker select{max-width:210px;min-width:120px;border:1px solid var(--divider-color,rgba(120,130,145,.24));border-radius:10px;padding:6px 9px;background:var(--card-background-color,rgba(255,255,255,.72));color:var(--primary-text-color,inherit);font:inherit}
  .lmVehiclePicker.required select{border-color:var(--primary-color,#03a9f4)}
  @media(max-width:520px){.lmVehiclePicker{max-width:100%}.lmVehiclePicker select{max-width:145px;min-width:90px}}
`;
