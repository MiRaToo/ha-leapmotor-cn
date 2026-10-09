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
 *   satellite: true     # 用卫星底图(默认用路网图)
 *   follow: true        # 车动了自动跟随居中(默认 true; 手动拖动后自动关闭)
 *
 * 这张卡专注"看车的位置 + 编辑/新增地理围栏": 只画车标与 HA 的区域(围栏)圆圈,
 * 行程轨迹改由「零跑·行程浏览」卡片负责(那里有缩略图/大图/叠加)。
 * (v1.6 起不再画 `sensor.*_xing_cheng_gui_ji` 的最近一段轨迹。)
 *
 * 这个文件由集成自动注册为前端模块(见 custom_components/leapmotor/__init__.py),
 * 用户不需要把它拷到 www/ 或手配资源。
 */

const TILE = 256;

/* ── WGS-84 → GCJ-02(国测局偏移公式; 国境外原样返回) ── */
const A_GCJ = 6378245.0;
const EE_GCJ = 0.00669342162296594323;

function outOfChina(lat, lon) {
  return !(lon > 73.66 && lon < 135.05 && lat > 3.86 && lat < 53.55);
}

function transformLat(x, y) {
  let r = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(y * Math.PI) + 40.0 * Math.sin((y / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((160.0 * Math.sin((y / 12.0) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

/* GCJ-02 的**经度**多项式(与 transformLat 是两个不同公式)。
   ⚠️ 坑: 这里曾错误地复用 transformLat(经度也用纬度多项式) ——
   与 Python 侧同源, 两处一起改; 见 poller/api_client.py `_transform_lon` 的说明。 */
function transformLon(x, y) {
  let r = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  r += ((20.0 * Math.sin(6.0 * x * Math.PI) + 20.0 * Math.sin(2.0 * x * Math.PI)) * 2.0) / 3.0;
  r += ((20.0 * Math.sin(x * Math.PI) + 40.0 * Math.sin((x / 3.0) * Math.PI)) * 2.0) / 3.0;
  r += ((150.0 * Math.sin((x / 12.0) * Math.PI) + 300.0 * Math.sin((x * Math.PI) / 30.0)) * 2.0) / 3.0;
  return r;
}

function gcj02ToWgs84(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE_GCJ * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A_GCJ / sqrtMagic) * Math.cos(radLat) * Math.PI);
  // 再迭代一次, 把误差压到亚米级
  const wLat = lat - dLat;
  const wLon = lon - dLon;
  let dLat2 = transformLat(wLon - 105.0, wLat - 35.0);
  let dLon2 = transformLon(wLon - 105.0, wLat - 35.0);
  const radLat2 = (wLat / 180.0) * Math.PI;
  let magic2 = Math.sin(radLat2);
  magic2 = 1 - EE_GCJ * magic2 * magic2;
  const sqrtMagic2 = Math.sqrt(magic2);
  dLat2 = (dLat2 * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic2 * sqrtMagic2)) * Math.PI);
  dLon2 = (dLon2 * 180.0) / ((A_GCJ / sqrtMagic2) * Math.cos(radLat2) * Math.PI);
  return [lat - dLat2, lon - dLon2];
}

function wgs84ToGcj02(lat, lon) {
  if (outOfChina(lat, lon)) return [lat, lon];
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * Math.PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE_GCJ * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A_GCJ * (1 - EE_GCJ)) / (magic * sqrtMagic)) * Math.PI);
  dLon = (dLon * 180.0) / ((A_GCJ / sqrtMagic) * Math.cos(radLat) * Math.PI);
  return [lat + dLat, lon + dLon];
}

/* 高德瓦片模板。{s} 是 1~4 的负载均衡序号。 */
const TILE_SOURCES = {
  vector:
    "https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}",
  satellite: "https://webst0{s}.is.autonavi.com/appmaptile?style=6&x={x}&y={y}&z={z}",
};
/* 高德连不上时回落到 OSM(海外用户/高德故障时至少还能看图) */
const TILE_FALLBACK = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

const CARD_VERSION = "1.6.1";

