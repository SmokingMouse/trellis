import "server-only";
import { getDB } from "./sqlite";
import { pendingSummary, type PendingItem, type PendingSnapshot } from "../pending";
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
  return shared.trellisPendingSnapshot = { revision: Math.max(Date.now(), (shared.trellisPendingSnapshot?.revision ?? 0) + 1), items };
}
