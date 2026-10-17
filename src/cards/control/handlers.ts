/*
 * 零跑·车辆控制卡 —— 事件处理(click / change / input / 标题双击)
 *
 * 从 src/cards/control.ts 原样搬出的方法: 只把接收者 this 换成第一个参数 ctx,
 * 调同类搬出的函数时改为直接调用并补传 ctx; 字符串/类名/data-* 属性/文案一律未改。
 */
import { fmtNum } from "../../lib/format";
import { writePalette } from "../../lib/palette";
import { cancelPreview, commitPreview, previewStyle } from "../../lib/appearance";
import { isStyleId } from "../../lib/ui/presets";
import { PRESET_MEMO_MS } from "./types";
import { CAR3D_BACKGROUNDS } from "./types";
import { onPalEye, onPalHue } from "./picker";
import type { ControlCtx } from "./types";

// ── 交互 ──
/** 双击标题改名(事件委托: .vname 是每次渲染新建的节点)。 */
export function onTitleDblClick(ctx: ControlCtx, ev: Event) {
  const t = ev.target as HTMLElement | null;
  const el = t && t.closest ? t.closest(".vname") : null;
  if (el) ctx._startTitleEdit();
}

export function onClick(ctx: ControlCtx, ev: Event) {
  const t = ev.target as HTMLElement | null;
  const el = t && t.closest ? (t.closest("[data-act]") as HTMLElement | null) : null;
  if (!el || (el as any).disabled) return;
  const act = el.dataset.act;
  if(act==='wrapopen')return ctx._showWrap(true);
  if(act==='paintconfirm'||act==='paintcancel')return ctx._finishPaint(act==='paintconfirm');
  if (act === "lock" || act === "lockround") return ctx._onLock();
  if (act === "trunk") return ctx._onTrunk(el.dataset.entity!, el.dataset.on === "1");
  if (act === "tires") {
    ctx._open.tires = !ctx._open.tires;
    ctx._render();
    return;
  }
  // 车模左侧的充电块: 在「⚡ 功率」胶囊与"竖排面板"之间切换
  if (act === "chgtoggle") {
    ctx._chgOpen = !ctx._chgOpen;
    ctx._render();
    return;
  }
  // 车模右上角的告警: 在"红色「!」"与"逐条展开"之间切换
  if (act === "warntoggle") {
    ctx._warnOpen = !ctx._warnOpen;
    ctx._render();
    return;
  }
  // 车模容器: 预留将来的"车模视图", 现在按了没反应
  if (act === "vehicle") return;
  // 弹窗开关(座椅与加热 / 充电设置 / 设置) —— 三个互斥, 都靠 _open.* 记录(不持久化)。
  // 打开任何一个之前先把取色器收掉: 它只活在「设置」弹窗的正文里, 换了弹窗就没锚点了。
  if (act === "seatmenu" || act === "chargemenu" || act === "car3dmenu") {
    const key = act === "seatmenu" ? "seats" : act === "chargemenu" ? "charge" : "car3d";
    const on = !ctx._open[key];
    if (on && ctx._palOpen) ctx._showPal("");
    ctx._open[key] = on;
    if (on) {
      ctx._open.seats = key === "seats";
      ctx._open.charge = key === "charge";
      ctx._open.car3d = key === "car3d";
    }
    ctx._render();
    return;
  }
  if (act === "smclose") {
    ctx._open.seats = false;
    ctx._open.charge = false;
    ctx._open.car3d = false;
    if (ctx._palOpen) ctx._showPal(""); // 取色器跟着弹窗一起关(它挂在弹窗正文里)
    ctx._render();
    return;
  }
  if (act === "fold") {
    const sec = el.dataset.sec!;
    if (!sec) return;
    if (ctx._collapsed[sec]) delete ctx._collapsed[sec];
    else ctx._collapsed[sec] = true;
    ctx._saveFold();
    ctx._render();
    return;
  }
  if (act === "window") {
    ctx._showWin(!ctx._open.window);
    return;
  }
  if (act === "presetmenu") {
    ctx._showPreset(!ctx._open.preset);
    return;
  }
  if (act === "preset") {
    const id = ctx._entId("ac");
    const val = el.dataset.val || "";
    ctx._showPreset(false); // 选完即收气泡
    if (id && val) {
      // 记下"用户最近点过的那颗预设": 车端对极速降温/升温/除味不回报状态, 温度区靠它显示
      // LO/HI/模式名(判定优先级见 templates.ts 的 climatePanel; 失效条件: 30 分钟超窗 /
      // 实体报出别的预设 / 手动调温或切模式 —— 后两处的清理见 _onTemp 与下面 hvac 分支)。
      ctx._lastPreset = { val, until: Date.now() + PRESET_MEMO_MS };
      ctx._render(); // 立刻把 LO/HI/模式名画上(不等服务调用的 busy 那次重绘)
      ctx._call("climate", "set_preset_mode",
        { entity_id: id, preset_mode: val }, "preset");
    }
    return;
  }
  if (act === "winstep") {
    const id = el.dataset.entity;
    ctx._showWin(false); // 选完一档自动收起气泡
    if (id) ctx._call("button", "press", { entity_id: id }, "btn:" + id);
    return;
  }
  if (act === "photo") {
    ctx._open.photo = true;
    ctx._render();
    return;
  }
  if (act === "closep") {
    ctx._open.photo = false;
    ctx._render();
    return;
  }
  if (act === "press") {
    const id = el.dataset.entity;
    // 电池预热(分段控件): 记一下本机点的是哪一段(车端不回报预热状态, 只为"选中段淡主题色"有个落点)
    if (el.dataset.seg) ctx._preheatSel = el.dataset.seg;
    if (id) ctx._call("button", "press", { entity_id: id }, "btn:" + id);
    return;
  }
  if (act === "toggle") {
    const id = el.dataset.entity;
    if (!id) return;
    const on = el.dataset.on === "1";
    ctx._call("switch", on ? "turn_off" : "turn_on", { entity_id: id }, "sw:" + id);
    return;
  }
  if (act === "hvac") {
    const id = ctx._entId("ac");
    if (id) {
      if (el.dataset.val && el.dataset.val !== "off") ctx._lastHvac = el.dataset.val;
      // 切模式 = 退出预设(与 _onTemp 同一口径); 切到 off 还要撤掉待发温度
      // (抖动窗口到点的 set_temperature 会把刚关掉的空调又打开)
      ctx._lastPreset = null;
      if (el.dataset.val === "off") ctx._dropTempPending();
      ctx._call("climate", "set_hvac_mode", { entity_id: id, hvac_mode: el.dataset.val }, "hvac");
    }
    return;
  }
  if (act === "acpower") return ctx._onAcPower();
  if (act === "temp") return ctx._onTemp(Number(el.dataset.delta) || 1);
  if (act === "seat" || act === "seatcycle") {
    return ctx._onSeat(el.dataset.key!, act === "seatcycle" ? 0 : Number(el.dataset.delta) || 0);
  }
  if (act === "pickdev") {
    ctx._picked = el.dataset.val!;
    ctx._resolveIndex();
    ctx._scheduleRender();
    return;
  }
  // ── 车模设置(3D 车模): 颜色 / 背景 / 自定义外观图 / 下载素材 ──
  if (act === "car3drefresh") return ctx._onCar3dRefresh();
  if (act === "car3ddl") return ctx._onCar3dDownload();
  if (act === "car3dcolor") {
    // 保存色号，渲染时查色表并通过 paint 消息实时更新车漆。
    const tsp = el.dataset.val || "";
    if (!tsp) return;
    ctx._car3dPrefs.tsp = tsp;
    delete ctx._car3dPrefs.hex;
    ctx._saveCar3dPrefs();
    ctx._showPal(""); // 选色表色即收起取色器
    return;
  }
  if (act === "car3dauto") {
    delete ctx._car3dPrefs.tsp;
    delete ctx._car3dPrefs.hex;
    ctx._saveCar3dPrefs();
    ctx._showPal(""); // 收起取色器
    return;
  }
  if (act === "car3dbg") {
    const v = el.dataset.val || "auto";
    ctx._car3dPrefs.bg = CAR3D_BACKGROUNDS.some(([key]) => key === v) ? v : "auto";
    ctx._saveCar3dPrefs();
    ctx._render();
    return;
  }
  if (act === "locationmode") {
    ctx._car3dPrefs.location = el.dataset.val === "photo" ? "photo" : "map";
    ctx._saveCar3dPrefs();
    ctx._render();
    return;
  }
  if (act === "car3dimgset") {
    const input = ctx.shadowRoot!.querySelector('input[data-act="car3dimg"]') as HTMLInputElement | null;
    const url = String((input ? input.value : ctx._car3dImgDraft) || "").trim();
    if (!url) return;
    ctx._car3dPrefs.img = url;
    ctx._car3dImgDraft = null;
    ctx._saveCar3dPrefs();
    // 换图后重新走一遍"先探针、确认能加载才上屏"(旧结果作废; 失败退避也一并清掉)
    ctx._carImgSrc = "";
    ctx._carImgOk = "";
    ctx._carImgRetryAt = 0;
    ctx._render();
    return;
  }
  if (act === "car3dimgclr") {
    ctx._car3dPrefs.img = ""; // "" = 明确清掉(集成选项里的默认图也不再顶上来)
    ctx._car3dImgDraft = null;
    ctx._saveCar3dPrefs();
    ctx._carImgSrc = "";
    ctx._carImgOk = "";
    ctx._carImgRetryAt = 0;
    ctx._render();
    return;
  }
  // ── 卡片配色(设置子卡最上面那行; 值存本机, 六张卡统一) ──
  // 点色块圆或「跟随主题」(data-val="")立即生效: 写 localStorage + 广播
  // (广播由 writePalette 派发, 六张卡的订阅会立刻重涂变量), 再重绘本卡把选中态画准。
  // 选完就收起取色器(色块圆是"直接挑预设", 取色器只走彩虹圆那条路)。
  if (act === "pal") {
    const val = String(el.dataset.val || "").trim().toLowerCase();
    if (val && !/^#[0-9a-f]{6}$/.test(val)) return; // 只认 #rrggbb; "" = 回到跟随主题
    writePalette({ accent: val });
    ctx._palHexDraft = null;
    ctx._showPal("");
    return;
  }
  // 彩虹圆 → 打开取色器面板(再点一次 / 点外面关闭; 开关都在 _showPal 里)
  if (act === "palopen") {
    const key = el.dataset.key === "hex" ? "hex" : "accent";
    ctx._showPal(ctx._palOpen === key ? "" : key);
    return;
  }
  if (act === "paleye") return onPalEye(ctx);

  // ── 界面风格(设置子卡) ──
  // 点预设 = **只在本页预览**(不写存储、不广播到别的标签页); 「应用」才持久化。
  // 广播由 appearance 层派发, 同页六张卡会立刻重涂 —— 切风格绝不触发任何车辆指令。
  if (act === "style") {
    const v = String(el.dataset.val || "");
    if (isStyleId(v)) previewStyle(v);
    return;
  }
  if (act === "styleapply") {
    commitPreview();
    return;
  }
  if (act === "stylecancel") {
    cancelPreview();
    return;
  }
}

export function onChange(ctx: ControlCtx, ev: Event) {
  const el = ev.target as HTMLInputElement | null;
  if (!el || !el.dataset) return;
  const act = el.dataset.act;
  if (act === "charge_limit") {
    const id = el.dataset.entity;
    if (!id) return;
    const v = Number(el.value);
    const cur = ctx._num("charge_limit");
    if (Number.isFinite(v) && (cur == null || Math.abs(cur - v) > 0.001)) {
      // 记下本地期望值, 给紧接着的重绘用(窗口 90s; 实体报出同值即释放)
      const pending = { id, value: v, until: Date.now() + 90000 };
      ctx._clPending = pending;
      if (ctx._clPendingTimer) clearTimeout(ctx._clPendingTimer);
      ctx._clPendingTimer = setTimeout(() => {
        ctx._clPendingTimer = null;
        if (ctx._clPending === pending) {
          ctx._clPending = null;
          ctx._scheduleRender();
        }
      }, 90000);
      ctx._clPreview = null; // 预览值交给 _clPending 接管(同一个数, 模板优先读 pending)
      void ctx._call("number", "set_value", { entity_id: id, value: v }, "cl:" + id).then((ok) => {
        if (!ok && ctx._clPending === pending) {
          ctx._clPending = null;
          if (ctx._clPendingTimer) clearTimeout(ctx._clPendingTimer);
          ctx._clPendingTimer = null;
          ctx._scheduleRender();
        }
      });
    }
    return;
  }
  if (act === "time") {
    const id = el.dataset.entity;
    if (!id) return;
    const v = String(el.value || "");
    if (!/^[0-9]{2}:[0-9]{2}$/.test(v)) return;
    // HA 的 time.set_value 要 "HH:MM:SS"
    ctx._call("time", "set_value", { entity_id: id, time: v + ":00" }, "time:" + id);
  }
}

export function onInput(ctx: ControlCtx, ev: Event) {
  const el = ev.target as HTMLInputElement | null;
  if (!el || !el.dataset) return;
  // 面板全走 Lit 之后: "重绘"不再是整块换 innerHTML, 输入节点会被复用, 所以不用再打
  // "这个面板刚被用户动过"的脏标记(命令失败时控件回弹实体值由 live() 绑定负责, 见 templates.ts)。
  // 车模设置里的 URL 输入框: 只记草稿 —— 用户打到一半的 URL 要留住; 点「应用」时才真的生效。
  if (el.dataset.act === "car3dimg") {
    ctx._car3dImgDraft = el.value;
    return;
  }
  // 取色器: hex 输入框同样只记草稿(回车/失焦才生效, 见 picker.ts 的 applyHexText);
  // 色相滑条走原生 range 的 input 事件(拖动与方向键都会来)。
  if (el.dataset.act === "palhexinput") {
    ctx._palHexDraft = el.value;
    return;
  }
  if (el.dataset.act === "palhue") {
    onPalHue(ctx, el);
    return;
  }
  if (el.dataset.act !== "charge_limit") return;
  // ⚠️ 不要直接改 .cV 的 textContent: 那个 span 现在由 Lit 渲染, 直接写会把 Lit 的锚点/文本节点
  //    抹掉 —— 下一次渲染就抛 "Cannot set properties of null (setting 'data')", 界面表现为
  //    "点了没反应"(实测: 拖滑条的 change 那一步必崩)。改为记下拖动中的预览值 + 排一次渲染,
  //    文字仍由模板输出(rAF 合并, 拖动不会卡)。
  const v = Number(el.value);
  if (Number.isFinite(v)) {
    ctx._clPreview = v;
    ctx._scheduleRender();
  }
}
