"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ToastShell } from "@/components/ui/Toast";
import { Button } from "@/components/ui/Button";

// Bottom-center prompts tied to Esc-abort anti-misfire + recovery:
//   • abortArm  → amber "再按 Esc 中止" confirm prompt (first Esc; auto-clears
//     when the hook disarms after its window).
//   • abortRecovery → after a stop, a "已中止 · ↻ 重新运行" toast so an
//     accidental abort is one click from recovery. Auto-dismisses after
//     RECOVERY_MS.
const RECOVERY_MS = 12000;

export function AbortToast() {
  const arm = useSessionStore((s) => s.abortArm);
  const recovery = useSessionStore((s) => s.abortRecovery);
  const setAbortRecovery = useSessionStore((s) => s.setAbortRecovery);
  const retryNode = useSessionStore((s) => s.retryNode);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);

  useEffect(() => {
    if (!recovery) return;
    const t = window.setTimeout(() => setAbortRecovery(null), RECOVERY_MS);
    return () => window.clearTimeout(t);
  }, [recovery, setAbortRecovery]);

  if (!arm && !recovery) return null;

  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-[60] flex flex-col items-center gap-2 pointer-events-none">
      {arm && (
        <ToastShell tone="warn" className="px-4 py-2 text-ui flex items-center gap-2">
          <span aria-hidden>⚠️</span>
          <span>
            再按一次{" "}
            <kbd className="px-1 rounded bg-warn-line/50 font-mono text-label">
              Esc
            </kbd>{" "}
            中止生成{arm.label ? `「${truncate(arm.label)}」` : ""}
          </span>
        </ToastShell>
      )}
      {recovery && (
        <ToastShell tone="neutral" className="px-3 py-2 text-ui flex items-center gap-3">
          <span className="text-ink-muted">
            已中止{recovery.label ? `「${truncate(recovery.label)}」` : ""}
          </span>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setActiveNode(recovery.nodeId);
              void retryNode(recovery.nodeId);
              setAbortRecovery(null);
            }}
          >
            ↻ 重新运行
          </Button>
          <button
            onClick={() => setAbortRecovery(null)}
            className="shrink-0 text-ink-faint hover:text-ink-strong text-sm leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </ToastShell>
      )}
    </div>
  );
}

function truncate(s: string): string {
  return s.length > 30 ? s.slice(0, 29) + "…" : s;
}
