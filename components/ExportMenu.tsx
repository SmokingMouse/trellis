"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import {
  exportJSON,
  exportMarkdown,
  downloadFile,
  safeFilename,
} from "@/lib/export";

export function ExportMenu() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  if (!session) return null;

  const onJSON = () => {
    const content = exportJSON(session, Object.values(nodes));
    downloadFile(
      `${safeFilename(session.title)}.trellis.json`,
      content,
      "application/json",
    );
    setOpen(false);
  };

  const onMarkdown = () => {
    const content = exportMarkdown(session, Object.values(nodes));
    downloadFile(
      `${safeFilename(session.title)}.md`,
      content,
      "text/markdown",
    );
    setOpen(false);
  };

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="px-2 py-1 rounded-md text-stone-600 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors"
        title="导出当前对话"
      >
        导出 <span className="text-stone-400 dark:text-stone-500">▾</span>
      </button>
      {open && (
        <div className="absolute right-0 mt-1.5 w-44 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-xl overflow-hidden text-sm">
          <button
            onClick={onMarkdown}
            className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 flex flex-col gap-0.5"
          >
            <span className="text-stone-900 dark:text-stone-100 text-[13px]">Markdown</span>
            <span className="text-[10px] text-stone-400 dark:text-stone-500">
              .md · 飞书可直接导入
            </span>
          </button>
          <button
            onClick={onJSON}
            className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 flex flex-col gap-0.5 border-t border-stone-100 dark:border-stone-800"
          >
            <span className="text-stone-900 dark:text-stone-100 text-[13px]">JSON</span>
            <span className="text-[10px] text-stone-400 dark:text-stone-500">
              .trellis.json · 完整结构，可往返
            </span>
          </button>
        </div>
      )}
    </div>
  );
}
