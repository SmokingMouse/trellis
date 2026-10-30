import "server-only";
import { getDB } from "./sqlite";
import { dbWrite } from "./db-error";
import type { SystemNodeKind } from "@/lib/role-changes";

// 会话里「不是模型回复」的系统消息（夜间整理卡、跟进报告、群聊轮次结束）。
// 共享约定见 docs/roles-p2.md：一个已完成的节点，question = 给人看的标题，response =
// 正文（markdown），meta 存在 nodes.system_meta_json（{ kind, ...meta }）。
//
// 节点作为**新根**挂进会话，且**不参与 claude resume**：
//   · 不写 claude_session_id / codex_session_id —— 没有 CLI 会话可接；
//   · 前端认出 systemMeta 就不把它当输入框的接续目标（tipNode 跳过它），下一轮用户
//     消息仍接在上一个真实节点后面，resume 的仍是那个节点所在的 CLI 会话；
//   · chat 路由拒绝以它为 parent 的 branch（isSystemNode），兜住绕过前端的请求。
// 不进全文搜索（不是对话内容），不触发 session_done（不经过 run-bus）。

export function appendSystemNode(opts: {
  sessionId: string;
  title: string;
  body: string;
  kind: SystemNodeKind;
  meta?: Record<string, unknown>;
}): { nodeId: string } {
  const db = getDB();
  const nodeId = crypto.randomUUID();
  const now = Date.now();
  // kind 放最后：meta 里误带的 kind 不能把类型改掉。
  const metaJson = JSON.stringify({ ...(opts.meta ?? {}), kind: opts.kind });
  if (!db.prepare("SELECT id FROM sessions WHERE id = ?").get(opts.sessionId)) {
    throw new Error(`session ${opts.sessionId} not found`);
  }
  dbWrite("appendSystemNode", db.transaction(() => {
    db.prepare(
      `INSERT INTO nodes (id, session_id, parent_id, parent_anchor_text, question, response,
                          status, sibling_index, created_at, system_meta_json)
       VALUES (?, ?, NULL, NULL, ?, ?, 'done', 0, ?, ?)`,
    ).run(nodeId, opts.sessionId, opts.title, opts.body, now, metaJson);
    db.prepare(
      "UPDATE sessions SET updated_at = ?, root_node_id = CASE WHEN root_node_id = '' THEN ? ELSE root_node_id END WHERE id = ?",
    ).run(now, nodeId, opts.sessionId);
  }));
  return { nodeId };
}

/** 节点是不是系统节点（chat 路由拒绝在它下面接着问）。 */
export function isSystemNode(nodeId: string): boolean {
  const r = getDB().query("SELECT system_meta_json FROM nodes WHERE id = ?").get(nodeId) as
    | { system_meta_json: string | null }
    | null;
  return !!r?.system_meta_json;
}
