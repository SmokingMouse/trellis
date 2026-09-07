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
  return { id: item.id, name, input, output, stderr: null, status: item.completedAtMs == null ? "running" : failed ? "error" : "done",
    startedAt: item.startedAtMs, endedAt: item.completedAtMs ?? null,
    durationMs: item.completedAtMs == null ? null : Math.max(0, item.completedAtMs - item.startedAtMs) };
}
export function projectResponse(items: Item[]) {
  const messages = items.filter((i): i is Extract<Item, {type:"agentMessage"}> => i.type === "agentMessage").sort((a,b) => a.seq-b.seq);
  const response = messages.map(i => i.payload.text).join("\n\n");
  return { response, finalStart: messages.length > 1 ? response.length - messages.at(-1)!.payload.text.length : 0 };
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
