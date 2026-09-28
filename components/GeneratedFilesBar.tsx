"use client";
import { File, FileText, FileType, Globe, Image, type LucideIcon } from "lucide-react";
import { Icon } from "@/components/ui";
import type { ChatNode } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { generatedFilesFromNode, previewKind } from "@/lib/generated-files";

const KIND_ICON: Record<string, LucideIcon> = {
  html: Globe,
  image: Image,
  pdf: FileType,
  markdown: FileText,
  text: File,
};

// Chips for the files this turn wrote/edited (from tool calls). Opens the same
// global preview overlay as clickable inline paths. Lists every written file —
// the server fences each to the session whitelist on open (out-of-cwd files
// Claude generated are previewable too), so we don't pre-filter here.
//
// 大会话的 toolCalls 不随会话载荷下发，所以优先用服务端预计算的
// generatedFiles；toolCalls 在手里时（流式 / 按需拉过后）就地算。
export function GeneratedFilesBar({ node }: { node: ChatNode }) {
  const openFilePreview = useSessionStore((s) => s.openFilePreview);
  const files =
    node.toolCalls.length > 0
      ? generatedFilesFromNode(node)
      : (node.generatedFiles ?? []);
  if (files.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-label text-ink-faint mr-0.5">本轮生成</span>
      {files.map((file) => (
        <button
          key={file.absPath}
          type="button"
          onClick={() => openFilePreview(file.absPath)}
          title={file.absPath}
          className="nodrag inline-flex items-center gap-1.5 min-h-6.5 px-2 rounded-field border border-line bg-surface text-label text-ink-muted hover:bg-surface-hover hover:text-ink transition-colors max-md:min-h-11"
        >
          <Icon icon={KIND_ICON[previewKind(file.name)] ?? File} size="sm" className="text-ink-faint" />
          <span className="truncate max-w-48 font-mono">{file.name}</span>
        </button>
      ))}
    </div>
  );
}
