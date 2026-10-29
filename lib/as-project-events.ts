import type { Item, PendingServerRequest, Turn, StartThreadParams } from "@smokingmouse/agent-server/protocol";
import type { RunEvent } from "./server/run-bus";
import type { PendingInteraction, ToolCall } from "./types";
import { providerFamily } from "./llm/providers";

export function projectThreadOptions(session: { model: string | null; workspacePath: string | null; requireApproval: boolean },
  options: { permission?: StartThreadParams["permission"]; effort?: string } = {}): StartThreadParams {
  const model = session.model ?? "claude-opus";
  const family = providerFamily(model);
  return { backend: family === "codex" ? "codex" : "claude", cwd: session.workspacePath ?? undefined,
    model: model === "codex" || model === "mock" ? undefined : model.startsWith("codex:") ? model.slice(6) : model,
    permission: options.permission ?? (session.requireApproval ? "default" : "full"),
    ...(options.effort ? { effort: options.effort } : {}),
  };
}
const printable = (value: unknown): string | null => value == null ? null : typeof value === "string" ? value : JSON.stringify(value);
export function itemToolCall(item: Item): ToolCall | null {
  let name: string, input: unknown, output: string | null = null, failed = item.status === "failed" || item.status === "rejected";
  switch (item.type) {
    case "commandExecution": name = "Bash"; input = { command: item.payload.command, cwd: item.payload.cwd }; output = item.payload.aggregatedOutput ?? null; failed ||= !!item.payload.exitCode; break;
    case "fileChange": name = "Edit"; input = { changes: item.payload.changes }; output = printable(item.payload.changes); break;
    case "toolCall": name = item.payload.name; input = item.payload.input; output = printable(item.payload.output); failed ||= !!item.payload.isError; break;
    case "mcpToolCall": name = `mcp__${item.payload.server}__${item.payload.tool}`; input = item.payload.arguments; output = printable(item.payload.result ?? item.payload.error); failed ||= !!item.payload.error; break;
    case "webSearch": name = "WebSearch"; input = { query: item.payload.query }; output = printable(item.payload.results); break;
    default: return null;
  }
  // Fork snapshots terminate inherited live items without inventing completion timestamps.
  const running = item.status ? item.status === "inProgress" : item.completedAtMs == null;
  return { id: item.id, name, input, output, stderr: null, status: running ? "running" : failed ? "error" : "done",
    startedAt: item.startedAtMs, endedAt: item.completedAtMs ?? null,
    durationMs: item.completedAtMs == null ? null : Math.max(0, item.completedAtMs - item.startedAtMs) };
}
/** 插话（turn/steer 注入的用户消息）在正文里的呈现：引用块 + 标签。 */
export function steerBlock(text: string) {
  return text.trim().split("\n").map((line, i) => `> ${i === 0 ? "**插话**　" : ""}${line}`).join("\n");
}
const userText = (item: Extract<Item, {type:"userMessage"}>) =>
  item.payload.content.map(p => p.type === "text" ? p.text : "").filter(Boolean).join("\n");
export function projectResponse(items: Item[]) {
  // 一轮里第一条 userMessage 是本轮的提问本身（节点 question），其后的都是中途
  // 插话：按 seq 穿插进正文，否则用户在回复里看不到自己插了什么。
  const ordered = items.filter(i => i.type === "agentMessage" || i.type === "userMessage").sort((a,b) => a.seq-b.seq);
  const firstUser = ordered.find(i => i.type === "userMessage");
  const parts: { text: string; agent: boolean }[] = [];
  for (const i of ordered) {
    if (i.type === "agentMessage") parts.push({ text: i.payload.text, agent: true });
    else if (i !== firstUser && i.type === "userMessage") {
      const text = userText(i);
      if (text.trim()) parts.push({ text: steerBlock(text), agent: false });
    }
  }
  const response = parts.map(p => p.text).join("\n\n");
  // finalStart = 最后一段 agent 正文的起点；只有一段（或最后一段 agent 就是第一段）时整段即答复。
  const lastAgent = parts.map(p => p.agent).lastIndexOf(true);
  const finalStart = lastAgent > 0 ? parts.slice(0, lastAgent).reduce((n, p) => n + p.text.length + 2, 0) : 0;
  return { response, finalStart };
}
export function projectInteraction(request: PendingServerRequest): PendingInteraction {
  const { method, params } = request;
  switch (method) {
    case "item/commandExecution/requestApproval": return { toolUseId: params.requestId, toolName: "Bash", input: { command: params.command, cwd: params.cwd } };
    case "item/fileChange/requestApproval": return { toolUseId: params.requestId, toolName: "Edit", input: { changes: params.changes } };
    case "item/permissions/requestApproval": return { toolUseId: params.requestId, toolName: "Permission", input: { permissions: params.permissions, reason: params.reason } };
    case "item/tool/requestUserInput": return { toolUseId: params.requestId, toolName: "AskUserQuestion", input: {
      questions: params.questions.map(q => ({ ...q, question: q.question, header: q.header ?? q.id, options: q.options ?? [] })),
    } };
  }
}
export function turnRunEvent(turn: Turn, finalStart: number): RunEvent {
  if (turn.status !== "completed") return { type: "error", message: turn.error?.message ?? (turn.status === "interrupted" ? "aborted" : turn.status) };
  const u = turn.usage;
  return { type: "done", usage: { input: u?.inputTokens ?? 0, output: u?.outputTokens ?? 0, cacheRead: u?.cachedTokens ?? 0,
    cacheCreation: u?.cacheCreation ?? 0, contextTokens: u?.contextTokens }, finalStart, durationMs: turn.durationMs };
}
