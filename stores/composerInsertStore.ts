"use client";
import { create } from "zustand";

// 「往某会话输入框草稿里追加一段文本」的单槽信箱。生产方（diff 审阅的「发送给
// agent」）投递；Composer 挂载到同一会话时取走、追加到当前草稿末尾并聚焦——
// 只放进输入框，不替用户发送。会话不匹配时原样留着，切到那个会话再取。

export type ComposerInsert = { id: number; sessionId: string; text: string };

type ComposerInsertState = {
  pending: ComposerInsert | null;
  queueComposerInsert: (sessionId: string, text: string) => void;
  /** 只清掉指定 id，避免把取走之后新投递的那一条也清了 */
  consumeComposerInsert: (id: number) => void;
};

let seq = 0;

export const useComposerInsertStore = create<ComposerInsertState>((set) => ({
  pending: null,
  queueComposerInsert: (sessionId, text) => set({ pending: { id: ++seq, sessionId, text } }),
  consumeComposerInsert: (id) => set((s) => (s.pending?.id === id ? { pending: null } : s)),
}));

/** 追加到已有草稿之后（空行分隔）；草稿为空时直接替换。 */
export function appendToDraft(current: string, insert: string): string {
  const cur = current.replace(/\s+$/, "");
  return cur ? `${cur}\n\n${insert}` : insert;
}
