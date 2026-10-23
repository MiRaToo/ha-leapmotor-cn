// 自定义车辆数据卡：复用行程统计与本车 HA 实体，可长按管理并拖动排序。
import { LitElement, css, html, nothing, unsafeCSS, type TemplateResult } from "lit";
import { property } from "lit/decorators.js";
import { live } from "lit/directives/live.js";
import type { HomeAssistant, HassEntity, LovelaceCardConfig } from "../types/hass";
import { defineCard, registerCustomCard, banner } from "../lib/register";
import { CARD_VERSIONS } from "../lib/version";
import { isDark } from "../lib/theme";
import { bindAppearance, unbindAppearance } from "../lib/appearance";
import { uiStyles } from "../lib/ui/styles";
import { loadVehicleSelection, saveVehicleSelection, vehicleRequest, type VehicleOption } from "../lib/vehicle-selection";

const VERSION = CARD_VERSIONS.metrics;
const PREF = "leapmotor.custom-card.v3.";
const LEGACY_PREF = "leapmotor.custom-card.v2.";

interface MetricDef {
  id: string;
  label: string;
  unit: string;
  precision: number;
  icon: string;
  sources?: string[][];
  format?: "text";
  tripStat?: { window: "today" | "days7" | "days30"; field: "km" | "kwh" | "kwh_per_100km" | "count" };
  dailyField?: "km" | "kwh" | "eff" | "ac";
  calculate?: (values: number[]) => number | null;
  entityId?: string;
}

const tripMetric = (
  id: string,
  label: string,
  window: "today" | "days7" | "days30",
  field: "km" | "kwh" | "kwh_per_100km" | "count",
  unit: string,
  icon: string,
  precision = 0,
): MetricDef => ({ id, label, unit, precision, icon, tripStat: { window, field } });

const METRICS: MetricDef[] = [
  tripMetric("mileage_7d", "近7天里程", "days7", "km", "km", "mdi:map-marker-distance", 1),
  tripMetric("avg_energy_7d", "近7天平均能耗", "days7", "kwh_per_100km", "kWh/100km", "mdi:lightning-bolt", 1),
  tripMetric("energy_7d", "近7天耗电", "days7", "kwh", "kWh", "mdi:flash", 1),
  tripMetric("trips_7d", "近7天行程", "days7", "count", "段", "mdi:map-marker-path"),
  tripMetric("mileage_today", "今日里程", "today", "km", "km", "mdi:map-marker-distance", 1),
  tripMetric("avg_energy_today", "今日平均能耗", "today", "kwh_per_100km", "kWh/100km", "mdi:lightning-bolt", 1),
  tripMetric("energy_today", "今日耗电", "today", "kwh", "kWh", "mdi:flash", 1),
  tripMetric("trips_today", "今日行程", "today", "count", "段", "mdi:map-marker-path"),
  { id: "ac_energy_today", label: "今日空调能耗", unit: "kWh", precision: 2, icon: "mdi:air-conditioner", dailyField: "ac" },
  tripMetric("mileage_30d", "近30天里程", "days30", "km", "km", "mdi:map-marker-distance", 1),
  tripMetric("avg_energy_30d", "近30天平均能耗", "days30", "kwh_per_100km", "kWh/100km", "mdi:lightning-bolt", 1),
  tripMetric("energy_30d", "近30天耗电", "days30", "kwh", "kWh", "mdi:flash", 1),
  tripMetric("trips_30d", "近30天行程", "days30", "count", "段", "mdi:map-marker-path"),
  { id: "range", label: "剩余续航", unit: "km", precision: 0, icon: "mdi:map-marker-distance", sources: [["xu_hang", "range"]] },
  { id: "total_range", label: "油电总续航", unit: "km", precision: 0, icon: "mdi:map-marker-path", sources: [["you_dian_zong_xu_hang", "total_range"]] },
  { id: "hundred_km_ec", label: "最近百公里能耗", unit: "kWh/100km", precision: 1, icon: "mdi:lightning-bolt", sources: [["bai_gong_li_neng_hao", "hundred_km_ec"]] },
  { id: "fuel_consumption", label: "平均油耗", unit: "L/100km", precision: 1, icon: "mdi:gas-station", sources: [["you_hao", "fuel_consumption"]] },
  { id: "energy_rank", label: "能耗排名", unit: "", precision: 0, icon: "mdi:podium", sources: [["neng_hao_pai_ming", "energy_rank"]] },
  { id: "total_mileage", label: "累计里程", unit: "km", precision: 0, icon: "mdi:counter", sources: [["zong_li_cheng", "total_mileage"]] },
  { id: "battery", label: "电池电量", unit: "%", precision: 0, icon: "mdi:battery", sources: [["dian_liang", "battery"]] },
  { id: "interior_temp", label: "车内温度", unit: "°C", precision: 1, icon: "mdi:thermometer", sources: [["che_nei_wen_du", "interior_temp"]] },
  { id: "charging_state", label: "充电状态", unit: "", precision: 0, icon: "mdi:ev-station", format: "text", sources: [["chong_dian_zhuang_tai", "charging_state"]] },
  { id: "vehicle_state", label: "车辆状态", unit: "", precision: 0, icon: "mdi:car", format: "text", sources: [["che_liang_zhuang_tai", "vehicle_state"]] },
  { id: "tire_fl", label: "左前胎压", unit: "bar", precision: 1, icon: "mdi:car-tire-alert", sources: [["tai_ya_zuo_qian", "tire_fl"]] },
  { id: "tire_fr", label: "右前胎压", unit: "bar", precision: 1, icon: "mdi:car-tire-alert", sources: [["tai_ya_you_qian", "tire_fr"]] },
  { id: "tire_rl", label: "左后胎压", unit: "bar", precision: 1, icon: "mdi:car-tire-alert", sources: [["tai_ya_zuo_hou", "tire_rl"]] },
  { id: "tire_rr", label: "右后胎压", unit: "bar", precision: 1, icon: "mdi:car-tire-alert", sources: [["tai_ya_you_hou", "tire_rr"]] },
  { id: "fuel_level", label: "剩余燃油", unit: "%", precision: 0, icon: "mdi:gas-station", sources: [["sheng_yu_ran_you", "fuel_level"]] },
  { id: "fuel_range", label: "燃油续航", unit: "km", precision: 0, icon: "mdi:gas-station", sources: [["ran_you_xu_hang", "fuel_range"]] },
  { id: "delivery_days", label: "交付天数", unit: "天", precision: 0, icon: "mdi:calendar-check", sources: [["jiao_fu_tian_shu", "delivery_days"]] },
];
const DEFAULTS = ["mileage_7d", "avg_energy_7d", "range", "battery", "mileage_today", "vehicle_state"];
const LEGACY_DEFAULTS = ["mileage_7d", "avg_energy_7d", "range"];
const DOMAINS = new Set(["sensor", "binary_sensor", "switch", "input_boolean", "number", "select", "lock", "cover", "climate", "button", "device_tracker", "light", "fan"]);

