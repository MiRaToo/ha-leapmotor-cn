// 冒烟测试: 在 JSDOM 里挂载**构建产物**(www/leapmotor-*.js), 验证关键渲染行为 ——
// 这是"产物是否真的能跑"的门禁, 不依赖 HA。node tools/card-smoke.mjs
//
// 覆盖(每一张卡):
//   1. 元素能被注册(customElements.get 有值)
//   2. 挂载 + 给 hass 后 shadow DOM 非空
//   3. ipIcon 的 SVG **真的成为 <svg> 节点**(而不是被转义成文字 "<svg ...")
//   4. energy 卡: header 标题/控件/图表容器在 hass 更新后可渲染(不因 Lit 异步而空壳)
import { JSDOM } from "jsdom";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WWW = resolve(ROOT, "custom_components/leapmotor/www");

/** 把 JSDOM 的浏览器全局装到 globalThis, 让按 ESM 加载的 bundle 能用它们。 */
function installGlobals(window) {
  const g = globalThis;
  g.window = window;
  g.document = window.document;
  g.HTMLElement = window.HTMLElement;
  g.customElements = window.customElements;
  g.customCards = window.customCards;
  g.SVGElement = window.SVGElement;
  g.requestAnimationFrame = window.requestAnimationFrame;
  g.cancelAnimationFrame = window.cancelAnimationFrame;
  g.ResizeObserver = window.ResizeObserver;
  g.IntersectionObserver = window.IntersectionObserver;
  // Lit(LitElement)需要 CSSStyleSheet/adoptedStyleSheets 来挂 static styles
  g.CSSStyleSheet = window.CSSStyleSheet;
  g.DocumentFragment = window.DocumentFragment;
  g.Node = window.Node;
  g.Event = window.Event;
  g.CustomEvent = window.CustomEvent;
  g.MutationObserver = window.MutationObserver;
  g.getComputedStyle = window.getComputedStyle;
  // localStorage 代理到 JSDOM(需要非不透明源, 见下 url:"http://localhost")
  Object.defineProperty(g, "localStorage", { value: window.localStorage, configurable: true });
  g.Image = window.Image;
}

// 一次只跑一张卡(由父进程逐卡 spawn, 保证 customElements 注册表与全局互不干扰)。
const ONLY = process.argv[2];
let failures = 0;
const fail = (msg) => {
  console.error("  ✗ " + msg);
  failures++;
};
const ok = (msg) => console.log("  ✓ " + msg);

/** 父进程: 逐卡 spawn 自身(spawn 子进程传卡名)。 */
async function drive() {
  const { spawnSync } = await import("node:child_process");
  let failed = 0;
  for (const name of ["map", "trips", "control", "energy", "lastweek", "metrics"]) {
    const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), name], {
      stdio: "inherit",
    });
    if (r.status !== 0) failed++;
  }
  console.log(`\n########## 冒烟测试: ${failed === 0 ? "全部通过" : failed + " 张卡失败"} ##########`);
  process.exit(failed === 0 ? 0 : 1);
}

if (!ONLY) {
  await drive();
}
const CARDS = [ONLY];

/** 造一个最小 hass(卡片挂载只用到这些)。
 *  控车卡额外给一组"能被后缀猜出来"的实体(见 control 的 _guessIndex) ——
 *  这样它才会走到真正的 hero(否则显示的是"还没找到实体"的提示卡)。 */
function fakeHass() {
  const ent = (id, state, attributes = {}) => [id, { entity_id: id, state, attributes }];
  const states = Object.fromEntries([
    // 胎压(左前 1.8 bar < 2.0 → 触发「胎压偏低」红色告警)
    ent("sensor.tai_ya_zuo_qian", "1.8", { friendly_name: "胎压-左前" }),
    ent("sensor.tai_ya_you_qian", "2.5", { friendly_name: "胎压-右前" }),
    // 后备箱开着 → 触发第二条红色告警(「后备箱未关」)
    ent("switch.hou_bei_xiang", "on", { friendly_name: "后备箱" }),
    // 基础车况(让 hero 有数可画)
    ent("sensor.dian_liang", "76", { friendly_name: "电量" }),
    ent("sensor.xu_hang", "412", { friendly_name: "续航", reev: false }),
    ent("sensor.che_liang_zhuang_tai", "parked", { friendly_name: "车辆状态" }),
    ent("sensor.chong_dian_zhuang_tai", "unplugged", { friendly_name: "充电状态" }),
    ent("lock.che_men_suo", "locked", { friendly_name: "车门锁" }),
    ent("sensor.zhuang_tai_geng_xin_shi_jian", "2026-10-13T00:00:00+00:00", {}),
    // hero 的"刷新车况"(button.press) —— 供"控件是否接上服务"的检查当探针
    ent("button.shua_xin_che_kuang", "2026-10-13T00:00:00+00:00", { friendly_name: "刷新车况" }),
    // 空调 + 一个座椅实体: 空调卡要渲染出来, 还它旁边的「座椅与加热」入口才存在
    ent("climate.che_kong_tiao", "off", { friendly_name: "空调", temperature: 24, min_temp: 16,
      max_temp: 32, target_temp_step: 1, hvac_modes: ["off", "cool", "heat", "fan_only"] }),
    ent("number.zuo_yi_jia_re", "0", { friendly_name: "主驾座椅加热", min: 0, max: 3, step: 1 }),
  ]);
  return {
    states,
    themes: { darkMode: false },
    user: { is_admin: true },
    callWS: async (msg) => {
      // 各卡取数命令统一返回空结构; 只为验证"不抛异常、能渲染"
      if (msg.type === "leapmotor/energy/daily") return { days: [], summary: {}, pending: 0 };
      if (msg.type === "leapmotor/energy/lastweek") return { breakdown: null };
      if (msg.type === "leapmotor/trips/list") return { trips: [], stats: {}, months: [], store: {} };
      if (msg.type === "config/entity_registry/list") return [];
      if (msg.type === "config/device_registry/list") return [];
      if (msg.type === "zone/list") return [];
      return {};
    },
    callService: async () => undefined,
  };
}

