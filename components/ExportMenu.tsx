"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Popover } from "@/components/ui/Popover";
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
    <Popover
      open={open}
      onClose={() => setOpen(false)}
      panelClassName="w-44 text-sm"
      trigger={
        <button
          onClick={() => setOpen((o) => !o)}
          className="px-2 py-1 rounded-md text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
          title="导出当前对话"
        >
          导出 <span className="text-ink-faint">▾</span>
        </button>
      }
    >
      <button
        onClick={onMarkdown}
        className="w-full text-left px-3 py-2 hover:bg-surface-muted flex flex-col gap-0.5"
      >
        <span className="text-ink-strong text-ui">Markdown</span>
        <span className="text-nano text-ink-faint">
          .md · 飞书可直接导入
        </span>
      </button>
      <button
        onClick={onJSON}
        className="w-full text-left px-3 py-2 hover:bg-surface-muted flex flex-col gap-0.5 border-t border-line-faint"
      >
        <span className="text-ink-strong text-ui">JSON</span>
        <span className="text-nano text-ink-faint">
          .trellis.json · 完整结构，可往返
        </span>
      </button>
    </Popover>
  );
}
