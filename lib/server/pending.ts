import "server-only";
import { getDB } from "./sqlite";
import { pendingKey, pendingSummary, type PendingItem, type PendingSnapshot } from "../pending";
import { newWaitingGroups } from "../push";
import { pushWaitingGroups } from "./push";
import type { PendingInteraction } from "../types";

const shared = globalThis as typeof globalThis & { trellisPendingSnapshot?: PendingSnapshot; trellisPendingRefresh?: boolean };
// HTTP handlers only read this cache. No daemon, socket, disk, or await here.
export function pendingSnapshot(): PendingSnapshot {
  return shared.trellisPendingSnapshot ?? { revision: 0, items: [] };
}

// Reuse existing list/run refresh triggers; this creates no polling loop.
export function schedulePendingRefresh(): void {
  if (shared.trellisPendingRefresh) return;
  shared.trellisPendingRefresh = true;
  setTimeout(() => {
    shared.trellisPendingRefresh = false;
    try { refreshPendingSnapshot(); } catch (error) { console.warn("[pending projection]", error); }
  }, 0);
}

// AS projections are maintained by as-project/as-adopt subscriptions. Never
// contact a daemon to reconstruct them, including when AS is off/unavailable.
export function refreshPendingSnapshot(): PendingSnapshot {
  const rows = getDB().prepare(`SELECT n.id, n.session_id, n.created_at, n.pending_interaction_json, s.title
    FROM nodes n JOIN sessions s ON s.id=n.session_id
    WHERE n.pending_interaction_json IS NOT NULL`).all() as {
      id: string; session_id: string; created_at: number; pending_interaction_json: string; title: string;
    }[];
  const items: PendingItem[] = [];
  for (const row of rows) {
    let interaction: PendingInteraction;
    try { interaction = JSON.parse(row.pending_interaction_json); } catch { continue; }
    if (!interaction?.toolUseId || !interaction.toolName) continue;
    for (const request of [interaction, ...(interaction.additional ?? [])]) {
      const { additional: _additional, ...single } = request;
      items.push({ nodeId: row.id, sessionId: row.session_id, sessionTitle: row.title || "未命名会话",
        kind: single.toolName === "AskUserQuestion" ? "question" : "approval",
        summary: pendingSummary(single), createdAt: single.createdAt ?? row.created_at, interaction: single });
    }
  }
  const previous = shared.trellisPendingSnapshot;
  const next = shared.trellisPendingSnapshot = { revision: Math.max(Date.now(), (previous?.revision ?? 0) + 1), items };
  // 「等你回答」推送的触发点：快照是所有来源（run-bus 暂停、AS 投影、CLI 同步）待处理项
  // 的唯一汇合处，在这里和上一版比出新冒出来的项。推送内部同步判门槛、异步发送，
  // 不会拖慢这条读路径；任何异常都不能影响快照本身。
  try {
    pushWaitingGroups(newWaitingGroups(previous ? new Set(previous.items.map(pendingKey)) : null, items, Date.now()));
  } catch (error) {
    console.warn("[pending push]", error);
  }
  return next;
}
