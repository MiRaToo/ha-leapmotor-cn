/*
 * 零跑车辆地图 —— 高德底图的 Lovelace 地图卡。
 *
 * 为什么不用 HA 自带的地图卡
 * --------------------------
 * 自带 `type: map` 只能选 OpenStreetMap / Google 两种图源, 而 OSM 瓦片
 * (tile.openstreetmap.org) 在国内网络基本连不上 —— 表现就是"地图上只有一个
 * 图标、没有任何底图"。本卡片直接取高德瓦片(`webrd0x.is.autonavi.com`),
 * 国内秒开。
 *
 * 坐标系: 输入 WGS-84, 显示时换算成 GCJ-02
 * ----------------------------------------
 * 集成对外发布的是 **WGS-84**(HA 地图 / 区域 / 手机都用这套, 用户才能直接在地图上
 * 画围栏), 而**高德瓦片是 GCJ-02**(火星坐标) —— 两者在国内相差 300~500 米。
 * 所以本卡片画之前会把 WGS-84 换算成 GCJ-02, 车标才落在高德底图的正确位置。
 *
 * 实测对照(卫星/路网图交叉验证): 换算后 → 正好落在马路边的小区门口;
 * 不换算直接画 → 偏到几百米外的空地里。
 *
 * 如果实体的属性里写了 `coordinate_system: GCJ-02`(例如指向另一个已经用火星坐标的
 * 实体), 卡片就不再换算; 也可以显式配置 `coordinate_system: wgs84|gcj02`。
 *
 * 用法
 * ----
 *   type: custom:leapmotor-map
 *   entity: device_tracker.ling_pao_c10_123456_che_liang_wei_zhi
 *   # 可选
 *   zoom: 16            # 初始缩放(15~18 比较合适)
 *   height: 320         # 卡片高度 px
 *   map_style: auto     # 底图: auto 随 HA 主题(浅色=路网/深色=夜色) / vector / satellite / dark
 *   follow: true        # 车动了自动跟随居中(默认 true; 手动拖动后自动关闭)
 *
 * 这张卡专注"看车的位置 + 编辑/新增地理围栏": 只画车标与 HA 的区域(围栏)圆圈,
 * 行程轨迹改由「零跑·行程浏览」卡片负责(那里有缩略图/大图/叠加)。
 * (v1.6 起不再画 `sensor.*_xing_cheng_gui_ji` 的最近一段轨迹。)
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 *
 * ⚠️ 本文件是 Lit + TS 重构版, 行为与视觉须与原 leapmotor-map.js **逐项等价**:
 *    瓦片引擎/区域圆圈仍是**命令式**(create-once 节点 + 以 z/x/y 为键缓存 <img>),
 *    只有静态骨架(.wrap/.layer/…/.bar)改用 lit 模板输出。
 */
import { LitElement, html, css, nothing, unsafeCSS, type CSSResult } from "lit";
import { unsafeSVG } from "lit/directives/unsafe-svg.js";
import type { HomeAssistant, HassEntity, LovelaceCardConfig } from "../types/hass";
import { clamp } from "../lib/dom";
import {
  TILE,
  TILE_FALLBACK,
  TILE_SOURCES,
  gcj02ToWgs84,
  project,
  unproject,
  wgs84ToGcj02,
} from "../lib/geo";
import { ipIcon } from "../lib/icons";
import { effMapStyle, isDark, normMapStyle } from "../lib/theme";
import { defineCard, registerCustomCard, banner } from "../lib/register";
import { CARD_VERSIONS } from "../lib/version";
import { carMarker } from "../lib/car-marker";
import { interactionStyles } from "../lib/motion";
import { uiStyles } from "../lib/ui/styles";
import { bindAppearance, unbindAppearance } from "../lib/appearance";
import { relTime } from "../lib/format";

const CARD_VERSION = CARD_VERSIONS.map;

type MapStyleMode = "auto" | "vector" | "satellite" | "dark";

interface MapCardConfig extends LovelaceCardConfig {
  entity?: string;
  zoom?: number;
  height?: number;
  map_style?: string;
  /** map_style 的旧别名(向后兼容) */
  satellite?: boolean;
  follow?: boolean;
  coordinate_system?: string;
  tiles?: string;
}

interface ZoneItem {
  id: string | number;
  name?: string;
  radius?: number | string;
  latitude?: number | string;
  longitude?: number | string;
}

/** 自动找"车辆位置"实体: 优先本集成的 tracker, 其次名字里带 leapmotor 的 tracker。 */
function pickTracker(hass: HomeAssistant | null | undefined): string {
  if (!hass || !hass.states) return "";
  const ids = Object.keys(hass.states).filter((e) => e.startsWith("device_tracker."));
  const ours = ids.filter((e) => /ling_pao|leapmotor/.test(e));
  const cand = (ours.length ? ours : ids).filter((e) => {
    const a = hass.states[e].attributes || {};
    return a.latitude != null && a.longitude != null;
  });
  return cand[0] || "";
}

class LeapmotorMapCard extends LitElement {
  private _config: MapCardConfig | null = null;
  private _hass: HomeAssistant | null = null;
  private _zoom = 16;
  private _center: [number, number] | null = null; // [lat, lon]
  private _follow = true;
  private _dragging = false;
  private _tiles = new Map<string, HTMLImageElement>(); // "z/x/y" → <img>
  private _marker: HTMLElement | null = null;
  private _built = false;
  private _mapStyle: MapStyleMode = "auto"; // auto 随 HA 主题 | vector | satellite | dark
  private _themeDark: boolean | undefined;
  private _lat?: number;
  private _lon?: number;
  private _latWgs?: number;
  private _lonWgs?: number;
  private _stateObj: HassEntity | null = null;
  private _hint: string | null = null;
  private _zoneItems: ZoneItem[] = [];
  private _zoneAnchor: "center" | "car" | null = null;
  private _ro: ResizeObserver | null = null;

  // ── 静态骨架节点(由 lit 模板渲染后 @query 取得) ──
  private _wrap: HTMLElement | null = null;
  private _layer: HTMLElement | null = null;
  private _overlay: HTMLElement | null = null;
  private _zonesLayer: HTMLElement | null = null;
  private _crosshair: HTMLElement | null = null;
  private _panel: HTMLElement | null = null;
  private _zpanel: HTMLElement | null = null;
  private _zlist: HTMLElement | null = null;
  private _zmsg: HTMLElement | null = null;
  private _panelMsg: HTMLElement | null = null;
  private _hintEl: HTMLElement | null = null;
  private _nameEl: HTMLElement | null = null;
  private _subEl: HTMLElement | null = null;
  private _followBtn: HTMLElement | null = null;
  private _styleBtn: HTMLElement | null = null;
  private _bound = false;

