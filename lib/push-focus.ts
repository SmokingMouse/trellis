// 点通知直达单张卡：通知 url 里的定位参数（构造见 lib/push.ts sessionUrl / herdrPaneUrl）。
// 纯函数，页面（hooks/usePushBridge）与 bun test 共用。

import { PUSH_FOCUS_PARAMS } from "./push";

export type PushFocus = {
  sessionId: string | null;
  nodeId: string | null;
  /** 自起会话：滚到这个节点的待处理卡（?focus=pending）。 */
  pendingNode: string | null;
  /** Herdr：滚到这个窗格的交互卡（?pane=）。 */
  paneId: string | null;
  /** 没绑会话的 Herdr 窗格：先打开总览（?view=herdr）。 */
  herdrView: boolean;
};

/** 没有定位参数（普通深链）→ null。经 hub 的 /__gw/go/<机器>/... 在网关 302 后才落到这里，
 *  查询串原样，所以只看 search。 */
export function parsePushFocus(search: string): PushFocus | null {
  const q = new URLSearchParams(search);
  const sessionId = q.get("session");
  const nodeId = q.get("node");
  const pendingNode = q.get(PUSH_FOCUS_PARAMS.focus) === "pending" && nodeId ? nodeId : null;
  const paneId = q.get(PUSH_FOCUS_PARAMS.pane) || null;
  if (!pendingNode && !paneId) return null;
  return { sessionId, nodeId, pendingNode, paneId, herdrView: !sessionId && q.get("view") === "herdr" };
}

/** 定位做完就把参数抹掉：刷新不该再被拽一次，URL 同步（app/page.tsx）也不认识它们。 */
export function stripPushFocus(href: string): string {
  const url = new URL(href);
  url.searchParams.delete(PUSH_FOCUS_PARAMS.focus);
  url.searchParams.delete(PUSH_FOCUS_PARAMS.pane);
  return `${url.pathname}${url.search}${url.hash}`;
}

/** 页面里能落定位的 Herdr 卡：总览「需要你」泳道的卡、会话页底部的交互卡。 */
export function herdrCardSelector(paneId: string): string {
  const id = paneId.replace(/["\\]/g, "\\$&");
  return `[data-herdr-need-card="${id}"], [data-herdr-session-card="${id}"]`;
}