for (const name of CARDS) {
  console.log(`\n[${name}]`);
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    runScripts: "outside-only",
    pretendToBeVisual: true,
    url: "http://localhost/", // 非不透明源, 否则 localStorage 抛 SecurityError
  });
  const { window } = dom;
  // 提供浏览器环境里卡片会用到的全局
  // ResizeObserver: 回调记到 __roCbs, 供"窄宽度断点"用例手动触发
  // (jsdom 没有布局、clientWidth 恒为 0、也不会自己回调, 只能桩掉宽度后手动调)。
  window.__roCbs = [];
  window.ResizeObserver = class {
    constructor(cb) {
      if (typeof cb === "function") window.__roCbs.push(cb);
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.IntersectionObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  window.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => clearTimeout(id);
  window.customCards = [];

  // 把 bundle 当脚本执行到 window 上下文里(它是 ESM, 但已自包含、无 import,
  // 直接 eval 成脚本形式即可; 顶层只有 class/函数/define 调用)。
  // 卡片 bundle 是**真 ESM**(control 用到 import.meta.url), 必须按模块加载 ——
  // 用 window.eval 会报 "Cannot use 'import.meta' outside a module"。
  // 做法: 把 JSDOM 的浏览器全局装到 globalThis, 再动态 import 该文件(HA 也是按 ESM 载入)。
  const code = readFileSync(resolve(WWW, `leapmotor-${name}.js`), "utf8");
  installGlobals(window);
  const tmp = resolve(ROOT, `.smoke-${name}.mjs`);
  writeFileSync(tmp, code);
  try {
    await import(pathToFileURL(tmp).href + `?t=${Date.now()}`);
  } catch (e) {
    fail(`加载 bundle 抛错: ${e.message}`);
    try { unlinkSync(tmp); } catch {}
    continue;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }

  const tag = `leapmotor-${name}`;
  if (!window.customElements.get(tag)) {
    fail(`元素 ${tag} 未注册`);
    continue;
  }
  ok(`元素 ${tag} 已注册`);

  // 捕获异步更新周期里的未处理异常(trips 曾因未覆写 render() 在 update() 里抛错 →
  // HA 显示「配置错误」; jsdom 里若不显式拦截会静默)。
  const asyncErrors = [];
  const onErr = (e) => asyncErrors.push(e && (e.message || String(e)));
  window.addEventListener("error", onErr);
  process.on("uncaughtException", onErr);
  const _err = console.error;
  let consoleErrored = false;
  console.error = (...a) => {
    consoleErrored = true;
    _err(...a);
  };

  // ── 场景 A(HA 的真实顺序): **未连接**的元素先 setConfig, 再装进文档, 再给 hass ──
  // 踩过的坑: HA 会先 setConfig 校验配置, 此时 Lit 的 createRenderRoot 还没跑、
  // shadowRoot 为 null, 若 _build 直接 .innerHTML 会抛错 → HA 显示「配置错误」。
  const elA = window.document.createElement(tag);
  try {
    if (typeof elA.setConfig === "function") elA.setConfig({ type: `custom:${tag}` });
  } catch (e) {
    fail(`[未连接] setConfig 抛错: ${e.message}`);
  }
  window.document.body.appendChild(elA);

  const el = elA;
  try {
    el.hass = fakeHass();
  } catch (e) {
    fail(`hass 抛错: ${e.message}`);
    continue;
  }

  // 等 Lit 首帧 + 异步取数
  await new Promise((r) => setTimeout(r, 60));
  console.error = _err;
  process.removeListener("uncaughtException", onErr);
  if (asyncErrors.length) fail(`异步更新抛错: ${asyncErrors[0]}`);
  else ok(`更新周期无异常`);

  const sr = el.shadowRoot;
  if (!sr || sr.innerHTML.length < 50) {
    fail(`shadow DOM 为空或过短(len=${sr ? sr.innerHTML.length : "null"})`);
    continue;
  }
  ok(`shadow DOM 已渲染(${sr.innerHTML.length} 字符)`);

  // 隐藏外框默认关闭；只清除最外层边框和阴影，内部表面保持当前风格。
  {
    const border = () => el.style.getPropertyValue("--lm-card-border").trim();
    const shadow = () => el.style.getPropertyValue("--lm-shadow-card").trim();
    const inner = () => ["--lm-section-border", "--lm-shadow-section", "--lm-shadow-control", "--lm-shadow-floating", "--lm-shadow-dialog"].map(key => el.style.getPropertyValue(key)).join("|");
    const syncAppearance = (value) => {
      if (value) window.localStorage.setItem("leapmotor.appearance", JSON.stringify(value));
      else window.localStorage.removeItem("leapmotor.appearance");
      window.dispatchEvent(new window.StorageEvent("storage", { key: "leapmotor.appearance" }));
    };
    if (border() === "0" || shadow() === "none") fail("隐藏外框: 默认关闭时应保留玻璃风格的外框和阴影");
    for (const style of ["glass", "soft", "brutalist", "minimal", "memphis"]) {
      syncAppearance({ version: 1, style, hideCardFrame: false });
      const original = { border: border(), shadow: shadow(), inner: inner() };
      syncAppearance({ version: 1, style, hideCardFrame: true });
      if (border() !== "0" || shadow() !== "none" || inner() !== original.inner) {
        fail(`隐藏外框: ${style} 未同时清除外边框和阴影，或改变了内部效果`);
      }
      syncAppearance({ version: 1, style, hideCardFrame: false });
      if (border() !== original.border || shadow() !== original.shadow || inner() !== original.inner) {
        fail(`隐藏外框: ${style} 关闭后未恢复原风格`);
      }
    }
    syncAppearance({ version: 1, style: "minimal" });
    if (border() === "0" || el.getAttribute("data-lm-style") !== "minimal") fail("隐藏外框: 旧偏好未保留风格原有外框");
    for (const legacy of [{ cardBorder: false }, { cardBorder: true }, { hideCardFrame: "true" }]) {
      syncAppearance({ version: 1, style: "glass", ...legacy });
      if (border() === "0" || shadow() === "none") fail("隐藏外框: 旧字段或无效值不应自动隐藏外框");
    }
    syncAppearance(null);
    ok("隐藏外框: 五种风格均去掉外层边框及阴影，保留内部效果，关闭后恢复原风格");
  }

  if (name === "control") {
    const darkHass = fakeHass();
    darkHass.themes.darkMode = true;
    el.hass = darkHass;
    if (el._appearanceDark !== true) fail("control: HA 深色主题更新后未重算卡片风格变量");
    else ok("control: hass 明暗更新会重算卡片风格变量");
  }

  if (name === "metrics") {
    const first = window.document.createElement(tag);
    const second = window.document.createElement(tag);
    first.setConfig({ type: `custom:${tag}`, device: "sensor.test_battery", instance_id: "commute" });
    second.setConfig({ type: `custom:${tag}`, device: "sensor.test_battery", instance_id: "charging" });
    window.document.body.append(first, second);
    const metricHass = fakeHass();
    metricHass.states["sensor.test_battery"] = { entity_id: "sensor.test_battery", state: "76", attributes: {} };
    metricHass.states["sensor.test_trip_stats"] = {
      entity_id: "sensor.test_trip_stats", state: "12.5", attributes: { 今日: { count: 2 } },
    };
    metricHass.states["sensor.test_wall_ac_energy"] = {
      entity_id: "sensor.test_wall_ac_energy", state: "1.23",
      attributes: { friendly_name: "壁挂式空调能耗", unit_of_measurement: "kWh" },
    };
    const baseCallWS = metricHass.callWS;
    metricHass.callWS = async (msg) => {
      if (msg.type === "leapmotor/trips/list") return { trips: [], stats: {}, months: [], store: {} };
      if (msg.type === "leapmotor/energy/daily") return { days: [{ km: 15.5, kwh: 3.1, eff: 20, ac: 1.23 }], summary: {}, pending: 0 };
      return baseCallWS(msg);
    };
    first.hass = metricHass;
    second.hass = fakeHass();
    await new Promise((r) => setTimeout(r, 60));
    if (first._prefKey === second._prefKey) fail("metrics: 同车的两张卡仍共享偏好键");
    else {
      first._selected = [...first._selected, "delivery_days"];
      first._save();
      const firstSaved = JSON.parse(window.localStorage.getItem(first._prefKey) || "[]");
      const secondSaved = JSON.parse(window.localStorage.getItem(second._prefKey) || "[]");
      if (!firstSaved.includes("delivery_days") || secondSaved.includes("delivery_days")) fail("metrics: 编辑一张自定义卡影响了另一张卡");
      else ok("metrics: 同车卡片按实例隔离保存显示项目");
    }
    const displays = {
      mileage_today: "15.5", avg_energy_today: "20.0", energy_today: "3.1",
      trips_today: "2", ac_energy_today: "1.23",
    };
    const wrong = Object.entries(displays).filter(([id, expected]) => first._display(first._selectedMetric(id)) !== expected);
    if (wrong.length) fail(`metrics: 今日数据未从行程/能耗接口回退: ${wrong.map(([id]) => id).join(", ")}`);
    else ok("metrics: 今日里程/能耗/行程数和空调能耗能复用 HA 统计与逐日拆分");
    const wallAc = first._available().find((metric) => metric.entityId === "sensor.test_wall_ac_energy");
    if (!wallAc || wallAc.label !== "空调能耗") fail(`metrics: 空调实体名称仍带壁挂式描述(${wallAc?.label || "未找到"})`);
    else ok("metrics: HA 空调能耗实体名称已规范为“空调能耗”");
    first._picker = true;
    first.requestUpdate();
    await first.updateComplete;
    const optionText = first.shadowRoot.querySelector(".options")?.textContent || "";
    if (!["今日空调能耗", "今日平均能耗", "今日耗电", "今日行程"].every((label) => optionText.includes(label))) {
      fail("metrics: 添加器没有列出今日统计和空调能耗");
    } else ok("metrics: 添加器列出今日统计与空调能耗");
  }

  // 关键: 检查有无"被转义的 svg 文字"(说明 ipIcon 被 html 模板转义了)
  const escaped = sr.querySelectorAll("*");
  let escapedSvgText = false;
  for (const n of escaped) {
    if (n.children.length === 0 && /&lt;svg|<svg/i.test(n.textContent || "")) {
      // 文本节点里出现 "<svg" 字样 = 被当文字输出了
      if ((n.textContent || "").includes("<svg") || (n.textContent || "").includes("&lt;svg")) {
        escapedSvgText = true;
        break;
      }
    }
  }
  if (escapedSvgText) fail(`发现被转义的 SVG 文本(ipIcon 未用 unsafeSVG)`);
  else ok(`无被转义的 SVG 文本`);

  const svgCount = sr.querySelectorAll("svg").length;
  console.log(`  · shadow 内 <svg> 节点数: ${svgCount}`);

  // 关键: SVG 内的子元素必须真在 SVG 命名空间 —— 否则浏览器不渲染(圆环消失)。
  // 踩过的坑: 把整段 <svg> 放进"再被插入"的子模板, lit 不会建立 SVG 命名空间,
  // <circle> 被建成 HTML 元素 → 元素在 DOM 里但看不见。
  const SVG_NS = "http://www.w3.org/2000/svg";
  const SVG_CHILD_TAGS = new Set([
    "circle", "rect", "line", "path", "polyline", "polygon", "g", "defs",
    "text", "stop", "linearGradient", "radialGradient", "tspan",
  ]);
  let badNs = null;
  for (const el2 of sr.querySelectorAll("*")) {
    const t = (el2.tagName || "").toLowerCase();
    if (!SVG_CHILD_TAGS.has(t)) continue;
    if (el2.namespaceURI !== SVG_NS) {
      badNs = `${el2.tagName} (ns=${el2.namespaceURI})`;
      break;
    }
  }
  if (badNs) fail(`发现非 SVG 命名空间的图形元素: ${badNs}(浏览器不会渲染)`);
  else ok(`SVG 命名空间正确`);

  // ── 界面风格体系:「块/按钮」统一消费同一组语义变量 ──
  // 逐卡对**规则文本**抽查几条(控车卡在它自己的专项里另有一条同类断言):
  //   ① 块/按钮那条规则必须有**显式 border 声明** —— 只删掉原 1px 会让 <button> 露出 UA 默认的
  //      2px outset 描边(实测踩过)。现在它要么是 0, 要么是 var(--lm-control-border) /
  //      var(--lm-section-border) 这类语义变量;
  //   ② 阴影必须来自共享语义变量 var(--lm-shadow-*), **不能**是各卡写死的字面值 ——
  //      这正是"换一次变量就整体换风格"(轻阴影/玻璃/粗野主义/极简)的前提。
  // ⚠️ 产物里 CSS 的换行是**字面量 \n 两个字符**, 所以跨行用 [\s\S], 规则体用 [^}](见上面的说明)。
  {
    const UNIFY = {
      map: [
        "\\.btns button\\s*\\{[^}]*\\}",
        "\\.panel\\s*\\{[^}]*\\}",
        "\\.panel button\\s*\\{[^}]*\\}",
      ],
      trips: [
        // 全局 button 那条(选择器就叫 button; 用规则体里的字号锚定, 免得匹配到 .winbar .seg button)
        "button\\s*\\{[^}]*font: inherit; font-size: 12px[^}]*\\}",
        "\\.sheet\\s*\\{[^}]*\\}",
        "\\.daycard\\s*\\{[^}]*\\}",
        // 用规则体里的字号锚定: `.dhead .tchip { flex: none }` 那条在前, 不能裸匹配 .tchip
        "\\.tchip\\s*\\{[^}]*font-size: 12px[^}]*\\}",
        "\\.mbtns button\\s*\\{[^}]*\\}",
      ],
      control: [
        "\\.sec, \\.half, \\.pick, \\.circ\\s*\\{[^}]*\\}",
        // 锁胶囊(.lockBox)已并入状态胶囊; 这一组现在是"可点小按钮"的合并规则
        "\\.toolBtn,\\s*\\.chip,[\\s\\S]*?\\.pickRow\\s*\\{[^}]*\\}",
      ],
      energy: [
        "\\.head button\\.refresh\\s*\\{[^}]*\\}",
        "\\.chartSec\\s*\\{[^}]*\\}",
        "\\.chip\\s*\\{[^}]*\\}",
      ],
      lastweek: [
        "\\.head button\\.refresh\\s*\\{[^}]*\\}",
        "\\.head button\\.stchip\\s*\\{[^}]*\\}",
        "\\.sec\\s*\\{[^}]*\\}",
      ],
    };
    const wantShadow = /box-shadow:\s*var\(--lm-shadow-[a-z-]+/;
    const wantBorder = /\bborder(?:-[a-z]+)?:\s*(?:0(?![.\d])|var\(--lm-)/;
    const bad = [];
    for (const re of UNIFY[name] || []) {
      const rule = (code.match(new RegExp(re)) || [""])[0];
      if (!rule) bad.push(`${re} 没找到`);
      else if (!wantBorder.test(rule)) bad.push(`${re} 缺显式 border 声明(0 或 --lm-* 变量)`);
      else if (!wantShadow.test(rule)) bad.push(`${re} 阴影没有走共享变量 var(--lm-shadow-*)`);
    }
    if (bad.length) fail(`界面风格: 块/按钮变量化抽查未过: ${bad.join("; ")}`);
    else ok(`界面风格: 块/按钮 = 显式 border + 共享阴影变量(${(UNIFY[name] || []).length} 条规则抽查)`);
  }

  // ── 卡片配色(六张卡统一): 预置 localStorage 后挂载 → 宿主元素上覆盖主题变量 ──
  // 方案: 六张卡的强调色全部走 HA 主题变量(--primary-color / --rgb-primary-color / …),
  // 所以「卡片配色」只需把颜色写到宿主元素的 inline style 上(变量继承进 shadow root, 零 CSS 改动)。
  // 这里逐卡验"变量确实落在宿主元素上", 且 --rgb-primary-color 是 HA 约定的 "r, g, b" 形式。
  // 1.9.38 起**只有主题色**: 旧的 progress(电量色 → --success-color)整行已去掉 ——
  // 本机存的老字段要被忽略并顺手清掉, --success-color 一律不再覆盖(这条对六张卡都成立)。
  {
    window.localStorage.setItem("leapmotor.palette", JSON.stringify({ accent: "#9c27b0", progress: "#ff9800" }));
    const elPal = window.document.createElement(tag);
    window.document.body.appendChild(elPal);
    try {
      if (typeof elPal.setConfig === "function") elPal.setConfig({ type: `custom:${tag}` });
      elPal.hass = fakeHass();
    } catch (e) {
      fail(`[配色] 挂载抛错: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, 60));
    const pc = elPal.style.getPropertyValue("--primary-color").trim();
    const rgb = elPal.style.getPropertyValue("--rgb-primary-color").trim();
    const sc = elPal.style.getPropertyValue("--success-color").trim();
    const left = window.localStorage.getItem("leapmotor.palette") || "";
    if (pc !== "#9c27b0") {
      fail(`[配色] 宿主元素没有 --primary-color(预期 #9c27b0, 实际「${pc}」)`);
    } else if (rgb !== "156, 39, 176") {
      fail(`[配色] --rgb-primary-color 不是 HA 的 "r, g, b" 形式(实际「${rgb}」; 半透明填充会不跟着变)`);
    } else if (sc) {
      fail(`[配色] 1.9.38 起不再覆盖 --success-color(电量/状态色整行已去掉), 实际「${sc}」`);
    } else if (left.indexOf("progress") >= 0) {
      fail(`[配色] 旧版存的 progress 字段没被顺手清掉: 「${left}」`);
    } else {
      ok(`[配色] 预置 {accent, progress} 后挂载 → 宿主只覆盖主题色, 旧 progress 字段被清掉(「${left}」)`);
    }
    window.localStorage.clear();
  }

  // trips 专项: 时间窗口行 + 详情页的图例/图标钮
  if (name === "trips") {
    const route=window.document.createElement("leapmotor-trips");window.document.body.appendChild(route);
    const ts=Math.floor(Date.now()/1000)-3600;
    const trip={id:"scrub",started_at:ts,ended_at:ts+60,point_count:3,distance_km:.3,duration_min:1,energy_kwh:.04,efficiency:13.3,start_lat:31.23,start_lon:121.47,end_lat:31.231,end_lon:121.471};
    const pts=[[31.23,121.47,20,ts,80],[31.2305,121.4705,50,ts+30,79.8],[31.231,121.471,10,ts+60,79.4]];
    route.setConfig({type:"custom:leapmotor-trips",flow:false});route.hass={...fakeHass(),callWS:async m=>m.type==="leapmotor/trips/list"?{trips:[trip],stats:{},months:[],store:{}}:m.type==="leapmotor/trips/track"?{points:pts}:[]};
    await new Promise(r=>setTimeout(r,60));const rroot=route.shadowRoot,map=rroot.querySelector(".map");
    route._toggleAllDays();
    if(!rroot.querySelector('.compactDay.collapsed')||rroot.querySelector('.dthumb'))fail('trips: 紧凑模式仍创建每日缩略图');else ok('trips: 紧凑收起不创建缩略图');
    route._toggleAllDays();if(rroot.querySelector('.daycard.collapsed'))fail('trips: 第三态没有全部展开');
    route._toggleAllDays();if(!rroot.querySelector('.daycard.collapsed .dthumb'))fail('trips: 三态循环未回到缩略图概览');else ok('trips: 紧凑、展开、缩略图概览按顺序切换');
    const dayThumbRule=(code.match(/\.dthumb\s*\{\\n\s*position:[\s\S]*?background:\s*var\(--lm-surface-section[^;]*;/)||[""])[0]||"";
    const mapRule=(code.match(/\.map\s*\{\\n\s*position:[\s\S]*?background:\s*var\(--lm-surface-section[^;]*;/)||[""])[0]||"";
    if(!/background:\s*var\(--lm-surface-section/.test(dayThumbRule)||/background:\s*#[0-9a-f]/i.test(dayThumbRule))fail('trips: 每日地图缩略图底色没有跟随卡片背景');
    else if(!/background:\s*var\(--lm-surface-section/.test(mapRule)||/background:\s*#[0-9a-f]/i.test(mapRule))fail('trips: 详情地图等待瓦片时没有使用卡片背景色');
    else ok('trips: 行程地图与每日缩略图加载底色跟随卡片背景');
    map.getBoundingClientRect=()=>({left:100,top:100,width:400,height:340,right:500,bottom:440});map.setPointerCapture=()=>{};
    await route._openDetail("scrub");
    const profile=rroot.querySelector(".tripPlot");profile.dispatchEvent(new window.KeyboardEvent("keydown",{key:"ArrowRight",bubbles:true}));
    const keyboardReadout=rroot.querySelector(".pointReadout"),keyboardCursor=rroot.querySelector(".profileCursor");
    if(route._pt?.idx!==1||!keyboardReadout?.textContent.includes("第 2 / 3 点")||keyboardReadout.textContent.includes("速度")||keyboardCursor?.getAttribute("x1")!=="150"||rroot.querySelector(".profileToggle")?.getAttribute("aria-expanded")!=="true")fail("trips: 键盘选点没有展开趋势气泡并同步当前位置");else ok("trips: 键盘选点展开原位趋势气泡，读数和游标同步且不重复显示速度");
    const beforePane=rroot.querySelector('.profilePane'),beforeSvg=rroot.querySelector('.tripPlot svg');rroot.querySelector('.profileToggle').click();
    if(rroot.querySelector('.profilePane')!==beforePane||rroot.querySelector('.tripPlot svg')!==beforeSvg||beforePane.classList.contains('is-open')||rroot.querySelector('.plotToggle'))fail('trips: 折叠重建图表或残留独立按钮');else ok('trips: 非图区折叠复用原 DOM，不重绘图表和其它信息');
    let tileDraws=0;route._renderTiles=()=>{tileDraws++};
    const xy=p=>String(route._screenMapper()(p)).split(",").map(Number),first=xy(route._sel.runs[0][0]),last=xy(route._sel.runs[0][2]);
    const pointer=(type,p)=>map.dispatchEvent(new window.MouseEvent(type,{bubbles:true,button:0,clientX:p[0]+100,clientY:p[1]+100}));
    pointer("pointerdown",first);pointer("pointermove",last);await new Promise(r=>setTimeout(r,40));pointer("pointerup",last);
    if(tileDraws||route._pt?.idx!==2||!rroot.querySelector(".pointReadout")?.textContent.includes("第 3 / 3 点"))fail("trips: 轨迹滑动未选中最后一点或重复绘制瓦片");else ok("trips: 沿轨迹滑动同步采样游标且不重绘瓦片");
    route._sel=route._prepare(pts.map(p=>p.slice(0,4)),4000);route._renderDetailInfo();
    if(!rroot.querySelector(".profileNote")?.textContent.includes("旧记录未采集电量"))fail("trips: 旧记录未提示未采集电量");else ok("trips: 旧记录明确提示未采集电量，不伪造电量曲线");route.remove();
    // 真正的时间窗口点击触发短动画，普通 hass 更新不触发；减少动态设置优先。
    let motions=0, wrongMotion=false;
    const animateBefore=window.HTMLElement.prototype.animate,matchBefore=window.matchMedia;
    window.HTMLElement.prototype.animate=function(frames,options){motions++;if(options.duration>200||frames.some(f=>Object.keys(f).some(k=>!["opacity","transform"].includes(k))))wrongMotion=true;return {cancel(){}};};
    window.matchMedia=()=>({matches:false});
    const selectDays=async days=>{sr.querySelector(`[data-days="${days}"]`).click();await new Promise(r=>setTimeout(r,50));};
    await selectDays(7);const actionMotions=motions;
    el.hass={...el.hass};await new Promise(r=>setTimeout(r,40));
    if(!actionMotions||motions!==actionMotions||wrongMotion)fail("trips: 窗口动作短动画/普通状态更新的性能边界异常");
    else ok("trips: 窗口动作只动画透明度和位移，普通状态推送不重复动画");
    window.matchMedia=()=>({matches:true});await selectDays(90);
    if(motions!==actionMotions)fail("trips: 减少动态设置下仍播放动作动画");
    else ok("trips: 遵从系统减少动态设置");
    window.HTMLElement.prototype.animate=animateBefore;window.matchMedia=matchBefore;await selectDays(30);
    // ① 翻页箭头必须在**下面那行**(.winsum 的行尾那一组), 不在上一行 ——
    //    手机宽度下"选择月份"变成"2026 年 10 月"更长, 挤得分段钮把"7 天"从中间断成两行
    const navArrows = sr.querySelectorAll(".winsum .wnav .arw");
    if (navArrows.length !== 2) fail(`trips: 翻页箭头不在窗口行尾(.winsum .wnav), 实际 ${navArrows.length} 个`);
    else if (sr.querySelectorAll(".winbar .arw").length) fail(`trips: .winbar 里还留着翻页箭头`);
    else ok(`trips: 翻页箭头在窗口行尾(2 个)`);
    // ② 分段钮/月份钮禁止折行(否则"7 天"会被断成两行)
    const segRule = (code.match(/\.winbar \.seg button\s*\{([^}]*)\}/) || [])[1] || "";
    const monRule = (code.match(/\.winbar \.monlab\s*\{([^}]*)\}/) || [])[1] || "";
    if (!/white-space:\s*nowrap/.test(segRule)) fail(`trips: 分段钮没禁折行(7 天 会被断成两行)`);
    else if (!/white-space:\s*nowrap/.test(monRule)) fail(`trips: 月份钮没禁折行`);
    else ok(`trips: 分段钮 / 月份钮均不许折行`);

    // ③ 详情页: 竖向速度图例在地图内左侧; 右侧一列纯图标钮(热力图/光效/归位/放大/缩小)
    const spdRule = (code.match(/\.spd \.speed-gradient\s*\{([^}]*)\}/) || [])[1] || "";
    const btnRule = (code.match(/\.mbtns \{([^}]*)\}/) || [])[1] || "";
    const spd = sr.querySelector(".map .spd");
    const grad = sr.querySelector(".map .spd .speed-gradient");
    const mbtns = [...sr.querySelectorAll(".map .mbtns button")];
    if (!spd || !grad) fail(`trips: 地图里没有竖向速度图例(.spd)`);
    else if (!/linear-gradient\(to top/.test(spdRule)) fail(`trips: 速度图例不是竖向渐变(to top)`);
    else if (!/position:\s*absolute/.test(btnRule) || !/right:\s*8px/.test(btnRule)) {
      fail(`trips: .mbtns 没有绝对定位在右上角(会挤压地图)`);
    } else if (sr.querySelector(".hmbox, .flowbox")) {
      fail(`trips: 热力图/光效仍是复选框(应改成图标钮)`);
    } else if (mbtns.length !== 6) fail(`trips: 右上角图标钮应为 6 颗(底图/热力图/光效/聚焦/放大/缩小), 实际 ${mbtns.length}`);
    else if (mbtns.some((b) => (!b.querySelector("svg") && !b.querySelector("ha-icon")) || b.textContent.trim())) {
      fail(`trips: 图标钮应为纯图标(有按钮带文字或缺图标)`);
    } else if (!["style", "heat", "flow", "fit", "in", "out"].every((m) => mbtns.some((b) => b.dataset.m === m))) {
      fail(`trips: 图标钮的动作不全(需 style/heat/flow/fit/in/out)`);
    } else if (sr.querySelector(".mstyle, .tools")) {
      fail(`trips: 底图下拉框/下方工具行还在(底图应改成右上角的按钮, 叠加应挪到页头)`);
    } else ok(`trips: 竖排速度图例 + 右上角 6 颗纯图标钮(含底图切换)`);

    // ③b 叠加挪到详情页头、且在「导出/下载」钮之前
    const dhead = sr.querySelector(".dhead");
    const ovl = sr.querySelector(".dhead .ovlLab");
    const exp = sr.querySelector(".dhead .dexp");
    if (!dhead || !ovl || !exp) fail(`trips: 叠加/导出钮不在详情页头里`);
    else if (!(ovl.compareDocumentPosition(exp) & window.Node.DOCUMENT_POSITION_FOLLOWING)) {
      fail(`trips: 「叠加」没有排在「导出」钮之前`);
    } else ok(`trips: 叠加在详情页头、排在导出钮之前`);

    // ③c 地图上的按钮必须"点得动": 地图的 pointerdown 会 setPointerCapture,
    //     指针一旦被地图捕获, 浏览器就把随后的 click 派发给地图而不是那颗钮 ——
    //     表现为"右上角按钮点了没反应"(真机实测过)。按下落在浮层上时不得捕获。
    const mapEl = sr.querySelector(".map");
    const heatBtn0 = sr.querySelector('.mbtns button[data-m="heat"]');
    if (mapEl && heatBtn0) {
      let captured = 0;
      mapEl.setPointerCapture = () => { captured++; };
      heatBtn0.dispatchEvent(new window.MouseEvent("pointerdown", { bubbles: true, composed: true }));
      if (captured) fail(`trips: 点地图按钮时地图抢走了指针(setPointerCapture) → 按钮点了没反应`);
      else ok(`trips: 地图按钮的按下不会被拖拽逻辑抢走指针`);
    }
    // ④ 点热力图/光效/底图钮 = 开关/切换(状态与选中态都要变), 且不该抛错
    const heat = mbtns.find((b) => b.dataset.m === "heat");
    const flow = mbtns.find((b) => b.dataset.m === "flow");
    const styleBtn = mbtns.find((b) => b.dataset.m === "style");
    if (styleBtn) {
      const s0 = el._mapStyle;
      styleBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (el._mapStyle === s0) fail(`trips: 点底图钮没有切换底图`);
      else if (!styleBtn.querySelector("ha-icon")?.getAttribute("icon")) fail(`trips: 底图钮没有图标`);
      else ok(`trips: 底图钮能循环切换(${s0} → ${el._mapStyle}, 图标随之更新)`);
    }
    if (heat && flow) {
      const h0 = el._heatmap;
      heat.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      flow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (el._heatmap === h0) fail(`trips: 点热力图钮没有切换状态`);
      else if (heat.classList.contains("on") !== !!el._heatmap) fail(`trips: 热力图钮的选中态与状态不一致`);
      else if (flow.classList.contains("on") !== !!el._flow) fail(`trips: 光效钮的选中态与状态不一致`);
      else ok(`trips: 热力图/光效钮能切换(选中态同步)`);
      // 复原, 免得影响后续
      heat.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      flow.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
    }
  }

  // energy 专项: 标题容器应能被命令式写入
  if (name === "energy") {
    if (sr.querySelector('.head')||!sr.querySelector('.energyTop')?.textContent.includes('里程与耗能'))fail('energy: 仍显示冗余标题或耗能名称不符');else ok('energy: 移除冗余标题，顶部保留突出功能按钮');
    const ctrls = sr.querySelector(".ctrls");
    if (!ctrls) fail(`energy: .ctrls 不存在`);
    else if (ctrls.children.length === 0 && (ctrls.innerHTML || "").length === 0)
      fail(`energy: .ctrls 未被命令式渲染(可能 _build 引用为空)`);
    else ok(`energy: .ctrls 已渲染(${ctrls.innerHTML.length} 字符)`);
    const box = sr.querySelector(".chartBox");
    if (!box) fail(`energy: .chartBox 不存在`);
    else ok(`energy: .chartBox 存在`);

    // 纯电车即使收到意外燃油数据也不显示；后面的增程夹具单独验证耗油系列。
    const elE = window.document.createElement("leapmotor-energy");
    window.document.body.appendChild(elE);
    elE.setConfig({ type: "custom:leapmotor-energy" });
    elE.hass = {
      states: {}, themes: { darkMode: false }, user: { is_admin: true },
      callWS: async (msg) => (msg.type === "leapmotor/energy/daily"
        ? { days: [ { day: "2026-10-12", km: 20, kwh: 3, eff: 15, fuel: 5.5 },
                    { day: "2026-10-13", km: 30, kwh: 4, eff: 13, fuel: 6.1 } ],
            summary: { km: 50, kwh: 7 }, pending: 0 }
        : {}),
      callService: async () => undefined,
    };
    await new Promise((r) => setTimeout(r, 80));
    const srE = elE.shadowRoot;
    if (srE.querySelector('[data-act="toggle-fuel"]')) fail(`energy: 油耗芯片又出现了(已明确隐藏)`);
    else if (/油耗/.test(srE.querySelector(".ctrls")?.textContent || "")) fail(`energy: 控件里还有"油耗"字样`);
    else ok(`energy: 纯电车隐藏油耗系列(即使后端给了 fuel 也不显示)`);

    // 充电账本从 HA 读取，电价保存不触发云端每日能耗请求。
    const bill = window.document.createElement("leapmotor-energy");
    window.document.body.appendChild(bill);
    bill.setConfig({ type:"custom:leapmotor-energy",entry_id:"car-a",range:"week" });
    let tariff={peak_price:null,valley_price:null,valley_start:"23:00",valley_end:"07:00",efficiency:.9};
    let rejectSave=false, delayedWeek=null;
    const calls=[];
    const history=days=>({vin:"A",days:[{day:"2026-10-13",kwh:9,grid_kwh:10,peak_kwh:0,valley_kwh:9,cost:(tariff.ac_valley_price??tariff.valley_price)==null?null:3,consumed_kwh:4}],sessions:[],tariff:{...tariff},revision:1,timezone:"Asia/Hong_Kong",active:false,summary:{kwh:days===30?30:9,grid_kwh:10,cost:(tariff.ac_valley_price??tariff.valley_price)==null?null:3,count:0}});
    const billHass={states:{},user:{is_admin:true},callService:async()=>{throw Error("unexpected vehicle command")},callWS:async msg=>{
      calls.push(msg);
      if(msg.type==="leapmotor/energy/daily")return {vin:"A",days:[],summary:{},pending:0};
      if(msg.type==="leapmotor/charging/history"){
        if(msg.days===7&&delayedWeek)return await new Promise(resolve=>{delayedWeek=resolve});
        return history(msg.days);
      }
      if(msg.type==="leapmotor/charging/tariff"){
        if(rejectSave)throw Error("模拟保存失败");
        tariff=msg.tariff;return {tariff};
      }
      return [];
    }};
    bill.hass=billHass;
    const tick=()=>new Promise(r=>setTimeout(r,40));await tick();
    const root=bill.shadowRoot;
    const clickText=text=>[...root.querySelectorAll("button")].find(n=>n.textContent.trim()===text)?.click();
    clickText("充电与电费");await tick();
    if(!root.querySelector(".chargeSvg")||!root.querySelector(".energyStat.cost").textContent.includes("请设置电价"))fail("energy: 未设电价应显示待设置，且有充电图表");
    else ok("energy: 未设电价不伪造零元账单，充电图表可用");
    const chargeRanges=[...root.querySelectorAll('.chargePlot .chargeRange .energyTools button')];
    if(chargeRanges.length!==2||chargeRanges[0].textContent.trim()!=='周'||chargeRanges[1].textContent.trim()!=='月'||chargeRanges[0].getAttribute('aria-label')!=='近 7 天'||chargeRanges[1].getAttribute('aria-label')!=='近 30 天')fail('energy: 充电图表周期按钮文案或辅助标签不正确');
    else ok('energy: 充电图表周期按钮显示「周 / 月」并保留完整辅助标签');
    root.querySelector('.chargeSvg g[role="button"]').dispatchEvent(new window.KeyboardEvent("keydown",{key:"Enter",bubbles:true}));await tick();
    if(!root.querySelector(".chargeTip")?.textContent.includes("行驶耗电 4.00"))fail("energy: 充电图表键盘详情未显示消耗");
    else ok("energy: 键盘可查看每日充电与耗电详情");
      // ⚠️ 必须**限定在充电面板里**: 驾驶模式的图表工具行也用 .chargeSeries / .chartSwitch
      //    (见 _renderCtrls), 不限定就会点到那三个系列开关上(实测踩过)。
      root.querySelectorAll('.chargePlot .chargeSeries button')[2].click();await tick();
      if(root.querySelectorAll('.chargePlot .chargeSeries button[aria-pressed="true"]').length!==3||!root.querySelector('.chargeTip').textContent.includes('电费'))fail('energy: 充电趋势不能切换电费系列');else ok('energy: 充电趋势可切换电费系列，气泡逐行显示');
      root.querySelector('.chargePlot .chartSwitch').click();await tick();
      if(!root.querySelector('.chargePlot .chargeSvg rect[fill="#40b49d"]'))fail('energy: 充电趋势柱状切换无效');else ok('energy: 充电趋势支持折线与分组柱状切换');
      root.querySelector('.chargePlot .chartSwitch').click();await tick();
      const chargeRequests=calls.length,firstDay=bill._chargeData.days[0];
    bill._chargeData.days=[firstDay,{...firstDay,day:'2026-10-14'},{...firstDay,day:'2026-10-15'}];bill.requestUpdate();await tick();
    const chargeHost=root.querySelector('.chargeBody'),chargeSvg=root.querySelector('.chargeSvg');
    chargeSvg.getBoundingClientRect=()=>({left:100,top:100,width:350,height:180});chargeHost.setPointerCapture=()=>{throw Error('模拟 WebView 不支持捕获')};
    const dragDay=(target,type,x)=>target.dispatchEvent(new window.MouseEvent(type,{bubbles:true,cancelable:true,button:0,buttons:type==='pointerup'?0:1,clientX:x,clientY:150}));
    dragDay(chargeSvg,'pointerdown',140);dragDay(window,'pointermove',280);await tick();
    const middleSelected=root.querySelector('.chargeTip').textContent.includes('2026-10-14');
    dragDay(window,'pointermove',425);await tick();dragDay(window,'pointerup',425);root.querySelector('.chargeSvg g').dispatchEvent(new window.MouseEvent('click',{bubbles:true}));await tick();
    if(!middleSelected||!root.querySelector('.chargeTip').textContent.includes('2026-10-15')||root.querySelector('.chargeBody')!==chargeHost||calls.length!==chargeRequests)fail('energy: 连续拖动中断、松手回跳或重复请求');else ok('energy: 连续跨日拖动在中途更新，捕获失败仍接续，松手不回跳且无额外请求');
    chargeSvg.dispatchEvent(new window.MouseEvent('pointermove',{bubbles:true,buttons:0,clientX:280,clientY:150}));await tick();
    if(!root.querySelector('.chargeTip').textContent.includes('2026-10-14'))fail('energy: 鼠标悬停未更新日期');else ok('energy: 鼠标移动即可连续查看不同日期');
    clickText("电价设置");await tick();
    if(!root.querySelector('.tariffForm[role="dialog"][aria-modal="true"]')||!root.querySelector('[aria-label="关闭电价设置"]'))fail('energy: 电价未放入可关闭弹窗');else ok('energy: 电价使用独立弹窗，关闭入口保留在卡内');
    if(root.querySelectorAll('.tariffTimeRange input').length!==2||root.querySelectorAll('.periodTimes input').length!==2||root.querySelectorAll('.tariffEfficiency').length!==2||!(/@container\s*\(max-width:\s*360px\)/.test(root.querySelector('style')?.textContent||'')))fail('energy: 电价设置时段、效率或窄屏排布缺少分组');
    else ok('energy: 电价设置将慢充时段、直流分时和效率分组，并适配窄屏');
    const input=(i,value)=>{const n=root.querySelectorAll(".tariffGrid input")[i];n.value=value;n.dispatchEvent(new window.Event("input",{bubbles:true}));};
    input(0,"-1");clickText("保存电价");await tick();
    if(calls.some(c=>c.type==="leapmotor/charging/tariff")||!root.querySelector(".tariffForm .error"))fail("energy: 非法电价发送给后端");
    else ok("energy: 非法电价在保存前拦截");
    clickText('添加电价时段');await tick();
    if(root.querySelectorAll('.periodRow').length!==2)fail('energy: 无法添加独立电价时段');else ok('energy: 新时段自动平分原时段，保留连续覆盖');
    root.querySelector('[aria-label="删除时段2"]').click();await tick();
    input(0,".8");input(1,".3");const dcPrice=root.querySelector('[aria-label="时段1电价"]');dcPrice.value='1.2';dcPrice.dispatchEvent(new window.Event('input',{bubbles:true}));rejectSave=true;clickText("保存电价");await tick();
    if(!root.querySelector(".tariffForm .error")?.textContent.includes("模拟保存失败")||!root.querySelector(".tariffForm"))fail("energy: 保存失败应保留电价输入并显示错误");
    else ok("energy: 保存失败保留输入，不显示假成功");
    rejectSave=false;const dailyCalls=calls.filter(c=>c.type==="leapmotor/energy/daily").length;
    clickText("保存电价");await tick();
    if(root.querySelector(".tariffForm")||!root.querySelector(".energyStat.cost").textContent.includes("¥3.00")||calls.filter(c=>c.type==="leapmotor/energy/daily").length!==dailyCalls||calls.filter(c=>c.type.startsWith("leapmotor/charging/")).some(c=>c.entry_id!=="car-a"))fail("energy: 电价保存刷新/车辆隔离/请求数量异常");
    else ok("energy: 按车辆保存电价，刷新本地账本，不额外取云端能耗");
    bill.hass={...billHass,user:{is_admin:false}};bill.requestUpdate();await tick();
    if(!root.querySelector(".priceBtn").disabled)fail("energy: 非管理员仍可设置电价");
    else ok("energy: 非管理员电价设置不可用");
    bill._chargeCache={};delayedWeek=true;bill._loadCharge(true);await tick();
    clickText("月");await tick();
    delayedWeek(history(7));delayedWeek=null;await tick();
    if(!root.querySelector(".energySummary").textContent.includes("30.0"))fail("energy: 旧范围迟到响应覆盖新范围");
    else ok("energy: 迟到的充电历史不会覆盖新范围");
    bill.remove();
    const priced=window.document.createElement('leapmotor-energy');window.document.body.appendChild(priced);priced.setConfig({type:'custom:leapmotor-energy',entry_id:'price-car'});
    const priceCalls=[];let failPrice=true;
    const record={id:'s1',started_at:1791900000,last_at:1791903600,ended_at:1791903600,kwh:6,grid_kwh:6.67,cost:3,sources:['power'],active:false,partial:false,charge_type:'ac'};
    priced.hass={...billHass,callWS:async msg=>{priceCalls.push(msg);if(msg.type==='leapmotor/energy/daily')return{days:[],summary:{}};if(msg.type==='leapmotor/charging/price'){if(failPrice)throw Error('保存失败');return{saved:true}};return{...history(7),sessions:[record],summary:{kwh:6,grid_kwh:6.67,cost:3,count:1}}}};
    await tick();const pr=priced.shadowRoot,pclick=t=>[...pr.querySelectorAll('button')].find(b=>b.textContent.trim()===t)?.click();pclick('充电与电费');await tick();pclick('修改本次价格');await tick();
    const mode=pr.querySelector('.sessionPrice select');mode.value='total';mode.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();const value=pr.querySelector('.sessionPrice input');value.value='12.5';value.dispatchEvent(new window.Event('input',{bubbles:true}));pclick('保存本次价格');await tick();
    if(!pr.querySelector('.sessionPrice .error')||pr.querySelector('.sessionPrice input').value!=='12.5')fail('energy: 单次价格失败后丢失输入或假报成功');else ok('energy: 单次价格保存失败保留金额并显示错误');
    failPrice=false;pclick('保存本次价格');await tick();
    const savedPrice=priceCalls.find(m=>m.type==='leapmotor/charging/price');
    if(!savedPrice||savedPrice.entry_id!=='price-car'||savedPrice.session_id!=='s1'||savedPrice.mode!=='total'||savedPrice.value!==12.5||pr.querySelector('.sessionPrice input'))fail('energy: 单次价格提交或刷新异常');else ok('energy: 单次价格按车辆和记录保存，成功后重新读取账本');priced.remove();
    const fuelEl=window.document.createElement("leapmotor-energy");window.document.body.appendChild(fuelEl);
    fuelEl.setConfig({type:"custom:leapmotor-energy",vin:"DEMO_FUEL",range:"week"});
    fuelEl.hass={...billHass,callWS:async msg=>msg.type==="leapmotor/energy/daily"?{vin:"DEMO_FUEL",reev:true,fuel_average:6.2,days:[{day:"2026-10-13",km:20,kwh:3,eff:15,fuel:.3},{day:"2026-10-14",km:30,kwh:4,eff:13.3,fuel:1.2}],summary:{km:50,kwh:7},pending:0}:history(7)};
    await tick();const fuelRoot=fuelEl.shadowRoot,chart=fuelRoot.querySelector(".chartBox");
    if(!fuelRoot.querySelector('[data-act="toggle-fuel"]')||!fuelRoot.querySelector(".energySummary").textContent.includes("6.2"))fail("energy: 增程车的耗油系列或近期油耗未出现");else ok("energy: 增程车显示耗油系列和近期油耗，纯电仍隐藏");
    const oldSvgRect=window.SVGElement.prototype.getBoundingClientRect;
    window.SVGElement.prototype.getBoundingClientRect=()=>({left:0,top:0,width:360,height:176,right:360,bottom:176});
    const pointer=(host,type,x)=>host.dispatchEvent(new window.MouseEvent(type,{bubbles:true,composed:true,button:0,clientX:x,clientY:50}));
    pointer(chart,"pointerdown",40);pointer(chart,"pointermove",300);pointer(chart,"pointerup",300);await tick();
    if(!fuelRoot.querySelector(".tip")?.textContent.includes("耗油估算 1.20 L"))fail("energy: 跨 SVG 重绘的滑动日期选择失败");else ok("energy: 滑动日期可连续选择，显示该日耗油估算");
    fuelEl.remove();window.document.body.appendChild(fuelEl);pointer(chart,"pointerdown",40);pointer(chart,"pointerup",40);await tick();
    if(!fuelRoot.querySelector(".tip")?.textContent.includes("耗油估算 0.30 L"))fail("energy: 卡片重新挂载后滑动监听失效");else ok("energy: 重新挂载仍可滑动选择日期");
    window.SVGElement.prototype.getBoundingClientRect=oldSvgRect;fuelEl.remove();
  }

  // ── control 专项:hero 新布局 + 车模右上角告警停靠区(可收起为红色「!」) ──
  if (name === "control") {
    // ① 左右分栏结构 —— 必须断言**父子关系**, 不能只断言"元素存在":    //    jsdom 没有布局, 元素存在但嵌套错了照样"通过"(真机踩过: 少一个 </div> 让
    //    heroRight 变成 heroLeft 的子节点 → 胶囊掉到续航行下面、电量条被拉长、
    //    车模被当成 heroTop 的 flex 项而挤窄不居中)。
    const top = sr.querySelector(".heroTop");
    const left = sr.querySelector(".heroLeft");
    const right = sr.querySelector(".heroRight");
    if (!top || !left || !right) fail(`control: heroTop/heroLeft/heroRight 结构缺失`);
    else if (left.parentElement !== top) fail(`control: heroLeft 不是 heroTop 的直接子节点`);
    else if (right.parentElement !== top) fail(`control: heroRight 不是 heroTop 的直接子节点(嵌套错了 → 胶囊会掉下去)`);
    else if (left.contains(right)) fail(`control: heroRight 被嵌在 heroLeft 里(应为兄弟节点)`);
    else ok(`control: heroTop 下 heroLeft / heroRight 是兄弟节点`);
    // 续航行必须在左栏里(它是"左栏内容", 不在左栏就会与右栏抢位置)
    const heroMain = sr.querySelector(".heroMain");
    if (heroMain && !left.contains(heroMain)) fail(`control: 续航行不在 heroLeft 里`);
    // 车模必须是 heroTop 的**兄弟**(在 hero 面板里), 不能被卷进 heroTop 当 flex 项
    const cm = sr.querySelector(".carModel");
    if (cm && top.contains(cm)) fail(`control: 车模被嵌进了 heroTop(会变成 flex 项被挤窄、不居中)`);
    else ok(`control: 车模在 heroTop 之外(不与分栏争宽)`);
    // 锁: 右栏**只放状态胶囊**, 锁本身已挪到动作行的圆钮(.circ[data-act="lockround"]) ——
    // 它在右栏里会与"已驻车/未插枪/待车端确认"抢位, 挤动续航行。
    if (right.querySelector(".lockBox") || right.querySelector('[data-act="lock"], [data-act="lockround"]')) {
      fail(`control: 锁又回到 hero 右栏了(应留在动作行的圆钮里)`);
    } else if (!sr.querySelector('.p-actions .circ[data-act="lockround"]')) {
      fail(`control: 动作行里没有锁圆钮(.circ[data-act="lockround"])`);
    } else if (sr.querySelector(".heroMain .lockBox")) {
      fail(`control: 续航行里出现锁(应为空)`);
    } else ok(`control: 锁在动作行圆钮里, hero 右栏只有状态胶囊`);

    // ② 状态胶囊(行驶/驻车 + 充电状态)在右栏;告警**不在**右栏(否则会挤动续航行)
    const statusPills = [...right.querySelectorAll(".pill")];
    if (!statusPills.length) fail(`control: 右栏没有状态胶囊`);
    else ok(`control: 右栏状态胶囊 ${statusPills.length} 个(${statusPills.map(p => p.textContent.trim()).join(" / ")})`);
    if (right.querySelector(".pill.err")) fail(`control: 红色告警出现在了右栏(应停在车模右上角)`);
    else ok(`control: 右栏没有红色告警`);

    // ②b 1.9.39: 右栏改**横排 + 允许换行 + 右对齐**(原来纵排: 已驻车/未插枪/车门已上锁 三行)。
    //    jsdom 没有布局, 量不到 y 坐标 —— 这里断言**规则本身**(横排/换行/右对齐/封顶),
    //    真正的"两个 pill 同一行"由浏览器夹具的几何自证(`_b5_*.json` 里 pills[].r.y 相等)兜底。
    const rightRule = (code.match(/\.heroRight\s*\{([^}]*)\}/) || [])[1] || "";
    if (!/flex-direction:\s*row/.test(rightRule)) {
      fail(`control: .heroRight 不是横排(胶囊会被排成三行): ${rightRule.slice(0, 90)}`);
    } else if (!/flex-wrap:\s*wrap/.test(rightRule)) {
      fail(`control: .heroRight 不允许换行(放不下时会溢出)`);
    } else if (!/justify-content:\s*flex-end/.test(rightRule)) {
      fail(`control: .heroRight 没有右对齐(胶囊列不再贴右缘)`);
    } else if (!/max-width:\s*50%/.test(rightRule)) {
      fail(`control: .heroRight 没有宽度封顶 —— 它会按"三颗排一行"的 max-content 要宽度, .heroTop 只好把整块右栏换到第二行`);
    } else ok(`control: .heroRight = 横排 + wrap + 右对齐 + 宽度封顶(胶囊同行、超宽才整块换行)`);

    // ③ 告警停靠区:两条告警 → 收起态是一颗带角标的红色「!」
    const btn = sr.querySelector(".warnDock .warnBtn");
    if (!btn) fail(`control: 车模右上角没有告警按钮(胎压低+后备箱开 应产生告警)`);
    else {
      const cnt = btn.querySelector(".cnt");
      if (btn.textContent.trim().replace(/\d/g, "") !== "!") fail(`control: 告警按钮文字异常: ${btn.textContent}`);
      else if (!cnt) fail(`control: 两条告警应有条数角标`);
      else ok(`control: 收起态 = 红色「!」+ 角标 ${cnt.textContent}`);
    }

    // ④ 点「!」→ 展开成逐条胶囊 + 「收起」;再点 → 收回去
    if (btn) {
      btn.dispatchEvent(new window.Event("click", { bubbles: true, composed: true }));
      const list = sr.querySelector(".warnDock .warnList");
      const pills = list ? [...list.querySelectorAll(".pill.err")] : [];
      if (!list || !pills.length) fail(`control: 点「!」后没有展开成逐条胶囊`);
      else if (!list.querySelector(".warnCollapse")) fail(`control: 展开态缺少「收起」按钮`);
      else ok(`control: 展开态 ${pills.length} 条(${pills.map(p => p.textContent.trim()).join(" / ")})`);
      const col = sr.querySelector(".warnDock .warnCollapse");
      if (col) {
        col.dispatchEvent(new window.Event("click", { bubbles: true, composed: true }));
        if (!sr.querySelector(".warnDock .warnBtn")) fail(`control: 点「收起」后没有回到红色「!」`);
        else ok(`control: 「收起」可切回红色「!」`);
      }
    }

    // ⑤ 车模:不再有子块外观(无背景/无边框/无阴影)
    if (!cm) fail(`control: .carModel 不存在`);
    else {
      const cs = window.getComputedStyle(cm);
      const bgOn = cs.backgroundColor && cs.backgroundColor !== "rgba(0, 0, 0, 0)" && cs.backgroundColor !== "transparent";
      const bw = parseFloat(cs.borderTopWidth || "0") || 0;
      const shadow = cs.boxShadow && cs.boxShadow !== "none";
      if (bgOn || bw > 0 || shadow) {
        fail(`control: 车模仍有子块外观(bg=${cs.backgroundColor} border=${bw} shadow=${shadow})`);
      } else ok(`control: 车模已直接落在卡片背景上(无底/无框/无阴影)`);
    }

    // ⑤b 1.9.39「只留阴影」: 子块(.sec/.half/.pick)与大按钮(.circ + 胶囊钮)都**去掉 1px 边框**,
    //    改成与卡片内弹窗(.smodal, 无边框 + 一层投影)同一套"浮起来"的写法。
    //    ⚠️ 必须显式 `border: 0`: 光删掉自己那条 1px 会让**按钮的 UA 默认 2px outset 描边**
    //    露出来(实测: 圆钮/胶囊全变黑边, 比原来的灰边难看) —— 所以这里连这一条也一起断言。
    {
      const secRule = (code.match(/\.sec,\s*\.half,\s*\.pick,\s*\.circ\s*\{([^}]*)\}/) || [])[1] || "";
      // ⚠️ 产物里换行是**字面量 \n 两个字符**(CSS 在 JS 字符串里), 所以选择器之间的换行只能用
      //    [\s\S] 跨过去, 不能写 \s(匹配不到反斜杠)。
      const btnRule = (code.match(/\.toolBtn,\s*\.chip,\s*\.winOpt,\s*\.fanBtn,\s*\.floatPill,\s*\.cabBtn,[\s\S]*?\.pickRow\s*\{([^}]*)\}/) || [])[1] || "";
      const modalRule = (code.match(/\.smodal\s*\{([^}]*)\}/) || [])[1] || "";
      const circWarn = (code.match(/\.circ\.warn\s*\{([^}]*)\}/) || [])[1] || "";
      if (!secRule || !btnRule) fail(`control: 找不到 .sec/.circ 或按钮那两组规则(断言没法跑)`);
      else if (/border:\s*1px/.test(secRule) || /border:\s*1px/.test(btnRule)) {
        fail(`control: 子块/按钮还在画 1px 边框(应改成只留阴影)`);
      } else if (!/\bborder:\s*0/.test(secRule) || !/\bborder:\s*0/.test(btnRule)) {
        fail(`control: 子块/按钮没有显式 border: 0 —— 按钮的 UA 默认 2px outset 描边会露出来`);
      } else if (!/box-shadow\s*:/.test(secRule) || !/box-shadow\s*:/.test(btnRule)) {
        fail(`control: 子块/按钮没有阴影(去掉边框后就没有"浮起来"的观感了)`);
      } else if (/border:\s*1px/.test(modalRule) || !/box-shadow\s*:/.test(modalRule)) {
        fail(`control: 卡片内弹窗(.smodal)应该保持"无边框 + 一层投影"(它就是这套语言的样板)`);
      } else if (!/inset/.test(circWarn)) {
        fail(`control: 圆钮的未关告警态没有改用 inset 描边(原来靠 border-color, 边框去掉后就没提示了)`);
      } else ok(`control: 子块/圆钮/胶囊钮 = 无边框 + 一层阴影(border: 0 挡住 UA 描边; 圆钮告警改 inset 环)`);
    }

    // 全页弹窗不依赖卡片高度，避免宽屏、整页滚动时裁切。
    {
      const maskRule = (code.match(/\.smask\s*\{([^}]*)\}/) || [])[1] || "";
      const modalRule = (code.match(/\.smodal\s*\{([^}]*)\}/) || [])[1] || "";
      if (!/position:\s*fixed/.test(maskRule) || !/position:\s*fixed/.test(modalRule)
          || !/85dvh/.test(modalRule) || /backdrop-filter/.test(maskRule)) fail('control: 弹窗未统一为无需模糊计算的全页遮罩');
      else ok('control: 充电/设置使用全页遮罩，正文高度受视口限制');
    }

    // 0.3.0: 车况更新时间与通用刷新钮已移除;3D 查看器在标题行提供独立刷新入口。
    const heroText=sr.querySelector(".p-hero")?.textContent||"";
    if(/状态更新|刷新车况/.test(heroText))fail("control: hero 仍显示车况更新时间或通用刷新入口");
    else ok("control: hero 不再显示车况更新时间与通用刷新入口");

    // ⑦ 重启窗口自愈:注册表读不到 + states 为空 → 先空; 之后恢复 → 必须自己好
    //    (实机踩过: 部署重启后卡片只剩"还没找到实体", 要点刷新页面才恢复)
    const el2 = window.document.createElement("leapmotor-control");
    window.document.body.appendChild(el2);
    let wsOk = false;
    const hassEmpty = {
      states: {},
      themes: { darkMode: false },
      user: { is_admin: true },
      callWS: async (msg) => {
        if (!wsOk) throw new Error("HA 还没起来");
        if (msg.type === "config/entity_registry/list") return [
          { entity_id: "sensor.reg_battery", platform: "leapmotor", device_id: "dev1",
            translation_key: "battery", unique_id: "V_battery", disabled_by: null },
        ];
        if (msg.type === "config/device_registry/list") return [{ id: "dev1", name: "零跑 C10", model: "C10" }];
        return {};
      },
      callService: async () => undefined,
    };
    el2.setConfig({ type: "custom:leapmotor-control" });
    el2.hass = hassEmpty;                                  // 重启窗口: 什么都没有
    await new Promise((r) => setTimeout(r, 60));
    const broken = !el2.shadowRoot.querySelector('[data-act="press"]')
      && !el2.shadowRoot.querySelector("[data-act]");
    // 现在 HA 起来了: 补上实体 + 让 WS 可用, 再推一帧 hass(重试节流 10s, 这里直接跨过去)
    wsOk = true;
    hassEmpty.states = { "sensor.reg_battery": { entity_id: "sensor.reg_battery", state: "76", attributes: {} } };
    el2._regRetryAt = 0;                                   // 跳过节流(测试里不等 10 秒)
    el2.hass = hassEmpty;
    await new Promise((r) => setTimeout(r, 120));
    const healed = !!el2.shadowRoot.querySelector("[data-act]");
    if (!broken) ok(`control: (重启窗口场景未复现出"空卡片", 直接进自愈检查)`);
    if (!healed) fail(`control: 注册表恢复后卡片没有自愈(仍无任何控件)`);
    else ok(`control: 重启窗口后能自愈(注册表恢复即重新解析出实体)`);

    // ⑧ 充电状态块(按当前规格): 只在"充电中"出现;
    //    收起态 = 图标 + 「慢充中/快充中」(**不显示功率**); 展开态 = 同款白框 + 电压/电流/功率,
    //    收起钮是**极简箭头**且整块可点; 快充由 dc_connected 区分(双状态图标里带 F)。
    const mkChg = (chgState, dc) => {
      const h = fakeHass();
      h.states["sensor.dian_liang"] = { entity_id: "sensor.dian_liang", state: "47.7",
        attributes: { friendly_name: "电量", charging_voltage: 688.7, charging_current: -9.099 } };
      h.states["sensor.chong_dian_zhuang_tai"] = { entity_id: "sensor.chong_dian_zhuang_tai",
        state: chgState, attributes: { friendly_name: "充电状态", remaining_minutes: 380,
          dc_connected: !!dc } };
      return h;
    };
    const mkEl = async (h) => {
      const el = window.document.createElement("leapmotor-control");
      window.document.body.appendChild(el);
      el.setConfig({ type: "custom:leapmotor-control" });
      el.hass = h;
      await new Promise((r) => setTimeout(r, 60));
      return el;
    };

    const el3 = await mkEl(mkChg("charging", false));
    const sr3 = el3.shadowRoot;
    const btn3 = sr3.querySelector(".chgDock .chgBtn");
    if (!btn3) fail(`control: 充电中没有出现车模左侧的充电块`);
    else {
      const txt = btn3.textContent.replace(/\s+/g, "");
      if (txt !== "慢充中") fail(`control: 收起态应为「慢充中」且**不带功率**, 实际「${txt}」`);
      else ok(`control: 收起态 = 慢充中(不显示功率)`);
      if (!btn3.querySelector('svg.bolt')) fail(`control: 收起态没有充电图标(svg.bolt)`);
      else ok(`control: 收起态带 SVG 闪电图标`);
      const cssTxt = sr3.querySelector("style")?.textContent || "";
      const dockRule = (cssTxt.match(/\.chgDock\s*\{[^}]*\}/) || [""])[0];
      const warnRule = (cssTxt.match(/\.warnDock\s*\{[^}]*\}/) || [""])[0];
      const c3Dock = (cssTxt.match(/\.heroStage\.stage3d\s+\.chgDock\s*,\s*\.heroStage\.stage3d\s+\.warnDock\s*\{[^}]*\}/) || [""])[0];
      if (!/position:\s*absolute/.test(dockRule)) fail(`control: 充电块不是绝对定位(会挤动车模)`);
      else if (/translateY/.test(dockRule)) fail(`control: 充电块带了 translateY(高度一变左上角就会移动)`);
      else if (!/left:\s*10px/.test(dockRule) || !/top:\s*10px/.test(dockRule)) {
        fail(`control: 充电块没有锚在车模左上角(应 left/top 10px): ${dockRule.slice(0, 70)}`);
      } else if (!/right:\s*10px/.test(warnRule) || !/top:\s*10px/.test(warnRule)) {
        fail(`control: 告警块没有锚在车模右上角(应 right/top 10px): ${warnRule.slice(0, 70)}`);
      } else if (!/--c3data/.test(c3Dock)) {
        fail(`control: 3D 下充电块/告警块没有贴到数据层下沿(--c3data) —— 会压住车名/胶囊`);
      } else ok(`control: 充电块贴车模左上角 10px、告警块贴右上角(3D 时都落在数据层下沿的空档)`);
      // ③b 1.9.39: 告警**展开态与收起态同锚点** —— 展开不再整块左移 70px(用户报的正是这一点:
      //    展开后胶囊与告警提示对不上)。这条以前反而在断言旧行为, 现在换成"**不许**再出现
      //    位移规则"的**更严**写法: 任何给 .warnDock.open 的 right/left 位移都会挂。
      const openRule = (cssTxt.match(/\.warnDock\.open\s*\{[^}]*\}/) || [""])[0];
      const listRule = (cssTxt.match(/\.warnDock\.open\s+\.warnList\s*\{[^}]*\}/) || [""])[0];
      if (/\bright\s*:/.test(openRule) || /\bleft\s*:/.test(openRule)) {
        fail(`control: .warnDock.open 又在横移了(展开/收起必须同锚点): ${openRule.slice(0, 80)}`);
      } else if (!/max-width/.test(listRule)) {
        fail(`control: 展开态的列表没有收窄(max-width) —— 长文案会把列表拉成整屏宽`);
      } else if (!/\.heroStage\.stage3d\s+\.tirePads\.hasWarn\s+\.tP\.b/.test(cssTxt)) {
        fail(`control: 3D 下展开告警时右列胎压读数没有让位(列表钉在右缘 10px, 会让读数被压住)`);
      } else ok(`control: 告警收起/展开同锚点(右缘 10px) + 展开态列表收窄 + 3D 右列读数让位`);
      if (!sr3.querySelector(".bar.charging")) fail(`control: 充电中电量条没有 charging 类(流光不生效)`);
      else ok(`control: 充电中电量条带 charging(流光)`);
      // 展开: 点整块 → 面板(电压/电流/功率 + 极简收起箭头)
      btn3.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const panel = sr3.querySelector(".chgPanel");
      if (!panel) fail(`control: 点充电块没有展开面板`);
      else {
        const p = panel.textContent.replace(/\s+/g, "");
        if (!(p.includes("688.7") && p.includes("9.1") && p.includes("6.3"))) {
          fail(`control: 展开面板缺数据(实际 ${p})`);
        } else ok(`control: 展开面板 = 电压 688.7 / 电流 9.1 / 功率 6.3`);
        if (!panel.querySelector(".chgMin")) fail(`control: 展开面板缺少极简收起箭头(.chgMin)`);
        else ok(`control: 展开态标题行带极简收起箭头`);
        // 整块可点: 点面板任意处即收起(点整块切换)
        panel.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        if (!sr3.querySelector(".chgBtn")) fail(`control: 点面板没有收起(应"点整块切换")`);
        else ok(`control: 点整块可收起`);
      }
    }

    // 快充: 文案变「快充中」, 图标里带 F
    const el5 = await mkEl(mkChg("charging", true));
    const fastBtn = el5.shadowRoot.querySelector(".chgDock .chgBtn");
    if (!fastBtn) fail(`control: 快充时没有充电块`);
    else {
      const t = (fastBtn.querySelector("span")?.textContent || "").replace(/\s+/g, "");
      const hasF = !!fastBtn.querySelector("svg.bolt text");
      if (t !== "快充中") fail(`control: 快充文案应为「快充中」, 实际「${t}」`);
      else if (!hasF) fail(`control: 快充图标里没有 F`);
      else ok(`control: 快充 = 快充中 + 图标带 F`);
    }

    // 已插枪未充电 → 不显示
    const el4 = await mkEl(mkChg("plugged", false));
    const anyChg = el4.shadowRoot.querySelector(".chgDock, .bar.charging");
    if (anyChg) fail(`control: "已插枪未充电"时不该显示充电块/流光`);
    else ok(`control: "已插枪未充电"时不显示充电块(只有充电中才显示)`);

    // ⑨ 座椅与加热 = 空调卡里的按钮(不是折叠卡); 点它弹窗; 充电卡点开也是弹窗
    const seatBtn = sr.querySelector('[data-act="seatmenu"]');
    if (!seatBtn) fail(`control: 空调卡里没有「座椅与加热」入口按钮`);
    else if (!sr.querySelector(".p-climate")?.contains(seatBtn)) fail(`control: 座椅按钮不在空调卡里`);
    else ok(`control: 座椅与加热是空调卡里的按钮`);
    // 注: comfort 面板已迁到 Lit 模板(恒为空) —— 容器里会留一个注释锚点, 所以这里判"空"
    //     要看**元素子节点**, 不能再用 innerHTML.trim()(注释节点也算非空)。
    if (sr.querySelector(".p-comfort")?.children.length) fail(`control: 座椅的折叠卡仍在(应已挪走)`);
    else ok(`control: 座椅的折叠卡已移除`);
    if (sr.querySelector('[data-act="fold"][data-sec="charging"]')) fail(`control: 充电仍是折叠卡(应改成弹窗入口)`);
    else ok(`control: 充电已改为弹窗入口`);
    if (seatBtn) {
      seatBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (!sr.querySelector(".smodal.on")) fail(`control: 点座椅按钮没有弹出弹窗`);
      else if (sr.querySelector(".smodal .smhead .t")?.textContent !== "座椅与加热") {
        fail(`control: 座椅弹窗标题不对: ${sr.querySelector(".smodal .smhead .t")?.textContent}`);
      } else ok(`control: 座椅按钮 → 弹窗(标题=座椅与加热)`);
      // 关掉再看充电弹窗
      sr.querySelector("[data-act=\"smclose\"]")?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const chgHead = sr.querySelector('[data-act="chargemenu"]');
      if (!chgHead) fail(`control: 充电卡没有弹出入口(data-act=chargemenu)`);
      else {
        chgHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        const title = sr.querySelector(".smodal .smhead .t")?.textContent;
        if (!sr.querySelector(".smodal.on")) fail(`control: 点充电卡没有弹出充电设置`);
        else if (title !== "充电设置") fail(`control: 充电弹窗标题不对: ${title}`);
        else ok(`control: 充电卡 → 弹窗(标题=充电设置)`);
      }
    }
    // ⑩ 窄宽度断点: <420 加 .narrow(圆钮缩小/车模变矮), <280 才加 .tiny(两张小卡堆叠)。
    //    jsdom 没有布局(clientWidth 恒 0、观察者不会自己回调), 所以桩掉宽度后**手动调**回调,
    //    验的是断点逻辑本身。关键回归: 300~419px 这段(HA 里最常见的列宽)两张小卡必须仍是
    //    **一次左右并排** —— 旧版在 <420 就堆叠, 那段宽度下就总是上下两行。
    const cardEl = sr.querySelector(".card");
    const setW = (w) =>
      Object.defineProperty(cardEl, "clientWidth", { value: w, configurable: true });
    const atW = (w) => {
      setW(w);
      for (const cb of window.__roCbs) cb();
      return {
        narrow: cardEl.classList.contains("narrow"),
        tiny: cardEl.classList.contains("tiny"),
      };
    };
    const b420 = atW(420), b419 = atW(419), b300 = atW(300), b279 = atW(279);
    if (b420.narrow || b420.tiny) fail(`control: 420px 不该加窄宽度类`);
    else if (!b419.narrow || b419.tiny) fail(`control: 419px 应只加 .narrow(圆钮缩小), 不加 .tiny`);
    else if (!b300.narrow || b300.tiny) fail(`control: 300px 应 .narrow(圆钮缩小)但不 .tiny`);
    else if (!b279.tiny) fail(`control: 279px 应加 .tiny(两张小卡才堆叠)`);
    else ok(`control: 断点 420/419/300/279px → 只在 <280 堆叠两张小卡`);
    // 断点必须落在 CSS 上: 堆叠只由 .tiny 驱动, .narrow 不再碰 cardsRow(否则又变"经常上下")
    const rowRule = (code.match(/\.card\.tiny\s*\.cardsRow\s*\{([^}]*)\}/) || [])[1] || "";
    if (!/flex-direction:\s*column/.test(rowRule)) {
      fail(`control: 产物里没有 ".card.tiny .cardsRow{flex-direction:column}"`);
    } else if (/\.card\.narrow\s*\.cardsRow/.test(code)) {
      fail(`control: .narrow 仍在控制两张小卡的堆叠(应只由 .tiny 控制)`);
    } else ok(`control: 两小卡堆叠只由 .tiny(<280px) 驱动`);

    // ⑪ 「预设」钮 + 「座椅」钮: 必须在同一个 .actPreset 里并排, 间距靠它的 gap
    //    (踩过: 这层是块级 + 两颗钮靠行内空白排 → 贴在一起 0px 且基线错位 10px, 看着像一颗钮)
    //    ⚠️ 这里必须重新查一次节点: 上面开关过弹窗, 卡片重渲染过, 早先抓的 seatBtn 已脱离文档。
    const actWrap = sr.querySelector(".actPreset");
    const preBtn = sr.querySelector('[data-act="presetmenu"]');
    const seatNow = sr.querySelector('[data-act="seatmenu"]');
    const actRule = (code.match(/\.actPreset\s*\{([^}]*)\}/) || [])[1] || "";
    if (!actWrap) fail(`control: 没有 .actPreset 包裹层`);
    else if (!preBtn || !seatNow || actWrap !== preBtn.parentElement || actWrap !== seatNow.parentElement) {
      fail(`control: 预设/座椅钮不在同一个 .actPreset 里(间距规则会失效)`);
    } else if (!/display:\s*inline-flex/.test(actRule) || !/gap:\s*12px/.test(actRule)) {
      fail(`control: .actPreset 缺 flex/gap(两颗钮会贴在一起)`);
    } else ok(`control: 预设/座椅钮同在一个 .actPreset(inline-flex + 12px 间距)`);

    // ⑬ 面板内容没变 → 一个字节都不动。
    //    为什么重要: 每次状态推送都会把所有面板都提交一遍模板, 但真变的常常只有续航/电量那一格;
    //    内容没变就不该动 DOM(否则焦点、输入草稿、滚动位置都要靠补丁去救)。C 档收尾后这条由
    //    **Lit 自己的 diff** 兜着(以前是 _setPanel 按 (html, class) 字符串比对 —— 那套已删除),
    //    所以这里挑三个面板一起验: 动作行 / hero / 车模设置。
    const focusCalls = [];
    const origFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function (opts) {
      focusCalls.push({ opts, act: this.getAttribute && this.getAttribute("data-act") });
      return origFocus.call(this, opts);
    };
    const noopPanels = [".p-actions", ".p-hero", ".p-car3d"].map((sel) => sr.querySelector(sel));
    if (noopPanels.some((p) => !p || !p.firstElementChild)) {
      fail(`control: 有面板没画出来, 面板跳过重画这条测不了`);
    } else {
      const before = noopPanels.map((p) => p.firstElementChild);
      let mutations = 0;
      const mo = new MutationObserver((recs) => { mutations += recs.length; });
      for (const p of noopPanels) {
        mo.observe(p, { childList: true, subtree: true, attributes: true, characterData: true });
      }
      el.hass = fakeHass();                  // 同一份数据 → 面板内容必然相同
      await new Promise((r) => setTimeout(r, 60));
      mo.disconnect();
      if (mutations) {
        fail(`control: 内容没变却改动了面板 DOM(${mutations} 次) —— 每次推送都白提交一遍`);
      } else if (noopPanels.some((p, i) => p.firstElementChild !== before[i])) {
        fail(`control: 内容没变却重建了面板节点(焦点/草稿/滚动又要靠补丁救)`);
      } else if (focusCalls.length) {
        fail(`control: 内容没变却动了焦点(${focusCalls.length} 次)`);
      } else ok(`control: 内容没变 → 三个面板零改动(节点身份不变, 焦点没被动过)`);
    }

    // ⑭ [原来是"内容变了照常重画 + 还焦点必须带 preventScroll" —— 那套 _setPanel 补丁已随机制
    //    一起删除] 换成等价覆盖: 内容变了照常更新, 但**那颗钮的节点没被换掉** —— Lit 原地打补丁,
    //    浏览器自己就把焦点与滚动留在原处, 所以"重画后把焦点还回去"这件事不再需要发生了。
    const changed = fakeHass();
    // 后备箱 开→关: 动作行面板的内容随之改变(后备箱钮的类/aria/title 都变)
    changed.states["switch.hou_bei_xiang"] = {
      entity_id: "switch.hou_bei_xiang", state: "off", attributes: { friendly_name: "后备箱" },
    };
    const actPanel = sr.querySelector(".p-actions");
    const trunkBtn = actPanel.querySelector('[data-act="trunk"]');
    const clsBefore = trunkBtn.className;
    trunkBtn.focus();
    const focusedBefore = sr.activeElement === trunkBtn;
    el.hass = changed;                       // 后备箱状态变了 → 动作行内容不同
    await new Promise((r) => setTimeout(r, 60));
    const trunkAfter = actPanel.querySelector('[data-act="trunk"]');
    if (!trunkAfter || trunkAfter.className === clsBefore) {
      fail(`control: 状态变了面板却没更新(该更新的没更新)`);
    } else if (trunkAfter !== trunkBtn) {
      fail(`control: 内容变了却重建了那颗钮(Lit 应原地打补丁; 否则焦点/滚动就丢了)`);
    } else if (focusedBefore && sr.activeElement !== trunkAfter) {
      fail(`control: 面板更新后焦点从原来那颗钮上掉了(应该原地保留)`);
    } else ok(`control: 内容变了照常更新 + 控件节点原地保留(焦点/滚动自然留着, 不再需要还焦点补丁)`);
    window.HTMLElement.prototype.focus = origFocus;

    // ⑯ [原来是"用户动过的面板必须再整块重画一次"的脏标记(已随 _setPanel 删除)] 换成两条等价覆盖:
    //    ① 用户动过的 range: 下一次推送仍把控件**拉回实体值**(旧"整块重画"的观感) —— 见下面 ㉒ 的
    //       "滑杆拖后能拉回实体值"那条(那里用的是 charging 面板里的充电上限滑杆);
    //    ② 车模设置里的输入框: 打字打到一半, 推一帧之后**字还在**(草稿机制或 Lit 复用节点都得保住它),
    //       点「应用」之后才真的生效。这条以前完全没有断言, 现在补上。
    {
      // 用**一张专门的卡片**验: 它的车模设置是"素材已就绪"(色表 + 色卡 + 自定义外观图都画出来),
      // 这样两个输入框都在(主卡片那份夹具的 car3d/info 是空的, 只有 URL 一个输入框)。
      const h3d = fakeHass();
      h3d.callWS = async (msg) => {
        if (msg.type === "leapmotor/car3d/info") {
          return { ready: true, car_type: "C10", year: 2026,
            model_param: { carType: "C10", year: 2026, carTypeCode: "530舒享版", colorCode: 2, seat: 5 },
            colors: [{ tsp: 0, name: "金属黑", hex: "#353535" }],
            options: { car3d_color: "", car3d_bg: "auto", car3d_image: "" },
            base_url: "/leapmotor-card/car3d/view.html", state: "ready", error: "" };
        }
        if (msg.type === "config/entity_registry/list") return [];
        if (msg.type === "config/device_registry/list") return [];
        return {};
      };
      const elK = await mkEl(h3d);
      const srK = elK.shadowRoot;
      const setCard = srK.querySelector(".p-car3d");
      // 1.9.39: 「设置」不再是折叠卡 —— 点卡片 → 弹窗, 那两个输入框在弹窗正文里
      setCard?.querySelector('[data-act="car3dmenu"]')?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const smbodyK = srK.querySelector(".smodal .smbody");
      const urlInput = smbodyK?.querySelector('input[data-act="car3dimg"]');
      const palOpen = smbodyK?.querySelector('[data-act="palopen"][data-key="hex"]');
      if (!urlInput || !palOpen) {
        fail(`control: 设置弹窗里没有 URL 输入框 / 取色器入口, 草稿这条测不了`);
      } else {
        urlInput.value = "https://example.com/my-car.png";
        urlInput.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
        // 取色器里的 hex 输入框: 与 URL 输入框同一套草稿机制(打到一半不能推一帧就被擦掉)
        palOpen.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        const hexInput = srK.querySelector('.palPop input[data-act="palhexinput"]');
        if (!hexInput) {
          fail(`control: 点彩虹圆没有打开取色器面板`);
        } else {
          hexInput.value = "#123456";
          hexInput.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
          elK.hass = h3d;                              // 状态推送一帧(内容其实没变)
          await new Promise((r) => setTimeout(r, 60));
          const hex2 = srK.querySelector('.paintDock input[data-act="palhexinput"]');
          if (!hex2 || hex2 !== hexInput || hex2.value !== "#123456") fail('control: 调色器草稿在推送后丢失');
          else if(srK.querySelector('.smodal.on')||!srK.querySelector('.paintDock [data-act="paintconfirm"]'))fail('control: 调色时未收起弹窗或缺少确定/返回按钮');
          else {
            const frameBefore=srK.querySelector('iframe');
            hex2.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,30));
            const beforeSave=localStorage.getItem('leapmotor-control.car3d.nodevice')||'';
            if(beforeSave.includes('123456')||srK.querySelector('iframe')!==frameBefore)fail('control: 预览颜色提前保存或重建了模型');else ok('control: 调色即时预览但不提前保存，不重载模型');
            srK.querySelector('[data-act="paintcancel"]').click();await new Promise(r=>setTimeout(r,30));
            const url3=srK.querySelector('input[data-act="car3dimg"]');
            if(!url3||url3.value!=="https://example.com/my-car.png"||elK._car3dPrefs.hex==='#123456')fail('control: 返回调色未恢复颜色与图片草稿');else ok('control: 返回调色恢复原色，重新打开设置时图片草稿保留');
            srK.querySelector('[data-act="car3dimgset"]').click();await new Promise(r=>setTimeout(r,30));
            const saved=localStorage.getItem('leapmotor-control.car3d.nodevice')||'';
            if(!saved.includes('example.com/my-car.png'))fail('control: 图片草稿应用失败');else ok('control: 图片草稿仅在应用后保存');
          }
        }
      }
      localStorage.clear();
    }

    // ⑰ 双击改名: 改名期间 hero 整块跳过(输入框是模板的一个分支), 结束后标题必须真画回来 ——
    //    以前是"面板被绕过 _setPanel 直接改过 → 缓存作废"这条钩子兜着, 机制删掉后由 Lit
    //    的模板分支切换负责, 断言口径不变。
    const vname = sr.querySelector(".vname");
    if (!vname) {
      fail(`control: 没有 .vname, 改名这条测不了`);
    } else {
      vname.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 30));
      const edit = sr.querySelector("input.vnameEdit");
      if (!edit) {
        fail(`control: 双击标题没有进入编辑态`);
      } else {
        edit.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        await new Promise((r) => setTimeout(r, 40));
        if (sr.querySelector("input.vnameEdit")) {
          fail(`control: Esc 取消后输入框还赖在标题位置(面板缓存没作废)`);
        } else if (!sr.querySelector(".vname")) {
          fail(`control: Esc 取消后标题没恢复`);
        } else ok(`control: 改名编辑(Esc 取消)后标题恢复 —— 缓存作废钩子生效`);
      }
    }

    // ⑱ 燃油(增程)面板: 已迁到 Lit 模板(control/templates.ts) —— 用一份"增程车"夹具渲染,
    //    断言结构/文案/口径都对(纯电车必须仍然整块隐藏), 并验证折叠交互照常。
    //    (本文件不定义 ha-icon 替身, 所以这里不涉及图标渲染; 浏览器夹具则要注意: 替身必须把图标
    //     画进**自己的 shadow root** —— 往 light DOM 写 innerHTML 会破坏外层 Lit 模板的锚点,
    //     实测展开时报 insertBefore of null。真实 HA 的 ha-icon 就是 shadow DOM 渲染, 不踩。)
    const reevHass = fakeHass();
    reevHass.states["sensor.sheng_yu_ran_you"] = { entity_id: "sensor.sheng_yu_ran_you", state: "42.5",
      attributes: { friendly_name: "剩余燃油", "燃油量_L": 24.6 } };
    reevHass.states["sensor.ran_you_xu_hang"] = { entity_id: "sensor.ran_you_xu_hang", state: "318",
      attributes: { friendly_name: "燃油续航" } };
    reevHass.states["sensor.you_dian_zong_xu_hang"] = { entity_id: "sensor.you_dian_zong_xu_hang", state: "730",
      attributes: { friendly_name: "油电总续航" } };
    reevHass.states["sensor.you_hao"] = { entity_id: "sensor.you_hao", state: "6.8",
      attributes: { friendly_name: "油耗", "电耗_kwh_100km": 15.2 } };
    reevHass.callWS = async (msg) => {
      if (msg.type === "config/entity_registry/list") {
        return [["battery", "sensor.dian_liang"], ["range", "sensor.xu_hang"],
                ["fuel_level", "sensor.sheng_yu_ran_you"], ["fuel_range", "sensor.ran_you_xu_hang"],
                ["total_range", "sensor.you_dian_zong_xu_hang"], ["fuel_consumption", "sensor.you_hao"]]
          .map(([k, id]) => ({ entity_id: id, platform: "leapmotor", device_id: "dev1",
            translation_key: k, unique_id: "VIN1_" + k, disabled_by: null }));
      }
      if (msg.type === "config/device_registry/list") return [{ id: "dev1", name: "零跑 C10", model: "C10" }];
      return {};
    };
    const elReev = await mkEl(reevHass);
    const srR = elReev.shadowRoot;
    const fuelEl = srR.querySelector(".p-fuel");
    const fuelTxt = (sel) => {
      const n = fuelEl && fuelEl.querySelector(sel);
      return n ? (n.textContent || "").trim() : "";
    };
    if (!fuelEl || fuelEl.style.display === "none") {
      fail(`control: 增程夹具下燃油面板没显示出来`);
    } else if (!fuelEl.querySelector('[data-act="fold"][data-sec="fuel"]')) {
      fail(`control: 燃油面板缺折叠标题(data-act=fold / data-sec=fuel)`);
    } else if (fuelTxt(".foldS") !== "43% · 318 km") {
      fail(`control: 燃油收起态摘要不对(应有油量%与燃油续航): 「${fuelTxt(".foldS")}」`);
    } else if (fuelEl.querySelector(".secB")) {
      fail(`control: 燃油面板默认应**收起**(SECTIONS 默认折叠), 现在正文直接展开了`);
    } else {
      // 展开 → 正文的油量/续航/油耗(含电耗)都要对上, 再收起回来
      const foldBtn = fuelEl.querySelector('[data-act="fold"][data-sec="fuel"]');
      foldBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 60));
      // 注: 这里把空白归一后再比(kv 的标签与数值之间在旧实现里没有空格, Lit 模板会带一点缩进空白)
      const kv = [...fuelEl.querySelectorAll(".kv")].map((n) => (n.textContent || "").replace(/\s+/g, ""));
      const bar = fuelEl.querySelector(".bar.fuel b");
      if (!fuelEl.querySelector(".secB")) {
        fail(`control: 点开燃油面板后正文没出来`);
      } else if (fuelTxt(".fuelV") !== "43%" || fuelTxt(".subline") !== "24.6 L") {
        fail(`control: 燃油油量行不对: 「${fuelTxt(".fuelV")}」/「${fuelTxt(".subline")}」`);
      } else if (!bar || bar.style.width !== "42.5%") {
        fail(`control: 油量条宽度不对: ${bar && bar.style.width}`);
      } else if (kv.join("|") !== "燃油续航318km|油电总续航730km|油耗6.8L/100km·电耗15.2kWh/100km") {
        fail(`control: 燃油 kv 行不对: 「${kv.join("|")}」`);
      } else if (foldBtn.getAttribute("aria-expanded") !== "true") {
        fail(`control: 展开后 aria-expanded 没跟上: ${foldBtn.getAttribute("aria-expanded")}`);
      } else {
        foldBtn.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 60));
        if (fuelEl.querySelector(".secB")) fail(`control: 再收起没生效`);
        else ok(`control: 燃油面板(Lit 模板)收起摘要/展开正文/折叠交互都对`);
      }
    }
    // 纯电车(没有燃油数据) → 整块隐藏
    const bevEl = sr.querySelector(".p-fuel");
    if (bevEl && bevEl.style.display !== "none") {
      fail(`control: 纯电车的燃油面板没有隐藏`);
    } else ok(`control: 纯电车燃油面板保持隐藏`);

    // ⑱b 折叠态存储的兼容(1.9.39): 「设置」不再是折叠块, 老浏览器里存着的 "car3d" 要
    //     **被忽略并顺手清掉**(它不再属于 SECTIONS); 同一条串里的 "fuel" 仍要正常生效,
    //     而且读到不认识的键**不能抛异常**(渲染照常)。
    {
      localStorage.clear();
      window.localStorage.setItem("leapmotor-control.fold.nodevice", "car3d,fuel");
      const elFold = await mkEl(fakeHass());
      const srFold = elFold.shadowRoot;
      const left = window.localStorage.getItem("leapmotor-control.fold.nodevice") || "";
      const fuelSec = srFold.querySelector(".p-fuel .sec");
      if (left.indexOf("car3d") >= 0) fail(`control: 旧折叠值里的 car3d 没被清掉: 「${left}」`);
      else if (left !== "fuel") fail(`control: 折叠键应被改写成只剩 fuel, 实际 「${left}」`);
      else if (!fuelSec || !fuelSec.querySelector('[data-act="fold"][data-sec="fuel"]')) {
        fail(`control: 读到旧折叠值时燃油块没画出来(那条存储没被正常消费)`);
      } else if (!srFold.querySelector(".p-car3d")) fail(`control: 旧折叠值把设置卡搞没了`);
      else ok(`control: 旧 "car3d" 折叠值被忽略并清掉(存储只剩 fuel), 卡片照常渲染`);
      localStorage.clear();
    }

    // ㉒ 充电卡 + 弹窗里的「充电设置」正文(已迁到 Lit 模板: control/templates.ts)
    //    ① 卡片本体 = 折叠入口(摘要 + 箭头), 不是内联展开;
    //    ② 点开的弹窗正文 = 健康充电 / 充电上限(range) / 预约 / 起止时间(time) / 电池预热;
    //    ③ range 与 time 的 `value` 既在属性上(与字符串产物一致)又走 live() —— 用户拖过之后,
    //       下一次状态推送必须把控件**拉回实体值**(旧"整块重画"的观感), 且节点不被重建
    //       (拖动中的手势不被打断)。
    const chgHass = fakeHass();
    chgHass.states["number.chong_dian_shang_xian"] = { entity_id: "number.chong_dian_shang_xian",
      state: "80", attributes: { friendly_name: "充电上限", min: 50, max: 100, step: 5 } };
    chgHass.states["switch.jian_kang_chong_dian"] = { entity_id: "switch.jian_kang_chong_dian",
      state: "off", attributes: { friendly_name: "健康充电" } };
    chgHass.states["switch.yu_yue_chong_dian"] = { entity_id: "switch.yu_yue_chong_dian",
      state: "on", attributes: { friendly_name: "预约充电" } };
    chgHass.states["time.yu_yue_chong_dian_kai_shi"] = { entity_id: "time.yu_yue_chong_dian_kai_shi",
      state: "07:30:00", attributes: { friendly_name: "预约充电-开始" } };
    chgHass.states["time.yu_yue_chong_dian_jie_shu"] = { entity_id: "time.yu_yue_chong_dian_jie_shu",
      state: "17:00:00", attributes: { friendly_name: "预约充电-结束" } };
    chgHass.states["button.dian_chi_yu_re_kai"] = { entity_id: "button.dian_chi_yu_re_kai",
      state: "2026-10-13T00:00:00+00:00", attributes: { friendly_name: "电池预热-开" } };
    const elC = await mkEl(chgHass);
    const srC = elC.shadowRoot;
    const chgCard = srC.querySelector(".p-charging");
    const chgHead = chgCard ? chgCard.querySelector('[data-act="chargemenu"]') : null;
    if (!chgCard || chgCard.style.display === "none") {
      fail(`control: 充电卡没画出来(有 battery/charging_state 就该有入口)`);
    } else if (!chgHead) {
      fail(`control: 充电卡缺弹窗入口(data-act=chargemenu)`);
    } else if ((chgHead.querySelector(".foldT")?.textContent || "") !== "充电") {
      fail(`control: 充电卡标题不对: ${chgHead.textContent}`);
    } else if ((chgHead.querySelector(".foldS")?.textContent || "").trim() !== "76% · 未插枪") {
      fail(`control: 充电卡摘要不对: 「${chgHead.querySelector(".foldS")?.textContent}」`);
    } else if (chgHead.getAttribute("aria-expanded") !== "false") {
      fail(`control: 充电卡收起态 aria-expanded 应为 false`);
    } else if (chgCard.querySelector(".secB")) {
      fail(`control: 充电卡本体不该自己铺开正文(正文在弹窗里)`);
    } else {
      chgHead.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const smbody = srC.querySelector(".smodal .smbody");
      const labels = [...smbody.querySelectorAll(".cL")].map((n) => n.textContent);
      const rng = smbody.querySelector('input[data-act="charge_limit"]');
      const times = [...smbody.querySelectorAll('input[data-act="time"]')];
      const chipTxt = [...smbody.querySelectorAll(".kvchip")].map((n) => n.textContent.trim());
      if (labels.join("|") !== "健康充电|充电上限|预约充电|起止时间") {
        fail(`control: 充电设置行不对: 「${labels.join("|")}」`);
      } else if (chipTxt[0] !== "电量 76 %") {
        fail(`control: 充电设置电量胶囊不对: 「${chipTxt[0]}」`);
      } else if (!rng || rng.getAttribute("value") !== "80" || rng.value !== "80"
                 || rng.min !== "50" || rng.max !== "100" || rng.step !== "5") {
        fail(`control: 充电上限滑杆不对(attr=${rng && rng.getAttribute("value")} value=${rng && rng.value} min=${rng && rng.min} max=${rng && rng.max} step=${rng && rng.step})`);
      } else if (times.length !== 2 || times[0].value !== "07:30" || times[1].value !== "17:00") {
        fail(`control: 起止时间输入不对: ${times.map((t) => t.value).join("/")}`);
      } else if (smbody.querySelector('[data-act="toggle"][data-entity="switch.yu_yue_chong_dian"]')
                 ?.getAttribute("data-on") !== "1") {
        fail(`control: 预约充电开关状态没接上`);
      } else if (!/充电上限/.test(rng.title)) {
        fail(`control: 充电上限滑杆的 title 丢了`);
      } else {
        const schedule = smbody.querySelector('[data-act="toggle"][data-entity="switch.yu_yue_chong_dian"]');
        const sent=[];const original=chgHass.callService;
        chgHass.callService=async(d,s,data)=>sent.push([d,s,data.entity_id]);
        schedule.dispatchEvent(new window.MouseEvent('click',{bubbles:true,composed:true}));
        await new Promise(r=>setTimeout(r,40));
        chgHass.callService=original;
        if(sent.length!==1||sent[0].join('|')!=='switch|turn_off|switch.yu_yue_chong_dian')fail('control: 预约开关点击未准确触发一次实体服务');
        else ok('control: 全页充电弹窗内预约开关正确发送实体服务');
        // 用户把滑杆拖到 90(实体还是 80) → 下一次推送必须拉回 80, 且**同一个节点**(手势不断)
        rng.value = "90";
        elC.hass = chgHass;
        await new Promise((r) => setTimeout(r, 60));
        const rng2 = srC.querySelector('input[data-act="charge_limit"]');
        if (rng2 !== rng) fail(`control: 状态推送重建了滑杆节点(拖动中会被打断)`);
        else if (rng2.value !== "80") {
          fail(`control: 用户拖过的滑杆没被拉回实体值(live() 没生效): ${rng2.value}`);
        } else if (!/^80\s*%$/.test((rng2.parentElement.querySelector(".cV") || {}).textContent || "")) {
          fail(`control: 滑杆旁边的百分比没跟上实体值: 「${(rng2.parentElement.querySelector(".cV") || {}).textContent}」`);
        } else ok(`control: 充电卡(Lit)入口/摘要 + 弹窗正文(上限滑杆·起止时间·预热)都对, 滑杆拖后能拉回实体值`);
      }
    }

    // ㉓ 空调卡(已迁到 Lit 模板): 大字车内温度 + 角标 + 风扇钮; 预设生效时给 LO/HI 且不给 ±;
    //    预设气泡里四颗选项(当前那颗点亮), 点一颗走 climate.set_preset_mode。
    const acHass = fakeHass();
    acHass.states["sensor.che_nei_wen_du"] = { entity_id: "sensor.che_nei_wen_du",
      state: "26.5", attributes: { friendly_name: "车内温度" } };
    acHass.states["climate.che_kong_tiao"] = { entity_id: "climate.che_kong_tiao", state: "cool",
      attributes: { friendly_name: "空调", temperature: 24.5, min_temp: 16, max_temp: 32,
        target_temp_step: 1, hvac_modes: ["off", "cool", "heat", "fan_only"],
        preset_mode: "极速降温" } };
    const elA = await mkEl(acHass);
    const srA = elA.shadowRoot;
    const cliEl = srA.querySelector(".p-climate");
    const acTemp = cliEl.querySelector(".acTemp");
    const tval = cliEl.querySelector(".tval");
    if (!cliEl || cliEl.style.display === "none") fail(`control: 空调卡没画出来`);
    else if (!acTemp || acTemp.textContent.replace(/\s+/g, "") !== "26.5℃车内") {
      fail(`control: 空调卡车内温度不对: 「${acTemp && acTemp.textContent}」`);
    } else if (!/fanBtn on/.test(cliEl.querySelector(".fanBtn")?.className || "")) {
      fail(`control: 空调开着时风扇钮没点亮`);
    } else if (!tval || tval.textContent.trim() !== "LO") {
      fail(`control: 「极速降温」预设生效时应显示 LO: 「${tval && tval.textContent}」`);
    } else if (cliEl.querySelectorAll('[data-act="temp"]').length) {
      fail(`control: 预设生效期间不该给温度 ±(改温度会与预设打架)`);
    } else {
      // 预设气泡: 四颗, 当前生效那颗带 .on
      cliEl.querySelector('[data-act="presetmenu"]').dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const opts = [...srA.querySelectorAll(".presetPop .presetOpt")];
      const onOpt = opts.filter((n) => n.classList.contains("on"));
      const vals = opts.map((n) => n.getAttribute("data-val"));
      if (vals.join("|") !== "极速降温|极速升温|快速除味|风挡除霜") {
        fail(`control: 预设气泡选项不对: 「${vals.join("|")}」`);
      } else if (onOpt.length !== 1 || onOpt[0].getAttribute("data-val") !== "极速降温") {
        fail(`control: 预设气泡没有点亮当前生效的那颗`);
      } else {
        const callsA = [];
        const origCallA = elA.hass.callService;
        elA.hass.callService = (d, s, data) => { callsA.push(d + "." + s + ":" + (data && data.preset_mode)); return Promise.resolve(); };
        opts[1].dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        elA.hass.callService = origCallA;
        if (!callsA.includes("climate.set_preset_mode:极速升温")) {
          fail(`control: 点预设没走 climate.set_preset_mode: ${callsA.join(",")}`);
        } else if (srA.querySelector(".presetPop")) {
          fail(`control: 选完预设气泡没收起`);
        } else ok(`control: 空调卡(Lit) 车内温度/LO 预设/气泡点亮/选预设走服务都对`);
      }
    }
    // 同一份数据再推一帧: Lit 面板一个字节都不该动(节点身份不变)
    {
      const boxBefore = cliEl.querySelector(".tempBox");
      let mut = 0;
      const moA = new MutationObserver((recs) => { mut += recs.length; });
      moA.observe(cliEl, { childList: true, subtree: true, attributes: true, characterData: true });
      elA.hass = acHass;
      await new Promise((r) => setTimeout(r, 60));
      moA.disconnect();
      if (mut) fail(`control: 空调卡内容没变却改动了 DOM(${mut} 次)`);
      else if (cliEl.querySelector(".tempBox") !== boxBefore) {
        fail(`control: 空调卡内容没变却重建了节点(Lit 的更新粒度不对)`);
      } else ok(`control: 空调卡内容没变 → Lit 零改动(节点身份不变)`);
    }

    // ㉓b 温度区显示规则(1.9.41): 以"当前生效的预设"定显示 ——
    //    极速降温→LO / 极速升温→HI(沿用 .tval 规格, 都不给 ±);
    //    快速除味 / 风挡除霜 → 「图标(mdi) + 模式名」替换温度(同样不给 ±);
    //    只有"单纯开着"(没有预设)才给 ± —— 这正是用户要的"单独点开关才有加减"。
    {
      const faces = [
        ["极速降温", "LO", ""],
        ["极速升温", "HI", ""],
        ["快速除味", "快速除味", "mdi:spray"],
        ["风挡除霜", "风挡除霜", "mdi:car-defrost-front"],
      ];
      const bad = [];
      for (const [pm, want, ico] of faces) {
        acHass.states["climate.che_kong_tiao"].attributes.preset_mode = pm;
        elA.hass = acHass;
        await new Promise((r) => setTimeout(r, 40));
        const box = srA.querySelector(".p-climate .tempBox");
        const steps = box ? box.querySelectorAll('[data-act="temp"]').length : -1;
        if (!box) { bad.push(`${pm}: 找不到 .tempBox`); continue; }
        if (steps) { bad.push(`「${pm}」生效时不该给 ±(画了 ${steps} 颗)`); continue; }
        if (ico) {
          const ic = box.querySelector(".tpr ha-icon");
          const txt = (box.querySelector(".tpr")?.textContent || "").trim();
          if (!ic || ic.getAttribute("icon") !== ico) {
            bad.push(`「${pm}」温度位没画 mdi 图标(实际 ${ic && ic.getAttribute("icon")})`);
          } else if (txt !== want) {
            bad.push(`「${pm}」温度位应显示「${want}」, 实际「${txt}」`);
          }
        } else {
          const tv = (box.querySelector(".tval")?.textContent || "").trim();
          if (tv !== want) bad.push(`「${pm}」温度位应显示「${want}」, 实际「${tv}」`);
        }
      }
      // 还原成夹具原状(这一段只借用 elA 推几帧状态)
      acHass.states["climate.che_kong_tiao"].attributes.preset_mode = "极速降温";
      elA.hass = acHass;
      await new Promise((r) => setTimeout(r, 40));
      if (bad.length) fail(`control: 温度区显示规则: ${bad.join(" / ")}`);
      else ok(`control: 温度区显示规则: LO / HI 沿用数字规格, 快速除味·风挡除霜 = 图标+模式名, 预设生效一律不给 ±`);
    }

    // ㉓c 预设的"本机记忆"兜底(用户的车只回报 mode=cool + temperature=16, **不报 preset_mode**):
    //    点过「极速降温」后温度区照样显示 LO(不靠实体); 实体一旦报出别的预设, 以实体为准(记忆让位)。
    {
      const memHass = fakeHass();
      memHass.states["climate.che_kong_tiao"] = { entity_id: "climate.che_kong_tiao", state: "cool",
        attributes: { friendly_name: "空调", temperature: 16, min_temp: 16, max_temp: 32,
          target_temp_step: 1, hvac_modes: ["off", "cool", "heat", "fan_only"] } }; // ⚠️ 故意不带 preset_mode
      const elM = await mkEl(memHass);
      const srM = elM.shadowRoot;
      const boxM = () => srM.querySelector(".p-climate .tempBox");
      const valM = () => (boxM().querySelector(".tval")?.textContent || "").trim();
      const bad = [];
      // ① 没有任何预设(实体不报 + 没记忆): 设定温度 + 两颗 ±("单独开着"的那支)
      const steps0 = boxM().querySelectorAll('[data-act="temp"]').length;
      if (steps0 !== 2) bad.push(`没有预设在生效时应给 2 颗 ±(实际 ${steps0})`);
      else if (valM() !== "16.0℃") bad.push(`普通模式应显示设定温度 16.0℃, 实际「${valM()}」`);
      // ② 点「极速降温」: 实体不回报 → 靠本机记忆显示 LO、± 收起
      srM.querySelector('[data-act="presetmenu"]').dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const opt = srM.querySelector('.presetPop .presetOpt[data-val="极速降温"]');
      if (!opt) bad.push(`预设气泡里没有「极速降温」那颗`);
      else {
        opt.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        if (valM() !== "LO") bad.push(`实体不报 preset_mode 时, 点过「极速降温」应显示 LO, 实际「${valM()}」`);
        else if (boxM().querySelectorAll('[data-act="temp"]').length) bad.push("预设生效(靠记忆)期间不该给 ±");
      }
      // ③ 实体报出别的预设(风挡除霜) → 以实体为准, 记忆让位
      memHass.states["climate.che_kong_tiao"].attributes.preset_mode = "风挡除霜";
      elM.hass = memHass;
      await new Promise((r) => setTimeout(r, 40));
      const txtM = (boxM().querySelector(".tpr")?.textContent || "").trim();
      if (txtM !== "风挡除霜") bad.push(`实体报「风挡除霜」时温度区应显示它, 实际「${txtM}」`);
      if (bad.length) fail(`control: 预设记忆兜底: ${bad.join(" / ")}`);
      else ok(`control: 预设记忆兜底: 实体不报 preset_mode 时点「极速降温」→ LO + 无 ±; 实体报别的预设 → 以实体为准`);
    }

    // ㉓d 温度 ± 连点合并(1.9.41): 间隔 100ms 连点三次「＋」→ 抖动窗口内一条都不发(数字乐观
    //    走到 27.0℃、± 不被禁用), 窗口到期**只发一次** climate.set_temperature(27);
    //    实体回报同值后待发值交回实体, 再点一次 → 新窗口照常发第二次。
    {
      const tpHass = fakeHass();
      tpHass.states["climate.che_kong_tiao"] = { entity_id: "climate.che_kong_tiao", state: "cool",
        attributes: { friendly_name: "空调", temperature: 24, min_temp: 16, max_temp: 32,
          target_temp_step: 1, hvac_modes: ["off", "cool", "heat", "fan_only"] } };
      const callsT = [];
      tpHass.callService = (d, s, data) => {
        if (d === "climate" && s === "set_temperature") callsT.push(data && data.temperature);
        return Promise.resolve();
      };
      const elT = await mkEl(tpHass);
      const srT = elT.shadowRoot;
      const plusT = () => srT.querySelector('.p-climate .tempBox [data-act="temp"][data-delta="1"]');
      const valT = () => (srT.querySelector(".p-climate .tval")?.textContent || "").trim();
      const bad = [];
      for (let i = 0; i < 3; i++) {
        plusT().dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 100));
      }
      if (callsT.length) bad.push(`抖动窗口内不该发包(已发 ${callsT.length} 条: ${callsT.join(",")})`);
      else if (valT() !== "27.0℃") bad.push(`连点三次应乐观显示 27.0℃, 实际「${valT()}」`);
      else if (plusT().disabled) bad.push("连点期间 ± 被禁用了(这就是原来「不能连续调节」的毛病)");
      await new Promise((r) => setTimeout(r, 700)); // 等抖动窗口到期 + 服务调用
      if (!bad.length) {
        if (callsT.length !== 1) bad.push(`连点三次应只发一次 set_temperature, 实际 ${callsT.length} 条: ${JSON.stringify(callsT)}`);
        else if (callsT[0] !== 27) bad.push(`下发的值应是连点后的目标值 27, 实际 ${callsT[0]}`);
        else {
          // 实体回报 27 → 待发值交回实体(与 _clPending 同一套释放口径)
          tpHass.states["climate.che_kong_tiao"].attributes.temperature = 27;
          elT.hass = tpHass;
          await new Promise((r) => setTimeout(r, 40));
          if (elT._tempPending !== null) bad.push("实体回报 27 后待发值没交回实体");
          else {
            // 释放后再点一次: 新窗口照常发包(值 = 28)
            plusT().dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
            await new Promise((r) => setTimeout(r, 700));
            if (callsT.length !== 2 || callsT[1] !== 28) {
              bad.push(`释放后再点一次应发第二条(28), 实际 ${JSON.stringify(callsT)}`);
            }
          }
        }
      }
      if (bad.length) fail(`control: 温度 ± 连点合并: ${bad.join(" / ")}`);
      else ok(`control: 温度 ± 连点三次(间隔 100ms)→ 只发一次 set_temperature(27), 期间 ± 不禁用; 实体回报同值即交回, 再点走新窗口(28)`);
    }

    // ㉔ 位置卡(已迁到 Lit 模板): 区域名/坐标 + 驻车照片背景(探到才铺)+ 两个浮动胶囊 + ⓘ
    //    背景走 locBg() 的"先探针后上屏": 这里把 Image 桩成"一定能加载", 验证 hasBg / locVeil /
    //    style 三处都跟着出现(真实 HA 里就是这张照片当底图)。
    const origImage = window.Image;
    const FakeImage = class {
      constructor() { this.onload = null; this.onerror = null; }
      set src(v) { this._s = v; setTimeout(() => { if (this.onload) this.onload(); }, 0); }
      get src() { return this._s; }
    };
    window.Image = FakeImage;
    globalThis.Image = FakeImage;
    const locHass = fakeHass();
    locHass.states["device_tracker.che_liang_wei_zhi"] = { entity_id: "device_tracker.che_liang_wei_zhi",
      state: "home", attributes: { friendly_name: "车辆位置", latitude: 31.2304166, longitude: 121.473701 } };
    locHass.states["zone.home"] = { entity_id: "zone.home", state: "1", attributes: { friendly_name: "家" } };
    locHass.states["image.zhu_che_zhao_pian"] = { entity_id: "image.zhu_che_zhao_pian",
      state: "2026-10-13T00:00:00+00:00",
      attributes: { friendly_name: "驻车照片", entity_picture: "/local/parking.jpg" } };
    locHass.states["button.xun_che_ming_di"] = { entity_id: "button.xun_che_ming_di",
      state: "2026-10-13T00:00:00+00:00", attributes: { friendly_name: "寻车鸣笛" } };
    const elL = await mkEl(locHass);
    const srL = elL.shadowRoot;
    let locEl = srL.querySelector(".p-location");
    const zoneTxt = () => (locEl.querySelector(".bigTxt") || {}).textContent;
    const subTxt = () => [...locEl.querySelectorAll(".halfS")].map((n) => n.textContent);
    // 探针是异步的 → 等它 onload + 那次 _scheduleRender 走完
    await new Promise((r) => setTimeout(r, 120));
    locEl = srL.querySelector(".p-location");
    const locBox = locEl ? locEl.querySelector("section") : null;
    if (!locEl || locEl.style.display === "none") {
      fail(`control: 位置卡没画出来(有车辆位置实体就该有)`);
    } else if (zoneTxt() !== "家") {
      fail(`control: 位置卡区域名不对(在 zone.home 里应显示「家」): 「${zoneTxt()}」`);
    } else if (!locBox?.classList.contains("hasMap") || locBox.querySelectorAll('.locTiles img').length !== 9 || !locBox.querySelector('.locCar svg')) {
      fail(`control: 默认驻车地图缺瓦片或汽车图标`);
    } else if (!locEl.querySelector('[data-act="photo"]')
               || !locEl.querySelector('[data-act="press"][data-entity="button.xun_che_ming_di"]')) {
      fail(`control: 位置卡缺浮动胶囊(驻车照片 / 鸣笛寻车)`);
    } else if (locEl.querySelector(".locInfo") || locEl.querySelector('.floatPill')?.textContent.trim()) {
      fail(`control: 驻车按钮应为纯图标，且不显示说明图标`);
    } else ok(`control: 驻车地图有区域名、瓦片、汽车图标与两个纯图标按钮`);
    elL._car3dPrefs.location = "photo";
    elL._render();
    await new Promise(r => setTimeout(r, 80));
    const photoBox = srL.querySelector('.p-location section');
    if (!photoBox?.classList.contains('hasBg') || !photoBox.querySelector('.locVeil') || photoBox.querySelector('.locMap')) fail('control: 驻车照片模式没有替换地图');
    else ok('control: 驻车背景可切换为照片，地图节点已收起');
    window.Image = origImage;
    globalThis.Image = origImage;
    // 没有任何位置实体 → 整块隐藏(且隐藏那一支不会去探驻车照片, 见 templates.ts 的说明)
    const noLoc = sr.querySelector(".p-location");
    if (noLoc && noLoc.style.display !== "none") {
      fail(`control: 没有位置实体时位置卡没隐藏`);
    } else ok(`control: 没有位置实体时位置卡保持隐藏`);

    // ㉕ hero(已迁到 Lit 模板): ① 内容没变 → 零改动(节点身份不变);
    //    ② 双击改名的路径照旧(输入框现在是模板的一支): 回车保存后标题真的换掉;
    //    ③ 多辆车时画候选卡、没有实体时画提示卡。
    localStorage.clear();
    const elH = await mkEl(fakeHass());
    const srH = elH.shadowRoot;
    {
      const heroEl = srH.querySelector(".p-hero");
      const vname0 = heroEl.querySelector(".vname");
      let mut = 0;
      const moH = new MutationObserver((recs) => { mut += recs.length; });
      moH.observe(heroEl, { childList: true, subtree: true, attributes: true, characterData: true });
      elH.hass = fakeHass(); // 同一份数据
      await new Promise((r) => setTimeout(r, 60));
      moH.disconnect();
      if (mut) fail(`control: hero 内容没变却改动了 DOM(${mut} 次)`);
      else if (srH.querySelector(".p-hero .vname") !== vname0) fail(`control: hero 内容没变却重建了节点`);
      else ok(`control: hero 内容没变 → Lit 零改动(节点身份不变)`);
      // 改名: 双击 → 输入框(模板分支) → 改成新名字 → 回车 → 标题变 + 存本机
      if (!vname0) fail(`control: hero 没有 .vname, 改名这条测不了`);
      else {
        vname0.dispatchEvent(new window.MouseEvent("dblclick", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        const ed = srH.querySelector("input.vnameEdit");
        if (!ed) fail(`control: hero 双击标题没进入编辑态`);
        else if (ed.type !== "text" || ed.getAttribute("maxlength") !== "40") {
          fail(`control: 改名输入框的属性不对(type=${ed.type} maxlength=${ed.getAttribute("maxlength")})`);
        } else {
          ed.value = "小白";
          ed.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
          await new Promise((r) => setTimeout(r, 60));
          const t = (srH.querySelector(".vname")?.textContent || "").trim();
          if (srH.querySelector("input.vnameEdit")) fail(`control: 回车保存后输入框还赖在标题位置`);
          else if (t !== "小白3D" && !t.startsWith("小白")) fail(`control: 改名回车后标题没跟着变: 「${t}」`);
          else if (!window.localStorage.getItem("leapmotor-control.name.nodevice")) {
            fail(`control: 改名没写进本机(键 leapmotor-control.name.nodevice)`);
          } else ok(`control: 改名(双击 → 回车保存)后标题变「${t}」且已存本机`);
        }
      }
    }
    // 多辆车 → 候选卡; 没有实体 → 提示卡(都是 hero 面板里的退化态)
    {
      const twoDev = fakeHass();
      twoDev.callWS = async (msg) => {
        if (msg.type === "config/entity_registry/list") {
          return [
            { entity_id: "sensor.d1_battery", platform: "leapmotor", device_id: "d1",
              translation_key: "battery", unique_id: "V1_battery", disabled_by: null },
            { entity_id: "sensor.d2_battery", platform: "leapmotor", device_id: "d2",
              translation_key: "battery", unique_id: "V2_battery", disabled_by: null },
          ];
        }
        if (msg.type === "config/device_registry/list") {
          return [{ id: "d1", name: "零跑 C10", model: "C10" }, { id: "d2", name: "零跑 C11", model: "C11" }];
        }
        return {};
      };
      const elP = await mkEl(twoDev);
      const pick = elP.shadowRoot.querySelector(".p-hero .pick");
      const rows = [...(pick?.querySelectorAll(".pickRow") || [])];
      const dbl = sr.querySelector(".p-hero .pickRow");
      if (!pick || (pick.querySelector(".pickT")?.textContent || "") !== "发现多辆零跑") {
        fail(`control: 多辆车时 hero 没画候选卡`);
      } else if (rows.length !== 2 || rows[0].getAttribute("data-act") !== "pickdev") {
        fail(`control: 候选卡行数/契约不对(${rows.length} 行)`);
      } else if (dbl) fail(`control: 单辆车的卡片上冒出了候选卡`);
      else ok(`control: 多辆车 → hero 画 2 行候选卡(data-act=pickdev)`);
      // 没有实体(注册表还没回来 / 一个实体都没解析出来): 直接清掉索引 —— 注意"多设备候选"
      // 那一支优先级更高, 所以这条要用**单辆车**的卡片(否则画的是候选卡, 不是提示卡)。
      const elN = await mkEl(fakeHass());
      elN._index = {};
      elN._regRetries = 30;
      elN.hass = fakeHass();
      await new Promise((r) => setTimeout(r, 60));
      const hint = elN.shadowRoot.querySelector(".p-hero .pickS")?.textContent || "";
      if (!/还没找到这辆车的实体|正在读取实体注册表/.test(hint)) {
        fail(`control: 没有实体时 hero 没画提示卡: 「${hint}」`);
      } else ok(`control: 没有实体 → hero 画提示卡(与迁移前同一支)`);
      localStorage.clear();
    }

    // ㉖ 座椅弹窗(已迁到 Lit 模板): 座舱底图 + 座位控件 + 档位循环; 5 座 / 7 座各一份夹具;
    //    再验"座椅 ↔ 充电"弹窗互切两轮(两块正文共用一个 .smbody 宿主, 不能被搞坏)。
    const seatHass = (seven) => {
      const h = fakeHass();
      const reg = [["ac", "climate.che_kong_tiao"],
                   ["battery", "sensor.dian_liang"],
                   ["charging_state", "sensor.chong_dian_zhuang_tai"],
                   ["seat_heat_driver", "number.zhu_jia_zuo_yi_jia_re"],
                   ["seat_vent_driver", "number.zhu_jia_zuo_yi_tong_feng"],
                   ["steering_heat", "switch.fang_xiang_pan_jia_re"],
                   ["mirror_heat", "switch.hou_shi_jing_jia_re"]];
      if (seven) {
        reg.push(["seat_heat_third_left", "number.san_pai_zuo_yi_jia_re"],
                 ["seat_heat_third_right", "number.san_pai_you_zuo_yi_jia_re"]);
      }
      h.states["number.zhu_jia_zuo_yi_jia_re"] = { entity_id: "number.zhu_jia_zuo_yi_jia_re",
        state: "2", attributes: { friendly_name: "主驾座椅加热", min: 0, max: 3, step: 1 } };
      h.states["number.zhu_jia_zuo_yi_tong_feng"] = { entity_id: "number.zhu_jia_zuo_yi_tong_feng",
        state: "1", attributes: { friendly_name: "主驾座椅通风", min: 0, max: 3, step: 1 } };
      h.states["switch.fang_xiang_pan_jia_re"] = { entity_id: "switch.fang_xiang_pan_jia_re",
        state: "on", attributes: { friendly_name: "方向盘加热" } };
      h.states["switch.hou_shi_jing_jia_re"] = { entity_id: "switch.hou_shi_jing_jia_re",
        state: "off", attributes: { friendly_name: "后视镜加热" } };
      if (seven) {
        h.states["number.san_pai_zuo_yi_jia_re"] = { entity_id: "number.san_pai_zuo_yi_jia_re",
          state: "1", attributes: { friendly_name: "三排左座椅加热", min: 0, max: 3, step: 1 } };
        h.states["number.san_pai_you_zuo_yi_jia_re"] = { entity_id: "number.san_pai_you_zuo_yi_jia_re",
          state: "0", attributes: { friendly_name: "三排右座椅加热", min: 0, max: 3, step: 1 } };
      }
      h.callWS = async (msg) => {
        if (msg.type === "config/entity_registry/list") {
          return reg.map(([k, id]) => ({ entity_id: id, platform: "leapmotor", device_id: "dev1",
            translation_key: k, unique_id: "VIN1_" + k, disabled_by: null }));
        }
        if (msg.type === "config/device_registry/list") return [{ id: "dev1", name: "零跑 C10", model: "C10" }];
        return {};
      };
      return h;
    };
    const elS = await mkEl(seatHass(false));
    const srS = elS.shadowRoot;
    const seatBtn2 = srS.querySelector('[data-act="seatmenu"]');
    if (!seatBtn2) fail(`control: 座椅夹具下空调卡里没有「座椅与加热」入口`);
    else {
      seatBtn2.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const body = srS.querySelector(".smodal .smbody");
      const cab = body?.querySelector(".cabin");
      const bg = cab?.querySelector("img.cabBg")?.getAttribute("src") || "";
      const pos = [...(cab?.querySelectorAll(".cabPos") || [])];
      const cycle = body?.querySelector('[data-act="seatcycle"][data-key="seat_heat_driver"]');
      const vent = body?.querySelector('[data-act="seatcycle"][data-key="seat_vent_driver"]');
      const steer = body?.querySelector('[data-act="toggle"][data-entity="switch.fang_xiang_pan_jia_re"]');
      const mirror = [...(body?.querySelectorAll('[data-act="toggle"][data-entity="switch.hou_shi_jing_jia_re"]') || [])];
      if (!srS.querySelector(".smodal.on") || !cab) fail(`control: 座椅弹窗里没有座舱图(.cabin)`);
      else if (!/cabin5_light\.jpg$/.test(bg)) fail(`control: 5 座浅色座舱底图不对: 「${bg}」`);
      else if (!pos.length) fail(`control: 座舱图上没有叠任何控件(.cabPos)`);
      else if (!cycle || !/cabBtn heat on/.test(cycle.className)) {
        fail(`control: 主驾加热 2 档的图标态不对: ${cycle && cycle.className}`);
      } else if (!vent || !/cabBtn vent on spin/.test(vent.className)) {
        fail(`control: 主驾通风 1 档的图标态不对(应 on + 转动): ${vent && vent.className}`);
      } else if (!steer || !/cabBtn sw on/.test(steer.className)) {
        fail(`control: 方向盘加热(开)的图标态不对: ${steer && steer.className}`);
      } else if (mirror.length !== 2 || !mirror.every((b) => /cabBtn sw compact off/.test(b.className))) {
        fail(`control: 后视镜加热应是左右两个「关」的小按钮, 实际 ${mirror.length} 个`);
      } else if (body.querySelector('[data-act="seatcycle"][data-key="seat_heat_third_left"]')) {
        fail(`control: 5 座车不该有第三排控件`);
      } else {
        // 点一下主驾加热: 2 档 → 3 档(number.set_value)
        const calls = [];
        const origCall = elS.hass.callService;
        elS.hass.callService = (d, s, data) => { calls.push(d + "." + s + ":" + (data && data.value)); return Promise.resolve(); };
        cycle.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        elS.hass.callService = origCall;
        if (!calls.includes("number.set_value:3")) {
          fail(`control: 点座椅图标没走 number.set_value(2→3): ${calls.join(",")}`);
        } else ok(`control: 座椅弹窗(Lit) 5 座底图/加热通风/方向盘/后视镜两个都对, 点一下走 number.set_value`);
      }
      // 座椅 → 充电 → 座椅 → 充电: 两块正文共用一个 .smbody 宿主, 切来切去内容都要对
      const hit2 = (sel) => srS.querySelector(sel)?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      const seq = [];
      for (let i = 0; i < 2; i++) {
        hit2('[data-act="chargemenu"]');
        await new Promise((r) => setTimeout(r, 40));
        seq.push(srS.querySelector(".smbody .cList") ? "chg" : "?");
        seq.push(srS.querySelector(".smhead .t")?.textContent || "?");
        hit2('[data-act="seatmenu"]');
        await new Promise((r) => setTimeout(r, 40));
        seq.push(srS.querySelector(".smbody .cabin") ? "seat" : "?");
        seq.push(srS.querySelector(".smhead .t")?.textContent || "?");
      }
      if (seq.join("|") !== "chg|充电设置|seat|座椅与加热|chg|充电设置|seat|座椅与加热") {
        fail(`control: 座椅↔充电弹窗互切两轮内容不对: ${seq.join("|")}`);
      } else ok(`control: 座椅↔充电弹窗互切两轮, 标题与正文都跟着换(共用 .smbody 宿主没被搞坏)`);
    }
    // 7 座: 第三排控件 + 7 座底图
    {
      localStorage.clear();
      const elS7 = await mkEl(seatHass(true));
      const srS7 = elS7.shadowRoot;
      srS7.querySelector('[data-act="seatmenu"]')?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const body7 = srS7.querySelector(".smodal .smbody");
      const bg7 = body7?.querySelector("img.cabBg")?.getAttribute("src") || "";
      const third = body7?.querySelectorAll('[data-act="seatcycle"][data-key^="seat_heat_third"]');
      if (!/cabin7_light\.jpg$/.test(bg7)) fail(`control: 7 座座舱底图不对: 「${bg7}」`);
      else if (third?.length !== 2) fail(`control: 7 座车应有第三排两个控件, 实际 ${third && third.length}`);
      else ok(`control: 7 座 -> 7 座底图 + 第三排两个加热控件`);
      localStorage.clear();
    }

    // ㉑ 3D 车模: 素材就绪 → iframe 挂在**独立容器(.p-carview)**里, 状态推送不重建它
    //    (浏览器会把被摘出文档的 iframe 销毁重建 = 整车重新加载, 卡片上表现为每次推送闪一下);
    //    素材未装配 → 只有下载入口, 且**不自动联网**(ensure 必须由用户点按钮触发)。
    localStorage.clear();
    const wsLog = [];
    const marketDeviceIds = [];
    const marketSelections = [];
    const marketVariantRequests = [];
    const car3dHass = (ready, optImg, st, err) => {
      const h = fakeHass();
      h.callWS = async (msg) => {
        wsLog.push(msg.type);
        if (msg.type === "config/entity_registry/list") {
          return [{ entity_id: "sensor.x", platform: "leapmotor", device_id: "dev1",
            translation_key: "battery", unique_id: "VIN1_battery", disabled_by: null }];
        }
        if (msg.type === "config/device_registry/list") {
          return [{ id: "dev1", name: "零跑 C10", model: "C10" }];
        }
        if (msg.type === "leapmotor/car3d/info") {
          return {
            ready, car_type: "C10", year: 2026,
            model_param: { carType: "C10", year: 2026, carTypeCode: "530舒享版", colorCode: 8, seat: 5 },
            colors: [{ tsp: 0, name: "金属黑", hex: "#353535" }],
            options: { car3d_color: "", car3d_bg: "auto", car3d_image: optImg || "" },
            base_url: "/leapmotor-card/car3d/view.html",
            state: st || (ready ? "ready" : "idle"), error: err || "",
          };
        }
        if (msg.type === "leapmotor/car3d/market-pictures") {
          marketDeviceIds.push(msg.device_id);
          if (msg.model) marketSelections.push({ model: msg.model, year: msg.year, energy: msg.energy, edition: msg.edition, model_id: msg.model_id });
          if (msg.model === "C16") return {
            pictures: [{ color: "松霜绿", url: "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/c16-green.png" }],
          };
          return {
            actual_color: "实车银",
            model: "C10",
            year: "2026",
            energy: "纯电",
            edition: "660版",
            model_id: "catalog-silver",
            pictures: [
              { color: "实车银", url: "https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/silver.png" },
              { color: "示例蓝", url: "https://ueapp-oss-static.leapmotor.com/blue.png" },
            ],
          };
        }
        if (msg.type === "leapmotor/car3d/market-catalog") return { models: [{ name: "C10" }, { name: "C16" }] };
        if (msg.type === "leapmotor/car3d/market-variants") {
          marketVariantRequests.push({ model: msg.model, year: msg.year || "" });
          if (msg.model === "C16") return { variants: msg.year === "2024"
            ? [{ id: "catalog-c16-2024", year: "2024", energy: "增程", edition: "300版" }]
            : msg.year ? [] : [{ id: "catalog-c16", year: "2025", energy: "纯电", edition: "580版" }] };
          return { variants: [{ id: "catalog-silver", year: "2026", energy: "纯电", edition: "660版" }] };
        }
        if (msg.type === "leapmotor/car3d/ensure") {
          return { state: "downloading", started: true, info: null };
        }
        return {};
      };
      return h;
    };
    const mkCar3dEl = async (h) => {
      const e = window.document.createElement("leapmotor-control");
      window.document.body.appendChild(e);
      e.setConfig({ type: "custom:leapmotor-control" });
      e.hass = h;
      await new Promise((r) => setTimeout(r, 60));
      return e;
    };
    const cnt = (t) => wsLog.filter((x) => x === t).length;

    const setEntryClick = (sr) => {
      const entry = sr.querySelector('.p-car3d [data-act="car3dmenu"]');
      if (entry) entry.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
    };

    const el6 = await mkCar3dEl(car3dHass(true, ""));
    const sr6 = el6.shadowRoot;
    const fr1 = sr6.querySelector(".p-carview iframe");
    const src1 = fr1 ? fr1.getAttribute("src") || "" : "";
    if (!fr1) fail(`control: 3D 就绪时车模区没有 iframe`);
    else if (!/car=C10/.test(src1) || !/trim=530%E8%88%92%E4%BA%AB%E7%89%88/.test(src1)) {
      fail(`control: iframe src 参数不对(中文版型没 encode): ${src1}`);
    } else if (sr6.querySelector(".vname .tag3d")) fail(`control: 3D 模式仍显示已移除的「3D」胶囊`);
    else if (!sr6.querySelector('.vnameRow .car3dRefresh[data-act="car3drefresh"]')) fail(`control: 3D 模式缺少标题行的专属刷新按钮`);
    else if (sr6.querySelector(".p-hero .carModel")) fail(`control: 3D 时 hero 里还画着一个车模盒(应只有一个)`);
    else ok(`control: 3D 就绪 → iframe 参数齐全、无「3D」胶囊且有专属刷新按钮`);

    for (let i = 0; i < 3; i++) { el6.hass = car3dHass(true, ""); await new Promise((r) => setTimeout(r, 40)); }
    if (!fr1 || sr6.querySelector(".p-carview iframe") !== fr1) {
      fail(`control: hass 推送后 iframe 被重建了(浏览器会整车重新加载 → 每次推送闪一下)`);
    } else if (sr6.querySelectorAll("iframe").length !== 1) {
      fail(`control: 文档里出现了多个 iframe(${sr6.querySelectorAll("iframe").length})`);
    } else if (cnt("leapmotor/car3d/info") !== 1) {
      fail(`control: info 应每辆车只问一次, 实际 ${cnt("leapmotor/car3d/info")} 次`);
    } else if (cnt("leapmotor/car3d/ensure")) {
      fail(`control: 打开卡片就调了 ensure(联网必须由用户点按钮触发)`);
    } else if (cnt("leapmotor/car3d/market-pictures")) {
      fail(`control: 未切换 2D 就提前查询了商城颜色`);
    } else ok(`control: 状态推送不重建 iframe(同一节点), info 只问一次, 无自动 ensure`);

    // 实际点击预设色与恢复，监测 src 属性写入，节点相同也不能重新导航。
    {
      el6._car3d.colors.push({tsp:3,name:'示例蓝',hex:'#336699'},{tsp:8,name:'实车银',hex:'#D0D8DE'});
      const paintLog=[],originalPost=el6._postCar3d,srcChanges=[];
      el6._postCar3d=m=>paintLog.push(m);
      const observer=new window.MutationObserver(records=>srcChanges.push(...records));
      observer.observe(fr1,{attributes:true,attributeFilter:['src']});
      setEntryClick(sr6);await new Promise(r=>setTimeout(r,30));
      const clickPaint=async(selector,hex)=>{
        paintLog.length=0;
        const button=sr6.querySelector(selector);
        if(!button){fail('control: 换色回归缺少按钮 '+selector);return;}
        button.click();await new Promise(r=>setTimeout(r,30));
        if(paintLog.filter(m=>m.t==='paint').at(-1)?.hex!==hex)fail('control: 换色未发送实时车漆 '+hex);
      };
      await clickPaint('[data-act="car3dcolor"][data-val="0"]','#353535');
      await clickPaint('[data-act="car3dcolor"][data-val="3"]','#336699');
      await clickPaint('[data-act="car3dcolor"][data-val="8"]','');
      await clickPaint('[data-act="car3dcolor"][data-val="0"]','#353535');
      await clickPaint('[data-act="car3dauto"]','');
      sr6.querySelector('[data-act="palopen"][data-key="hex"]').click();await new Promise(r=>setTimeout(r,30));
      const hexInput=sr6.querySelector('input[data-act="palhexinput"]');
      hexInput.value='#ABCDEF';hexInput.dispatchEvent(new window.Event('input',{bubbles:true,composed:true}));
      hexInput.dispatchEvent(new window.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));await new Promise(r=>setTimeout(r,30));
      if(paintLog.filter(m=>m.t==='paint').at(-1)?.hex!=='#ABCDEF')fail('control: 自定义色未实时预览');
      await clickPaint('[data-act="paintcancel"]','');
      // 已保存预设、未知旧色号、集成默认色均在加载完成时同步，不进入 URL。
      for(const [prefs,option,hex] of [[{tsp:'3'},'','#336699'],[{tsp:'missing'},'',''],[{},'示例蓝','#336699'],[{hex:'#123456'},'','#123456'],[{},'','']]){
        el6._car3dPrefs=prefs;el6._car3d.options.car3d_color=option;paintLog.length=0;
        el6._onCar3dMsg({source:fr1.contentWindow,data:{t:'full'}});
        if(paintLog.filter(m=>m.t==='paint').at(-1)?.hex!==hex)fail('control: 加载后未同步已保存车漆 '+hex);
        el6._render();await new Promise(r=>setTimeout(r,20));
      }
      if(sr6.querySelector('.p-carview iframe')!==fr1||fr1.getAttribute('src')!==src1||srcChanges.length)fail('control: 预设/自定义/恢复车漆触发 iframe 重新导航');
      else ok('control: 多次切换预设、自定义、取消及实车色不写 src，加载完成正确同步偏好');
      observer.disconnect();el6._postCar3d=originalPost;
      sr6.querySelector('[data-act="smclose"]')?.click();await new Promise(r=>setTimeout(r,30));
      localStorage.clear();
    }

    const stableFrame=sr6.querySelector('.p-carview iframe');
    el6.setConfig({type:'custom:leapmotor-control'});
    el6.setConfig({type:'custom:leapmotor-control'});
    el6.hass=car3dHass(true, '');
    await new Promise(r=>setTimeout(r,60));
    if(sr6.querySelector('.p-carview iframe')!==stableFrame)fail('control: HA 重复应用配置重建了车模 iframe');
    else ok('control: 配置重复应用与车况刷新均复用同一 iframe');

    {
      const poseLog = [];
      const originalPost = el6._postCar3d;
      el6._postCar3d = m => poseLog.push(m);
      // 这份最小 3D 夹具只注册了 battery；姿态用例补上实际对应实体。
      el6._index.vehicle_state = 'sensor.che_liang_zhuang_tai';
      el6._index.trunk = 'switch.hou_bei_xiang';
      const h = car3dHass(true, "");
      const a = h.states['sensor.che_liang_zhuang_tai'].attributes;
      a.windows_percent = {left_front:20,right_front:50,left_rear:100,right_rear:null};
      a.windows_state = {'1':2,'2':2,'3':2,'4':2};
      el6.hass = h;
      await new Promise(r => setTimeout(r, 40));
      const p = poseLog.find(m => m.t === 'vehicle');
      if (!p || p.lf !== .2 || p.rf !== .5 || p.lr !== 1 || p.rr !== 1) fail('control: 车窗开度/四窗同开兜底同步错误');
      else ok('control: 独立窗开度优先，无开度时四窗同开可兜底');
      poseLog.length = 0;
      a.windows_percent = {left_front:0,right_front:0,left_rear:null,right_rear:null};
      a.windows_state = {'1':2,'2':0,'3':0,'4':0};
      el6.hass = h;
      await new Promise(r => setTimeout(r, 40));
      const mixed = poseLog.find(m => m.t === 'vehicle');
      if (!mixed || ['lf','rf','lr','rr'].some(k => k in mixed)) fail('control: 枚举逐窗顺序未验证时不能猜左右位置');
      else ok('control: 枚举混合开关且开度缺失时不猜逐窗状态');
      poseLog.length = 0;
      el6.hass = h;
      await new Promise(r => setTimeout(r, 40));
      if (poseLog.some(m => m.t === 'vehicle')) fail('control: 未变化的车窗状态重复发送');
      else ok('control: 相同车辆姿态不重复发消息');
      el6._postCar3d = originalPost;
    }

    // ㉑a2 1.9.43: 云端声明"这辆车没有 3D 素材"(modelType 2/1)时, 状态行要**说明情况**
    //     而不是"素材下载失败: ..." —— 那是信息, 不是故障; 按钮也换成"重新检查云端素材"。
    const el6u = await mkCar3dEl(car3dHass(false, "", "unsupported",
      "云端这次没有下发 3D 素材(只返回了 2D 模式)"));
    const sr6u = el6u.shadowRoot;
    setEntryClick(sr6u);
    await new Promise((r) => setTimeout(r, 40));
    const subU = sr6u.querySelector(".smodal .smbody .subline")?.textContent || "";
    const dlU = sr6u.querySelector('.smodal .smbody [data-act="car3ddl"]')?.textContent || "";
    if (!/没有下发 3D 素材/.test(subU)) fail(`control: unsupported 状态没显示说明: 「${subU}」`);
    else if (/下载失败/.test(subU)) fail(`control: unsupported 被当成失败来措辞了: 「${subU}」`);
    else if (!dlU.trim()) fail(`control: unsupported 时没有重试入口`);
    else ok(`control: unsupported(云端无 3D 素材) → 直说情况(不带"失败"), 按钮改为「重新检查」`);

    // ㉑b 1.9.39: 「设置」= 与「充电」**并排**的入口卡 + 弹窗(原来的"最底部可折叠子卡"没了)。
    //    ⚠️ 这里换掉的旧断言是"车模设置排在燃油块之后(最底部) + 有 fold 头 + 默认收起" ——
    //    新写法**更严**: 断言它和充电卡是**同一个 .csRow 里的兄弟**(并排的前提), 且卡片本体
    //    不再自带正文(.secB)、不再有 fold 头; 正文只在点开弹窗后出现在 .smbody 里。
    const car3dP = sr6.querySelector(".p-car3d");
    const chgP6 = sr6.querySelector(".p-charging");
    const csRow6 = sr6.querySelector(".csRow");
    if (!car3dP) fail(`control: 没有设置卡(.p-car3d)`);
    else if (!csRow6 || !chgP6 || car3dP.parentElement !== csRow6 || chgP6.parentElement !== csRow6) {
      fail(`control: 充电卡与设置卡不在同一个 .csRow 里(并排不了)`);
    } else if (!(chgP6.compareDocumentPosition(car3dP) & window.Node.DOCUMENT_POSITION_FOLLOWING)) {
      fail(`control: 设置卡没有排在充电卡之后`);
    } else if (car3dP.querySelector('[data-act="fold"]')) {
      fail(`control: 设置卡还挂着折叠头(data-act=fold) —— 应改成弹窗入口`);
    } else if (car3dP.querySelector(".secB")) {
      fail(`control: 设置卡本体不该自己铺开正文(正文在弹窗里)`);
    } else if (!/\.csRow\s*\{[^}]*grid-template-columns:\s*1fr\s+1fr/.test(code)) {
      fail(`control: .csRow 不是两列(两张卡应各占一半)`);
    } else if (/\.card\.narrow\s+\.csRow/.test(code)) {
      fail(`control: .narrow(<420px) 还在把并排的两张卡堆叠(应只由 .tiny <280px 驱动)`);
    } else ok(`control: 充电/设置 = 同 .csRow 两列并排的入口卡(本体不带正文, 堆叠只由 .tiny 驱动)`);
    const setEntry = sr6.querySelector('.p-car3d [data-act="car3dmenu"]');
    if (setEntry) {
      // 标题已随「车模设置 → 设置」改名(配色也并进这张卡了)
      if ((setEntry.querySelector(".foldT")?.textContent || "") !== "设置") {
        fail(`control: 设置卡标题不是「设置」: ${setEntry.textContent}`);
      }
      setEntry.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const smBody6 = sr6.querySelector(".smodal .smbody");
      if (!sr6.querySelector(".smodal.on")) fail(`control: 点设置卡没有弹出设置弹窗`);
      else if ((sr6.querySelector(".smodal .smhead .t")?.textContent || "") !== "设置") {
        fail(`control: 设置弹窗标题不对: ${sr6.querySelector(".smodal .smhead .t")?.textContent}`);
      }
      // 1.9.38 起色卡自定义(input[type=color] + 「应用」)换成"末尾一颗彩虹圆开取色器",
      // 所以这里断言的是**更严**的一组: 圆色块 + 彩虹圆 + 回到实车色, 且旧控件一个都不留。
      const dots = [...(smBody6?.querySelectorAll('[data-act="car3dcolor"]') || [])];
      const rain = smBody6?.querySelector('[data-act="palopen"][data-key="hex"]');
      // 取色器面板必须**跟着正文一起进弹窗**(它的定位基准是弹窗, 见 picker.ts 的 placePalPop)
      const palInModal = smBody6?.querySelector(".palPop");
      if (!dots.length) fail(`control: 设置弹窗里没有车模颜色色块`);
      else if (!dots.every((b) => b.querySelector(".pcSw"))) fail(`control: 车模颜色色块不是"圆色块 + 圆下方名字"的写法`);
      else if (sr6.querySelector('input[data-act="car3dhex"], [data-act="car3dhexset"], [data-act="palhexset"]')) {
        fail(`control: 还留着 input[type=color] / 「应用」钮(自定义色应走彩虹圆 → 取色器)`);
      } else if (!rain || !rain.querySelector(".pcSw.rainbow")) {
        fail(`control: 车模颜色行末尾没有彩虹圆(自定义车漆的入口)`);
      } else if (!smBody6?.querySelector('[data-act="car3dauto"]')) {
        fail(`control: 没有「回到实车色」`);
      } else if (!smBody6?.querySelector('[data-act="car3dbg"][data-val="night"]')) fail(`control: 设置弹窗里没有背景选择`);
      else if(!smBody6?.querySelector('[data-act="wrapopen"]'))fail('control: 3D 设置缺少车衣入口');
      else if (!smBody6?.querySelector('input[data-act="car3dimg"]')) fail(`control: 设置弹窗里没有自定义外观图输入框`);
      else if (palInModal) fail(`control: 取色器面板不该在没点彩虹圆时就画出来`);
      else if (!smBody6.querySelector('[data-act="palopen"][data-key="accent"]')) fail(`control: 弹窗里没有「卡片配色」那行的彩虹圆`);
      else if (!smBody6.querySelector('[data-act="car3dviewmode"][data-val="2d"]')) fail(`control: 设置弹窗里没有手动切换 2D 车模的选项`);
      else ok(`control: 设置 → 弹窗(标题=设置) 里有 车模颜色大圆 + 彩虹圆(取色器) + 回到实车色 + 背景 + 外观图`);
      const modalCard=sr6.querySelector('.card'),oldRect=modalCard.getBoundingClientRect;
      modalCard.getBoundingClientRect=()=>({top:-250,height:800});
      el6._placeModal();
      if(sr6.querySelector('.smodal').style.top||smBody6.contains(sr6.querySelector('.smx'))||sr6.querySelector('.card').contains(sr6.querySelector('.smodal'))||sr6.querySelector('.smodal').getAttribute('aria-modal')!=='true') fail('control: 全页弹窗仍受卡片定位限制或关闭按钮进入滚动正文');
      else ok('control: 全页弹窗独立于卡片，关闭按钮固定在正文外');
      modalCard.getBoundingClientRect=oldRect;
      sr6.querySelector('.smodal .smbody [data-act="car3dviewmode"][data-val="2d"]')?.click();
      await new Promise(r=>setTimeout(r,40));
      const savedMode=JSON.parse(localStorage.getItem(el6._car3dPrefsStoreKey())||'{}');
      if(el6._car3dPrefs.modelView!=='2d'||savedMode.modelView!=='2d')fail('control: 选择 2D 后没有保存本机车模模式');
      else if(sr6.querySelector('.p-carview iframe')||sr6.querySelector('.heroStage')?.classList.contains('stage3d'))fail('control: 固定 2D 后仍保留 3D 车模舞台');
      else if(cnt('leapmotor/car3d/market-pictures')!==2||marketDeviceIds.at(-1)!=='dev1')fail('control: 切换 2D 后没有先匹配当前车辆再按所选商城配置查询颜色');
      else if(el6._car3dPrefs.market2dColor!=='实车银'||el6._car3dPrefs.market2dUrl!=='https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/silver.png')fail('control: 2D 模式没有默认选中实车颜色对应的商城整车图');
      else if(el6._carImgSrc!=='https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/silver.png')fail('control: 2D 车模没有切换为商城真车渲染图');
      else if(!sr6.querySelector('.p-hero .carModel'))fail('control: 固定 2D 后没有切回外观图车模区域');
      else ok('control: 固定 2D → 按当前车辆读取商城颜色并使用实车颜色图片，偏好持久保存');
      const scaleSlider=sr6.querySelector('.smodal .smbody [data-act="car2dscale"]');
      const scaleHeader=sr6.querySelector('.smodal .smbody [data-act="car2dmenu"]');
      const model2d=sr6.querySelector('.p-hero .carModel.model2d');
      if(!scaleSlider||!scaleHeader)fail('control: 2D 外观设置缺少可收起入口或车图大小滑条');
      else if(scaleSlider.value!=='1.5'||model2d?.style.getPropertyValue('--lm-car-2d-image-scale')!=='1.5')fail('control: 2D 车图默认大小不是 1.5 倍');
      else {
        scaleHeader.click();
        if(sr6.querySelector('.smodal .smbody [data-act="car2dscale"]'))fail('control: 2D 外观设置无法收起');
        else {
          sr6.querySelector('.smodal .smbody [data-act="car2dmenu"]')?.click();
          const reopenedScale=sr6.querySelector('.smodal .smbody [data-act="car2dscale"]');
          if(!reopenedScale)fail('control: 收起后的 2D 外观设置无法重新展开');
          else {
            reopenedScale.value='1.85';
            reopenedScale.dispatchEvent(new window.Event('input',{bubbles:true,composed:true}));
            await new Promise(r=>setTimeout(r,40));
            const savedScale=JSON.parse(localStorage.getItem(el6._car3dPrefsStoreKey())||'{}').market2dScale;
            if(Number(savedScale)!==1.85||sr6.querySelector('.p-hero .carModel.model2d')?.style.getPropertyValue('--lm-car-2d-image-scale')!=='1.85')fail('control: 调整 2D 车图大小后没有即时应用并保存');
            else ok('control: 2D 外观设置可收起/展开，车图大小默认 1.5 倍并支持即时调整和保存');
          }
        }
      }
      const blue2d=sr6.querySelector('.smodal .smbody [data-act="car2dcolor"][data-val="示例蓝"]');
      blue2d?.dispatchEvent(new window.MouseEvent('click',{bubbles:true,composed:true}));
      await new Promise(r=>setTimeout(r,35));
      if(!blue2d)fail('control: 商城颜色选项没有显示可选车色');
      else if(el6._car3dPrefs.market2dColor!=='示例蓝'||el6._carImgSrc!=='https://ueapp-oss-static.leapmotor.com/blue.png')fail('control: 手动选择商城颜色后没有更新 2D 真车图片');
      else ok('control: 手动选择指定商城颜色后即时更新 2D 真车图片');
      const modelSelect=sr6.querySelector('.smodal .smbody [data-act="car2dmodel"]');
      if(modelSelect){modelSelect.value='C16';modelSelect.dispatchEvent(new window.Event('change',{bubbles:true,composed:true}));}
      await new Promise(r=>setTimeout(r,70));
      if(!modelSelect)fail('control: 商城车型目录选择框没有显示');
      else if(el6._car3dPrefs.market2dModel!=='C16'||el6._car3dPrefs.market2dYear!=='2025'||el6._car3dPrefs.market2dEdition!=='580版')fail('control: 更换商城车型后没有读取并保存对应年款配置');
      else if(el6._carImgSrc!=='https://lpmall-dop-prod.oss-cn-hangzhou.aliyuncs.com/c16-green.png'||marketSelections.at(-1)?.model_id!=='catalog-c16')fail('control: 新车型配置没有切换到其商城整车颜色图');
      else ok('control: 可改选其他商城车型，并按该车型年款配置加载其颜色图片');
      const yearSelect=sr6.querySelector('.smodal .smbody [data-act="car2dyear"]');
      if(yearSelect){
        const yearOptions=Array.from(yearSelect.options).map(option=>option.value);
        if(!yearOptions.includes('2020'))fail('control: 年款选项没有从 2020 年开始');
        else ok('control: 年款选择器提供从 2020 年起的连续年份');
        yearSelect.value='2020';yearSelect.dispatchEvent(new window.Event('change',{bubbles:true,composed:true}));
      }
      await new Promise(r=>setTimeout(r,30));
      if(!yearSelect)fail('control: 独立的年款选择框没有显示');
      else if(el6._marketSelectedYear!=='2020'||el6._marketSelectedVariant!==''||el6._marketPictures.length!==0||el6._marketPicturesError!=='该年款暂无商城配置')fail('control: 无商城配置年份没有保留选择并清除旧配置图片');
      else if(!marketVariantRequests.some((item)=>item.model==='C16'&&item.year==='2020'))fail('control: 目录缺少年款时没有按选中年份探测历史接口');
      else if(!sr6.querySelector('.smodal .smbody [data-act="car2dvariant"]')?.disabled)fail('control: 无商城配置年份的配置选择器仍可用');
      else ok('control: 无商城配置年份显示明确状态，不沿用其他年份图片');
      const currentYearSelect=sr6.querySelector('.smodal .smbody [data-act="car2dyear"]');
      if(currentYearSelect){currentYearSelect.value='2024';currentYearSelect.dispatchEvent(new window.Event('change',{bubbles:true,composed:true}));}
      await new Promise(r=>setTimeout(r,60));
      if(!yearSelect)fail('control: 独立的年款选择框没有显示');
      else if(el6._car3dPrefs.market2dYear!=='2024'||el6._car3dPrefs.market2dModelId!=='catalog-c16-2024')fail('control: 切换年款后没有选择该年款配置并刷新图片');
      else if(!marketVariantRequests.some((item)=>item.model==='C16'&&item.year==='2024'))fail('control: 2024 款没有按年款请求官网接口');
      else ok('control: 年款可独立切换，配置选择与商城图片随年款同步更新');
      sr6.querySelector('.smodal .smbody [data-act="car3dviewmode"][data-val="auto"]')?.click();
      await new Promise(r=>setTimeout(r,50));
      const restoredMode=JSON.parse(localStorage.getItem(el6._car3dPrefsStoreKey())||'{}');
      if(el6._car3dPrefs.modelView||restoredMode.modelView)fail('control: 恢复自动模式后仍保留 2D 覆盖');
      else if(!sr6.querySelector('.p-carview iframe')||!sr6.querySelector('.heroStage')?.classList.contains('stage3d'))fail('control: 恢复自动模式后没有回到可用的 3D 车模');
      else ok('control: 恢复自动模式 → 可用时回到 3D');
      // 关掉弹窗, 免得影响后面的用例
      sr6.querySelector('[data-act="smclose"]')?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
    } else fail(`control: 设置卡没有弹窗入口(data-act=car3dmenu)`);

    // 未装配: 不建 iframe、不联网; 只有下载入口; 点一下才 ensure(且只有一次)
    const el7 = await mkCar3dEl(car3dHass(false, ""));
    if(el7.shadowRoot.querySelector('.carSvg')) fail('control: 无素材时仍显示 car_svg 回退');
    else ok('control: 无素材时不绘制 car_svg 回退');
    const sr7 = el7.shadowRoot;
    if (sr7.querySelector(".p-carview iframe")) fail(`control: 素材未就绪却建了 iframe`);
    else if (cnt("leapmotor/car3d/ensure")) fail(`control: 未装配时自动调了 ensure`);
    else ok(`control: 素材未装配 → 无 iframe、不联网`);
    sr7.querySelector('.p-car3d [data-act="car3dmenu"]')?.dispatchEvent(
      new window.MouseEvent("click", { bubbles: true, composed: true }));
    await new Promise((r) => setTimeout(r, 40));
    const dl7 = sr7.querySelector('.smodal .smbody [data-act="car3ddl"]');
    if (!dl7) fail(`control: 未装配时车模设置里没有下载按钮`);
    else if (!/下载 3D 车模素材/.test(dl7.textContent)) fail(`control: 下载按钮文案不对: ${dl7.textContent}`);
    else {
      dl7.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (cnt("leapmotor/car3d/ensure") !== 1) fail(`control: 点下载按钮没有(或重复)调用 ensure: ${cnt("leapmotor/car3d/ensure")}`);
      else ok(`control: 点下载按钮 → ensure(共 1 次)`);
    }

    // 选项里填了自定义外观图: 不进 3D、也不给下载按钮
    const el8 = await mkCar3dEl(car3dHass(true, "/local/my-car.png"));
    const sr8 = el8.shadowRoot;
    if (sr8.querySelector(".p-carview iframe")) fail(`control: 选了自定义外观图仍是 3D`);
    else if (sr8.querySelector(".vname .tag3d")) fail(`control: 自定义外观图时标题旁不该有「3D」标`);
    else {
      sr8.querySelector('.p-car3d [data-act="car3dmenu"]')?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (sr8.querySelector('.smodal .smbody [data-act="car3ddl"]')) fail(`control: 选了自定义外观图还显示下载按钮`);
      else ok(`control: 自定义外观图 → 不进 3D、不给下载按钮、无「3D」标`);
    }

    // ⑮ 舞台/控件位置: 2D 保持"数据在上、车模在下", 3D 时车模当背景、数据叠上去;
    //    胎压开关必须在车模**外面**(车模下方的 .carTools), 不能压车
    const stage0 = sr.querySelector(".heroStage");
    if (!stage0) fail(`control: 没有 hero 舞台容器(.heroStage)`);
    else if (sr.querySelector(".p-hero").parentElement !== stage0) fail(`control: .p-hero 不在 .heroStage 里`);
    else if (sr.querySelector(".p-carview").parentElement !== stage0) fail(`control: .p-carview 不在 .heroStage 里`);
    else if (!sr.querySelector(".heroStage .p-hero .carModel")) fail(`control: 2D 车模盒不在 hero 里(应保持两段式)`);
    else if (sr.querySelector(".heroStage .p-carview").innerHTML.trim()) fail(`control: 2D 时 3D 盒不该有内容`);
    else if (stage0.classList.contains("stage3d")) fail(`control: 2D 不应带 stage3d 类(会变成全幅舞台)`);
    else if (sr.querySelector(".heroStage .carModel .tireTgl")) {
      fail(`control: 胎压开关还在车模盒里(会压住车)`);
    } else if (!sr.querySelector(".carTools .tireTgl")) {
      fail(`control: 胎压开关不在车模下方的小控件行(.carTools)里`);
    } else if (!sr.querySelector(".heroStage .stageVeil")) fail(`control: 缺下缘渐隐层(.stageVeil)`);
    else {
      // 胎压开关 1.9.38 起是**纯图标**(无边框/无底色/无胶囊): 只有一个 mdi:gauge, 尺寸 20px
      const tgl = sr.querySelector(".carTools .tireTgl");
      const tglRule = ((sr.querySelector("style")?.textContent || "").match(/\.tireTgl\s*\{[^}]*\}/) || [""])[0];
      if (tgl.children.length !== 1 || tgl.firstElementChild.tagName.toLowerCase() !== "ha-icon" ||
          tgl.firstElementChild.getAttribute("icon") !== "mdi:gauge") {
        fail(`control: 胎压开关不是"只有一颗 mdi:gauge 图标"的纯图标钮: ${tgl.innerHTML}`);
      } else if (!/background:\s*transparent/.test(tglRule) || !/border:\s*0/.test(tglRule)) {
        fail(`control: 胎压开关还带底/边框(应是视觉无框的纯图标): ${tglRule.slice(0, 80)}`);
      } else if (!/width:\s*32px/.test(tglRule) || !/height:\s*32px/.test(tglRule)) {
        fail(`control: 胎压开关的命中区不是 ~32px: ${tglRule.slice(0, 80)}`);
      } else if (!/\.tireTgl\.on\s*\{[^}]*color:\s*var\(--primary-color/.test(sr.querySelector("style")?.textContent || "")) {
        fail(`control: 胎压开关的选中态不是"图标变主题色"`);
      } else {
        // 读数层: 3D 下必须被夹回**舞台**矩形(bottom: var(--c3ext)) —— 否则后两颗读数会掉出舞台
        const css2 = sr.querySelector("style")?.textContent || "";
        const padLayer = (css2.match(/\.heroStage\.stage3d\s+\.tirePads\s*\{[^}]*\}/) || [""])[0];
        const padFront = (css2.match(/\.heroStage\.stage3d\s+\.tP\.a[^{]*\{[^}]*\}/) || [""])[0];
        if (!/bottom:\s*var\(--c3ext/.test(padLayer)) {
          fail(`control: 3D 下胎压读数层没有被夹回舞台(会掉出舞台压到圆钮行上): ${padLayer.slice(0, 80)}`);
        } else if (!/--c3data/.test(padFront) || !/min\(/.test(padFront)) {
          fail(`control: 3D 下前两颗读数没有从数据层下沿排(缺 --c3data/min()): ${padFront.slice(0, 80)}`);
        } else ok(`control: 2D 两段式保持 + 胎压开关=纯图标(mdi:gauge, 32px 命中区, 选中态变主题色) + 读数层夹回舞台`);
      }
    }

    // 3D: 舞台带 stage3d + 定高; 数据层 .p-hero 是舞台的子节点(叠在车模上); 渐隐层可见
    const stage6 = sr6.querySelector(".heroStage");
    if (!stage6 || !stage6.classList.contains("stage3d")) fail(`control: 3D 时舞台没切成 stage3d`);
    else if (!stage6.style.height || !/px$/.test(stage6.style.height)) fail(`control: 3D 舞台没有高度: ${stage6.style.height}`);
    else if (sr6.querySelector(".p-hero").parentElement !== stage6) fail(`control: 3D 数据层不在舞台上`);
    else if (!/radius=\d/.test(src1)) fail(`control: iframe src 没带取景 radius: ${src1}`);
    else {
      const veil = window.getComputedStyle(sr6.querySelector(".stageVeil"));
      if (veil.display === "none") fail(`control: 3D 时渐隐层被藏了`);
      else ok(`control: 3D 舞台(定高 ${stage6.style.height}) + 数据叠层 + 渐隐层 + iframe 带 radius`);
    }
    // 3D 里点胎压: 读数浮层出现在车模盒里, 开关仍在车模下方
    const tgl6 = sr6.querySelector(".carTools .tireTgl");
    if (tgl6) {
      tgl6.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (!sr6.querySelector(".p-carview .carModel .tP")) fail(`control: 3D 打开胎压后车模盒里没有四角读数`);
      else if (!sr6.querySelector(".carTools .tireTgl.on")) fail(`control: 3D 胎压开关的选中态丢了`);
      else if (sr6.querySelector(".p-carview .tireTgl")) fail(`control: 3D 打开胎压后开关又跑回车模里了`);
      else ok(`control: 3D 胎压 → 读数在车模盒里、开关留在下方且选中`);
      tgl6.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 30));
    }
    // compact: 胎压整行不出现(行为与原实现一致)
    const el9 = window.document.createElement("leapmotor-control");
    window.document.body.appendChild(el9);
    el9.setConfig({ type: "custom:leapmotor-control", compact: true });
    el9.hass = car3dHass(false, "");
    await new Promise((r) => setTimeout(r, 60));
    const tools9 = el9.shadowRoot.querySelector(".carTools");
    // 判"有没有元素子节点"而不是 innerHTML: Lit 空模板会在容器里留一个注释锚点
    if (!tools9 || tools9.children.length) fail(`control: compact 模式还画了车模下方的小控件行`);
    else ok(`control: compact 下胎压开关整行不出现`);

    // ㉗ 卡片配色(「设置」子卡最上面那行大圆色块): 点色圆 → 立即生效(写本机 + 变量更新 + 广播);
    //    点「跟随主题」→ 变量移除(回到主题变量)。六张卡都吃这几个变量, 所以是一处设置全局生效。
    //    再验取色器(末尾彩虹圆 → 面板): 拖 SV / hex 回车都即时生效、非法输入还原、
    //    没有 window.EyeDropper 的环境里吸管按钮整颗不出现、点外面关闭。
    {
      localStorage.clear();
      const elPal = await mkCar3dEl(car3dHass(true, ""));
      const srPal = elPal.shadowRoot;
      // 1.9.39: 「设置」的正文在**弹窗**里(点卡片本体 → .smodal .smbody)
      srPal.querySelector('.p-car3d [data-act="car3dmenu"]')?.dispatchEvent(
        new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      if (!srPal.querySelector(".smodal.on")) fail(`control: 点设置卡没有弹出设置弹窗(配色这条测不了)`);
      const rows = [...srPal.querySelectorAll(".smodal .smbody .cRow .cL")].map((n) => n.textContent);
      const dot = () => srPal.querySelector('[data-act="pal"][data-key="accent"][data-val="#9c27b0"]');
      const autoBtn = () => srPal.querySelector('[data-act="pal"][data-key="accent"][data-val=""]');
      const hint = srPal.querySelector(".smodal .smbody .subline")?.textContent || "";
      // 设置弹窗: 主题色 → 界面风格 → 隐藏卡片外框 → 车模显示 → 车模颜色
      // (界面风格与主题色是两个独立维度: 前者决定控件长相, 后者决定强调色)
      if (rows[0] !== "卡片配色 · 主题色" || rows[1] !== "界面风格" || rows[2] !== "隐藏卡片外框" || rows[3] !== "车模显示" || rows[4] !== "车模颜色") {
        fail(`control: 设置弹窗顶部次序不正确(实际 ${JSON.stringify(rows.slice(0, 5))})`);
      } else if (rows.indexOf("卡片配色 · 电量/状态色") >= 0) {
        fail(`control: 「卡片配色 · 电量/状态色」整行还留着(--success-color 不该再被覆盖)`);
      } else if (!dot() || !dot().querySelector(".pcSw")) {
        fail(`control: 卡片配色行缺"圆色块 + 圆下方名字"的色块`);
      } else if (srPal.querySelector('[data-act="palhex"], [data-act="palhexset"]')) {
        fail(`control: 卡片配色行还留着 input[type=color] / 「应用」钮(自定义色应走彩虹圆 → 取色器)`);
      } else if (!srPal.querySelector('[data-act="palopen"][data-key="accent"]')) {
        fail(`control: 卡片配色行末尾没有彩虹圆(自定义色入口)`);
      } else if (/五张卡片统一生效/.test(srPal.textContent || "")) {
        // 用户要求去掉这行说明 → 反过来锁住"它不该再出现"
        fail(`control: 设置里那行「对本集成自带的五张卡片统一生效…」说明还在`);
      } else if (!autoBtn().classList.contains("on")) {
        fail(`control: 没设过配色时「跟随主题」应点亮(其余色块不亮)`);
      } else {
        // 点紫色圆: 写 localStorage + 宿主变量跟着变 + 派发广播事件
        let evt = 0;
        const onPal = () => { evt++; };
        window.addEventListener("leapmotor:palette", onPal);
        dot().dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        window.removeEventListener("leapmotor:palette", onPal);
        const saved = window.localStorage.getItem("leapmotor.palette") || "";
        const pc = elPal.style.getPropertyValue("--primary-color").trim();
        const rgb = elPal.style.getPropertyValue("--rgb-primary-color").trim();
        if (!evt) fail(`control: 点色圆没有派发 leapmotor:palette 广播事件(同页别的卡不会跟着变)`);
        else if (!/"accent":"#9c27b0"/.test(saved)) fail(`control: 点色圆没写进本机: 「${saved}」`);
        else if (pc !== "#9c27b0" || rgb !== "156, 39, 176") {
          fail(`control: 点色圆后宿主变量没跟上(--primary-color=「${pc}」/--rgb-primary-color=「${rgb}」)`);
        } else if (!dot().classList.contains("on") || autoBtn().classList.contains("on")) {
          fail(`control: 选中态没跟着切(紫圆应点亮, 「跟随主题」应熄灭)`);
        } else {
          // 点「跟随主题」: 变量被移除(回到主题变量), 本机键清掉
          autoBtn().dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
          await new Promise((r) => setTimeout(r, 40));
          const pc2 = elPal.style.getPropertyValue("--primary-color").trim();
          const rgb2 = elPal.style.getPropertyValue("--rgb-primary-color").trim();
          const left = window.localStorage.getItem("leapmotor.palette");
          if (pc2 || rgb2) fail(`control: 点「跟随主题」后变量没被移除(--primary-color=「${pc2}」)`);
          else if (left) fail(`control: 点「跟随主题」后本机键没清: 「${left}」`);
          else if (autoBtn().classList.contains("on") !== true) fail(`control: 点「跟随主题」后它没有点亮`);
          else ok(`control: 卡片配色 = 点色圆立即生效(本机+变量+广播), 「跟随主题」移除变量回到主题`);
        }
      }

      // 边框开关立即持久化，不能顺带提交或取消正在预览的风格。
      {
        const click = (selector) => srPal.querySelector(selector)?.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        const tick = () => new Promise(r => setTimeout(r, 40));
        const toggle = () => srPal.querySelector('[data-act="hidecardframe"]');
        if (toggle()?.getAttribute("aria-checked") !== "false") fail("control: 隐藏外框开关应默认关闭");
        click('[data-act="style"][data-val="brutalist"]'); await tick();
        click('[data-act="hidecardframe"]'); await tick();
        const pending = JSON.parse(window.localStorage.getItem("leapmotor.appearance") || "{}");
        if (toggle()?.getAttribute("aria-checked") !== "true" || pending.hideCardFrame !== true || pending.style === "brutalist" || elPal.getAttribute("data-lm-style") !== "brutalist" || elPal.style.getPropertyValue("--lm-shadow-card") !== "none") fail("control: 隐藏外框未保存、未去除阴影，或错误提交了风格预览");
        click('[data-act="styleapply"]'); await tick();
        const saved = JSON.parse(window.localStorage.getItem("leapmotor.appearance") || "{}");
        if (saved.style !== "brutalist" || saved.hideCardFrame !== true) fail("control: 应用风格时丢失隐藏外框偏好");
        click('[data-act="style"][data-val="memphis"]'); await tick();
        click('[data-act="hidecardframe"]'); await tick();
        click('[data-act="stylecancel"]'); await tick();
        if (elPal.getAttribute("data-lm-style") !== "brutalist" || elPal.style.getPropertyValue("--lm-card-border") === "0" || elPal.style.getPropertyValue("--lm-shadow-card") === "none") fail("control: 取消风格预览时未保留已恢复的原有外框及阴影");
        window.localStorage.removeItem("leapmotor.appearance");
        window.dispatchEvent(new window.StorageEvent("storage", { key: "leapmotor.appearance" }));
        await tick();
        ok("control: 隐藏外框开关立即保存，独立于风格预览、应用和取消");
      }

      // 取色器: 彩虹圆 → 面板; 拖 SV / hex 回车 / 方向键都即时生效; 非法 hex 还原; 吸管按支持度出现;
      // 点外面关闭。(jsdom 没有布局, 这里把 SV 的 rect 桩掉再派发指针事件。)
      const rain = srPal.querySelector('[data-act="palopen"][data-key="accent"]');
      rain.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
      await new Promise((r) => setTimeout(r, 40));
      const pop = srPal.querySelector(".palPop");
      const sv = pop ? pop.querySelector('[data-act="palsv"]') : null;
      const hue = pop ? pop.querySelector('input[data-act="palhue"]') : null;
      const hexIn = pop ? pop.querySelector('input[data-act="palhexinput"]') : null;
      const hasED = typeof window.EyeDropper === "function";
      if (!pop || !sv || !hue || !hexIn) {
        fail(`control: 点彩虹圆没有打开取色器面板(缺 SV 方块 / 色相滑条 / hex 输入框)`);
      } else if (hue.getAttribute("min") !== "0" || hue.getAttribute("max") !== "359") {
        fail(`control: 色相滑条范围不对: ${hue.getAttribute("min")}~${hue.getAttribute("max")}`);
      } else if (hasED && !pop.querySelector('[data-act="paleye"]')) {
        fail(`control: 浏览器支持 window.EyeDropper 时应该画出吸管按钮`);
      } else if (!hasED && pop.querySelector('[data-act="paleye"]')) {
        fail(`control: 浏览器没有 window.EyeDropper 时吸管按钮应整颗不出现`);
      } else if (!pop.querySelector(".palPct") || !pop.querySelector(".palFmt")) {
        fail(`control: 取色器底部行缺「100 %」/「hex ⌄」`);
      } else {
        const R = { left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0 };
        sv.getBoundingClientRect = () => R;
        sv.setPointerCapture = () => {};
        const drag = (x, y) => {
          sv.dispatchEvent(new window.MouseEvent("pointerdown", { clientX: x, clientY: y, bubbles: true, composed: true }));
          sv.dispatchEvent(new window.MouseEvent("pointerup", { clientX: x, clientY: y, bubbles: true, composed: true }));
        };
        // ① 拖到正中(s=0.5, v=0.5) → 色相滑条定到 0° → 颜色是确定值 #804040(与初始色相无关)
        drag(50, 50);
        await new Promise((r) => setTimeout(r, 30));
        hue.value = "0";
        hue.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 30));
        const pcA = elPal.style.getPropertyValue("--primary-color").trim();
        const savedA = window.localStorage.getItem("leapmotor.palette") || "";
        // ② hex 输入框: 先来一个非法的(应该被还原), 再来一个合法的回车生效
        hexIn.value = "#zzzzzz";
        hexIn.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
        hexIn.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        const pcB = elPal.style.getPropertyValue("--primary-color").trim();
        hexIn.value = "#39c5bb";
        hexIn.dispatchEvent(new window.Event("input", { bubbles: true, composed: true }));
        hexIn.dispatchEvent(new window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        const pcC = elPal.style.getPropertyValue("--primary-color").trim();
        // ③ 键盘微调: SV 方块上的左右键改饱和度
        sv.dispatchEvent(new window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        await new Promise((r) => setTimeout(r, 30));
        const pcD = elPal.style.getPropertyValue("--primary-color").trim();
        // ④ 点面板外面 → 关闭
        window.document.body.dispatchEvent(new window.MouseEvent("click", { bubbles: true, composed: true }));
        await new Promise((r) => setTimeout(r, 40));
        if (pcA !== "#804040") fail(`control: 拖 SV 到正中 + 色相 0° 应为 #804040, 实际「${pcA}」`);
        else if (!/"accent":"#804040"/.test(savedA)) fail(`control: 拖动取色器没有写进本机: 「${savedA}」`);
        else if (pcB !== "#804040") fail(`control: 非法 hex 应该被还原成当前色, 实际「${pcB}」`);
        else if (pcC !== "#39c5bb") fail(`control: hex 输入框回车没生效: 「${pcC}」`);
        else if (pcD === pcC) fail(`control: SV 方块的方向键没有微调饱和度(--primary-color 没变)`);
        else if (srPal.querySelector(".palPop")) fail(`control: 点面板外面没有关闭取色器`);
        else ok(`control: 取色器(彩虹圆打开)拖 SV / hex 回车即时生效、非法输入还原、方向键可微调、点外面关闭`);
      }
      localStorage.clear();
    }
  }
}

