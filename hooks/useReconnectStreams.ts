"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// Stage 17: window-level triggers that reattach SSE to any node still
// in 'streaming' state locally. The actual reconnect logic is in the
// store action — this hook just decides *when* to call it.
//
// Triggers:
//   - document.visibilityState flips to 'visible' (mobile tab waking,
//     desktop tab returning to foreground after long idle)
//   - navigator.onLine flips to true (wifi/cellular returned)
//
// Both events can fire simultaneously (e.g. bringing a laptop out of
// sleep). The store action is idempotent: a second call while a
// reconnect is already in flight is a no-op.
export function useReconnectStreams(): void {
  const reconnect = useSessionStore((s) => s.reconnectStreamingNodes);
  useEffect(() => {
    const onVisible = () => {
      if (typeof document === "undefined") return;
      if (document.visibilityState === "visible") reconnect();
    };
    const onOnline = () => reconnect();
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("online", onOnline);
    // Cover the case where the user opens the app already in the
    // background tab and switches to it before any event fires — first
    // mount run-through.
    onVisible();
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("online", onOnline);
    };
  }, [reconnect]);
}
