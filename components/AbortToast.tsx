"use client";
import { useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";

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
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 flex flex-col items-center gap-2 pointer-events-none">
      {arm && (
        <div className="pointer-events-auto bg-amber-50 dark:bg-amber-950/80 border border-amber-300 dark:border-amber-800 text-amber-800 dark:text-amber-200 rounded-lg shadow-lg px-4 py-2 text-[13px] flex items-center gap-2">
          <span aria-hidden>⚠️</span>
          <span>
            再按一次{" "}
            <kbd className="px-1 rounded bg-amber-200/70 dark:bg-amber-900/70 font-mono text-[11px]">
              Esc
            </kbd>{" "}
            中止生成{arm.label ? `「${truncate(arm.label)}」` : ""}
          </span>
        </div>
      )}
      {recovery && (
        <div className="pointer-events-auto bg-white dark:bg-stone-900 border border-stone-300 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 text-[13px] flex items-center gap-3">
          <span className="text-stone-600 dark:text-stone-300">
            已中止{recovery.label ? `「${truncate(recovery.label)}」` : ""}
          </span>
          <button
            onClick={() => {
              setActiveNode(recovery.nodeId);
              void retryNode(recovery.nodeId);
              setAbortRecovery(null);
            }}
            className="shrink-0 inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-indigo-600 hover:bg-indigo-500 text-white text-[12px] font-medium"
          >
            ↻ 重新运行
          </button>
          <button
            onClick={() => setAbortRecovery(null)}
            className="shrink-0 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200 text-sm leading-none"
            aria-label="关闭"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

function truncate(s: string): string {
  return s.length > 30 ? s.slice(0, 29) + "…" : s;
}
