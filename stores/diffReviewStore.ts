"use client";
import { create } from "zustand";
import type { ReviewComment } from "@/lib/diff-review";

// diff 审阅层的全局状态：
//   target   —— 会话内入口（顶栏菜单 / 本轮文件条）打开的审阅目标，DiffReviewHost 渲染
//   comments —— 评论草稿，按仓库根路径分桶；关掉审阅再打开还在，发进输入框后清空
// 侧栏入口仍自己挂 WorkspaceDiffModal（workspaceId），评论桶与这里共用。

export type ReviewScope = "all" | "unstaged" | "staged" | "base" | "turn";

export type DiffReviewTarget = {
  sessionId: string;
  /** 初始过滤；"turn" = 仅上一轮（或 turnNodeId 指定那一轮）改过的文件 */
  scope?: ReviewScope;
  turnNodeId?: string;
};

type DiffReviewState = {
  target: DiffReviewTarget | null;
  comments: Record<string, ReviewComment[]>;
  openReview: (t: DiffReviewTarget) => void;
  closeReview: () => void;
  addComment: (bucket: string, c: ReviewComment) => void;
  updateComment: (bucket: string, id: string, body: string) => void;
  removeComment: (bucket: string, id: string) => void;
  clearComments: (bucket: string) => void;
};

export const useDiffReviewStore = create<DiffReviewState>((set) => ({
  target: null,
  comments: {},
  openReview: (target) => set({ target }),
  closeReview: () => set({ target: null }),
  addComment: (bucket, c) =>
    set((s) => ({ comments: { ...s.comments, [bucket]: [...(s.comments[bucket] ?? []), c] } })),
  updateComment: (bucket, id, body) =>
    set((s) => ({
      comments: {
        ...s.comments,
        [bucket]: (s.comments[bucket] ?? []).map((c) => (c.id === id ? { ...c, body } : c)),
      },
    })),
  removeComment: (bucket, id) =>
    set((s) => ({
      comments: { ...s.comments, [bucket]: (s.comments[bucket] ?? []).filter((c) => c.id !== id) },
    })),
  clearComments: (bucket) =>
    set((s) => {
      const next = { ...s.comments };
      delete next[bucket];
      return { comments: next };
    }),
}));
