import type { Item, PendingServerRequest, Turn, NotificationParams } from "@smokingmouse/agent-server/protocol";
import type { ThreadEvent } from "./as-thread-event";

export interface ThreadLog {
  items: Record<string, Item>;
  pending: NotificationParams<"thread/pendingRequests">[];
  cursor: number;
  state: string;
  turns: Record<string, Turn>;
  errors: NotificationParams<"error">[];
}
export const emptyThreadLog = (): ThreadLog => ({ items: {}, pending: [], cursor: 0, state: "connecting", turns: {}, errors: [] });

function pendingState(request: PendingServerRequest): NotificationParams<"thread/pendingRequests"> {
  const p = request.params;
  return request.state ?? { threadId:p.threadId, turnId:p.turnId, requestId:p.requestId, itemId:p.itemId,
    kind: request.method === "item/commandExecution/requestApproval" ? "commandExecution" : request.method === "item/fileChange/requestApproval" ? "fileChange" : request.method === "item/permissions/requestApproval" ? "permissions" : "userInput",
    status:"pending", decidedBy:null, createdAtMs:"startedAtMs" in p ? p.startedAtMs : 0, updatedAtMs:0 };
}

/** Snapshots/completions replace payloads; only live deltas append. */
export function applyThreadEvent(log: ThreadLog, event: ThreadEvent): ThreadLog {
  if (event.type === "connection") return log.state === event.state ? log : { ...log, state: event.state };
  if (event.type === "snapshot") {
    let items = log.items;
    for (const item of event.snapshot.items) {
      if (JSON.stringify(log.items[item.id]) === JSON.stringify(item)) continue;
      if (items === log.items) items = { ...items };
      items[item.id] = item;
    }
    const cursor = Math.max(log.cursor, event.snapshot.nextSeq - 1);
    const states = event.snapshot.pendingRequests.map(pendingState);
    const pending = JSON.stringify(log.pending) === JSON.stringify(states) ? log.pending : states;
    return items === log.items && pending === log.pending && cursor === log.cursor ? log : { ...log, items, pending, cursor };
  }
  const { method, params } = event.notification;
  if (method === "thread/pendingRequests") {
    const previous = log.pending.find(request => request.requestId === params.requestId);
    if (params.status === "pending" && JSON.stringify(previous) === JSON.stringify(params)) return log;
    if (params.status !== "pending" && !previous) return log;
    const pending = log.pending.filter(request => request.requestId !== params.requestId);
    if (params.status === "pending") pending.push(params);
    return { ...log, pending };
  }
  if (method === "error") {
    if (log.errors.some(error => JSON.stringify(error) === JSON.stringify(params))) return log;
    return { ...log, errors: [...log.errors, params] };
  }
  if (method === "turn/started" || method === "turn/completed") {
    if (JSON.stringify(log.turns[params.turnId]) === JSON.stringify(params.turn)) return log;
    return { ...log, turns: { ...log.turns, [params.turnId]: params.turn } };
  }
  if (method === "item/started" || method === "item/completed") {
    if (params.seq <= log.cursor) return log;
    return { ...log, items: { ...log.items, [params.item.id]: params.item }, cursor: params.seq };
  }
  if (method === "serverRequest/resolved" || method === "serverRequest/expired") {
    const pending = log.pending.filter(request => request.requestId !== params.requestId);
    return pending.length === log.pending.length ? log : { ...log, pending };
  }
  if (!("itemId" in params)) return log;
  const item = log.items[params.itemId];
  if (!item || item.status !== "inProgress") return log;
  if (("delta" in params && !params.delta) || ("chunk" in params && !params.chunk)) return log;
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
  return updated === item || JSON.stringify(updated) === JSON.stringify(item) ? log : { ...log, items: { ...log.items, [item.id]: updated } };
}
