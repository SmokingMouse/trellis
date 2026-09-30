"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { pageEvents } from "@/lib/page-events";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";

type CliSyncEvent =
  | ({ type: "pending_snapshot" } & import("@/lib/pending").PendingSnapshot)
  | { type: "session_updated"; sessionId: string }
  | { type: "ping" };

// 数据来自页面级统一事件流 /api/events 的 `cli` 通道（原 /api/cli-sync/events 的 data 原样转发）。
export function useCliSyncEvents(): void {
  const loadSession = useSessionStore((s) => s.loadSession);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);
  const markSessionLive = useSessionStore((s) => s.markSessionLive);

  useEffect(() => {
    const stream = pageEvents();
    const offEvents = stream.on("cli", (data) => {
      const event = data as CliSyncEvent;
      if (event.type === "pending_snapshot") { useSessionStore.getState().ingestPending(event); return; }
      if (event.type !== "session_updated") return;
      // live 感知：收到更新 = 该 session 正被实时写（claude 在驱动它）。
      markSessionLive(event.sessionId);
      bumpSessionsRevision();
      // Read the ACTIVE session id at event time (not from a captured
      // prop): during a tab switch the closure value is stale for a few
      // hundred ms, and a session_updated for the still-streaming old
      // session would loadSession() the view right back to it — 串台.
      if (event.sessionId === useSessionStore.getState().session?.id) {
        void loadSession(event.sessionId);
        // Herdr 运行态由 herdr 通道推送；内容刚变就顺手对一次 ETag，让「正在生成 /
        // 已完成」和正文一起翻。没变就是 304。
        if (useSessionStore.getState().session?.origin === "herdr") {
          void refreshHerdrFleet();
        }
      }
    });
    // 断线期间的 session_updated 丢了：重连后补一次侧栏 + 当前会话。
    const offStatus = stream.onStatus(({ connected, reconnect }) => {
      if (!connected || !reconnect) return;
      bumpSessionsRevision();
      const active = useSessionStore.getState().session?.id;
      if (active) void loadSession(active);
    });
    return () => { offEvents(); offStatus(); };
  }, [bumpSessionsRevision, loadSession, markSessionLive]);
}
