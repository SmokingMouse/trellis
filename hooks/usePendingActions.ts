"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { PendingItem } from "@/lib/pending";
import { openPendingItem } from "@/lib/pending-navigation";

// 「等你处理」的数据源与两个动作（去处理 / 允许·拒绝），PendingBar 与首页共用。
// 数据来自 useRunPolling 喂进 store 的 pending 快照，不另起轮询。
export function usePendingActions() {
  const snapshot = useSessionStore(s => s.pending);
  const submitting = useSessionStore(s => s.pendingSubmissions);
  const items = snapshot.items.filter(item => !submitting.has(item.nodeId));
  const [error, setError] = useState("");

  const jump = async (item: PendingItem, onBeforeJump?: () => void) => {
    setError("");
    try {
      await openPendingItem(item, onBeforeJump ?? (() => {}), useSessionStore.getState(), nodeId => {
        const state = useSessionStore.getState();
        if (state.session?.id !== item.sessionId || state.activeNodeId !== nodeId) throw new Error("目标会话未能载入，请重试");
        useSessionStore.setState(s => ({ viewMode: "linear", pendingNavigation: {
          nodeId, sequence: (s.pendingNavigation?.sequence ?? 0) + 1,
        } }));
      });
    } catch (error) {
      console.error("[pending navigation]", error);
      setError(error instanceof Error ? error.message : "跳转失败，请重试。");
    }
  };
  const decide = async (item: PendingItem, allow: boolean) => {
    setError("");
    const result = await useSessionStore.getState().respondToInteraction(item.nodeId, item.interaction.toolUseId,
      allow ? { behavior: "allow", updatedInput: item.interaction.input } : { behavior: "deny", message: "用户拒绝了本次工具执行" });
    if (!result.ok && result.reason !== "stale") setError("处理失败，请重试。");
  };
  return { items, error, jump, decide };
}
