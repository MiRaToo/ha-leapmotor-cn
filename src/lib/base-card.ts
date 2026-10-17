// 卡片基类。
//
// ⚠️ 现状: **六张卡片都没有采用它**(各自 `extends LitElement` 并自建 hass 调度)。
//    保留是为了后续「命令式 DOM 收敛」的 C 档(逐面板迁到 Lit 模板时统一接线);
//    若那条路最终不走, 这个文件应直接删掉。见 docs/PRIVATE-REFACTOR-LIT-MIGRATION.md 的「后续阶段」。
//
// 设计取舍: **不把 hass/config 做成 Lit 响应式属性**。HA 是直接给元素赋 `.hass`
// (和 `setConfig()` 调用), 而且本项目现有卡片全部把 hass 存进 `this._hass`、
// 在 setter 里自己做节流调度。做强响应式会改变更新时机与竞态行为 —— 与"原样保留
// 现有功能"冲突。所以这里保持与原生实现相同的**契约**:
//   * `hass` 是普通属性(setter 覆写), `setConfig()` 由子类实现;
//   * 子类按各自原有的节流策略调用 `this.requestRender()`。
// LitElement 提供的是模板渲染与 shadow 样式(`static styles`), 不改变生命周期契约。
import { LitElement } from "lit";
import type { HomeAssistant, LovelaceCardConfig } from "../types/hass";

export abstract class LeapmotorBaseCard extends LitElement {
  protected _hass: HomeAssistant | null = null;
  protected _config: LovelaceCardConfig | null = null;

  // HA 直接给 .hass 赋值; 子类覆写此 setter 并调用 super / 自建调度。
  set hass(hass: HomeAssistant | null) {
    this._hass = hass;
    if (!this._built_flag) {
      this._built_flag = true;
      this.firstHass();
    } else {
      this.hassUpdated();
    }
  }
  get hass(): HomeAssistant | null {
    return this._hass;
  }

  private _built_flag = false;
  private _raf = 0;

  /** 第一次收到 hass 时调用(代替原卡片里的 `if (!this._built) {...}`)。 */
  protected abstract firstHass(): void;

  /** 后续 hass 更新时调用(默认合并到下一帧, 与原"避免每个状态变化都重画"一致)。 */
  protected hassUpdated(): void {
    this.requestRender();
  }

  /** 合并同一帧里的多次更新。 */
  protected requestRender(): void {
    if (this._raf) return;
    const run = () => {
      this._raf = 0;
      this.renderCard();
    };
    if (typeof requestAnimationFrame === "function") this._raf = requestAnimationFrame(run);
    else this._raf = setTimeout(run, 16) as unknown as number;
  }

  /** 子类的渲染入口(模板渲染或命令式更新都走这里)。 */
  protected abstract renderCard(): void;

  /** 卡片尺寸默认值: 子类按需覆写。 */
  getCardSize(): number {
    return 3;
  }

  // LitElement 生成的 shadow root 默认是 open; 与原实现一致。
  protected createRenderRoot(): HTMLElement | DocumentFragment {
    return this.attachShadow({ mode: "open" });
  }
}
