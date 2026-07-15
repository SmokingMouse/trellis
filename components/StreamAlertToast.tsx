"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ToastShell } from "@/components/ui/Toast";

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
    <div className="fixed bottom-20 inset-x-0 z-[60] flex justify-center px-4 pointer-events-none">
      <ToastShell
        tone="danger"
        className="max-w-md w-full px-3 py-2 flex items-start gap-2.5"
      >
        <span className="shrink-0 mt-0.5" aria-hidden>
          ⚠️
        </span>
        <div className="flex-1 min-w-0 text-ui break-words">{alert}</div>
        <button
          onClick={() => setStreamAlert(null)}
          className="shrink-0 -mt-0.5 -mr-1 px-1.5 py-0.5 text-danger/60 hover:text-danger text-sm leading-none"
          aria-label="关闭"
        >
          ×
        </button>
      </ToastShell>
    </div>
  );
}
