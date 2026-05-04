"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ReferencePicker } from "./ReferencePicker";

export function QuestionInput() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    const trimmed = q.trim();
    if (!trimmed || busy) return;
    setBusy(true);
    // Fire and forget — store handles state updates from SSE events.
    streamRoot(trimmed);
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Cmd+Enter (mac) / Ctrl+Enter (win/linux) sends. Plain Enter inserts a
    // newline so accidental keystrokes can't fire a request.
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-stone-500 dark:text-stone-400 mb-6 text-sm">
          想深入探索什么？任何问题都可以——后续可以选中回复里的任意文字继续追问。
        </p>
        <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-xl shadow-sm overflow-hidden">
          <textarea
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            placeholder="例如：Rust 的 ownership 系统在汇编层面是怎么实现的？"
            rows={4}
            className="w-full px-5 py-4 outline-none resize-none text-[15px] leading-relaxed bg-transparent text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500"
            disabled={busy}
          />
          <div className="border-t border-stone-100 dark:border-stone-800 px-4 py-2 flex items-center justify-between">
            <div className="text-xs text-stone-400 dark:text-stone-500">
              <kbd className="bg-stone-100 dark:bg-stone-800 dark:text-stone-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
                ⌘↩
              </kbd>{" "}
              提交 ·{" "}
              <kbd className="bg-stone-100 dark:bg-stone-800 dark:text-stone-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
                Enter
              </kbd>{" "}
              换行
            </div>
            <button
              onClick={submit}
              disabled={!q.trim() || busy}
              className="bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-sm px-4 py-1.5 rounded-md hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? "提交中…" : "开始探索"}
            </button>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
          <span className="text-stone-400 dark:text-stone-500">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
        </div>
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-4 py-2 rounded-md text-sm border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/60 active:scale-95 transition-colors flex items-center gap-2"
          >
            <span aria-hidden>📄</span>
            <span>从背景材料开始（粘贴 / URL）</span>
          </button>
        </div>
        <div className="text-center text-xs text-stone-400 dark:text-stone-500 mt-4">
          模型在右上角切换 · 默认 Claude Sonnet
        </div>
      </div>
      {pickerOpen && (
        <ReferencePicker onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