function numeric(state?: HassEntity): number | null {
  if (!state || state.state === "unknown" || state.state === "unavailable" || state.state === "") return null;
  const n = Number(state.state);
  return Number.isFinite(n) ? n : null;
}

interface MetricsCardHost extends HTMLElement { _config?: LovelaceCardConfig | null; }

/** 跨 shadow root 按 Lovelace 中的显示顺序收集卡片，为旧 YAML 卡片提供稳定的独立偏好槽。 */
function metricCardsInDocument(): MetricsCardHost[] {
  const cards: MetricsCardHost[] = [];
  const visit = (node: Node): void => {
    const ElementCtor = (globalThis as any).Element || (globalThis as any).window?.Element;
    if (ElementCtor && node instanceof ElementCtor) {
      const element = node as Element;
      if (element.localName === "leapmotor-metrics") cards.push(element as MetricsCardHost);
      if (element.shadowRoot) visit(element.shadowRoot);
    }
    for (const child of Array.from(node.childNodes)) visit(child);
  };
  if (typeof document !== "undefined") visit(document);
  return cards;
}

function shortHash(value: string): string {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) hash = Math.imul(hash ^ value.charCodeAt(i), 16777619);
  return (hash >>> 0).toString(36);
}

function configIdentity(config?: LovelaceCardConfig | null): string {
  return String(config?.instance_id || config?.id || "").trim();
}

class LeapmotorMetricsCard extends LitElement {
  static styles = css`${unsafeCSS(uiStyles)}
    :host{display:block;color:var(--primary-text-color,#222);font:inherit;}
    *{box-sizing:border-box}
    .card{position:relative;padding:12px;border-radius:var(--ha-card-border-radius,12px);background:var(--lm-surface-section,var(--ha-card-background,var(--card-background-color,#fff)));box-shadow:var(--lm-shadow-card,0 5px 18px #0002);}
    button{font:inherit;color:inherit;cursor:pointer;}
    .remove,.add,.done{display:grid;place-items:center;border:0;color:inherit;background:var(--lm-surface-control,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-control,0 1px 5px #0002);}
    .editingBar{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin:0 0 8px;color:var(--secondary-text-color,#6b7280);font-size:10px;}
    .vehicleBar{display:flex;align-items:center;gap:7px;margin:0 0 8px;color:var(--secondary-text-color,#6b7280);font-size:11px;}
    .vehicleBar select{max-width:240px;min-width:130px;border:1px solid var(--divider-color,rgba(120,130,145,.24));border-radius:10px;padding:6px 9px;background:var(--lm-surface-control,var(--card-background-color,#fff));color:var(--primary-text-color,inherit);font:inherit;}
    .vehicleHint{margin:0 0 8px;color:var(--secondary-text-color,#6b7280);font-size:11px;}
    .editingBar span{margin-right:auto;}
    .done{min-height:28px;padding:4px 10px;border-radius:999px;background:var(--lm-accent,var(--primary-color,#03a9f4));color:var(--text-primary-color,#fff);}
    .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}
    .tile{position:relative;display:flex;min-width:0;min-height:88px;flex-direction:column;justify-content:center;gap:3px;padding:9px;border:1px solid transparent;border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-control,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-section,0 1px 5px #0002);touch-action:pan-y;user-select:none;}
    .tile.editable{cursor:grab;border-color:var(--lm-border-color,var(--divider-color,#8886));}
    .tile.editable{touch-action:none;}
    .tile.dragging{opacity:.65;transform:scale(.97);}
    .tile.dropTarget{outline:2px solid var(--lm-accent,var(--primary-color,#03a9f4));outline-offset:1px;}
    .tileHead{display:flex;min-width:0;align-items:center;gap:5px;}
    .tileIcon{--mdc-icon-size:15px;flex:none;color:var(--lm-accent,var(--primary-color,#03a9f4));}
    .label{display:block;min-width:0;overflow:hidden;color:var(--secondary-text-color,#6b7280);font-size:11px;line-height:1.25;text-overflow:ellipsis;white-space:nowrap;}
    .value{display:block;min-width:0;overflow:hidden;font-size:clamp(15px,4.6vw,21px);font-weight:700;letter-spacing:-.03em;text-overflow:ellipsis;white-space:nowrap;}
    .unit{display:block;min-height:13px;color:var(--secondary-text-color,#6b7280);font-size:10px;line-height:1.25;overflow-wrap:anywhere;}
    .remove{position:absolute;top:4px;right:4px;width:19px;height:19px;padding:0;border-radius:50%;background:var(--error-color,#c83d45);color:#fff;box-shadow:var(--lm-shadow-control,0 1px 4px #0002);}
    .remove ha-icon{--mdc-icon-size:13px;}
    .dragHandle{position:absolute;right:5px;bottom:5px;color:var(--secondary-text-color,#6b7280);opacity:.7;--mdc-icon-size:14px;}
    .add{min-height:88px;border:1px dashed var(--lm-border-color,var(--divider-color,#8886));border-radius:var(--lm-radius-section,14px);background:var(--lm-surface-inset,var(--secondary-background-color,#eef1f5));box-shadow:none;color:var(--secondary-text-color,#6b7280);}
    .add ha-icon{--mdc-icon-size:27px;}
    .empty{grid-column:1/-1;padding:12px;text-align:center;color:var(--secondary-text-color,#6b7280);font-size:11px;}
    .backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;padding:16px;background:var(--lm-mask,#0007);}
    .picker{display:flex;width:min(480px,100%);max-height:min(82dvh,650px);flex-direction:column;overflow:hidden;border-radius:var(--lm-radius-overlay,20px);border:var(--lm-floating-border,1px solid var(--divider-color,#0002));background:var(--lm-surface-floating,var(--card-background-color,#fff));box-shadow:var(--lm-shadow-dialog,0 18px 48px #0004);}
    .pickerHead{display:flex;align-items:center;gap:10px;padding:15px 16px 11px;}
    .pickerHead strong{font-size:14px;}.pickerHead button{margin-left:auto;width:30px;height:30px;border:0;border-radius:50%;background:var(--lm-surface-control,var(--card-background-color,#fff));font-size:20px;}
    .pickerHint{margin:0;padding:0 16px 10px;color:var(--secondary-text-color,#6b7280);font-size:11px;}
    .search{margin:0 16px 10px;padding:10px 12px;border:var(--lm-field-border,1px solid var(--divider-color,#0002));border-radius:var(--lm-radius-control,10px);background:var(--lm-surface-inset,var(--secondary-background-color,#eef1f5));color:inherit;font:inherit;}
    .options{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;overflow:auto;padding:2px 16px 16px;overscroll-behavior:contain;}
    .option{display:flex;min-width:0;min-height:62px;align-items:center;gap:9px;padding:9px 10px;border:var(--lm-field-border,1px solid var(--divider-color,#0002));border-radius:var(--lm-radius-control,11px);background:var(--lm-surface-control,var(--card-background-color,#fff));text-align:left;}
    .option:disabled{opacity:.42;cursor:default;}.optionIcon{display:grid;width:29px;height:29px;flex:none;place-items:center;border-radius:9px;background:var(--lm-surface-inset,var(--secondary-background-color,#eee));color:var(--lm-accent,var(--primary-color,#03a9f4));}.optionIcon ha-icon{--mdc-icon-size:17px;}.optionText{display:grid;flex:1;min-width:0;gap:3px;align-content:center;}.optionText b{display:block;min-width:0;overflow:hidden;font-size:12px;line-height:1.3;text-overflow:ellipsis;white-space:nowrap;}.optionText small{display:block;min-width:0;overflow-wrap:anywhere;color:var(--lm-text-secondary,var(--secondary-text-color,#6b7280));font-size:11px;line-height:1.35;opacity:1;}.noOptions{grid-column:1/-1;padding:18px 6px;text-align:center;color:var(--secondary-text-color,#6b7280);font-size:11px;}
    @media(max-width:330px){.grid{gap:5px}.tile,.add{min-height:82px;padding:6px}.options{grid-template-columns:1fr}}
  `;

