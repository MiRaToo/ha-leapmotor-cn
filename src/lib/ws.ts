// WebSocket 调用封装与错误分类 —— 五张卡原本各写一套 WS 错误判定, 这里合并。
//
// 语义逐字保留各卡原实现("命令没注册"= 旧版集成 → 静默留空, 不当错误吓用户)。

import type { HomeAssistant } from "../types/hass";

export interface WsLikeError {
  code: string;
  message: string;
}

/** 把 callWS 失败归一化成 {code, message}(两者都保证是字符串)。 */
export function wsErr(err: unknown): WsLikeError {
  const e = (err || {}) as { code?: string; message?: string };
  return { code: String(e.code || ""), message: String(e.message || err || "") };
}

/** "命令没注册" —— 旧版集成, 卡片应静默退化而不是报错。 */
export function isUnknownCommand(err: unknown): boolean {
  const { code, message } = wsErr(err);
  return (
    code === "unknown_command" ||
    code === "no_callws" ||
    /unknown command/i.test(message)
  );
}

/**
 * 通用的错误文案(行程/里程/上周能耗共用)。
 * 返回 "" 表示"不该提示"(命令未注册)。
 */
export function wsErrText(err: unknown): string {
  const { code, message } = wsErr(err);
  if (isUnknownCommand(err)) return "";
  if (code === "not_found") return "集成还没就绪(等车机上报数据后点刷新)";
  if (code === "unauthorized" || /admin|管理员/i.test(message)) return "需要管理员权限";
  return "读取失败: " + (message || "未知错误").slice(0, 80);
}

/** callWS 包装: 没有 callWS(非 HA 环境)时抛一个带 code 的错误, 与原先一致。 */
export async function callWs<T = any>(
  hass: HomeAssistant | null | undefined,
  msg: Record<string, any>
): Promise<T> {
  if (!hass || !hass.callWS) {
    throw Object.assign(new Error("no callWS"), { code: "no_callws" });
  }
  return hass.callWS<T>(msg);
}
