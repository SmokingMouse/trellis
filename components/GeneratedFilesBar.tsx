"use client";
import type { ChatNode } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";
import { generatedFilesFromNode, previewKind } from "@/lib/generated-files";

const KIND_ICON: Record<string, string> = {
  html: "🌐",
  image: "🖼",
  pdf: "📕",
  markdown: "📝",
  text: "📄",
};

// Chips for the files this turn wrote/edited (from tool calls). Opens the same
// global preview overlay as clickable inline paths. Lists every written file —
// the server fences each to the session whitelist on open (out-of-cwd files
// Claude generated are previewable too), so we don't pre-filter here.
export function GeneratedFilesBar({ node }: { node: ChatNode }) {
  const openFilePreview = useSessionStore((s) => s.openFilePreview);
  const files = generatedFilesFromNode(node);
  if (files.length === 0) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="text-[11px] text-stone-400 dark:text-stone-500 mr-0.5">
        本轮生成 ·
      </span>
      {files.map((file) => (
        <button
          key={file.absPath}
          type="button"
          onClick={() => openFilePreview(file.absPath)}
          title={file.absPath}
          className="nodrag inline-flex items-center gap-1 px-2 py-1 rounded-md border border-stone-200 dark:border-stone-700 text-[12px] text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 hover:border-stone-300 dark:hover:border-stone-600 transition-colors"
        >
          <span>{KIND_ICON[previewKind(file.name)] ?? "📄"}</span>
          <span className="truncate max-w-[180px]">{file.name}</span>
        </button>
      ))}
    </div>
  );
}