  private _config: LovelaceCardConfig = { type: "custom:leapmotor-metrics" };
  private _hass: HomeAssistant | null = null;
  private _selected: string[] = [...DEFAULTS];
  private _editing = false;
  private _picker = false;
  private _query = "";
  private _prefKey = "";
  private _prefIdentity = "";
  private _tripStats: Record<string, any> | null = null;
  private _todayEnergy: Record<string, any> | null = null;
  private _tripStatsLoading = false;
  private _tripStatsAttemptAt = 0;
  private _todayEnergyLoading = false;
  private _todayEnergyAttemptAt = 0;
  private _registryEntityIds: Set<string> | null = null;
  private _registryVin = "";
  private _registryLoading = false;
  private _registryAttemptAt = 0;
  private _vehicleOptions: VehicleOption[] = [];
  private _vehicleEntryId = "";
  private _vehicleRequired = false;
  private _vehicleLocked = false;
  private _vehicleInitStarted = false;
  private _selectionGeneration = 0;
  private _pointerId: number | null = null;
  private _pointerOrigin: { x: number; y: number } | null = null;
  private _activeTileId = "";
  private _dropTargetId = "";
  private _dragActive = false;
  private _pressTimer: ReturnType<typeof setTimeout> | null = null;

  @property({ attribute: false })
  set hass(value: HomeAssistant | null) {
    this._hass = value;
    this.requestUpdate();
    if (!this._vehicleInitStarted) {
      this._vehicleInitStarted = true;
      void this._initVehicleSelection();
      return;
    }
    if (this._vehicleRequired) return;
    this._maybeLoadRegistry();
    this._maybeLoadTripStats();
    this._maybeLoadTodayEnergy();
  }
  get hass(): HomeAssistant | null { return this._hass; }

  setConfig(config: LovelaceCardConfig): void {
    if (!config || config.type !== "custom:leapmotor-metrics") throw new Error("需要 custom:leapmotor-metrics 配置");
    this._config = config;
    this._vehicleInitStarted = false;
    this._vehicleOptions = [];
    this._vehicleEntryId = "";
    this._vehicleRequired = false;
    this._vehicleLocked = false;
    this._selectionGeneration++;
    this._prefIdentity = "";
    if (this.isConnected) this._loadPreferences();
    this._tripStats = null;
    this._todayEnergy = null;
    this._tripStatsAttemptAt = 0;
    this._todayEnergyAttemptAt = 0;
    this._registryEntityIds = null;
    this._registryVin = "";
    this._registryAttemptAt = 0;
    if (this._hass) {
      this._vehicleInitStarted = true;
      void this._initVehicleSelection();
    }
  }

  connectedCallback(): void {
    super.connectedCallback();
    this._loadPreferences();
    bindAppearance(this, { getDark: () => isDark(this._hass), onChange: () => this.requestUpdate() });
  }
  disconnectedCallback(): void { unbindAppearance(this); super.disconnectedCallback(); }

  private _isValidSelection(value: unknown): value is string {
    return typeof value === "string" && (METRICS.some(m => m.id === value) || /^entity:[a-z_]+\.[a-z0-9_-]+$/i.test(value));
  }

