import type { PendingInteraction } from "./types";

export type PendingItem = {
  sessionId: string;
  sessionTitle: string;
  nodeId: string;
  kind: "approval" | "question";
  summary: string;
  createdAt: number;
  interaction: PendingInteraction;
};
export type PendingSnapshot = { revision: number; items: PendingItem[] };
export const pendingKey = (item: PendingItem) => `${item.nodeId}:${item.interaction.toolUseId}`;

export function pendingSummary(interaction: PendingInteraction): string {
  const input = interaction.input as Record<string, unknown> | null;
  const questions = input?.questions as { question?: string }[] | undefined;
  const text = interaction.toolName === "AskUserQuestion"
    ? questions?.map(q => q.question).filter(Boolean).join("；")
    : input?.description || input?.command || input?.reason || input?.plan;
  return (typeof text === "string" && text.trim() ? text : interaction.toolName).replace(/\s+/g, " ").slice(0, 180);
}

export function reconcilePending(current: PendingSnapshot, incoming: PendingSnapshot): PendingSnapshot {
  if (incoming.revision < current.revision) return current;
  const unique = new Map(incoming.items.map(item => [pendingKey(item), item]));
  return { revision: incoming.revision, items: [...unique.values()].sort((a, b) => a.createdAt - b.createdAt || pendingKey(a).localeCompare(pendingKey(b))) };
}