  /** 从卡片选择器添加时, 自动填好车辆位置实体(用户不用自己找)。 */
  static getStubConfig(hass: HomeAssistant) {
    return { entity: pickTracker(hass) || "", zoom: 16, height: 320, map_style: "auto" };
  }

  setConfig(config: LovelaceCardConfig) {
    // 不抛异常 —— 没填实体时自动识别(否则 HA 只会显示一张"配置错误"卡片,
    // 用户完全不知道该怎么办)。真正找不到时才在卡片上给一句提示。
    const raw: MapCardConfig = config || {};
    this._config = {
      zoom: 16,
      height: 320,
      map_style: "auto",
      follow: true,
      ...raw,
    };
    // satellite 是 map_style 的旧别名(向后兼容)
    if (raw.map_style == null && raw.satellite != null) {
      this._config.map_style = raw.satellite ? "satellite" : "vector";
    }
    this._mapStyle = normMapStyle(this._config.map_style);
    // 高德瓦片 z=19 在很多区域没有数据(会返回空白图), 所以上限取 18
    this._zoom = clamp(Number(this._config.zoom) || 16, 3, 18);
    this._follow = this._config.follow !== false;
    this._tiles.forEach((img) => img.remove());
    this._tiles.clear();
    this._built = false;
    this._center = null;
    this.requestUpdate();
    // 首次 setConfig 时尚未渲染, 渲染后由 firstUpdated 建卡; 之后则由 updated 重建。
    this.updateComplete.then(() => {
      if (this._config && !this._built) this._render();
    });
  }

  /** 实际生效的底图: auto → HA 深色主题时用深色, 否则路网。 */
  private _effMapStyle() {
    return effMapStyle(this._mapStyle || "auto", this._hass);
  }

  /** 底图循环切换: 自动 → 路网 → 卫星 → 深色, 点了立刻重绘并刷新按钮态。 */
  private _cycleMapStyle() {
    const order: MapStyleMode[] = ["auto", "vector", "satellite", "dark"];
    const i = order.indexOf(this._mapStyle || "auto");
    this._mapStyle = order[(i + 1) % order.length];
    this._tiles.forEach((img) => img.remove()); // 换底图源, 旧瓦片必须丢掉重取
    this._tiles.clear();
    this._applyMapStyle();
    this._renderTiles();
    this._syncStyleBtn();
  }

  /** 把当前底图样式落到 DOM(class, 深色靠 CSS 滤镜)。 */
  private _applyMapStyle() {
    if (this._wrap) this._wrap.classList.toggle("dark", this._effMapStyle() === "dark");
  }

  private _syncStyleBtn() {
    if (!this._styleBtn) return;
    const s = this._mapStyle || "auto";
    // 一律用图标表示, 不放文字: 自动=主题图标 / 路网=地图 / 卫星=卫星 / 深色=月亮
    const ICON: Record<string, string> = {
      auto: "mdi:theme-light-dark",
      vector: "mdi:map-outline",
      satellite: "mdi:satellite-variant",
      dark: "mdi:weather-night",
    };
    const NAME: Record<string, string> = {
      auto: "自动(随主题)",
      vector: "路网",
      satellite: "卫星",
      dark: "深色",
    };
    this._styleBtn.innerHTML = '<ha-icon icon="' + (ICON[s] || ICON.vector) + '"></ha-icon>';
    this._styleBtn.title = "底图: " + (NAME[s] || "路网") + " —— 点一下切换";
    this._styleBtn.classList.toggle("on", s !== "vector");
  }

  set hass(hass: HomeAssistant) {
    this._hass = hass;
    // "自动"底图随 HA 主题: 主题从浅切深时重画瓦片(深色靠 CSS 滤镜)
    const dark = !!(hass && hass.themes && hass.themes.darkMode);
    if (this._themeDark !== undefined && this._themeDark !== dark && this._mapStyle === "auto") {
      this._applyMapStyle();
      if (this._center) this._renderTiles();
    }
    this._themeDark = dark;
    if (!this._config) return;
    if (!this._config.entity) {
      const guess = pickTracker(hass);
      if (guess) {
        this._config.entity = guess; // 自动识别, 用户什么都不用填
        this._follow = this._config.follow !== false;
      } else {
        this._renderHint("这张卡片需要指定车辆位置实体 —— 编辑卡片, 实体选 device_tracker.…");
        return;
      }
    }
    const st = hass.states[this._config.entity];
    const lat = st && Number(st.attributes.latitude);
    const lon = st && Number(st.attributes.longitude);
    if (!st || !Number.isFinite(lat) || !Number.isFinite(lon)) {
      this._renderHint("车辆位置暂不可用(等车端上报定位)");
      return;
    }
    this._latWgs = lat;
    this._lonWgs = lon;
    const [dlat, dlon] = this._toDisplay(lat, lon, st);
    const moved = dlat !== this._lat || dlon !== this._lon;
    this._lat = dlat;
    this._lon = dlon;
    this._stateObj = st;

    if (!this._center) {
      this._center = [dlat, dlon];
      this._built = false;
    } else if (moved && this._follow) {
      this._center = [dlat, dlon];
    }
    this._render();
    if (!this._built) return; // 首次渲染前 _render 不做事, 渲染后 firstUpdated 会补建
    if (moved) this._renderMarker();
    this._renderInfo();
  }
  // 与 trips/energy 保持一致:有 setter 就给 getter —— 否则 `card.hass` 读出来是
  // undefined(原型上只挂了 setter), 任何读它的代码(含测试/HA 侧包装)都拿不到状态。
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  /** 开关"管理区域"面板: 列出卡片/HA 里用界面建的区域, 可定位与删除。 */
  private async _toggleZoneList() {
    if (!this._zpanel) return;
    const on = !this._zpanel.classList.contains("on");
    if (this._panel) this._panel.classList.remove("on");
    this._zpanel.classList.toggle("on", on);
    if (!on) return;
    if (!this._hass || !this._hass.callWS) {
      if (this._zmsg) this._zmsg.textContent = "当前环境不支持读取区域列表";
      return;
    }
    if (this._hass.user && !this._hass.user.is_admin) {
      if (this._zmsg) this._zmsg.textContent = "⚠️ 需要管理员权限才能删除区域";
    }
    await this._loadZoneList();
  }

