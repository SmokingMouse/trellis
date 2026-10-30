import "server-only";
import { getDB } from "./sqlite";
import { dbWrite } from "./db-error";
import { createRootInSession } from "./repo";
import type { SystemNodeKind } from "@/lib/system-node-meta";

// 会话里插一条「不是模型回复」的系统消息（docs/roles-p2.md 共享约定）：建一个已完成的
// 新根节点，question = 给人看的标题，answer = 正文（markdown），nodes.meta_json 带
// { kind, ...meta }。前端靠 meta.kind 认出来换渲染，输入框续聊时跳过它（不参与 resume）。
//
// 包 C 的最小实现：签名照共享约定，合并时以包 A 的实现为准。

export function appendSystemNode(opts: {
  sessionId: string;
  title: string; // 节点 question
  body: string; // 节点 answer（markdown）
  kind: SystemNodeKind;
  meta?: Record<string, unknown>;
}): { nodeId: string } {
  const nodeId = crypto.randomUUID();
  const now = Date.now();
  createRootInSession({ sessionId: opts.sessionId, nodeId, question: opts.title, now });
  finishSystemNode(nodeId, opts.sessionId, opts.body, opts.kind, opts.meta);
  return { nodeId };
}

/** 把刚建的根节点收成系统节点：done + 正文 + meta + 正文进全文索引。
 * 也给「会话还不存在、连根一起建」的调用方用（先 createSessionWithRoot 再调这里）。 */
export function finishSystemNode(
  nodeId: string,
  sessionId: string,
  body: string,
  kind: SystemNodeKind,
  meta?: Record<string, unknown>,
): void {
  const db = getDB();
  const metaJson = JSON.stringify({ ...(meta ?? {}), kind });
  dbWrite("finishSystemNode", () =>
    db.transaction(() => {
      db.prepare(
        "UPDATE nodes SET status = 'done', response = ?, meta_json = ?, duration_ms = 0 WHERE id = ?",
      ).run(body, metaJson, nodeId);
      db.prepare("DELETE FROM search_index WHERE source_id = ? AND source_kind = 'node_response'").run(nodeId);
      if (body) {
        db.prepare(
          "INSERT INTO search_index (text, source_kind, source_id, session_id) VALUES (?, 'node_response', ?, ?)",
        ).run(body, nodeId, sessionId);
      }
    })(),
  );
}
