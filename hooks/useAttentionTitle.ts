"use client";
import { useEffect, useMemo } from "react";
import { attentionTitle, waitingSessionIds } from "@/lib/attention";
import { useHerdrSessionStatuses } from "@/hooks/useHerdrFleet";
import { useSessionStore } from "@/stores/sessionStore";

/** 等你回答的会话 id 集合：store.pending + Herdr 窗格状态，与侧栏同一来源（lib/attention）。 */
export function useWaitingSessionIds(): Set<string> {
  const pending = useSessionStore((s) => s.pending.items);
  const submitting = useSessionStore((s) => s.pendingSubmissions);
  // fleet 订阅是模块级单例，侧栏已在订阅，这里不会多起一路轮询。
  const { statuses } = useHerdrSessionStatuses();
  return useMemo(() => waitingSessionIds(pending, submitting, statuses), [pending, submitting, statuses]);
}

/**
 * 标签页标题提示：有会话等你回答时 document.title 前缀「(N) 」，0 时恢复原标题。
 * 原标题来自 Next metadata（app/layout.tsx），这里只加 / 去前缀，不持有原标题副本；
 * 监听 <title> 变化是为了 Next 在导航 / refresh 时重写标题后把前缀补回来
 *（attentionTitle 幂等，自己写入触发的回调算出来相同，不会循环）。
 */
export function useAttentionTitle(): void {
  const count = useWaitingSessionIds().size;
  useEffect(() => {
    const apply = () => {
      const next = attentionTitle(document.title, count);
      if (next !== document.title) document.title = next;
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(document.head, { subtree: true, childList: true, characterData: true });
    return () => {
      observer.disconnect();
      document.title = attentionTitle(document.title, 0);
    };
  }, [count]);
}