/** 经纬度 → 世界像素坐标(标准 Web 墨卡托, 与高德/OSM 一致)。 */
function project(lat, lon, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const x = ((lon + 180) / 360) * scale;
  const sin = Math.sin((lat * Math.PI) / 180);
  const y = (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale;
  return [x, y];
}

function unproject(x, y, zoom) {
  const scale = TILE * Math.pow(2, zoom);
  const lon = (x / scale) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / scale;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return [lat, lon];
}

/** 自动找"车辆位置"实体: 优先本集成的 tracker, 其次名字里带 leapmotor 的 tracker。 */
function pickTracker(hass) {
  if (!hass || !hass.states) return "";
  const ids = Object.keys(hass.states).filter((e) => e.startsWith("device_tracker."));
  const ours = ids.filter((e) => /ling_pao|leapmotor/.test(e));
  const cand = (ours.length ? ours : ids).filter((e) => {
    const a = hass.states[e].attributes || {};
    return a.latitude != null && a.longitude != null;
  });
  return cand[0] || "";
}

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

class LeapmotorMapCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._zoom = 16;
    this._center = null;      // [lat, lon]
    this._follow = true;
    this._dragging = false;
    this._tiles = new Map();  // "z/x/y" → <img>
    this._marker = null;
    this._built = false;
  }

  /** 从卡片选择器添加时, 自动填好车辆位置实体(用户不用自己找)。 */
  static getStubConfig(hass) {
    return { entity: pickTracker(hass) || "", zoom: 16, height: 320 };
  }

  setConfig(config) {
    // 不抛异常 —— 没填实体时自动识别(否则 HA 只会显示一张"配置错误"卡片,
    // 用户完全不知道该怎么办)。真正找不到时才在卡片上给一句提示。
    this._config = {
      zoom: 16,
      height: 320,
      satellite: false,
      follow: true,
      ...(config || {}),
    };
    // 高德瓦片 z=19 在很多区域没有数据(会返回空白图), 所以上限取 18
    this._zoom = clamp(Number(this._config.zoom) || 16, 3, 18);
    this._follow = this._config.follow !== false;
    this._tiles.forEach((img) => img.remove());
    this._tiles.clear();
    this._built = false;
    this._center = null;
    this._render();
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config.entity) {
      const guess = pickTracker(hass);
      if (guess) {
        this._config.entity = guess;          // 自动识别, 用户什么都不用填
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
    if (moved) this._renderMarker();
    this._renderInfo();
  }

  /** 开关"管理区域"面板: 列出卡片/HA 里用界面建的区域, 可定位与删除。 */
  async _toggleZoneList() {
    const on = !this._zpanel.classList.contains("on");
    this._panel.classList.remove("on");
    this._zpanel.classList.toggle("on", on);
    if (!on) return;
    if (!this._hass || !this._hass.callWS) {
      this._zmsg.textContent = "当前环境不支持读取区域列表";
      return;
    }
    if (this._hass.user && !this._hass.user.is_admin) {
      this._zmsg.textContent = "⚠️ 需要管理员权限才能删除区域";
    }
    await this._loadZoneList();
  }

  async _loadZoneList() {
    this._zmsg.textContent = "读取中…";
    try {
      const list = await this._hass.callWS({ type: "zone/list" });
      this._zoneItems = Array.isArray(list) ? list : [];
    } catch (err) {
      this._zoneItems = [];
      this._zmsg.textContent = "读取失败:" + String(err && err.message ? err.message : err).slice(0, 70);
      return;
    }
    if (!this._zoneItems.length) {
      this._zlist.innerHTML = "";
      this._zmsg.textContent = "还没有用界面建过区域 —— 点右上角「＋」建一个";
      return;
    }
    this._zmsg.textContent = `共 ${this._zoneItems.length} 个区域(点「删」会先变成确认, 再点一次才真删)`;
    this._zlist.innerHTML = this._zoneItems
      .map((z) => {
        const r = Math.round(Number(z.radius) || 100);
        const nm = String(z.name || z.id || "?").replace(/[<>&]/g, "");
        return (
          '<div class="zrow" data-id="' + String(z.id) + '">' +
          '<span class="nm">' + nm + '</span><span class="rd">' + r + 'm</span>' +
          '<button data-zz="go">定位</button>' +
          '<button data-zz="del" class="danger">删</button>' +
          "</div>"
        );
      })
      .join("");
  }

  /** 把地图移到某个区域(定位)。 */
  _gotoZone(id) {
    const z = (this._zoneItems || []).find((x) => String(x.id) === String(id));
    if (!z || z.latitude == null) return;
    const [glat, glon] = wgs84ToGcj02(Number(z.latitude), Number(z.longitude));
    this._center = [glat, glon];
    const r = Number(z.radius) || 100;
    const rect = this._wrap.getBoundingClientRect();
    const h = rect.height || this._config.height || 320;
    // 让圆圈大致占满一半高度
    const want = (156543.03392 * Math.cos((glat * Math.PI) / 180)) / (r * 4);
    this._zoom = Math.max(3, Math.min(18, Math.round(Math.log2(want * h))));
    this._setFollow(false);
    this._zpanel.classList.remove("on");
    this._renderTiles();
    this._renderZones();
    this._renderMarker();
  }

  /** 删除某个区域(界面建的 zone; 需要管理员权限)。 */
  async _deleteZone(id, btn) {
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.classList.add("armed");
      btn.textContent = "确认删";
      setTimeout(() => {                        // 3 秒内没确认就复位, 防止误触
        if (btn.dataset.armed) {
          delete btn.dataset.armed;
          btn.classList.remove("armed");
          btn.textContent = "删";
        }
      }, 3000);
      return;
    }
    this._zmsg.textContent = "删除中…";
    try {
      await this._hass.callWS({ type: "zone/delete", zone_id: id });
      await this._loadZoneList();
    } catch (err) {
      this._zmsg.textContent = "删除失败:" + String(err && err.message ? err.message : err).slice(0, 70);
    }
  }

  /** 开关"建区域"面板(类名、准星、重绘都在这里统一处理, 避免漏掉重绘)。 */
  _setPanel(on) {
    if (on && this._zpanel) this._zpanel.classList.remove("on");
    this._panel.classList.toggle("on", on);
    // 面板高度变了 → 焦点位置变了 → 底图/车标/区域都要按新焦点重画
    this._renderTiles();
    this._renderZones();
    this._renderMarker();
  }

  /** 准星(也就是"地图中心")在卡片内的屏幕坐标 —— 就是显示区域的正中心。 */
  _focusPoint() {
    const rect = this._wrap.getBoundingClientRect();
    const w = rect.width || this._wrap.clientWidth || 400;
    const h = rect.height || this._config.height || 320;
    return [w / 2, h / 2];
  }

  /** 打开/收起"建区域"面板。 */
  _toggleZonePanel() {
    const on = !this._panel.classList.contains("on");
    this._setPanel(on);
    if (on) {
      const el = this.shadowRoot.querySelector(".zname");
      if (el && !el.value) el.value = "停车位";
      this._panelMsg.textContent = this._hass && this._hass.user && !this._hass.user.is_admin
        ? "⚠️ 需要管理员权限才能创建区域"
        : "把地图拖到要圈的位置(准星处), 或用「用车的位置」—— 然后点「创建区域」";
    }
  }

  /** 用地图中心或车辆位置创建 HA 区域(zone) —— 走官方 WS 接口 zone/create。 */
  async _createZone(where) {
    const nameEl = this.shadowRoot.querySelector(".zname");
    const radEl = this.shadowRoot.querySelector(".zradius");
    const name = (nameEl.value || "").trim();
    const radius = Math.max(20, Math.min(5000, Number(radEl.value) || 200));
    if (!name) {
      this._panelMsg.textContent = "请先填区域名称";
      return;
    }
    if (!this._hass || !this._hass.callWS) {
      this._panelMsg.textContent = "当前环境不支持创建区域(需要在 Home Assistant 里打开)";
      return;
    }
    // 输入用的是 WGS-84(与 HA 区域一致), 不能直接用显示坐标(那是 GCJ-02)
    let lat, lon;
    if (where === "car") {
      if (this._latWgs == null) {
        this._panelMsg.textContent = "还没有车辆定位";
        return;
      }
      [lat, lon] = [this._latWgs, this._lonWgs];
    } else {
      [lat, lon] = gcj02ToWgs84(this._center[0], this._center[1]);
    }
    this._panelMsg.textContent = "正在创建…";
    try {
      await this._hass.callWS({
        type: "zone/create",
        name,
        latitude: Number(lat.toFixed(6)),
        longitude: Number(lon.toFixed(6)),
        radius,
        icon: "mdi:map-marker",
      });
      this._panel.classList.remove("on");
      if (this._crosshair) this._crosshair.classList.remove("on");
      this._renderTiles();
      this._renderZones();
      this._renderMarker();
    } catch (err) {
      this._panelMsg.textContent = "创建失败:" + String(err && err.message ? err.message : err).slice(0, 80);
    }
  }

  /** 把 HA 里所有 zone 画成圆圈(高德底图是 GCJ-02, 所以中心要换算)。 */
  _renderZones() {
    if (!this._zonesLayer || !this._hass || !this._center) return;
    const rect = this._wrap.getBoundingClientRect();
    const w = rect.width || this._wrap.clientWidth || 400;
    const h = rect.height || this._config.height;
    const z = this._zoom;
    const [cx, cy] = project(this._center[0], this._center[1], z);
    const [fx, fy] = this._focusPoint();
    const mpp = (156543.03392 * Math.cos((this._center[0] * Math.PI) / 180)) / Math.pow(2, z);
    const wanted = new Set();
    for (const st of Object.values(this._hass.states)) {
      if (!st.entity_id.startsWith("zone.")) continue;
      const a = st.attributes || {};
      if (a.latitude == null || a.longitude == null) continue;
      const radius = Number(a.radius) || 100;
      wanted.add(st.entity_id);
      let el = this._zonesLayer.querySelector(`[data-zone="${st.entity_id}"]`);
      if (!el) {
        el = document.createElement("div");
        el.className = "zone";
        el.dataset.zone = st.entity_id;
        el.innerHTML = "<span></span>";
        this._zonesLayer.appendChild(el);
      }
      const [glat, glon] = wgs84ToGcj02(a.latitude, a.longitude);   // 显示坐标系
      const [zx, zy] = project(glat, glon, z);
      const rpx = radius / mpp;
      el.style.width = `${rpx * 2}px`;
      el.style.height = `${rpx * 2}px`;
      el.style.left = `${zx - cx + fx - rpx}px`;
      el.style.top = `${zy - cy + fy - rpx}px`;
      el.querySelector("span").textContent = a.friendly_name || st.entity_id.slice(5);
    }
    this._zonesLayer.querySelectorAll(".zone").forEach((el) => {
      if (!wanted.has(el.dataset.zone)) el.remove();
    });
  }

  /** 把实体坐标换算成"底图坐标系"(高德瓦片是 GCJ-02)。 */
  _toDisplay(lat, lon, st) {
    const mode = this._config.coordinate_system || "auto";
    if (mode === "gcj02") return [lat, lon];
    if (mode === "wgs84") return wgs84ToGcj02(lat, lon);
    // auto: 实体自己声明是火星坐标就不换算, 否则按 WGS-84 处理(集成默认)
    const declared = String((st.attributes && st.attributes.coordinate_system) || "").toUpperCase();
    return declared.includes("GCJ") ? [lat, lon] : wgs84ToGcj02(lat, lon);
  }

  getCardSize() {
    const cfg = this._config || {};
    return Math.ceil((cfg.height || 320) / 50) + 1;
  }

  // ── 渲染 ──
  _render() {
    if (!this._config) return;
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

  _renderHint(text) {
    if (!this._built) {
      this._build();
      this._built = true;
    }
    if (this._hintEl) this._hintEl.textContent = text;
    if (this._hintEl) this._hintEl.style.display = "block";
  }

  _build() {
    const h = Number(this._config.height) || 320;
    this.shadowRoot.innerHTML = `
      <style>
        :host { display: block; }
        .wrap {
          position: relative; width: 100%; height: ${h}px;
          /* 必须用 clip 而不是 hidden: hidden 仍是可滚动容器, 一旦容器被滚动
             (浏览器把按钮滚进视野、手势等), 里面绝对定位的瓦片和车标会整体偏移 */
          overflow: clip; border-radius: var(--ha-card-border-radius, 12px);
          background: var(--card-background-color, #fff);
          cursor: grab; touch-action: none; user-select: none;
        }
        .wrap.dragging { cursor: grabbing; }
        .layer { position: absolute; left: 0; top: 0; z-index: 0; will-change: transform; }
        .overlay { position: absolute; left: 0; top: 0; width: 100%; height: 100%;
                   z-index: 5; pointer-events: none; }
        .layer img {
          position: absolute; width: ${TILE}px; height: ${TILE}px;
          -webkit-user-drag: none;
        }
        .marker {
          position: absolute; left: 0; top: 0; width: 34px; height: 34px;
          margin: -17px 0 0 -17px; pointer-events: none;
          filter: drop-shadow(0 2px 3px rgba(0,0,0,.45));
        }
        .bar {
          position: absolute; left: 0; right: 0; bottom: 0; z-index: 6; display: flex; gap: 8px;
          align-items: center; padding: 6px 10px; font-size: 12px; line-height: 1.5;
          color: var(--primary-text-color, #222);
          background: linear-gradient(to top, rgba(255,255,255,.92), rgba(255,255,255,0));
        }
        .bar .name { font-weight: 600; }
        .bar .sub { opacity: .75; }
        .btns {
          position: absolute; right: 8px; top: 8px; z-index: 8; display: flex; flex-direction: column;
          gap: 6px;
        }
        /* 小按钮统一: 白底(卡片同款) + 灰边 + 与外框同款轻阴影; hover 淡蓝; 选中主题蓝 */
        .btns button {
          width: 32px; height: 32px; border-radius: 8px; cursor: pointer;
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          background: var(--ha-card-background, var(--card-background-color, #fff));
          color: var(--primary-text-color, #222);
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
          font-size: 16px; line-height: 1;
          transition: background .15s ease;
        }
        .btns button:not(.on):hover { background: rgba(var(--rgb-primary-color, 3, 169, 244), .12); }
        .btns button.on {
          background: var(--primary-color, #03a9f4); color: var(--text-primary-color, #fff);
          border-color: transparent;
        }
        .zones { position: absolute; left: 0; top: 0; width: 100%; height: 100%; z-index: 3; pointer-events: none; }
        .zone {
          position: absolute; border: 2px solid rgba(33,150,243,.85); border-radius: 50%;
          background: rgba(33,150,243,.14); box-sizing: border-box;
        }
        .zone span {
          position: absolute; left: 50%; top: -18px; transform: translateX(-50%);
          font-size: 11px; white-space: nowrap; padding: 1px 6px; border-radius: 999px;
          background: rgba(33,150,243,.85); color: #fff;
        }
        /* 准星: 始终显示在地图正中心, 也是"地图中心"建区域时用的位置 */
        .crosshair {
          position: absolute; left: 50%; top: 50%; width: 20px; height: 20px;
          margin: -10px 0 0 -10px; z-index: 7; pointer-events: none;
          filter: drop-shadow(0 1px 1px rgba(0,0,0,.35));
        }
        .panel {
          position: absolute; left: 8px; right: 8px; bottom: 30px; display: none; z-index: 10;
          touch-action: auto;                 /* 面板里要能点、能输入, 不能被地图的拖拽规则吃掉 */
          padding: 6px 8px; border-radius: 10px; font-size: 12px;
          background: var(--card-background-color, #fff); color: var(--primary-text-color, #222);
          border: 1px solid var(--divider-color, #ccc); box-shadow: 0 2px 8px rgba(0,0,0,.2);
        }
        .panel.on { display: block; }
        .panel input {
          box-sizing: border-box; padding: 4px 6px; font-size: 12px; min-width: 0;
          border: 1px solid var(--divider-color, #ccc); border-radius: 6px;
          background: var(--card-background-color, #fff); color: inherit;
        }
        .panel .zname { flex: 1 1 auto; }
        .panel .zradius { flex: 0 0 62px; }
        .panel .row { display: flex; gap: 6px; align-items: center; }
        .panel .row + .row { margin-top: 5px; }
        .panel button {
          flex: 1; padding: 5px 6px; font-size: 12px; cursor: pointer; border-radius: 8px;
          white-space: nowrap;
          border: 1px solid var(--divider-color, rgba(0, 0, 0, .09));
          background: var(--ha-card-background, var(--card-background-color, #fff));
          color: inherit;
          box-shadow: 0 1px 3px rgba(0, 0, 0, .13);
          transition: background .15s ease;
        }
        .panel button:not(.primary):not(.armed):not(.danger):not([disabled]):hover {
          background: rgba(var(--rgb-primary-color, 3, 169, 244), .12);
        }
        .panel button.primary {
          background: var(--primary-color, #03a9f4); border-color: var(--primary-color, #03a9f4);
          color: #fff; font-weight: 600;
        }
        .panel .msg { margin-top: 4px; font-size: 11px; opacity: .85; min-height: 13px; }
        .panel .zlist { max-height: 168px; overflow: auto; }
        .zrow { display: flex; align-items: center; gap: 6px; padding: 3px 0; }
        .zrow + .zrow { border-top: 1px solid var(--divider-color, #eee); }
        .zrow .nm { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .zrow .rd { opacity: .6; font-size: 11px; }
        .zrow button { flex: 0 0 auto; padding: 3px 8px; font-size: 11px; }
        .zrow button.danger { border-color: var(--error-color, #db4437); color: var(--error-color, #db4437); }
        .zrow button.armed { background: var(--error-color, #db4437); color: #fff; border-color: var(--error-color, #db4437); }
        .hint {
          position: absolute; left: 10px; top: 10px; z-index: 11; display: none;
          padding: 4px 8px; border-radius: 6px; font-size: 12px;
          background: rgba(0,0,0,.6); color: #fff;
        }
      </style>
      <div class="wrap">
        <div class="layer"></div>
        <div class="zones"></div>
        <div class="crosshair">
          <svg viewBox="0 0 20 20" width="20" height="20">
            <g stroke="#fff" stroke-width="3" opacity=".9" stroke-linecap="round">
              <line x1="10" y1="1" x2="10" y2="5"/><line x1="10" y1="15" x2="10" y2="19"/>
              <line x1="1" y1="10" x2="5" y2="10"/><line x1="15" y1="10" x2="19" y2="10"/>
            </g>
            <g stroke="#e53935" stroke-width="1.4" stroke-linecap="round">
              <line x1="10" y1="1" x2="10" y2="5"/><line x1="10" y1="15" x2="10" y2="19"/>
              <line x1="1" y1="10" x2="5" y2="10"/><line x1="15" y1="10" x2="19" y2="10"/>
            </g>
            <circle cx="10" cy="10" r="1.4" fill="#e53935" stroke="#fff" stroke-width="1"/>
          </svg>
        </div>
        <div class="overlay"></div>
        <div class="btns">
          <button data-a="in" title="放大">＋</button>
          <button data-a="out" title="缩小">－</button>
          <button data-a="follow" title="跟随车辆">◎</button>
          <button data-a="zone" title="建一个区域(围栏)">＋</button>
          <button data-a="zones" title="管理区域(定位/删除)">☰</button>
        </div>
        <div class="panel">
          <div class="row">
            <input class="zname" type="text" placeholder="区域名称(默认 停车位)">
            <input class="zradius" type="number" min="20" max="5000" step="10" value="200" title="半径(米)">
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
      </div>`;
    this._wrap = this.shadowRoot.querySelector(".wrap");
    this._layer = this.shadowRoot.querySelector(".layer");
    this._overlay = this.shadowRoot.querySelector(".overlay");
    this._zonesLayer = this.shadowRoot.querySelector(".zones");
    this._crosshair = this.shadowRoot.querySelector(".crosshair");
    this._panel = this.shadowRoot.querySelector(".panel");
    this._zpanel = this.shadowRoot.querySelector(".zpanel");
    this._zlist = this.shadowRoot.querySelector(".zpanel .zlist");
    this._zmsg = this.shadowRoot.querySelector(".zpanel .msg");
    this._panelMsg = this.shadowRoot.querySelector(".panel .msg");
    this._hintEl = this.shadowRoot.querySelector(".hint");
    this._nameEl = this.shadowRoot.querySelector(".bar .name");
    this._subEl = this.shadowRoot.querySelector(".bar .sub");
    this._followBtn = this.shadowRoot.querySelector('button[data-a="follow"]');

    this._zlist.addEventListener("click", (ev) => {
      const b = ev.target.closest("button");
      if (!b) return;
      ev.stopPropagation();
      const row = b.closest(".zrow");
      if (!row) return;
      if (b.dataset.zz === "go") this._gotoZone(row.dataset.id);
      else if (b.dataset.zz === "del") this._deleteZone(row.dataset.id, b);
    });
    this.shadowRoot.querySelectorAll(".panel button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const z = b.dataset.z || b.dataset.zm;   // 兼容两种写法, 免得再踩属性名不一致
        if (z === "cancel") this._setPanel(false);
        else if (z === "close") this._zpanel.classList.remove("on");
        else if (z === "create") this._createZone(this._zoneAnchor || "center");
        else if (z === "car" || z === "center") {
          this._zoneAnchor = z;
          this._panelMsg.textContent =
            z === "car"
              ? "位置 = 车辆当前位置(点「创建区域」)"
              : "位置 = 准星处的地图中心(拖动地图可调整)";
        }
      });
    });
    this.shadowRoot.querySelectorAll(".btns button").forEach((b) => {
      b.addEventListener("click", (ev) => {
        ev.stopPropagation();
        this._onButton(b.dataset.a);
      });
    });
    this._bindPointer();
    this._bindWheel();

    // 卡片尺寸变化(切到别的视图再切回来、改列宽)时要重算可视瓦片
    if (typeof ResizeObserver !== "undefined") {
      this._ro = new ResizeObserver(() => {
        if (this._center) this._renderTiles();
        this._renderMarker();
        this._renderZones();    // 改列宽/切视图后圈的大小与位置同样要重算
      });
      this._ro.observe(this._wrap);
    }
  }

  _bindPointer() {
    let start = null;
    this._wrap.addEventListener("pointerdown", (ev) => {
      // 落在按钮/面板上的指针事件必须放行 —— 一旦在这里 setPointerCapture,
      // 后续 pointerup 会被地图抢走, 按钮的 click 就永远不会触发
      if (ev.target.closest(".btns") || ev.target.closest(".panel")) return;
      this._wrap.setPointerCapture(ev.pointerId);
      start = { x: ev.clientX, y: ev.clientY, center: [...this._center] };
      this._dragging = false;
    });
    this._wrap.addEventListener("pointermove", (ev) => {
      if (!start) return;
      const dx = ev.clientX - start.x;
      const dy = ev.clientY - start.y;
      if (!this._dragging && Math.abs(dx) + Math.abs(dy) < 4) return;
      this._dragging = true;
      this._wrap.classList.add("dragging");
      const [cx, cy] = project(start.center[0], start.center[1], this._zoom);
      this._center = unproject(cx - dx, cy - dy, this._zoom);
      this._renderTiles();
      this._renderMarker();
      // 围栏(zone 圆圈)必须跟瓦片/车标一起走, 否则拖动时它停在原地、松手后
      // 要等下一次 hass 推送才"跳"到位(曾出现过的"延迟一下"就是这个)
      this._renderZones();
    });
    const end = (ev) => {
      if (!start) return;
      start = null;
      this._wrap.classList.remove("dragging");
      if (this._dragging) {
        this._setFollow(false);
      }
      this._dragging = false;
    };
    this._wrap.addEventListener("pointerup", end);
    this._wrap.addEventListener("pointercancel", end);
    this._wrap.addEventListener("dblclick", (ev) => {
      if (ev.target.closest(".panel") || ev.target.closest(".btns")) return;
      ev.stopPropagation();
      this._zoomAt(ev.clientX, ev.clientY, 1);
    });
  }

  _bindWheel() {
    this._wrap.addEventListener(
      "wheel",
      (ev) => {
        if (ev.target.closest(".panel") || ev.target.closest(".btns")) return;  // 面板里滚轮照常
        ev.preventDefault();      // 拦下页面滚动, 让滚轮专心缩放地图
        ev.stopPropagation();
        this._zoomAt(ev.clientX, ev.clientY, ev.deltaY < 0 ? 1 : -1);
      },
      { passive: false }
    );
  }

  _zoomAt(clientX, clientY, delta) {
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
    this._renderZones();      // 缩放同理: 圈的大小/位置都要当场重算
  }

  _onButton(action) {
    if (action === "in" || action === "out") {
      const rect = this._wrap.getBoundingClientRect();
      this._zoomAt(rect.left + rect.width / 2, rect.top + rect.height / 2, action === "in" ? 1 : -1);
    } else if (action === "zone") {
      this._toggleZonePanel();
    } else if (action === "zones") {
      this._toggleZoneList();
    } else if (action === "follow") {
      const on = !this._follow;
      this._setFollow(on);
      if (on && this._lat != null) {
        this._center = [this._lat, this._lon];
        this._renderTiles();
        this._renderMarker();
      }
    }
  }

  _setFollow(on) {
    this._follow = on;
    if (this._followBtn) this._followBtn.classList.toggle("on", on);
  }

  _tileUrl(z, x, y, fallback) {
    const conf = this._config;
    let tpl = conf.tiles || (conf.satellite ? TILE_SOURCES.satellite : TILE_SOURCES.vector);
    if (fallback) tpl = TILE_FALLBACK;
    const s = ((x + y) % 4) + 1;
    return tpl
      .replace("{s}", String(s))
      .replace("{z}", String(z))
      .replace("{x}", String(x))
      .replace("{y}", String(y));
  }

  _renderTiles() {
    if (!this._wrap || !this._center) return;
    // 双保险: 任何情况下都不允许容器带着滚动偏移渲染
    if (this._wrap.scrollLeft || this._wrap.scrollTop) {
      this._wrap.scrollLeft = 0;
      this._wrap.scrollTop = 0;
    }
    const rect = this._wrap.getBoundingClientRect();
    const w = rect.width || this._wrap.clientWidth || 400;
    const h = rect.height || this._config.height;
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
    const needed = new Set();

    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (y < 0 || y >= max) continue;
        const wx = ((x % max) + max) % max;      // 经度方向绕回
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
          this._layer.appendChild(img);
        }
        const img = this._tiles.get(key);
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
    this._layer.style.transform = "translate(0,0)";
  }

  _renderMarker() {
    if (!this._wrap || this._lat == null) return;
    const rect = this._wrap.getBoundingClientRect();
    const w = rect.width || this._wrap.clientWidth || 400;
    const h = rect.height || this._config.height;
    const [cx, cy] = project(this._center[0], this._center[1], this._zoom);
    const [mx, my] = project(this._lat, this._lon, this._zoom);
    const [fx, fy] = this._focusPoint();
    if (!this._marker) {
      this._marker = document.createElement("div");
      this._marker.className = "marker";
      this._marker.innerHTML = `
        <svg viewBox="0 0 24 24" width="34" height="34">
          <path fill="#e53935" stroke="#fff" stroke-width="1.5"
                d="M12 2C8.1 2 5 5.1 5 9c0 5.2 7 13 7 13s7-7.8 7-13c0-3.9-3.1-7-7-7z"/>
          <circle cx="12" cy="9" r="2.6" fill="#fff"/>
        </svg>`;
      this._overlay.appendChild(this._marker);
    }
    this._marker.style.transform = `translate(${mx - cx + fx}px, ${my - cy + fy}px)`;
  }

  _renderInfo() {
    if (!this._nameEl || !this._stateObj) return;
    const st = this._stateObj;
    this._nameEl.textContent = st.attributes.friendly_name || this._config.entity;
    const parts = [];
    if (st.attributes.vehicle_state) {
      parts.push(st.attributes.vehicle_state === "driving" ? "行驶中" : "已驻车");
    }
    if (st.attributes.odometer != null) parts.push(`总里程 ${Math.round(st.attributes.odometer)} km`);
    if (st.attributes.speed) parts.push(`车速 ${Math.round(st.attributes.speed)} km/h`);
    this._subEl.textContent = parts.join(" · ");
  }
}

if (!customElements.get("leapmotor-map")) {
  customElements.define("leapmotor-map", LeapmotorMapCard);
}

window.customCards = window.customCards || [];
if (!window.customCards.some((c) => c.type === "leapmotor-map")) {
  window.customCards.push({
    type: "leapmotor-map",
    name: "零跑车辆地图",
    description: "高德底图 + 车辆实时位置(国内可直接显示底图)",
    preview: false,
    documentationURL: "https://github.com/MiRaToo/ha-leapmotor-cn/blob/main/docs/dashboard.md",
  });
}

console.info(`%c 零跑车辆地图 ${CARD_VERSION} `, "color:#fff;background:#e53935;border-radius:3px");
