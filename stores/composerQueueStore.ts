"use client";
import { create } from "zustand";
import { sessionScopedKey } from "@/lib/prefs";
import { EMPTY_QUEUE, parseQueue, serializeQueue, type ComposerQueue } from "@/lib/composer-queue";

// 每个会话的排队列表（状态机在 lib/composer-queue.ts）。
//
// 单独一个小 store 而不是组件 state：出队发生在 effect 里（观察到当前轮结束），
// zustand 的 set 是同步的、不是 React setState——StrictMode 双跑 effect 时第二次
// 读到的已经是出队后的状态，不会重复发送；也不触发 set-state-in-effect。
// 写穿 localStorage（sessionScopedKey.queue），刷新 / 切会话回来都还在。

function load(sessionId: string): ComposerQueue {
  try {
    return parseQueue(localStorage.getItem(sessionScopedKey.queue(sessionId)));
  } catch {
    return EMPTY_QUEUE;
  }
}

function persist(sessionId: string, q: ComposerQueue) {
  try {
    const raw = serializeQueue(q);
    const key = sessionScopedKey.queue(sessionId);
    if (raw) localStorage.setItem(key, raw);
    else localStorage.removeItem(key);
  } catch {
    /* 隐私模式 / 配额满：队列退化成仅内存 */
  }
}

type QueueStore = {
  queues: Record<string, ComposerQueue>;
  /** 读（首次从 localStorage 懒加载）。 */
  get: (sessionId: string) => ComposerQueue;
  /** 用纯函数推进一步；返回推进后的状态（调用方据此执行动作）。 */
  update: (sessionId: string, next: (q: ComposerQueue) => ComposerQueue) => ComposerQueue;
};

export const useComposerQueueStore = create<QueueStore>((set, get) => ({
  queues: {},
  get: (sessionId) => get().queues[sessionId] ?? load(sessionId),
  update: (sessionId, next) => {
    const prev = get().get(sessionId);
    const q = next(prev);
    if (q !== prev || !(sessionId in get().queues)) {
      set((s) => ({ queues: { ...s.queues, [sessionId]: q } }));
      if (q !== prev) persist(sessionId, q);
    }
    return q;
  },
}));

/** 组件订阅某会话的队列（未加载时给空队列，挂载后 effect 里 hydrate）。 */
export function useSessionQueue(sessionId: string | null | undefined): ComposerQueue {
  return useComposerQueueStore((s) => (sessionId ? s.queues[sessionId] : undefined) ?? EMPTY_QUEUE);
}
