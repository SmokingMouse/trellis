"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";

// Modal composer for "新提问" — adds a parallel root (parent_id=NULL) to the
// current session. Visual structure mirrors ReferencePicker for consistency.
export function NewQuestionPicker({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const ref = useRef<HTMLTextAreaElement>(null);
  // In project mode a new root also forks a fresh claude session id — the
  // model loses its conversation memory of the existing tree. Call it out
  // so users don't trip over the "wait, why doesn't it remember?" beat.
  const isProject = sessionMode === "project";

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Esc closes when no field has focus (textarea handles its own Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    if (busy) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setError("问题不能为空");
      return;
    }
    setError(null);
    setBusy(true);
    // Fire and forget — close immediately so the user sees the new node
    // start streaming on canvas. The store handles the rest via SSE.
    onClose();
    streamRoot(trimmed, { attachToCurrentSession: true });
  };

  return (
    <div
      className="fixed inset-0 z-50 bg-stone-900/40 dark:bg-black/60 flex items-center justify-center px-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xl bg-white dark:bg-stone-900 rounded-xl shadow-2xl overflow-hidden border border-transparent dark:border-stone-800"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-5 py-4 border-b border-stone-100 dark:border-stone-800 flex items-center justify-between">
          <div>
            <div className="text-[15px] font-semibold text-stone-900 dark:text-stone-100 flex items-center gap-2">
              新提问
              {isProject && (
                <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-rose-50 dark:bg-rose-950/40 text-rose-600 dark:text-rose-300 border border-rose-200/60 dark:border-rose-900/60">
                  🧹 全新上下文
                </span>
              )}
            </div>
            <div className="text-[12px] text-stone-500 dark:text-stone-400 mt-0.5">
              {isProject
                ? "起一条独立的根问答；Project 模式下会同时开启全新的 Claude 会话记忆。"
                : "在当前画布上起一条独立的根问答，不继承现有节点的上下文。"}
            </div>
          </div>
          <button
            onClick={onClose}
            className="px-2 py-1 text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-200"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>

        <div className="px-5 py-4">
          <textarea
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                submit();
              }
            }}
            placeholder="想问点什么？例如：这个 session 之外的另一个角度…"
            rows={6}
            className="w-full px-3 py-2 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-900 dark:text-stone-100 text-sm outline-none focus:border-stone-500 dark:focus:border-stone-500 resize-none leading-relaxed placeholder:text-stone-400 dark:placeholder:text-stone-500"
            disabled={busy}
          />
          <div className="text-[11px] text-stone-400 dark:text-stone-500 mt-1">
            ⌘↩ 提交 · {q.length} 字
          </div>
          {error && (
            <div className="mt-2 text-[12px] text-rose-600 dark:text-rose-400">
              {error}
            </div>
          )}
        </div>

        <div className="px-5 py-3 border-t border-stone-100 dark:border-stone-800 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-stone-600 dark:text-stone-300 hover:text-stone-900 dark:hover:text-stone-100"
          >
            取消
          </button>
          <button
            onClick={submit}
            disabled={!q.trim() || busy}
            className="bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-sm px-4 py-1.5 rounded-md hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {busy ? "提交中…" : "开始"}
          </button>
        </div>
      </div>
    </div>
  );
}
