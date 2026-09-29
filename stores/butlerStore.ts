"use client";
import { create } from "zustand";
import type { ButlerChange } from "@/lib/butler";

// 管家改动提案的客户端缓存。独立于 sessionStore（理由同 agentStore：数据与会话
// 流式状态零交集）。卡片按 nodeId 从 bySession 里取；右栏「变更记录」读 recent。

type ButlerState = {
  bySession: Record<string, ButlerChange[]>;
  recent: ButlerChange[];
  /** 正在提交的提案 id → 动作，卡片据此禁用按钮 */
  busy: Record<string, string>;
  refresh: (sessionId: string) => Promise<void>;
  refreshRecent: () => Promise<void>;
  act: (
    change: ButlerChange,
    action: "apply" | "reject" | "revert",
    confirm?: string,
  ) => Promise<string | null>;
};

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url, { cache: "no-store" });
    return res.ok ? ((await res.json()) as T) : null;
  } catch {
    return null;
  }
}

export const useButlerStore = create<ButlerState>((set, get) => ({
  bySession: {},
  recent: [],
  busy: {},

  refresh: async (sessionId) => {
    const j = await getJson<{ changes: ButlerChange[] }>(
      `/api/butler/changes?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (j) set((s) => ({ bySession: { ...s.bySession, [sessionId]: j.changes } }));
  },

  refreshRecent: async () => {
    const j = await getJson<{ changes: ButlerChange[] }>("/api/butler/changes?recent=1&limit=8");
    if (j) set({ recent: j.changes });
  },

  // 返回错误文案（null = 成功）。成功后刷新本会话与变更记录。
  act: async (change, action, confirm) => {
    set((s) => ({ busy: { ...s.busy, [change.id]: action } }));
    try {
      const res = await fetch(`/api/butler/changes/${change.id}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, confirm }),
      });
      const j = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) return j?.error ?? `HTTP ${res.status}`;
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    } finally {
      set((s) => {
        const busy = { ...s.busy };
        delete busy[change.id];
        return { busy };
      });
      await Promise.all([get().refresh(change.sessionId), get().refreshRecent()]);
    }
  },
}));