if(ONLY==='control'){
  const widget=document.createElement('leapmotor-vehicle-tools');widget.section='schedule';widget.chargeEnabled=true;widget.entityId='sensor.car_b';const calls=[];let broken=false;
  widget.hass={user:{is_admin:true},states:{},callWS:async m=>{calls.push(m);if(m.type.endsWith('/save')){if(broken)throw Error('模拟云端拒绝');return{accepted:true}}return{can_charge:true,can_preheat:true,charge:{circulation:1,cycles:'1,0,0,0,0,0,1',recharge:0},preheat:[{set_id:'p1',on:'1',start_time:'2026-10-16 07:15:00',days:[1,5]}],preheat_error:''}}};document.body.appendChild(widget);
  const tick=()=>new Promise(r=>setTimeout(r,40));await tick();const r=widget.shadowRoot;
  if(r.querySelectorAll('.week button[aria-pressed="true"]').length!==4)fail('control: 预约重复日期没有按周日为0回显');else ok('control: 预约充电与预热分别回显周日到周六');
  const btn=[...r.querySelectorAll('button')].find(b=>b.textContent==='保存充电重复与续充');btn.click();await tick();
  const saved=calls.find(m=>m.type.endsWith('/save'));
  if(saved?.entity_id!=='sensor.car_b'||saved.kind!=='charge'||saved.data.days.join(',')!=='0,6')fail('control: 预约设置未发往所选车辆或日期错位');else ok('control: 预约设置按所选实体发送，保留独立周计划');
  broken=true;[...r.querySelectorAll('button')].find(b=>b.textContent==='保存预热预约').click();await tick();
  if(!r.querySelector('[role="alert"]')?.textContent.includes('模拟云端拒绝')||r.textContent.includes('云端已受理'))fail('control: 预约失败仍显示受理或隐藏错误');else ok('control: 云端拒绝预约时显示错误，不报假成功');
  const switchEl=r.querySelector('.preheatTitle input');switchEl.checked=false;switchEl.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
  if(!r.querySelector('.preheatTitle input').checked||!r.querySelector('input[type=time]'))fail('control: 预热开关失败未恢复原状态');else ok('control: 预热开关提交失败恢复原状态和时间设置');
  broken=false;switchEl.checked=false;switchEl.dispatchEvent(new window.Event('change',{bubbles:true}));await tick();
  if(r.querySelector('input[type=time]')||!calls.some(m=>m.kind==='preheat'&&m.data.enabled===false))fail('control: 关闭预热未提交或没有收起时间');else ok('control: 关闭预热立即提交并收起时间，保留限时确认反馈');
  widget.chargeEnabled=false;await tick();
  if(r.querySelector('[aria-label="预约充电重复日期"]'))fail('control: 关闭预约充电后重复设置未收起');else ok('control: 预约充电关闭时隐藏重复与续充设置');
  widget.remove();
  const mapWidget=document.createElement('leapmotor-vehicle-tools');mapWidget.section='media';mapWidget.entityId='sensor.car_b';const mapCalls=[];
  mapWidget.hass={user:{is_admin:true},states:{},callWS:async msg=>{mapCalls.push(msg);if(msg.type==='leapmotor/map/search')return{places:[{poi_id:'B_TEST',name:'测试公园',address:'公园路1号',latitude:31.2,longitude:121.4,city:'演示城市'}]};if(msg.type.endsWith('/save'))return{accepted:true};return{can_destination:true,amap_configured:true}}};document.body.appendChild(mapWidget);await tick();
  const mr=mapWidget.shadowRoot;mr.querySelector('details').open=true;mr.querySelector('[aria-label="高德地点关键词"]').value='公园';mr.querySelector('[aria-label="高德地点关键词"]').dispatchEvent(new window.Event('input',{bubbles:true}));[...mr.querySelectorAll('button')].find(b=>b.textContent==='搜索地点').click();await tick();mr.querySelector('.placeResult').click();await tick();
  if(mapCalls.some(m=>m.type.endsWith('/save')))fail('control: 搜索选择地点时不应自动下发车辆');
  [...mr.querySelectorAll('button')].find(b=>b.textContent==='发送到车机').click();await tick();const sent=mapCalls.find(m=>m.kind==='destination');
  if(sent?.entity_id!=='sensor.car_b'||sent.data.poi_id!=='B_TEST'||sent.data.coordinate_type!=='gcj02'||sent.data.latitude!==31.2)fail('control: 搜索地点未保留 POI、坐标与选定车辆');else ok('control: 高德搜索仅在点击发送后下发，保留 POI 与 GCJ-02 坐标');mapWidget.remove();
}

console.log(`\n===== ${failures === 0 ? "全部通过" : failures + " 项失败"} =====`);
process.exit(failures === 0 ? 0 : 1);

