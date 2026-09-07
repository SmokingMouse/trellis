import type { Item, PendingServerRequest } from "@smokingmouse/agent-server/protocol";
import type { ShadowEvent } from "./as-shadow";

export interface ThreadLog {
  items: Record<string, Item>;
  pending: PendingServerRequest[];
  cursor: number;
  state: string;
}
export const emptyThreadLog = (): ThreadLog => ({ items: {}, pending: [], cursor: 0, state: "connecting" });

/** Snapshots/completions replace payloads; only live deltas append. */
export function applyShadowEvent(log: ThreadLog, event: ShadowEvent): ThreadLog {
  if (event.type === "connection") return { ...log, state: event.state };
  if (event.type === "snapshot") {
    const items = { ...log.items };
    for (const item of event.snapshot.items) items[item.id] = item;
    return { ...log, items, pending: event.snapshot.pendingRequests, cursor: Math.max(log.cursor, event.snapshot.nextSeq - 1) };
  }
  const { method, params } = event.notification;
  if (method === "item/started" || method === "item/completed") {
    if (params.seq <= log.cursor) return log;
    return { ...log, items: { ...log.items, [params.item.id]: params.item }, cursor: params.seq };
  }
  if (method === "serverRequest/resolved" || method === "serverRequest/expired") {
    return { ...log, pending: log.pending.filter(request => request.params.requestId !== params.requestId) };
  }
  if (!("itemId" in params)) return log;
  const item = log.items[params.itemId];
  if (!item || item.status !== "inProgress") return log;
  let updated = item;
  if (method === "item/agentMessage/delta" && item.type === "agentMessage")
    updated = { ...item, payload: { ...item.payload, text: item.payload.text + params.delta } };
  if (method === "item/reasoning/textDelta" && item.type === "reasoning")
    updated = { ...item, payload: { ...item.payload, text: (item.payload.text ?? "") + params.delta } };
  if (method === "item/reasoning/summaryTextDelta" && item.type === "reasoning")
    updated = { ...item, payload: { ...item.payload, summary: (item.payload.summary ?? "") + params.delta } };
  if (method === "item/commandExecution/outputDelta" && item.type === "commandExecution")
    updated = { ...item, payload: { ...item.payload, aggregatedOutput: (item.payload.aggregatedOutput ?? "") + params.chunk } };
  if (method === "item/fileChange/patchUpdated" && item.type === "fileChange")
    updated = { ...item, payload: { ...item.payload, changes: params.changes } };
  if (method === "item/subAgent/progress" && item.type === "subAgent")
    updated = { ...item, payload: { ...item.payload, phase: params.phase, progress: params.progress } };
  return updated === item ? log : { ...log, items: { ...log.items, [item.id]: updated } };
}

export function itemText(item: Item): string {
  switch (item.type) {
    case "userMessage": return item.payload.content.map(input => input.type === "text" ? input.text : input.path).join("\n");
    case "agentMessage": return item.payload.text;
    case "reasoning": return [item.payload.summary, item.payload.text].filter(Boolean).join("\n");
    case "commandExecution": return `$ ${item.payload.command}\n${item.payload.cwd}\n${item.payload.aggregatedOutput ?? ""}${item.payload.exitCode == null ? "" : `\nexit ${item.payload.exitCode}`}`;
    case "fileChange": return item.payload.changes.map(change => `${change.kind} ${change.path}\n${change.diff ?? ""}`).join("\n");
    default: return JSON.stringify(item.payload, null, 2);
  }
}
