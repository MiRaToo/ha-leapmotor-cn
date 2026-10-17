// 自定义元素注册守卫 —— 与原实现**行为等价**, 六张卡共用一份。
//
// 背景(为什么需要这层, 逐字保留原注释的语义):
// HA 新版前端启动时会**整个替换** window.customElements(scoped registry polyfill):
// 若本模块在替换前求值, 元素就注册进了被丢弃的旧注册表 —— 前端查"当前"注册表查不到,
// 卡片会永久显示 "Custom element does not exist"(不报错、无日志; 冷加载 / 手机 App
// 上更易命中, 打开 DevTools 反而掩盖)。上游: home-assistant/frontend#52960、#53890。
// 修法: 记住加载时的注册表对象, 一旦它被换掉, 就把尚未生效的元素补注册到"当前"注册表;
// HA 的错误卡会在 whenDefined 解析后自动重建, 于是自愈。未换表时轮询自然结束。
//
// 关于"Lit 是否有更好的方式": 查过 Lit 3 的 @lit/reactive-element —— 它在模块求值时
// `global.customElements ??= customElements` 抓住当时的注册表, 之后**不会**自愈, 对
// 上述竞态同样无解; HA 上游 issue #52960 给的推荐做法也正是这套
// "define 后经 whenDefined('home-assistant') + 兜底定时器再补注册"。故沿用原做法。
import type { CustomCardInfo } from "../types/hass";

const _REG = customElements;
const _pend = new Map<string, CustomElementConstructor>();
let _pollN = 0;
const MAX_POLLS = 30;

function _heal(): void {
  if (customElements === _REG || _pend.size === 0) return; // 注册表没被换 → 无需处理
  for (const [name, ctor] of [..._pend]) {
    try {
      if (!customElements.get(name)) customElements.define(name, ctor);
      _pend.delete(name);
    } catch (e) {
      /* 交给下一轮重试 */
    }
  }
}

function _pollHeal(): void {
  if (_pend.size === 0 || _pollN >= MAX_POLLS) return;
  _pollN += 1;
  setTimeout(() => {
    _heal();
    _pollHeal();
  }, 1000);
}

/** 注册自定义元素(带 registry-swap 自愈)。幂等, 可重复调用。 */
export function defineCard(name: string, ctor: CustomElementConstructor): void {
  try {
    if (!_REG.get(name)) _REG.define(name, ctor);
  } catch (e) {
    console.warn(`leapmotor: 注册 ${name} 失败`, e);
    return;
  }
  _pend.set(name, ctor);
  try {
    _REG.whenDefined("home-assistant").then(_heal).catch(() => {});
  } catch (e) {
    /* ignore */
  }
  _pollHeal();
}

/** 注册到 window.customCards(卡片选择器), 同名只登记一次。 */
export function registerCustomCard(info: CustomCardInfo): void {
  window.customCards = window.customCards || [];
  if (!window.customCards.some((c) => c.type === info.type)) {
    window.customCards.push(info);
  }
}

/** 版本横幅(与原实现同一行格式与配色)。 */
export function banner(label: string, version: string, color = "#1e88e5"): void {
  console.info(`%c ${label} ${version} `, `color:#fff;background:${color};border-radius:3px`);
}
