"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

const AUTO_DISMISS_MS = 8000;

// #5: surface for stream failures that happen BEFORE the server creates a
// node (fetch refused / non-2xx / server restart). Those errors used to be
// silently dropped (handleStreamEvent's error branch needs a nodeId), which
// left composers looking dead with no explanation. Bottom-center so it's
// visible from both the first-screen composer and the docked composers.
export function StreamAlertToast() {
  const alert = useSessionStore((s) => s.streamAlert);
  const setStreamAlert = useSessionStore((s) => s.setStreamAlert);

  useEffect(() => {
    if (!alert) return;
    const t = window.setTimeout(() => setStreamAlert(null), AUTO_DISMISS_MS);
    return () => window.clearTimeout(t);
  }, [alert, setStreamAlert]);

  if (!alert) return null;

  return (
    <div className="fixed bottom-20 inset-x-0 z-50 flex justify-center px-4 pointer-events-none">
      <div className="pointer-events-auto max-w-md w-full bg-rose-50 dark:bg-rose-950/90 border border-rose-200 dark:border-rose-800 rounded-lg shadow-lg px-3 py-2 flex items-start gap-2.5">
        <span className="shrink-0 mt-0.5" aria-hidden>
          ⚠️
        </span>
        <div className="flex-1 min-w-0 text-[13px] text-rose-800 dark:text-rose-200 break-words">
          {alert}
        </div>
        <button
          onClick={() => setStreamAlert(null)}
          className="shrink-0 -mt-0.5 -mr-1 px-1.5 py-0.5 text-rose-400 hover:text-rose-700 dark:hover:text-rose-200 text-sm leading-none"
          aria-label="关闭"
        >
          ×
        </button>
      </div>
    </div>
  );
}
