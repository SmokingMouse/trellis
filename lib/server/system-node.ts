import "server-only";
import { createRootInSession, finalizeNode, getNode } from "./repo";
import { getDB } from "./sqlite";

// 会话里「不是模型回复」的系统消息（docs/roles-p2.md 共享约定）：建一个已完成的根节点，
// question = 给人看的标题，answer = 正文，nodes.meta_json 带 meta.kind，前端据此换成卡片渲染。
// 作为新根挂进会话 —— 不参与任何 claude resume（下一轮仍接在上一个真实节点后面）。
//
// 这是包 B（群聊）的最小实现，签名与包 A 约定的完全一致；合并时以 A 的实现为准。

export type SystemNodeKind = "role-nightly" | "role-follow" | "group-round-end";

export function appendSystemNode(opts: {
  sessionId: string;
  title: string;
  body: string;
  kind: SystemNodeKind;
  meta?: Record<string, unknown>;
}): { nodeId: string } {
  const nodeId = crypto.randomUUID();
  const now = Date.now();
  createRootInSession({ sessionId: opts.sessionId, nodeId, question: opts.title, now });
  getDB()
    .prepare("UPDATE nodes SET response = ?, meta_json = ? WHERE id = ?")
    .run(opts.body, JSON.stringify({ ...(opts.meta ?? {}), kind: opts.kind }), nodeId);
  finalizeNode({
    nodeId,
    status: "done",
    tokenInput: 0,
    tokenOutput: 0,
    tokenCacheRead: 0,
    tokenCacheCreation: 0,
    now,
  });
  if (!getNode(nodeId)) throw new Error("system node vanished");
  return { nodeId };
}
