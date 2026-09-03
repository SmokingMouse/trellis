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
// Keep polling while hidden: recent-chain status must not depend on focus or
// the active conversation. Browsers may coalesce background timers, but the
// app itself never gates this source on document visibility.
export function useRunPolling() {
  const ingest = useSessionStore((s) => s.ingestRunningSessions);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      fetch("/api/runs")
        .then((r) => r.json())
        .then((data) => {
          if (!cancelled) {
            const runningNodes = Array.isArray(data.runningNodes)
              ? data.runningNodes
              : [];
            const waitingNodes = Array.isArray(data.waitingNodes)
              ? data.waitingNodes
              : [];
            ingest(
              new Set<string>(data.runningSessionIds ?? []),
              new Set<string>(
                runningNodes.map((run: { nodeId: string }) => run.nodeId),
              ),
              new Set<string>(
                waitingNodes.map((run: { nodeId: string }) => run.nodeId),
              ),
            );
          }
        })
        .catch(() => {
          /* transient — keep prior snapshot */
        });
    };
    poll();
    const id = window.setInterval(poll, POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [ingest]);
}