  static getStubConfig(): LovelaceCardConfig {
    const instance = `card-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    return { type: "custom:leapmotor-metrics", instance_id: instance };
  }

  private _loadPreferences(): void {
    const selectedVehicle = this._vehicleOptions.find(item => item.entry_id === this._vehicleEntryId);
    const selectionKey = this._vehicleOptions.length > 1 ? (selectedVehicle?.device_id || selectedVehicle?.vin) : "";
    const device = String(this._config.device || selectionKey || "default")
      .toLowerCase().replace(/[^a-z0-9_-]/g, "_");
    const explicit = configIdentity(this._config);
    const cards = metricCardsInDocument();
    let identity: string;
    let legacySlot = false;
    if (explicit) {
      const duplicates = cards.filter(card => configIdentity(card._config) === explicit);
      const duplicateIndex = Math.max(0, duplicates.indexOf(this as unknown as MetricsCardHost));
      identity = `id-${shortHash(explicit)}${duplicateIndex ? `-copy-${duplicateIndex + 1}` : ""}`;
    } else {
      legacySlot = true;
      const legacyCards = cards.filter(card => !configIdentity(card._config));
      const position = Math.max(0, legacyCards.indexOf(this as unknown as MetricsCardHost));
      const page = typeof location === "undefined" ? "" : `${location.pathname}${location.search}`;
      identity = `legacy-${shortHash(page)}-${position}`;
    }
    const nextIdentity = `${device}.${identity}`;
    if (nextIdentity === this._prefIdentity) return;
    this._prefIdentity = nextIdentity;
    this._prefKey = PREF + nextIdentity;
    try {
      let saved = JSON.parse(localStorage.getItem(this._prefKey) || "null");
      if (!Array.isArray(saved) && legacySlot) {
        // 旧版按车辆共用一把键。为每张旧卡各复制一次，保住升级前的内容，再独立保存。
        const sharedV2 = JSON.parse(localStorage.getItem(LEGACY_PREF + device) || "null");
        const sharedV1 = JSON.parse(localStorage.getItem("leapmotor.metrics.v1." + device) || "null");
        saved = Array.isArray(sharedV2) ? sharedV2 : Array.isArray(sharedV1)
          ? JSON.stringify(sharedV1) === JSON.stringify(LEGACY_DEFAULTS) ? DEFAULTS : sharedV1
          : DEFAULTS;
      }
      this._selected = Array.isArray(saved)
        ? saved.filter((id: unknown): id is string => this._isValidSelection(id))
        : [...DEFAULTS];
    } catch { this._selected = [...DEFAULTS]; }
    this.requestUpdate();
  }

  private async _initVehicleSelection(): Promise<void> {
    const generation = this._selectionGeneration;
    const state = await loadVehicleSelection(this._hass, "metrics", this._config, this);
    if (generation !== this._selectionGeneration) return;
    this._vehicleOptions = state.vehicles;
    this._vehicleEntryId = state.entryId;
    this._vehicleRequired = state.required;
    this._vehicleLocked = state.locked;
    this._selectionGeneration++;
    this._registryEntityIds = null;
    this._registryVin = "";
    this._registryAttemptAt = 0;
    this._tripStats = null;
    this._todayEnergy = null;
    this._tripStatsAttemptAt = 0;
    this._todayEnergyAttemptAt = 0;
    this._loadPreferences();
    this.requestUpdate();
    if (!this._vehicleRequired) {
      this._maybeLoadRegistry();
      this._maybeLoadTripStats();
      this._maybeLoadTodayEnergy();
    }
  }

  private _onVehicleChange(entryId: string): void {
    if (this._vehicleLocked) return;
    this._vehicleEntryId = entryId;
    this._vehicleRequired = this._vehicleOptions.length > 1 && !entryId;
    saveVehicleSelection("metrics", this._config, entryId, this);
    this._selectionGeneration++;
    this._registryEntityIds = null;
    this._registryVin = "";
    this._registryLoading = false;
    this._registryAttemptAt = 0;
    this._tripStats = null;
    this._tripStatsLoading = false;
    this._tripStatsAttemptAt = 0;
    this._todayEnergy = null;
    this._todayEnergyLoading = false;
    this._todayEnergyAttemptAt = 0;
    this._loadPreferences();
    this.requestUpdate();
    if (!this._vehicleRequired) {
      this._maybeLoadRegistry();
      this._maybeLoadTripStats();
      this._maybeLoadTodayEnergy();
    }
  }

  private _vehicleSelector(): Record<string, string> {
    return vehicleRequest(this._config, this._vehicleEntryId);
  }

  private _selectedVehicle(): VehicleOption | undefined {
    const config = this._config as Record<string, unknown>;
    const explicitVin = String(config.vin || "").toUpperCase();
    const explicitEntry = String(config.entry_id || this._vehicleEntryId || "");
    const explicitDevice = String(config.device_id || "");
    const legacyDevice = String(config.device || "");
    const explicitEntity = String(config.entity_id || "");
    return this._vehicleOptions.find(item => item.entry_id === explicitEntry ||
      (explicitVin && item.vin.toUpperCase() === explicitVin) ||
      (explicitDevice && item.device_id === explicitDevice) ||
      (legacyDevice && (item.device_id === legacyDevice || item.tracker_entity_id === legacyDevice)) ||
      (explicitEntity && item.tracker_entity_id === explicitEntity));
  }

  private _maybeLoadRegistry(): void {
    const hass = this._hass;
    if (!hass?.callWS || this._vehicleRequired || this._registryLoading ||
        (!this._config.device && !this._config.entity_id && !this._selectedVehicle() && !this._vehicleEntryId) ||
        Date.now() - this._registryAttemptAt < 300_000) return;
    this._registryAttemptAt = Date.now();
    this._registryLoading = true;
    void this._loadRegistry(hass, this._selectionGeneration);
  }

  private async _loadRegistry(hass: HomeAssistant, generation: number): Promise<void> {
    try {
      const callWS = hass.callWS?.bind(hass);
      if (!callWS) return;
      const entries = await callWS<any[]>({ type: "config/entity_registry/list" });
      if (!Array.isArray(entries)) return;
      const device = String(this._config.device || this._config.entity_id || "");
      const selected = entries.find((entry: any) => entry.entity_id === device);
      const vehicle = this._selectedVehicle();
      let deviceId = String(vehicle?.device_id || selected?.device_id || (!device.includes(".") ? device : ""));
      let vin = String(this._config.vin || vehicle?.vin || this._registryVin || "");
      if (!vin && /^[A-HJ-NPR-Z0-9]{17}$/i.test(device)) vin = device;
      const uniqueId = String(selected?.unique_id || "");
      if (!vin) vin = uniqueId.match(/^([^_]+)_[^_]+$/)?.[1] || "";
      if (deviceId) {
        try {
          const devices = await callWS<any[]>({ type: "config/device_registry/list" });
          const found = Array.isArray(devices) ? devices.find((item: any) => item.id === deviceId) : null;
          const identifiers = Array.isArray(found?.identifiers) ? found.identifiers : [];
          const leapmotor = identifiers.find((pair: any) => Array.isArray(pair) && pair[0] === "leapmotor");
          if (!vin && leapmotor?.[1]) vin = String(leapmotor[1]);
        } catch { /* 普通用户或旧版 HA 不允许读设备注册表时, 退回实体前缀 */ }
      }
      const owned = entries.filter((entry: any) => (deviceId && entry.device_id === deviceId) ||
        (vin && String(entry.unique_id || "").startsWith(vin + "_")));
      if (generation === this._selectionGeneration && this._hass === hass) {
        if (owned.length) this._registryEntityIds = new Set(owned.map((entry: any) => String(entry.entity_id)));
        if (vin) this._registryVin = vin;
      }
    } catch { /* 注册表不可读时仍可按实体名前缀显示本车状态 */ }
    finally {
      if (generation === this._selectionGeneration) {
        this._registryLoading = false;
        this.requestUpdate();
        this._maybeLoadTripStats();
        this._maybeLoadTodayEnergy();
      }
    }
  }

  private _maybeLoadTripStats(): void {
    const hass = this._hass;
    if (!hass?.callWS || this._vehicleRequired || this._tripStatsLoading ||
        ((this._config.device || this._vehicleEntryId) && this._registryLoading) ||
        Date.now() - this._tripStatsAttemptAt < 300_000) return;
    this._tripStatsAttemptAt = Date.now();
    this._tripStatsLoading = true;
    void this._loadTripStats(hass, this._selectionGeneration);
  }

  private async _loadTripStats(hass: HomeAssistant, generation: number): Promise<void> {
    try {
      const callWS = hass.callWS?.bind(hass);
      if (!callWS) return;
      const result = await callWS<any>({ type: "leapmotor/trips/list", limit: 1, ...this._vehicleSelector() });
      const expectedVin = this._config.vin || this._selectedVehicle()?.vin || this._registryVin;
      if (generation === this._selectionGeneration && this._hass === hass &&
          (!expectedVin || !result?.vin || String(result.vin).toUpperCase() === String(expectedVin).toUpperCase())) {
        this._tripStats = result?.stats || null;
      }
    } catch { /* 没有行程命令的旧版集成仍能展示可用实体 */ }
    finally { if (generation === this._selectionGeneration) { this._tripStatsLoading = false; this.requestUpdate(); } }
  }

  private _needsTodayEnergy(): boolean {
    return this._picker || this._selected.some(id => id === "ac_energy_today" ||
      id === "mileage_today" || id === "avg_energy_today" || id === "energy_today");
  }

  private _maybeLoadTodayEnergy(): void {
    const hass = this._hass;
    if (!this._needsTodayEnergy() || !hass?.callWS || this._todayEnergyLoading ||
        this._vehicleRequired || ((this._config.device || this._vehicleEntryId) && this._registryLoading) ||
        Date.now() - this._todayEnergyAttemptAt < 300_000) return;
    this._todayEnergyAttemptAt = Date.now();
    this._todayEnergyLoading = true;
    void this._loadTodayEnergy(hass, this._selectionGeneration);
  }

  private async _loadTodayEnergy(hass: HomeAssistant, generation: number): Promise<void> {
    try {
      const callWS = hass.callWS?.bind(hass);
      if (!callWS) return;
      const result = await callWS<any>({ type: "leapmotor/energy/daily", days: 1, ...this._vehicleSelector() });
      const expectedVin = this._config.vin || this._selectedVehicle()?.vin || this._registryVin;
      if (generation === this._selectionGeneration && this._hass === hass &&
          (!expectedVin || !result?.vin || String(result.vin).toUpperCase() === String(expectedVin).toUpperCase())) {
        this._todayEnergy = Array.isArray(result?.days) ? result.days[0] || null : null;
      }
    } catch { /* 行程统计或 HA 实体仍可作为回退数据源 */ }
    finally { if (generation === this._selectionGeneration) { this._todayEnergyLoading = false; this.requestUpdate(); } }
  }

  private _sensorPrefix(): string {
    const states = this._hass?.states || {};
    if (this._vehicleRequired) return "";
    if (this._vehicleOptions.length === 1 && !this._vehicleEntryId && !this._vehicleOptions[0].available) return "";
    const device = String(this._config.device || this._config.entity_id || "");
    const configured = device.includes(".") ? device : String(
      this._selectedVehicle()?.vin || this._config.vin || device);
    const ids = this._registryEntityIds ? [...this._registryEntityIds] : Object.keys(states);
    let chosen = configured && states[configured] ? configured : "";
    if (!chosen && configured.includes(".")) {
      const objectId = configured.slice(configured.indexOf(".") + 1);
      const prefix = objectId.replace(/_(?:jin_7tian_li_cheng|mileage_7d|dian_liang|battery|xu_hang|range)$/i, "_");
      if (prefix !== objectId) return configured.slice(0, configured.indexOf(".")) + "." + prefix;
    }
    if (!chosen && configured) chosen = ids.find(id => {
      const dot = id.indexOf(".");
      const objectId = dot >= 0 ? id.slice(dot + 1) : id;
      return objectId.startsWith(configured + "_") || id.endsWith("_" + configured);
    }) || "";
    if (!chosen && this._vehicleOptions.length > 1) return "";
    if (!chosen) chosen = ids.find(id => id.startsWith("sensor.") && (id.endsWith("_dian_liang") || id.endsWith("_battery"))) || "";
    if (!chosen) return "";
    const suffix = chosen.match(/^(.*)_(?:jin_7tian_li_cheng|mileage_7d|dian_liang|battery|xu_hang|range)$/i);
    if (suffix) return suffix[1] + "_";
    const dot = chosen.indexOf(".");
    const last = chosen.lastIndexOf("_");
    return dot >= 0 && last > dot ? chosen.slice(0, last + 1) : "";
  }

  private _stateFor(source: string): HassEntity | undefined {
    const states = this._hass?.states || {};
    const prefix = this._sensorPrefix();
    const candidates = Object.keys(states).filter(id => id.startsWith("sensor.") && (id.endsWith("_" + source) || id === "sensor." + source));
    const match = prefix ? candidates.find(id => id.startsWith(prefix)) : candidates.length === 1 ? candidates[0] : undefined;
    return match ? states[match] : undefined;
  }

  private _sourceState(aliases: string[]): HassEntity | undefined {
    for (const alias of aliases) { const state = this._stateFor(alias); if (state) return state; }
    return undefined;
  }

  private _entityStates(): HassEntity[] {
    const states = this._hass?.states || {};
    const prefix = this._sensorPrefix();
    if (this._registryEntityIds?.size) {
      return [...this._registryEntityIds].map(id => states[id]).filter((state): state is HassEntity => !!state &&
        DOMAINS.has(state.entity_id.split(".")[0] || ""));
    }
    if (!prefix) return [];
    // 没有设备注册表权限时，_sensorPrefix 是从电量传感器推导出的 `sensor.<车辆前缀>`；
    // 去掉域名后再匹配 object_id，才能同时找到 switch./lock./climate. 等同车实体。
    const objectPrefix = prefix.includes(".") ? prefix.slice(prefix.indexOf(".") + 1) : prefix;
    return Object.entries(states).filter(([id, state]) => {
      const dot = id.indexOf(".");
      return dot > 0 && id.slice(dot + 1).startsWith(objectPrefix) &&
        DOMAINS.has(id.slice(0, dot)) && !!state;
    }).map(([, state]) => state);
  }

  private _entityMetric(entityId: string): MetricDef {
    const state = this._hass?.states[entityId];
    const domain = entityId.split(".")[0] || "sensor";
    const domainIcons: Record<string, string> = {
      binary_sensor: "mdi:checkbox-marked-circle-outline", switch: "mdi:toggle-switch",
      input_boolean: "mdi:toggle-switch", number: "mdi:numeric", select: "mdi:format-list-bulleted",
      lock: "mdi:lock", cover: "mdi:window-shutter", climate: "mdi:thermostat",
      button: "mdi:gesture-tap-button", device_tracker: "mdi:map-marker", light: "mdi:lightbulb",
      fan: "mdi:fan", sensor: "mdi:car-info",
    };
    const unit = String(state?.attributes?.unit_of_measurement || "");
    const decimals = state?.attributes?.suggested_display_precision;
    const friendlyName = String(state?.attributes?.friendly_name || entityId)
      .replace(/壁挂(?:式)?空调/g, "空调");
    return {
      id: "entity:" + entityId,
      entityId,
      label: domain === "climate" ? "空调" : friendlyName,
      unit,
      precision: Number.isInteger(decimals) ? Number(decimals) : /kwh|bar|°c|l\/100/i.test(unit) ? 1 : 0,
      icon: String(state?.attributes?.icon || domainIcons[domain] || "mdi:car-info"),
      format: "text",
    };
  }

  private _selectedMetric(id: string): MetricDef | undefined {
    const metric = METRICS.find(item => item.id === id);
    if (metric) return metric;
    return id.startsWith("entity:") ? this._entityMetric(id.slice(7)) : undefined;
  }

  private _value(metric: MetricDef): number | null {
    if (metric.dailyField) {
      const raw = this._todayEnergy?.[metric.dailyField];
      if (raw == null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
    if (metric.tripStat) {
      const window = metric.tripStat.window;
      const statKeys = { today: "今日", days7: "近7天", days30: "近30天" };
      const raw = this._tripStats?.[window]?.[metric.tripStat.field] ??
        this._sourceState(["trip_stats"])?.attributes?.[statKeys[window]]?.[metric.tripStat.field] ??
        (window === "today" ? this._todayEnergy?.[
          ({ km: "km", kwh: "kwh", kwh_per_100km: "eff" } as Record<string, string>)[metric.tripStat.field]
        ] : undefined);
      if (raw == null) return null;
      const value = Number(raw);
      return Number.isFinite(value) ? value : null;
    }
    const values = (metric.sources || []).map(aliases => numeric(this._sourceState(aliases)));
    if (values.some(value => value == null)) return null;
    if (metric.calculate) return metric.calculate(values as number[]);
    return values[0] ?? null;
  }

  private _display(metric: MetricDef): string {
    if (metric.entityId) {
      const state = this._hass?.states[metric.entityId];
      const raw = String(state?.state || "");
      if (!raw || ["unknown", "unavailable"].includes(raw)) return "—";
      if (["switch", "input_boolean", "light", "fan"].includes(metric.entityId.split(".")[0])) {
        if (raw === "on") return "开启";
        if (raw === "off") return "关闭";
      }
      const stateLabels: Record<string, string> = {
        parked: "已驻车", driving: "行驶中", charging: "充电中", plugged: "已插枪",
        on: "开启", off: "关闭", open: "打开", closed: "关闭", locked: "已上锁",
        unlocked: "已解锁", home: "在家", not_home: "离家", idle: "待机", paused: "暂停",
      };
      const n = numeric(state);
      return n == null ? (stateLabels[raw.toLowerCase()] || raw) : n.toFixed(metric.precision);
    }
    if (metric.format === "text") {
      const state = this._sourceState(metric.sources?.[0] || []);
      const raw = state?.state || "";
      const labels: Record<string, string> = { parked: "已驻车", driving: "行驶中", charging: "充电中", plugged: "已插枪", on: "开启", off: "关闭" };
      return raw && !["unknown", "unavailable"].includes(raw) ? labels[raw.toLowerCase()] || raw : "—";
    }
    if (metric.id === "energy_rank") {
      const state = this._sourceState(metric.sources?.[0] || []);
      return state && !["unknown", "unavailable"].includes(state.state) ? state.state : "—";
    }
    const value = this._value(metric);
    return value == null ? (metric.tripStat && this._tripStatsLoading ? "…" : "—") : value.toFixed(metric.precision);
  }

  private _available(): MetricDef[] {
    // 固定车辆指标始终可选，避免注册表/前缀尚未就绪时把续航、电量等数据从选择器隐藏。
    // 不适用于当前车型的项目会显示“—”，实体列表仍只列出本车 HA 实体。
    const builtIns = METRICS;
    const entities = this._entityStates().map(state => this._entityMetric(state.entity_id));
    return [...builtIns, ...entities];
  }

  private _optionInfo(metric: MetricDef): string {
    if (metric.dailyField) return "今日能耗拆分 · 单位：kWh";
    if (metric.entityId) {
      const domain = metric.entityId.split(".")[0] || "sensor";
      const domainNames: Record<string, string> = {
        binary_sensor: "状态传感器", switch: "开关", input_boolean: "开关",
        number: "数值", select: "选项", lock: "门锁", cover: "覆盖实体",
        climate: "空调", button: "按钮", device_tracker: "位置", light: "灯",
        fan: "风扇", sensor: "传感器",
      };
      const unit = metric.unit ? ` · ${metric.unit}` : "";
      return `本车 HA · ${domainNames[domain] || "实体"}${unit}`;
    }
    if (metric.tripStat) return `行程统计 · 单位：${metric.unit || "次"}`;
    return metric.unit ? `车辆数据 · 单位：${metric.unit}` : "车辆状态数据";
  }

  private _save(): void {
    try { localStorage.setItem(this._prefKey, JSON.stringify(this._selected)); } catch { /* 偏好不可存时仍在本页可用 */ }
    this.requestUpdate();
  }
  private _add(id: string): void {
    if (!this._selected.includes(id)) { this._selected = [...this._selected, id]; this._save(); }
    this._picker = false; this._query = "";
    this._maybeLoadTodayEnergy();
  }
  private _remove(id: string): void { this._selected = this._selected.filter(key => key !== id); this._save(); }

  private _tilePointerDown(event: PointerEvent, id: string): void {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    if ((event.target as HTMLElement).closest("button")) return;
    const element = event.currentTarget as HTMLElement;
    const pointerId = event.pointerId;
    this._pointerId = pointerId;
    this._pointerOrigin = { x: event.clientX, y: event.clientY };
    this._activeTileId = id;
    this._dropTargetId = id;
    this._dragActive = false;
    if (!this._editing) {
      this._pressTimer = setTimeout(() => {
        this._pressTimer = null;
        if (this._pointerId !== pointerId) return;
        this._editing = true;
        this._dragActive = true;
        try { element.setPointerCapture(pointerId); } catch { /* 指针已离开时仍进入整理状态 */ }
        this.requestUpdate();
      }, 480);
    }
  }

  private _tilePointerMove(event: PointerEvent): void {
    if (this._pointerId !== event.pointerId || !this._pointerOrigin) return;
    const distance = Math.hypot(event.clientX - this._pointerOrigin.x, event.clientY - this._pointerOrigin.y);
    if (!this._editing && distance > 10) {
      if (this._pressTimer) clearTimeout(this._pressTimer);
      this._pressTimer = null;
      this._activeTileId = "";
      return;
    }
    if (!this._editing) return;
    if (!this._dragActive && distance > 8) {
      this._dragActive = true;
      try { (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId); } catch { /* 指针捕获可选 */ }
    }
    if (!this._dragActive) return;
    const target = this._nearestTile(event.clientX, event.clientY);
    if (target && target !== this._dropTargetId) {
      this._dropTargetId = target;
      this.requestUpdate();
    }
  }

  private _nearestTile(x: number, y: number): string {
    const tiles = [...(this.shadowRoot?.querySelectorAll<HTMLElement>(".tile[data-id]") || [])];
    let best = "";
    let distance = Number.POSITIVE_INFINITY;
    for (const tile of tiles) {
      const rect = tile.getBoundingClientRect();
      const d = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
      if (d < distance) { distance = d; best = tile.dataset.id || ""; }
    }
    return best;
  }

  private _tilePointerEnd(event: PointerEvent): void {
    if (this._pointerId !== event.pointerId) return;
    if (this._pressTimer) clearTimeout(this._pressTimer);
    this._pressTimer = null;
    if (this._editing && this._dragActive && this._activeTileId && this._dropTargetId) {
      const from = this._selected.indexOf(this._activeTileId);
      const to = this._selected.indexOf(this._dropTargetId);
      if (from >= 0 && to >= 0 && from !== to) {
        const next = [...this._selected];
        const [moved] = next.splice(from, 1);
        next.splice(to, 0, moved);
        this._selected = next;
        this._save();
      }
    }
    this._pointerId = null;
    this._pointerOrigin = null;
    this._activeTileId = "";
    this._dropTargetId = "";
    this._dragActive = false;
    this.requestUpdate();
  }

  private _tileKeyDown(event: KeyboardEvent, id: string): void {
    if ((event.target as HTMLElement).closest("button")) return;
    if (!this._editing && ["Enter", " "].includes(event.key)) {
      event.preventDefault();
      this._editing = true;
      this.requestUpdate();
      return;
    }
    if (!this._editing || !["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    const from = this._selected.indexOf(id);
    const to = Math.max(0, Math.min(this._selected.length - 1, from + (event.key === "ArrowRight" ? 1 : -1)));
    if (from < 0 || from === to) return;
    event.preventDefault();
    const next = [...this._selected];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    this._selected = next;
    this._save();
  }

  private _finishEdit(): void { this._editing = false; this._picker = false; this.requestUpdate(); }

  private _tile(metric: MetricDef): TemplateResult {
    const text = this._display(metric);
    const classes = ["tile", this._editing ? "editable" : "", this._dragActive && this._activeTileId === metric.id ? "dragging" : "", this._dragActive && this._dropTargetId === metric.id ? "dropTarget" : ""].filter(Boolean).join(" ");
    return html`<div class=${classes} data-id=${metric.id} role="group" tabindex="0" aria-label=${metric.label} @pointerdown=${(event: PointerEvent) => this._tilePointerDown(event, metric.id)} @pointermove=${(event: PointerEvent) => this._tilePointerMove(event)} @pointerup=${(event: PointerEvent) => this._tilePointerEnd(event)} @pointercancel=${(event: PointerEvent) => this._tilePointerEnd(event)} @contextmenu=${(event: Event) => event.preventDefault()} @keydown=${(event: KeyboardEvent) => this._tileKeyDown(event, metric.id)}><span class="tileHead"><ha-icon class="tileIcon" icon=${metric.icon}></ha-icon><span class="label">${metric.label}</span></span><b class="value">${text}</b>${metric.unit ? html`<small class="unit">${metric.unit}</small>` : nothing}${this._editing ? html`<button class="remove" aria-label=${"删除" + metric.label} title="移除此数据" @pointerdown=${(event: Event) => event.stopPropagation()} @click=${(event: Event) => { event.stopPropagation(); this._remove(metric.id); }}><ha-icon icon="mdi:close"></ha-icon></button><ha-icon class="dragHandle" icon="mdi:drag"></ha-icon>` : nothing}</div>`;
  }

  private _pickerView(available: MetricDef[]): TemplateResult | typeof nothing {
    if (!this._picker) return nothing;
    const query = this._query.trim().toLowerCase();
    const options = available.filter(m => !this._selected.includes(m.id) && (!query || (m.label + " " + m.unit + " " + (m.entityId || "")).toLowerCase().includes(query)));
    return html`<div class="backdrop" @click=${(e: MouseEvent) => { if (e.target === e.currentTarget) { this._picker = false; this.requestUpdate(); } }} @keydown=${(e: KeyboardEvent) => { if (e.key === "Escape") { this._picker = false; this.requestUpdate(); } }}><section class="picker" role="dialog" aria-modal="true" aria-label="新增车辆数据"><header class="pickerHead"><strong>添加数据</strong><button aria-label="关闭" @click=${() => { this._picker = false; this.requestUpdate(); }}>×</button></header><p class="pickerHint">可选行程统计、车辆指标和本车 HA 实体状态。</p><input class="search" type="search" placeholder="搜索数据" aria-label="搜索数据" .value=${live(this._query)} @input=${(e: Event) => { this._query = (e.target as HTMLInputElement).value; this.requestUpdate(); }}><div class="options">${options.length ? options.map(m => html`<button class="option" @click=${() => this._add(m.id)}><span class="optionIcon"><ha-icon icon=${m.icon}></ha-icon></span><span class="optionText"><b>${m.label}</b><small>${this._optionInfo(m)}</small></span></button>`) : html`<div class="noOptions">${available.length ? "没有更多可添加的数据" : this._tripStatsLoading || this._registryLoading ? "正在读取本车 HA 实体与行程统计…" : "暂未发现可添加的数据"}</div>`}</div></section></div>`;
  }

  protected render(): TemplateResult {
    const available = this._available();
    const shown = this._selected.map(id => this._selectedMetric(id)).filter((m): m is MetricDef => !!m);
    const selected = this._selectedVehicle();
    const picker = this._vehicleOptions.length > 1 && !this._vehicleLocked
      ? html`<label class="vehicleBar"><span>车辆</span><select .value=${this._vehicleEntryId} @change=${(event: Event) => this._onVehicleChange((event.currentTarget as HTMLSelectElement).value)}><option value="">${this._vehicleRequired ? "请选择车辆" : "切换车辆"}</option>${this._vehicleOptions.map(vehicle => html`<option value=${vehicle.entry_id} ?disabled=${!vehicle.available}>${vehicle.name || `${vehicle.car_type || "零跑"} · ${vehicle.vin.slice(-6)}`}${vehicle.ownership === "shared" ? " · 共享" : vehicle.ownership === "owner" ? " · 自有" : ""}${vehicle.available ? "" : "（未加载）"}</option>`)}</select></label>`
      : nothing;
    return html`<main class="card">${picker}${this._vehicleRequired ? html`<p class="vehicleHint">当前账号配置了多辆车，请先选择这张卡片要显示的车辆。</p>` : nothing}${!this._vehicleRequired && selected && !selected.available ? html`<p class="vehicleHint">所选车辆尚未加载，请检查集成状态。</p>` : nothing}${this._editing ? html`<div class="editingBar"><span>拖动子卡可调整顺序</span><button class="done" @click=${() => this._finishEdit()}>完成</button></div>` : nothing}${this._vehicleRequired ? nothing : html`<section class="grid" aria-label="自定义卡">${shown.map(m => this._tile(m))}${this._editing ? html`<button class="add" aria-label="新增数据" title="新增数据" @click=${() => { this._picker = true; this.requestUpdate(); }}><ha-icon icon="mdi:plus"></ha-icon></button>` : shown.length ? nothing : html`<button class="add" @click=${() => { this._editing = true; this._picker = true; this.requestUpdate(); }}><ha-icon icon="mdi:plus"></ha-icon></button>`}</section>`}</main>${this._pickerView(available)}`;
  }
}

defineCard("leapmotor-metrics", LeapmotorMetricsCard);
registerCustomCard({
  // HA 的 window.customCards 元数据使用不带 `custom:` 的裸类型名；YAML config 才带前缀。
  type: "leapmotor-metrics",
  name: "零跑·自定义卡",
  description: "组合行程统计和本车 HA 实体状态，支持长按整理与拖动排序",
  preview: false,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});
banner("零跑自定义卡", VERSION, "#5887c2");
