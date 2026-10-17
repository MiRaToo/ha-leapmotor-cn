/*
 * 浮层协调 —— 焦点、Esc、关闭顺序的**唯一**入口。
 *
 * 为什么需要页面级协调: 六张卡各自打包成独立 JS, 同一个页面上会有五份本模块的副本。
 * 模块内的局部变量因此**不是**单例(方案 §4.3 明确点出这一点), 所以栈与监听器都挂
 * 在 window 上, 用同一把键共享, 保证:
 *   * Esc 只关**最上层**的那一个浮层, 不会一次关掉两层;
 *   * window 级 keydown 监听只装一次(五个 bundle 各装一次会重复触发)。
 *
 * 本模块只提供"外壳与行为契约", 不接管各卡已有的弹窗实现(那些继续自己开关, 只是
 * 需要 Esc 抢先时调 pushOverlay)。
 */

interface OverlayEntry {
  close: () => void;
  seq: number;
}

interface OverlayPage {
  stack: OverlayEntry[];
  seq: number;
  escapeInstalled: boolean;
}

const PAGE_KEY = "__leapmotorOverlayV1";

function page(): OverlayPage {
  const w = window as unknown as Record<string, unknown>;
  let p = w[PAGE_KEY] as OverlayPage | undefined;
  if (!p) {
    p = { stack: [], seq: 0, escapeInstalled: false };
    try {
      w[PAGE_KEY] = p;
    } catch (err) {
      /* 环境不让挂 window 属性就算了: 退化成"只在本次调用内有效" */
    }
    installEscape(p);
  } else {
    installEscape(p);
  }
  return p;
}

/** window 级 Esc 派发(只装一次, 只关最上层)。 */
function installEscape(p: OverlayPage): void {
  if (p.escapeInstalled) return;
  p.escapeInstalled = true;
  try {
    window.addEventListener(
      "keydown",
      (ev: KeyboardEvent) => {
        if (ev.key !== "Escape" && ev.key !== "Esc") return;
        const top = p.stack[p.stack.length - 1];
        if (!top) return;
        ev.stopPropagation();
        top.close();
      },
      true
    );
  } catch (err) {
    p.escapeInstalled = false;
  }
}

/**
 * 把一个浮层压栈; 返回"出栈"函数(必须在关闭时调用, 否则 Esc 会一直关它)。
 * `close` 只在它是栈顶时被 Esc 调用。
 */
export function pushOverlay(close: () => void): () => void {
  const p = page();
  const entry: OverlayEntry = { close, seq: ++p.seq };
  p.stack.push(entry);
  return () => {
    const i = p.stack.indexOf(entry);
    if (i >= 0) p.stack.splice(i, 1);
  };
}

/** 当前是否有浮层(供"点外部收起"之类的判断用)。 */
export function hasOverlay(): boolean {
  return page().stack.length > 0;
}

/** 焦点循环: 把 Tab/Shift+Tab 限制在容器内的可聚焦元素之间。 */
export function trapTab(container: HTMLElement, ev: KeyboardEvent): void {
  if (ev.key !== "Tab") return;
  const nodes = Array.from(
    container.querySelectorAll<HTMLElement>("button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex='-1'])")
  ).filter((n) => n.offsetParent !== null || n === container);
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const root = (container.getRootNode ? container.getRootNode() : document) as Document | ShadowRoot;
  const active = root.activeElement as HTMLElement | null;
  if (ev.shiftKey && active === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && active === last) {
    ev.preventDefault();
    first.focus();
  }
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  okText?: string;
  cancelText?: string;
  /** 危险动作(解锁/开后备箱): 确认按钮用告警色。 */
  danger?: boolean;
  /** 确认期间要禁用按钮(例如等待车端回执)时由调用方置位。 */
  root: ShadowRoot | HTMLElement;
}

/**
 * 共享确认框(替代 `window.confirm`)。
 *
 * 与 `window.confirm` 的语义等价: 确定 → resolve(true); 取消 / Esc / 点遮罩 →
 * resolve(false)。**只调用一次**(连点确定不会重复 resolve), 不会触发任何车辆指令 ——
 * 指令由调用方在拿到 true 之后自己发。
 *
 * ⚠️ 节点挂在传入的 root(卡片 shadow root)直下, **不要**放进 .card: 玻璃风格给
 *    .card 加了 backdrop-filter, 会让 position: fixed 的后代相对卡片定位。
 */
export function openConfirm(opts: ConfirmOptions): Promise<boolean> {
  const root = opts.root;
  return new Promise<boolean>((resolve) => {
    const doc = (root instanceof Document ? root : root.ownerDocument) || document;
    const mask = doc.createElement("div");
    mask.className = "lm-confirm-mask";
    const box = doc.createElement("div");
    box.className = "lm-confirm";
    box.setAttribute("role", "alertdialog");
    box.setAttribute("aria-modal", "true");
    box.setAttribute("tabindex", "-1");

    const body = doc.createElement("div");
    body.className = "lm-confirm-body";
    const title = doc.createElement("p");
    title.className = "lm-confirm-title";
    title.textContent = opts.title;
    body.appendChild(title);
    if (opts.message) {
      const msg = doc.createElement("p");
      msg.className = "lm-confirm-msg";
      msg.textContent = opts.message;
      body.appendChild(msg);
    }

    const actions = doc.createElement("div");
    actions.className = "lm-confirm-actions";
    const cancel = doc.createElement("button");
    cancel.type = "button";
    cancel.className = "lm-confirm-cancel";
    cancel.textContent = opts.cancelText || "取消";
    const ok = doc.createElement("button");
    ok.type = "button";
    ok.className = "lm-confirm-ok" + (opts.danger ? " lm-danger" : "");
    ok.textContent = opts.okText || "确定";
    actions.appendChild(cancel);
    actions.appendChild(ok);

    box.appendChild(body);
    box.appendChild(actions);
    root.appendChild(mask);
    root.appendChild(box);

    const prevFocus = (doc.activeElement as HTMLElement | null) || null;
    let done = false;
    const release = pushOverlay(() => finish(false));

    function finish(v: boolean): void {
      if (done) return;
      done = true;
      release();
      try {
        mask.remove();
        box.remove();
      } catch (err) {
        /* 宿主已经被摘掉就算了 */
      }
      if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === "function") {
        try {
          prevFocus.focus();
        } catch (err) {
          /* 焦点回不去不算错 */
        }
      }
      resolve(v);
    }

    cancel.addEventListener("click", () => finish(false));
    ok.addEventListener("click", () => finish(true));
    mask.addEventListener("click", () => finish(false));
    box.addEventListener("keydown", (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        ev.stopPropagation();
        finish(false);
        return;
      }
      trapTab(box, ev);
    });

    try {
      ok.focus();
    } catch (err) {
      /* 拿不到焦点也还能点 */
    }
  });
}
