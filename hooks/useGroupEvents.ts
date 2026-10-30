"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { useGroupStore } from "@/stores/groupStore";
import type { GroupEvent } from "@/lib/groups";

// 打开群聊时订阅 /api/groups/[id]/events（SSE）：
//   round → groupStore.rounds（轮次条、「X 在想…」）
//   node  → sessionStore.ingestServerNode（新消息 / 上限卡；流式节点随即挂上 /api/nodes/[id]/stream）
// 断线按 1s → 2s → … 最多 15s 退避重连；切走就断。

export function useGroupEvents(groupId: string | null): void {
  useEffect(() => {
    if (!groupId) return;
    let stopped = false;
    let ctrl: AbortController | null = null;
    let retry = 0;
    let timer: number | undefined;
    let connectedOnce = false;

    const connect = async () => {
      ctrl = new AbortController();
      try {
        const res = await fetch(`/api/groups/${encodeURIComponent(groupId)}/events`, {
          signal: ctrl.signal,
          cache: "no-store",
        });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        retry = 0;
        // 断线期间可能错过了新消息：重连成功后按 DB 补一次。
        if (connectedOnce && useSessionStore.getState().session?.id === groupId) {
          void useSessionStore.getState().loadSession(groupId);
        }
        connectedOnce = true;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let at: number;
          while ((at = buf.indexOf("\n\n")) !== -1) {
            const raw = buf.slice(0, at);
            buf = buf.slice(at + 2);
            if (!raw.startsWith("data: ")) continue;
            let e: GroupEvent | { type: "ping" };
            try {
              e = JSON.parse(raw.slice(6));
            } catch {
              continue;
            }
            if (e.type === "round") useGroupStore.getState().setRound(groupId, e.round);
            else if (e.type === "node") useSessionStore.getState().ingestServerNode(e.node);
          }
        }
      } catch {
        /* 断线：下面重连 */
      }
      if (stopped) return;
      retry += 1;
      timer = window.setTimeout(() => void connect(), Math.min(15_000, 1000 * 2 ** (retry - 1)));
    };
    void connect();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      ctrl?.abort();
    };
  }, [groupId]);
}
