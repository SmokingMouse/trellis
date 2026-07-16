"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

type CliSyncEvent =
  | { type: "session_updated"; sessionId: string }
  | { type: "ping" };

export function useCliSyncEvents(): void {
  const loadSession = useSessionStore((s) => s.loadSession);
  const bumpSessionsRevision = useSessionStore((s) => s.bumpSessionsRevision);
  const markSessionLive = useSessionStore((s) => s.markSessionLive);

  useEffect(() => {
    const ctrl = new AbortController();
    let cancelled = false;
    let retryTimer = 0;

    async function run() {
      try {
        const res = await fetch("/api/cli-sync/events", {
          signal: ctrl.signal,
          headers: { Accept: "text/event-stream" },
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const frames = buffer.split("\n\n");
          buffer = frames.pop() ?? "";
          for (const frame of frames) {
            const line = frame
              .split("\n")
              .find((l) => l.startsWith("data: "));
            if (!line) continue;
            const event = JSON.parse(line.slice(6)) as CliSyncEvent;
            if (event.type !== "session_updated") continue;
            // live 感知：收到更新 = 该 session 正被实时写（claude 在驱动它）。
            markSessionLive(event.sessionId);
            bumpSessionsRevision();
            // Read the ACTIVE session id at event time (not from a captured
            // prop): during a tab switch the closure value is stale for a few
            // hundred ms, and a session_updated for the still-streaming old
            // session would loadSession() the view right back to it — 串台.
            if (
              event.sessionId ===
              useSessionStore.getState().session?.id
            ) {
              void loadSession(event.sessionId);
            }
          }
        }
      } catch {
        /* transient — retry below while mounted */
      } finally {
        if (!cancelled) {
          retryTimer = window.setTimeout(run, 2000);
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
      ctrl.abort();
    };
  }, [bumpSessionsRevision, loadSession, markSessionLive]);
}