  private async _loadZoneList() {
    if (!this._hass) return;
    if (this._zmsg) this._zmsg.textContent = "读取中…";
    let list: ZoneItem[];
    try {
      list = await this._hass.callWS!<ZoneItem[]>({ type: "zone/list" });
      this._zoneItems = Array.isArray(list) ? list : [];
    } catch (err) {
      this._zoneItems = [];
      if (this._zmsg) {
        this._zmsg.textContent =
          "读取失败:" + String((err as any)?.message ? (err as any).message : err).slice(0, 70);
      }
      return;
    }
    if (!this._zoneItems.length) {
      if (this._zlist) this._zlist.innerHTML = "";
      if (this._zmsg) this._zmsg.textContent = "还没有用界面建过区域 —— 点右上角「＋」建一个";
      return;
    }
    if (this._zmsg) {
      this._zmsg.textContent = `共 ${this._zoneItems.length} 个区域(改半径后点「改」; 点「删」会先变成确认, 再点一次才真删)`;
    }
    if (this._zlist) {
      this._zlist.innerHTML = this._zoneItems
        .map((z) => {
          const r = Math.round(Number(z.radius) || 100);
          const nm = String(z.name || z.id || "?").replace(/[<>&]/g, "");
          return (
            '<div class="zrow" data-id="' +
            String(z.id) +
            '">' +
            '<span class="nm">' +
            nm +
            "</span>" +
            '<input class="zrad" type="number" min="20" max="5000" step="10" value="' +
            r +
            '" title="半径(米)">' +
            '<button data-zz="rad" title="保存半径">改</button>' +
            '<button data-zz="go">定位</button>' +
            '<button data-zz="del" class="danger">删</button>' +
            "</div>"
          );
        })
        .join("");
    }
  }

  /** 改某个区域的半径(走 HA 官方 WS 接口 zone/update; 需要管理员)。 */
  private async _updateZone(id: string, row: Element) {
    const z = (this._zoneItems || []).find((x) => String(x.id) === String(id));
    if (!z) return;
    const input = row ? (row.querySelector(".zrad") as HTMLInputElement | null) : null;
    const radius = Math.max(20, Math.min(5000, Number(input && input.value) || 0));
    if (!radius) {
      if (this._zmsg) this._zmsg.textContent = "半径填写不合法(20~5000 米)";
      return;
    }
    if (!this._hass || !this._hass.callWS) return;
    if (this._zmsg) this._zmsg.textContent = "保存中…";
    try {
      // HA 的 zone/update 是**部分字段更新**: 只给 zone_id + radius, 其余(名字/坐标)保持不变。
      await this._hass.callWS({ type: "zone/update", zone_id: id, radius: radius });
      await this._loadZoneList();
    } catch (err) {
      if (this._zmsg) {
        this._zmsg.textContent =
          "保存失败:" + String((err as any)?.message ? (err as any).message : err).slice(0, 70);
      }
    }
  }

  /** 把地图移到某个区域(定位)。 */
  private _gotoZone(id: string) {
    const z = (this._zoneItems || []).find((x) => String(x.id) === String(id));
    if (!z || z.latitude == null || !this._wrap || !this._config) return;
    const [glat, glon] = wgs84ToGcj02(Number(z.latitude), Number(z.longitude));
    this._center = [glat, glon];
    const r = Number(z.radius) || 100;
    const rect = this._wrap.getBoundingClientRect();
    const h = rect.height || this._config.height || 320;
    // 让圆圈大致占满一半高度
    const want = (156543.03392 * Math.cos((glat * Math.PI) / 180)) / (r * 4);
    this._zoom = Math.max(3, Math.min(18, Math.round(Math.log2(want * h))));
    this._setFollow(false);
    if (this._zpanel) this._zpanel.classList.remove("on");
    this._renderTiles();
    this._renderZones();
    this._renderMarker();
  }

