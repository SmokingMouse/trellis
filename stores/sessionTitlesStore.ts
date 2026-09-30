"use client";
import { create } from "zustand";

// 会话 id → 标题的只读镜像，给 Herdr 窗格标题兜底用（终端标题是「Claude Code」这类默认值时，
// 取绑定会话的标题）。侧栏 / 标签条拉 /api/sessions 时顺手喂进来，不单独发请求。
type State = {
  titles: Record<string, string>;
  ingest: (sessions: { id: string; title?: string | null }[]) => void;
};

export const useSessionTitlesStore = create<State>((set, get) => ({
  titles: {},
  ingest: (sessions) => {
    const prev = get().titles;
    let changed = false;
    const next: Record<string, string> = { ...prev };
    for (const s of sessions) {
      const title = s.title?.trim();
      if (title && next[s.id] !== title) {
        next[s.id] = title;
        changed = true;
      }
    }
    if (changed) set({ titles: next });
  },
}));
