"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

const POLL_MS = 1500;

// Workbench Wave 4: a single, app-level poll of GET /api/runs.
//
// Previously SessionTabs owned this interval. Now both the tab bar and the
// left explorer sidebar need the same "which sessions are running / just
// finished" signal, so we hoist the poll here (mounted once in page.tsx)
// and feed the result into the store via ingestRunningSessions — which also
// computes the cross-tick "finished while away → unread" diff. Components
// read runningSessionIds / unreadSessionIds straight off the store; nobody
// else runs an interval.
//
// Paused while the document is hidden (no point polling an invisible bar)
// and refetched immediately on re-show so badges are fresh on return.
export function useRunPolling() {
  const ingest = useSessionStore((s) => s.ingestRunningSessions);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      if (document.hidden) return;
      fetch("/api/runs")
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) {
            ingest(new Set<string>(data.runningSessionIds ?? []));
          }
        })
        .catch(() => {
          /* transient — keep prior snapshot */
        });
    };
    poll();
    const id = window.setInterval(poll, POLL_MS);
    const onVisible = () => {
      if (!document.hidden) poll();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ingest]);
}