  /** 删除某个区域(界面建的 zone; 需要管理员权限)。 */
  private async _deleteZone(id: string, btn: HTMLButtonElement) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      btn.textContent = "确认删";
      setTimeout(() => {
        // 3 秒内没确认就复位, 防止误触
        if (btn.dataset.armed) {
          delete btn.dataset.armed;
          btn.classList.remove("armed");
          btn.textContent = "删";
        }
      }, 3000);
      return;
    }
    if (this._zmsg) this._zmsg.textContent = "删除中…";
    try {
      await this._hass!.callWS!({ type: "zone/delete", zone_id: id });
      await this._loadZoneList();
    } catch (err) {
      if (this._zmsg) {
        this._zmsg.textContent =
          "删除失败:" + String((err as any)?.message ? (err as any).message : err).slice(0, 70);
      }
    }
  }

  /** 开关"建区域"面板(类名、准星、重绘都在这里统一处理, 避免漏掉重绘)。 */
  private _setPanel(on: boolean) {
    if (on && this._zpanel) this._zpanel.classList.remove("on");
    if (this._panel) this._panel.classList.toggle("on", on);
    // 面板高度变了 → 焦点位置变了 → 底图/车标/区域都要按新焦点重画
    this._renderTiles();
    this._renderZones();
    this._renderMarker();
  }

  /** 准星(也就是"地图中心")在卡片内的屏幕坐标 —— 就是显示区域的正中心。 */
  private _focusPoint(): [number, number] {
    const rect = this._wrap!.getBoundingClientRect();
    const w = rect.width || this._wrap!.clientWidth || 400;
    const h = rect.height || this._config!.height || 320;
    return [w / 2, h / 2];
  }

  /** 打开/收起"建区域"面板。 */
  private _toggleZonePanel() {
    if (!this._panel) return;
    const on = !this._panel.classList.contains("on");
    this._setPanel(on);
    if (on) {
      const el = this.shadowRoot!.querySelector(".zname") as HTMLInputElement | null;
      if (el && !el.value) el.value = "停车位";
      if (this._panelMsg) {
        this._panelMsg.textContent =
          this._hass && this._hass.user && !this._hass.user.is_admin
            ? "⚠️ 需要管理员权限才能创建区域"
            : "把地图拖到要圈的位置(准星处), 或用「用车的位置」—— 然后点「创建区域」";
      }
    }
  }

  /** 用地图中心或车辆位置创建 HA 区域(zone) —— 走官方 WS 接口 zone/create。 */
  private async _createZone(where: "center" | "car") {
    const nameEl = this.shadowRoot!.querySelector(".zname") as HTMLInputElement | null;
    const radEl = this.shadowRoot!.querySelector(".zradius") as HTMLInputElement | null;
    const name = ((nameEl && nameEl.value) || "").trim();
    const radius = Math.max(20, Math.min(5000, Number(radEl && radEl.value) || 200));
    if (!name) {
      if (this._panelMsg) this._panelMsg.textContent = "请先填区域名称";
      return;
    }
    if (!this._hass || !this._hass.callWS) {
      if (this._panelMsg) {
        this._panelMsg.textContent = "当前环境不支持创建区域(需要在 Home Assistant 里打开)";
      }
      return;
    }
    // 输入用的是 WGS-84(与 HA 区域一致), 不能直接用显示坐标(那是 GCJ-02)
    let lat: number;
    let lon: number;
    if (where === "car") {
      if (this._latWgs == null || this._lonWgs == null) {
        if (this._panelMsg) this._panelMsg.textContent = "还没有车辆定位";
        return;
      }
      lat = this._latWgs;
      lon = this._lonWgs;
    } else {
      [lat, lon] = gcj02ToWgs84(this._center![0], this._center![1]);
    }
    if (this._panelMsg) this._panelMsg.textContent = "正在创建…";
    try {
      await this._hass.callWS({
        type: "zone/create",
        name,
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lon.toFixed(6)),
        radius,
        icon: "mdi:map-marker",
      });
      if (this._panel) this._panel.classList.remove("on");
      if (this._crosshair) this._crosshair.classList.remove("on");
      this._renderTiles();
      this._renderZones();
      this._renderMarker();
    } catch (err) {
      if (this._panelMsg) {
        this._panelMsg.textContent =
          "创建失败:" + String((err as any)?.message ? (err as any).message : err).slice(0, 80);
      }
    }
  }

  /** 把 HA 里所有 zone 画成圆圈(高德底图是 GCJ-02, 所以中心要换算)。 */
  private _renderZones() {
    if (!this._zonesLayer || !this._hass || !this._center || !this._wrap) return;
    const z = this._zoom;
    const [cx, cy] = project(this._center[0], this._center[1], z);
    const [fx, fy] = this._focusPoint();
    const mpp = (156543.03392 * Math.cos((this._center[0] * Math.PI) / 180)) / Math.pow(2, z);
    const wanted = new Set<string>();
    for (const st of Object.values(this._hass.states)) {
      if (!st.entity_id.startsWith("zone.")) continue;
      const a = st.attributes || {};
      if (a.latitude == null || a.longitude == null) continue;
      const radius = Number(a.radius) || 100;
      wanted.add(st.entity_id);
      let el = this._zonesLayer.querySelector(`[data-zone="${st.entity_id}"]`) as HTMLElement | null;
      if (!el) {
        el = document.createElement("div");
        el.className = "zone";
        el.dataset.zone = st.entity_id;
        el.innerHTML = "<span></span>";
        this._zonesLayer.appendChild(el);
      }
      const [glat, glon] = wgs84ToGcj02(a.latitude, a.longitude); // 显示坐标系
      const [zx, zy] = project(glat, glon, z);
      const rpx = radius / mpp;
      el.style.width = `${rpx * 2}px`;
      el.style.height = `${rpx * 2}px`;
      el.style.left = `${zx - cx + fx - rpx}px`;
      el.style.top = `${zy - cy + fy - rpx}px`;
      el.querySelector("span")!.textContent = a.friendly_name || st.entity_id.slice(5);
    }
    this._zonesLayer.querySelectorAll(".zone").forEach((el) => {
      if (!wanted.has((el as HTMLElement).dataset.zone!)) el.remove();
    });
  }

  /** 把实体坐标换算成"底图坐标系"(高德瓦片是 GCJ-02)。 */
  private _toDisplay(lat: number, lon: number, st: HassEntity): [number, number] {
    const mode = this._config!.coordinate_system || "auto";
    if (mode === "gcj02") return [lat, lon];
    if (mode === "wgs84") return wgs84ToGcj02(lat, lon);
    // auto: 实体自己声明是火星坐标就不换算, 否则按 WGS-84 处理(集成默认)
    const declared = String((st.attributes && st.attributes.coordinate_system) || "").toUpperCase();
    return declared.includes("GCJ") ? [lat, lon] : wgs84ToGcj02(lat, lon);
  }

  getCardSize() {
    const cfg: MapCardConfig = this._config || ({} as MapCardConfig);
    return Math.ceil((cfg.height || 320) / 50) + 1;
  }

  // ── 渲染 ──
  firstUpdated() {
    const pending = this._hint;
    this._render();
    // set hass 可能在模板首帧之前到达(hint 先被记下): 首帧后补显示
    if (pending != null && this._hint != null) this._renderHint(pending);
  }

  protected update(changed: Map<PropertyKey, unknown>): void {
    super.update(changed);
    this._cacheNodes();
    // 节点引用在每次模板更新后重新绑定; 已有 DOM 节点不变, 引用不变
    if (this._built) {
      this._syncStyleBtn();
      this._applyMapStyle();
      this._renderTiles();
      this._renderZones();
      this._renderMarker();
      this._renderInfo();
      if (this._hint != null) this._renderHint(this._hint);
    }
  }

  private _cacheNodes() {
    const q = (sel: string) => this.shadowRoot!.querySelector(sel) as HTMLElement | null;
    this._wrap = q(".wrap");
    this._layer = q(".layer");
    this._overlay = q(".overlay");
    this._zonesLayer = q(".zones");
    this._crosshair = q(".crosshair");
    this._panel = q(".panel");
    this._zpanel = q(".zpanel");
    this._zlist = q(".zpanel .zlist");
    this._zmsg = q(".zpanel .msg");
    this._panelMsg = q(".panel .msg");
    this._hintEl = q(".hint");
    this._nameEl = q(".bar .name");
    this._subEl = q(".bar .sub");
    this._followBtn = q('button[data-a="follow"]');
    this._styleBtn = q('button[data-a="style"]');
  }

  private _render() {
    this._hint = null;
    if (!this._config || !this._wrap) return; // 模板尚未渲染, 渲染完成后 firstUpdated 会补做
    if (!this._built) {
      this._build();
      this._built = true;
    }
    if (this._hintEl) this._hintEl.style.display = "none";
    this._renderTiles();
    this._renderZones();
    this._renderMarker();
    this._renderInfo();
  }

  private _renderHint(text: string) {
    this._hint = text;
    if (!this._config || !this._wrap) return; // 模板尚未渲染, 渲染完成后 firstUpdated 会补做
    if (!this._built) {
      this._build();
      this._built = true;
    }
    if (this._hintEl) {
      this._hintEl.textContent = text;
      this._hintEl.style.display = "block";
    }
  }

  /** 第一帧后一次性装配: 取节点引用 + 绑定事件 + 起 ResizeObserver。 */
  private _build() {
    this._cacheNodes();
    this._syncStyleBtn();
    this._applyMapStyle();
    if (this._bound) return;
    this._bound = true;

    if (this._zlist) {
      this._zlist.addEventListener("click", (ev) => {
        const b = (ev.target as Element).closest("button");
        if (!b) return;
        ev.stopPropagation();
        const row = b.closest(".zrow");
        if (!row) return;
        if (b.dataset.zz === "go") this._gotoZone((row as HTMLElement).dataset.id!);
        else if (b.dataset.zz === "del")
          this._deleteZone((row as HTMLElement).dataset.id!, b as HTMLButtonElement);
        else if (b.dataset.zz === "rad") this._updateZone((row as HTMLElement).dataset.id!, row);
      });
    }
    this.shadowRoot!.querySelectorAll(".panel button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const btn = b as HTMLButtonElement;
        const z = btn.dataset.z || btn.dataset.zm; // 兼容两种写法, 免得再踩属性名不一致
        if (z === "cancel") this._setPanel(false);
        else if (z === "close") this._zpanel && this._zpanel.classList.remove("on");
        else if (z === "create") this._createZone(this._zoneAnchor || "center");
        else if (z === "car" || z === "center") {
          this._zoneAnchor = z;
          if (this._panelMsg) {
            this._panelMsg.textContent =
              z === "car"
                ? "位置 = 车辆当前位置(点「创建区域」)"
                : "位置 = 准星处的地图中心(拖动地图可调整)";
          }
        }
      });
    });
    this.shadowRoot!.querySelectorAll(".btns button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._onButton((b as HTMLButtonElement).dataset.a!);
      });
    });
    this._bindPointer();
    this._bindWheel();

    // 卡片尺寸变化(切到别的视图再切回来、改列宽)时要重算可视瓦片
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (this._center) this._renderTiles();
        this._renderMarker();
        this._renderZones(); // 改列宽/切视图后圈的大小与位置同样要重算
      });
      this._ro.observe(this._wrap!);
    }
  }

  private _bindPointer() {
    let start: { x: number; y: number; center: [number, number] } | null = null;
    this._wrap!.addEventListener("pointerdown", (ev) => {
      // 落在按钮/面板上的指针事件必须放行 —— 一旦在这里 setPointerCapture,
      // 后续 pointerup 会被地图抢走, 按钮的 click 就永远不会触发
      if ((ev.target as Element).closest(".btns") || (ev.target as Element).closest(".panel")) return;
      this._wrap!.setPointerCapture(ev.pointerId);
      start = { x: ev.clientX, y: ev.clientY, center: [...this._center!] as [number, number] };
      this._dragging = false;
    });
    this._wrap!.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!this._dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
      this._dragging = true;
      this._wrap!.classList.add("dragging");
      const [cx, cy] = project(start.center[0], start.center[1], this._zoom);
      this._center = unproject(cx - dx, cy - dy, this._zoom);
      this._renderTiles();
      this._renderMarker();
      // 围栏(zone 圆圈)必须跟瓦片/车标一起走, 否则拖动时它停在原地、松手后
      // 要等下一次 hass 推送才"跳"到位(曾出现过的"延迟一下"就是这个)
      this._renderZones();
    });
    const end = () => {
      if (!start) return;
      start = null;
      this._wrap!.classList.remove("dragging");
      if (this._dragging) {
        this._setFollow(false);
      }
      this._dragging = false;
    };
    // ── 双指捏合缩放(手机/平板) ──
    let pinch: { d: number; zoom: number; cx: number; cy: number } | null = null;
    const dist2 = (ts: TouchList) =>
      Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
    this._wrap!.addEventListener(
      "touchstart",
      (ev) => {
        if (ev.touches.length !== 2) return;
        ev.preventDefault();
        start = null; // 捏合期间不拖地图
        pinch = {
          d: dist2(ev.touches) || 1,
          zoom: this._zoom,
          cx: (ev.touches[0].clientX + ev.touches[1].clientX) / 2,
          cy: (ev.touches[0].clientY + ev.touches[1].clientY) / 2,
        };
      },
      { passive: false }
    );
    this._wrap!.addEventListener(
      "touchmove",
      (ev) => {
        if (!pinch || ev.touches.length !== 2) return;
        ev.preventDefault();
        const want = clamp(
          Math.round(pinch.zoom + Math.log2(dist2(ev.touches) / pinch.d)),
          3,
          18
        );
        if (want !== this._zoom) {
          this._zoomAt(pinch.cx, pinch.cy, want - this._zoom);
          this._setFollow(false);
        }
      },
      { passive: false }
    );
    this._wrap!.addEventListener("touchend", () => {
      pinch = null;
    });
    this._wrap!.addEventListener("touchcancel", () => {
      pinch = null;
    });
    this._wrap!.addEventListener("pointerup", end);
    this._wrap!.addEventListener("pointercancel", end);
    this._wrap!.addEventListener("dblclick", (ev) => {
      if ((ev.target as Element).closest(".panel") || (ev.target as Element).closest(".btns")) return;
      ev.stopPropagation();
      this._zoomAt(ev.clientX, ev.clientY, 1);
    });
  }

  private _bindWheel() {
    this._wrap!.addEventListener(
      "wheel",
      (ev) => {
        // 面板里滚轮照常
        if ((ev.target as Element).closest(".panel") || (ev.target as Element).closest(".btns")) return;
        ev.preventDefault(); // 拦下页面滚动, 让滚轮专心缩放地图
        ev.stopPropagation();
        this._zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
  }

  private _zoomAt(clientX: number, clientY: number, delta: number) {
    if (!this._center || !this._wrap) return;
    const z0 = this._zoom;
    const z1 = clamp(z0 + delta, 3, 18);
    if (z1 === z0) return;
    const rect = this._wrap.getBoundingClientRect();
    const px = clientX - rect.left;
    const py = clientY - rect.top;
    const [fx, fy] = this._focusPoint();
    const [cx, cy] = project(this._center[0], this._center[1], z0);
    const [lat, lon] = unproject(cx + px - fx, cy + py - fy, z0);
    const [nx, ny] = project(lat, lon, z1);
    this._zoom = z1;
    this._center = unproject(nx - px + fx, ny - py + fy, z1);
    this._renderTiles();
    this._renderMarker();
    this._renderZones(); // 缩放同理: 圈的大小/位置都要当场重算
  }

  private _onButton(action: string) {
    if (action === "in" || action === "out") {
      const rect = this._wrap!.getBoundingClientRect();
      this._zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, action === "in" ? 1 : -1);
    } else if (action === "zone") {
      this._toggleZonePanel();
    } else if (action === "zones") {
      this._toggleZoneList();
    } else if (action === "follow") {
      const on = !this._follow;
      this._setFollow(on);
      if (on && this._lat != null) {
        this._center = [this._lat, this._lon!];
        this._renderTiles();
        this._renderMarker();
        this._renderZones(); // 区域圆圈也要当场跟着走, 否则要等下一帧才归位
      }
    } else if (action === "style") {
      this._cycleMapStyle();
    }
  }

  private _setFollow(on: boolean) {
    this._follow = on;
    if (this._followBtn) this._followBtn.classList.toggle("on", on);
  }

  private _tileUrl(z: number, x: number, y: number, fallback: boolean): string {
    const conf = this._config!;
    // 深色底图 = 路网瓦片 + CSS 滤镜(见 .wrap.dark), 瓦片源仍是 vector
    const style = this._effMapStyle();
    const src = style === "satellite" ? TILE_SOURCES.satellite : TILE_SOURCES.vector;
    let tpl = conf.tiles || src;
    if (fallback) tpl = TILE_FALLBACK;
    const s = ((x + y) % 4) + 1;
    return tpl
      .replace("{s}", String(s))
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  private _renderTiles() {
    if (!this._wrap || !this._center) return;
    // 双保险: 任何情况下都不允许容器带着滚动偏移渲染
    if (this._wrap.scrollLeft || this._wrap.scrollTop) {
      this._wrap.scrollLeft = 0;
      this._wrap.scrollTop = 0;
    }
    const rect = this._wrap.getBoundingClientRect();
    const w = rect.width || this._wrap.clientWidth || 400;
    const h = rect.height || (this._config!.height as number);
    const z = this._zoom;
    const [cx, cy] = project(this._center[0], this._center[1], z);
    const [fx, fy] = this._focusPoint();
    const left = cx - fx;
    const top = cy - fy;
    const x0 = Math.floor(left / TILE);
    const y0 = Math.floor(top / TILE);
    const x1 = Math.floor((left + w) / TILE);
    const y1 = Math.floor((top + h) / TILE);
    const max = Math.pow(2, z);
    const needed = new Set<string>();

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        const wx = ((x % max) + max) % max; // 经度方向绕回
        const key = `${z}/${x}/${y}`;
        needed.add(key);
        if (!this._tiles.has(key)) {
          const img = document.createElement("img");
          img.decoding = "async";
          img.src = this._tileUrl(z, wx, y, false);
          img.addEventListener("error", () => {
            // 高德连不上(海外网络)时回落 OSM, 至少还能看图
            if (!img.dataset.retried) {
              img.dataset.retried = "1";
              img.src = this._tileUrl(z, wx, y, true);
            }
          });
          this._tiles.set(key, img);
          this._layer!.appendChild(img);
        }
        const img = this._tiles.get(key)!;
        img.style.left = `${x * TILE - left}px`;
        img.style.top = `${y * TILE - top}px`;
      }
    }
    // 回收滚出视野的瓦片, 避免长时间拖动后 DOM 堆积
    this._tiles.forEach((img, key) => {
      if (!needed.has(key)) {
        img.remove();
        this._tiles.delete(key);
      }
    });
    this._layer!.style.transform = "translate(0,0)";
  }

  private _renderMarker() {
    if (!this._wrap || this._lat == null || !this._center) return;
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const [mx, my] = project(this._lat, this._lon!, this._zoom);
    const [fx, fy] = this._focusPoint();
    if (!this._marker) {
      this._marker = document.createElement("div");
      this._marker.className = "marker";
      this._marker.innerHTML = carMarker();
      this._overlay!.appendChild(this._marker);
    }
    this._marker.style.transform = `translate(${mx - cx + fx}px, ${my - cy + fy}px)`;
  }

  private _renderInfo() {
    if (!this._nameEl || !this._stateObj) return;
    const st = this._stateObj;
    const zone = this._hass?.states["zone." + st.state]?.attributes.friendly_name;
    const locationName = zone || (st.state === "home" ? "家" : st.state === "not_home" ? "外出" : ["unknown", "unavailable"].includes(st.state) ? "位置未知" : st.state);
    this._nameEl.textContent = locationName || "车辆位置";
    this._nameEl.title = st.attributes.friendly_name || this._config!.entity!;
    const parts: string[] = [];
    if (st.attributes.vehicle_state) {
      parts.push(st.attributes.vehicle_state === "driving" ? "行驶中" : "已驻车");
    }
    if (st.attributes.odometer != null) parts.push(`总里程 ${Math.round(st.attributes.odometer)} km`);
    if (st.attributes.speed) parts.push(`车速 ${Math.round(st.attributes.speed)} km/h`);
    const time = relTime(st.attributes.state_updated || st.attributes.location_time || st.last_updated);
    if (time) parts.push("更新 · " + time);
    this._subEl!.textContent = parts.join(" · ");
  }

  /** 卡片配色(本机; 六张卡统一): 连接期间订阅配色变化 —— 变量写在宿主元素上(见 lib/palette.ts) */
  connectedCallback() {
    super.connectedCallback();
    // 界面风格 + 本机主题色(六张卡统一; 变量写在宿主元素上, 见 lib/appearance.ts)
    bindAppearance(this, { getDark: () => isDark(this._hass) });
  }

  disconnectedCallback() {
    super.disconnectedCallback();
    unbindAppearance(this); // 外观订阅同样只在"连接期间"需要
    if (this._ro) {
      this._ro.disconnect();
      this._ro = null;
    }
  }

  render() {
    if (!this._config) return nothing;
    const h = Number(this._config.height) || 320;
    // 高度走样式变量: 静态样式表由 Lit 注入, 用变量把卡片高度传进去, 保持逐字等价
    return html`
      <div
        class="wrap"
        style="--lm-map-h:${unsafeCSS(String(h))}px"
        @click=${this._onWrapClick}
      >
        <div class="layer"></div>
        <div class="zones"></div>
        <div class="crosshair" title="地图中心(建区域时以它为圆心)">
          <svg viewBox="0 0 20 20" width="20" height="20">
            <circle cx="10" cy="10" r="5" fill="#e53935" stroke="#fff" stroke-width="2" />
          </svg>
        </div>
        <div class="overlay"></div>
        <div class="btns">
          <button data-a="in" title="放大">＋</button>
          <button data-a="out" title="缩小">－</button>
          <button data-a="follow" title="跟随车辆">${unsafeSVG(ipIcon("aiming", 18))}</button>
          <button data-a="style" class="style" title="底图: 点一下切换">
            <ha-icon icon="mdi:theme-light-dark"></ha-icon>
          </button>
          <button data-a="zone" title="建一个区域(围栏)">＋</button>
          <button data-a="zones" title="管理区域(定位/删除)">☰</button>
        </div>
        <div class="panel">
          <div class="row">
            <input class="zname" type="text" placeholder="区域名称(默认 停车位)" />
            <input
              class="zradius"
              type="number"
              min="20"
              max="5000"
              step="10"
              value="200"
              title="半径(米)"
            />
          </div>
          <div class="row">
            <button data-z="center">地图中心</button>
            <button data-z="car">车的位置</button>
            <button class="primary" data-z="create">创建</button>
            <button data-z="cancel">取消</button>
          </div>
          <div class="msg"></div>
        </div>
        <div class="panel zpanel">
          <div class="zlist"></div>
          <div class="msg"></div>
          <div class="row"><button data-z="close">关闭</button></div>
        </div>
        <div class="hint"></div>
        <div class="bar"><span class="name"></span><span class="sub"></span></div>
      </div>
    `;
  }

  // 骨架上的 click 只用于面板按钮; 地图交互走命令式监听(与原实现一致)
  private _onWrapClick(_ev: Event) {
    /* no-op: 具体按钮事件在 _build() 中命令式绑定 */
  }

  static styles: CSSResult[] = [
    css`${unsafeCSS(interactionStyles)}`,
    css`
      :host {
        display: block;
      }
      .wrap {
        position: relative;
        width: 100%;
        height: var(--lm-map-h, 320px);
        /* 必须用 clip 而不是 hidden: hidden 仍是可滚动容器, 一旦容器被滚动
           (浏览器把按钮滚进视野、手势等), 里面绝对定位的瓦片和车标会整体偏移 */
        overflow: clip;
        border-radius: var(--ha-card-border-radius, 12px);
        background: var(--lm-surface-control, var(--card-background-color, #fff));
        cursor: grab;
        touch-action: none;
        user-select: none;
      }
      .wrap.dragging {
        cursor: grabbing;
      }
      /* 深色底图: 亮色路网瓦片整体反相 + 色相翻转 → 夜色地图(与官方 App 深色图观感一致) */
      .wrap.dark {
        background: #111418;
      }
      .wrap.dark .layer {
        filter: invert(100%) hue-rotate(180deg) brightness(85%) contrast(90%);
      }
      .layer {
        position: absolute;
        left: 0;
        top: 0;
        z-index: 0;
        will-change: transform;
      }
      .overlay {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        z-index: 5;
        pointer-events: none;
      }
      .layer img {
        position: absolute;
        width: ${unsafeCSS(String(TILE))}px;
        height: ${unsafeCSS(String(TILE))}px;
        -webkit-user-drag: none;
      }
      .marker {
        position: absolute;
        left: 0;
        top: 0;
        width: 28px;
        height: 28px;
        margin: -14px 0 0 -14px;
        pointer-events: none;
        filter: drop-shadow(0 3px 5px rgba(0, 0, 0, 0.28));
      }
      .bar {
        position: absolute;
        left: 12px;
        right: auto;
        max-width: calc(100% - 72px);
        bottom: 12px;
        z-index: 6;
        display: flex;
        gap: 6px;
        flex-wrap: wrap;
        align-items: center;
        padding: 5px 8px;
        font-size: 10px;
        line-height: 1.5;
        color: var(--primary-text-color, #222);
        background: color-mix(in srgb,var(--ha-card-background,var(--lm-surface-control, var(--card-background-color,#fff))) 65%,transparent);
        border-radius: var(--lm-radius-control, 8px);
        pointer-events: none;
      }
      .bar .name {
        font-weight: 600;
        font-size: 11px;
      }
      .bar .sub {
        opacity: 0.75;
      }
      .marker svg { width: 28px; height: 28px; }
      .btns {
        position: absolute;
        right: 12px;
        top: 12px;
        z-index: 8;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      /* 小按钮统一: 白底(卡片同款) + 一层阴影(1.9.40 起与控车卡同款: 不描边, 见那边
         ".sec, .half, .pick, .circ" 那一组的说明); hover 淡蓝; 选中主题蓝。
         ⚠️ border: 0 不能省: 只删掉原 1px 会让 <button> 露出 UA 默认的 2px outset 描边。 */
      .btns button {
        width: 32px;
        height: 32px;
        border-radius: var(--lm-radius-control, 8px);
        cursor: pointer;
        border: 0;
        background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
        color: var(--primary-text-color, #222);
        box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
        font-size: 16px;
        line-height: 1;
        transition: background 0.15s ease;
      }
      .btns button:not(.on):hover {
        background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
      }
      .btns button.on {
        background: var(--primary-color, #03a9f4);
        color: var(--text-primary-color, #fff);
        /* 1.9.40 起不再需要 border-color: transparent(底色已换成实心主题色, 边框整条已去) */
      }
      /* 底图切换按钮显示文字(路网/卫星/深色)或用"自动"图标, 字号小一点才放得下 */
      .btns button.style {
        font-size: 11px;
        font-weight: 600;
        letter-spacing: -0.5px;
      }
      .btns button.style ha-icon {
        width: 18px;
        height: 18px;
        --mdc-icon-size: 18px;
      }
      .zones {
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        z-index: 3;
        pointer-events: none;
      }
      .zone {
        position: absolute;
        border: 2px solid rgba(33, 150, 243, 0.85);
        border-radius: 50%;
        background: rgba(33, 150, 243, 0.14);
        box-sizing: border-box;
      }
      .zone span {
        position: absolute;
        left: 50%;
        top: -18px;
        transform: translateX(-50%);
        font-size: 11px;
        white-space: nowrap;
        padding: 1px 6px;
        border-radius: var(--lm-radius-badge, 999px);
        background: rgba(33, 150, 243, 0.85);
        color: #fff;
      }
      /* 地图中心红点(简单一点的标记, 取代原来的十字准星) */
      .crosshair {
        position: absolute;
        left: 50%;
        top: 50%;
        width: 20px;
        height: 20px;
        margin: -10px 0 0 -10px;
        z-index: 7;
        pointer-events: none;
        filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.35));
      }
      .panel {
        position: absolute;
        left: 8px;
        right: 8px;
        bottom: 30px;
        display: none;
        z-index: 10;
        touch-action: auto; /* 面板里要能点、能输入, 不能被地图的拖拽规则吃掉 */
        padding: 6px 8px;
        border-radius: 10px;
        font-size: 12px;
        background: var(--lm-surface-control, var(--card-background-color, #fff));
        color: var(--primary-text-color, #222);
        /* 1.9.40 起与控制卡同款: 浮层不描边, 只靠一层阴影(原来是 1px 灰边 + 0 1px 4px/.2) */
        border: 0;
        box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
      }
      .panel.on {
        display: block;
      }
      /* 文本/数值输入框: **有意保留** 1px 描边(表单控件没有边框会显得没做完; 与控制卡里
         .tinput 的处置一致) —— 1.9.40 的"去边框"只覆盖面板/按钮。 */
      .panel input {
        box-sizing: border-box;
        padding: 4px 6px;
        font-size: 12px;
        min-width: 0;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 6px;
        background: var(--lm-surface-control, var(--card-background-color, #fff));
        color: inherit;
      }
      .panel .zname {
        flex: 1 1 auto;
      }
      .panel .zradius {
        flex: 0 0 62px;
      }
      .panel .row {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .panel .row + .row {
        margin-top: 5px;
      }
      /* 面板里的按钮(保存/取消/改/删): 与卡片其它按钮同款 —— 白底 + 一层阴影, 不描边
         (原 1px 灰边改成 0 1px 4px/.16; ⚠️ 显式 border: 0 挡掉 UA 的 2px outset 默认描边) */
      .panel button {
        flex: 1;
        padding: 5px 6px;
        font-size: 12px;
        cursor: pointer;
        border-radius: var(--lm-radius-control, 8px);
        white-space: nowrap;
        border: 0;
        background: var(--lm-surface-section, var(--ha-card-background, var(--card-background-color, #fff)));
        color: inherit;
        box-shadow: var(--lm-shadow-section, 0 1px 4px rgba(0, 0, 0, .16));
        transition: background 0.15s ease;
      }
      .panel button:not(.primary):not(.armed):not(.danger):not([disabled]):hover {
        background: rgba(var(--rgb-primary-color, 3, 169, 244), 0.12);
      }
      .panel button.primary {
        background: var(--primary-color, #03a9f4);
        /* 原来是 border-color: 主题色 —— 整条边框已去, 实心主题底色自己就表达了"主按钮" */
        color: #fff;
        font-weight: 600;
      }
      .panel .msg {
        margin-top: 4px;
        font-size: 11px;
        opacity: 0.85;
        min-height: 13px;
      }
      .panel .zlist {
        max-height: 168px;
        overflow: auto;
      }
      .zrow {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 3px 0;
      }
      .zrow + .zrow {
        border-top: 1px solid var(--divider-color, #eee);
      }
      .zrow .nm {
        flex: 1 1 auto;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      /* 可编辑半径: 小输入框 + 「改」按钮 —— 输入框**有意保留** 1px 描边(同 .panel input) */
      .zrow .zrad {
        flex: 0 0 56px;
        width: 56px;
        padding: 3px 4px;
        font-size: 11px;
        border: 1px solid var(--divider-color, #ccc);
        border-radius: 6px;
        background: var(--lm-surface-control, var(--card-background-color, #fff));
        color: inherit;
      }
      .zrow button {
        flex: 0 0 auto;
        padding: 3px 8px;
        font-size: 11px;
      }
      /* 「删」: 危险操作 —— 这一圈红是**语义描边**, 按 1.9.40 的口径保留(其余按钮才去边框)。
         ⚠️ 必须写整条 border(基类 .panel button 是 border: 0, 只写 border-color 没宽度不生效)。 */
      .zrow button.danger {
        border: 1px solid var(--error-color, #db4437);
        color: var(--error-color, #db4437);
      }
      /* 「确认删除」: 红底白字本身就是状态, 不再需要一圈与底色同色的边框 */
      .zrow button.armed {
        background: var(--error-color, #db4437);
        color: #fff;
      }
      .hint {
        position: absolute;
        left: 10px;
        top: 10px;
        z-index: 11;
        display: none;
        padding: 4px 8px;
        border-radius: 6px;
        font-size: 12px;
        background: rgba(0, 0, 0, 0.6);
        color: #fff;
      }
    `,
    /* 共享控件层: 必须放在**最后**(同特异度下由它定稿), 见 src/lib/ui/styles.ts */
    css`${unsafeCSS(uiStyles)}`,
  ];
}

/* ── 注册(带 registry-swap 自愈守卫) ── */
defineCard("leapmotor-map", LeapmotorMapCard as unknown as CustomElementConstructor);

registerCustomCard({
  type: "leapmotor-map",
  name: "零跑车辆地图",
  description: "高德底图 + 车辆实时位置(国内可直接显示底图)",
  preview: false,
  documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
});

banner("零跑车辆地图", CARD_VERSION, "#e53935");
