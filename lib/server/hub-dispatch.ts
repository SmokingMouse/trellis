import "server-only";
import fs from "node:fs";
import { getDB } from "./sqlite";
import { getNode, getSession, renameSession } from "./repo";
import { larkFinalAnswer } from "./lark/final-answer";
import * as chatRoute from "@/app/api/chat/route";
import {
  MAX_DISPATCH_RESPONSE,
  type DispatchInput,
  type DispatchState,
} from "@/lib/hub-dispatch";

// 跨机派活的目标侧（B 机器）：hub 中继转来 POST /api/hub/dispatch-in，这里新建会话
// 并开跑一轮；GET /api/hub/dispatch-in/<sid>/<nid> 取该轮状态与回答。
//
// 建会话 + 起 run 不另写一套：进程内调 POST /api/chat（与 trellisctl ask --new 发的
// 是同一个请求体），读到首个 SSE 事件 created 拿 id 就断开订阅 —— run 与 HTTP 早就
// 解耦（run-bus），断开不杀 run。provider / agent / platform env / 自动命名全部照旧。
//
// hub_dispatches 记「这个会话是谁派来的」：标题前缀给人看，这张表给取结果做校验 ——
// 来源机器只能取自己派来的那一轮，不能借这个口子读 B 上任意会话（那要走 shareOut）。
// 表随用随建（与网关 node_policies 同法），不动 sqlite.ts 的主迁移。

function ensureTable(): void {
  getDB().exec(`
    CREATE TABLE IF NOT EXISTS hub_dispatches (
      session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
      node_id TEXT NOT NULL,
      from_machine TEXT NOT NULL,
      prompt_chars INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
}

export function dispatchTitlePrefix(from: string): string {
  return `[由 ${from} 派来] `;
}

export type DispatchInResult =
  | { ok: true; sessionId: string; nodeId: string }
  | { ok: false; status: number; error: string };

/** 读 /api/chat 的 SSE 直到 created 事件。 */
async function readCreated(res: Response): Promise<{ sessionId: string; nodeId: string } | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let buf = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return null;
      buf += decoder.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const chunk = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const line = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!line) continue;
        try {
          const ev = JSON.parse(line.slice(5).trim()) as {
            type?: string;
            session?: { id?: string };
            node?: { id?: string; sessionId?: string };
          };
          if (ev.type !== "created") continue;
          const sessionId = ev.session?.id ?? ev.node?.sessionId ?? "";
          const nodeId = ev.node?.id ?? "";
          return sessionId && nodeId ? { sessionId, nodeId } : null;
        } catch {
          /* 半截 / 非 JSON 事件，跳过 */
        }
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

export async function startDispatchedRun(from: string, input: DispatchInput): Promise<DispatchInResult> {
  if (input.workspace && !fs.existsSync(input.workspace)) {
    return { ok: false, status: 400, error: `目标机器上没有这个目录：${input.workspace}` };
  }
  const payload: Record<string, unknown> = {
    kind: "root",
    question: input.prompt,
    // 有目录 = project 会话（在那个仓库里干活）；没有 = 增强对话（scratch 目录 + 全工具），
    // 与无人值守的任务同一档：派来的活没人在场点审批卡。
    ...(input.workspace ? { mode: "project", workspacePath: input.workspace } : { mode: "chat", chatEnhanced: true }),
    ...(input.provider ? { provider: input.provider } : {}),
  };
  const ac = new AbortController();
  const res = await chatRoute.POST(
    new Request("http://internal/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      signal: ac.signal,
    }),
  );
  if (!(res.headers.get("content-type") || "").includes("text/event-stream")) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    return { ok: false, status: res.status >= 400 ? res.status : 500, error: j?.error ?? `建会话失败（HTTP ${res.status}）` };
  }
  const created = await readCreated(res);
  // 只断开订阅，run 继续（见文件头）。
  ac.abort();
  if (!created) return { ok: false, status: 500, error: "建会话后没拿到会话 id" };

  ensureTable();
  getDB()
    .prepare(
      "INSERT OR REPLACE INTO hub_dispatches (session_id,node_id,from_machine,prompt_chars,created_at) VALUES (?,?,?,?,?)",
    )
    .run(created.sessionId, created.nodeId, from, input.prompt.length, Date.now());
  // 标题前缀 = 界面上一眼看出来源。renameSession 会锁住标题（title_source='user'），
  // 自动命名不会把前缀冲掉；代价是这类会话标题停在 prompt 开头，可接受。
  const title = getSession(created.sessionId)?.title ?? "";
  renameSession(created.sessionId, `${dispatchTitlePrefix(from)}${title}`, Date.now());
  console.log(
    `[trellis/hub] dispatch-in from=${from} session=${created.sessionId} node=${created.nodeId} prompt=${input.prompt.length}字`,
  );
  return { ok: true, ...created };
}

export type DispatchInStatus = {
  status: DispatchState;
  response: string;
  truncated: boolean;
  errorMessage: string | null;
  pendingTool: string | null;
};

/** 来源机器取它派来的那一轮。不是它派来的（或不存在）→ null，调用方一律 404。 */
export function dispatchedTurnStatus(from: string, sessionId: string, nodeId: string): DispatchInStatus | null {
  ensureTable();
  const row = getDB()
    .prepare("SELECT 1 FROM hub_dispatches WHERE session_id=? AND node_id=? AND from_machine=?")
    .get(sessionId, nodeId, from);
  if (!row) return null;
  const node = getNode(nodeId);
  if (!node || node.sessionId !== sessionId) return null;
  const status: DispatchState =
    node.status === "done" ? "done" : node.status === "error" ? "error" : node.pendingInteraction ? "waiting" : "running";
  const full = status === "done" ? larkFinalAnswer(node) : node.response;
  const truncated = full.length > MAX_DISPATCH_RESPONSE;
  return {
    status,
    response: truncated ? full.slice(0, MAX_DISPATCH_RESPONSE) : full,
    truncated,
    errorMessage: node.errorMessage,
    pendingTool: node.pendingInteraction?.toolName ?? null,
  };
}
