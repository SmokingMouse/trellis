"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { MD_COMPONENTS } from "@/lib/md-components";
import { useSessionStore } from "@/stores/sessionStore";
import { filePreviewUrl, previewKind } from "@/lib/generated-files";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];

// Global file-preview overlay, mounted once at the app root and driven by the
// store's `filePreview` target. Every entry point (chips, clickable inline
// paths, …) just calls openFilePreview(relPath); this renders whenever that's
// set for the active session.
export function FilePreview() {
  const target = useSessionStore((s) => s.filePreview);
  const sessionId = useSessionStore((s) => s.session?.id ?? null);
  const onClose = useSessionStore((s) => s.closeFilePreview);

  useEffect(() => {
    if (!target) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [target, onClose]);

  if (!target || !sessionId) return null;
  const url = filePreviewUrl(sessionId, target.path);
  const kind = previewKind(target.name);
  const file = { name: target.name };

  return createPortal(
    <div className="fixed inset-0 z-[100] flex flex-col bg-stone-900/70 backdrop-blur-sm">
      {/* top bar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 bg-white dark:bg-stone-900 border-b border-stone-200 dark:border-stone-700">
        <span className="text-sm">📄</span>
        <span
          className="flex-1 truncate text-[13px] font-medium text-stone-800 dark:text-stone-100"
          title={target.path}
        >
          {file.name}
          <span className="ml-2 text-[11px] font-normal text-stone-400">
            {target.path}
          </span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          ↗ 新标签打开
        </a>
        <button
          onClick={onClose}
          className="px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          ✕ 关闭
        </button>
      </div>
      {/* body */}
      <div className="flex-1 min-h-0 bg-white dark:bg-stone-950 overflow-hidden">
        <PreviewBody kind={kind} url={url} name={file.name} />
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({
  kind,
  url,
  name,
}: {
  kind: ReturnType<typeof previewKind>;
  url: string;
  name: string;
}) {
  if (kind === "html") {
    // Render live but sandboxed: scripts run (dashboards need them) under an
    // opaque origin — no allow-same-origin, so it can't reach the parent /
    // cookies / storage. Relative assets still load via the path-based URL.
    return (
      <iframe
        src={url}
        title={name}
        className="w-full h-full border-0 bg-white"
        sandbox="allow-scripts allow-popups allow-forms allow-modals"
      />
    );
  }
  if (kind === "image") {
    return (
      <div className="w-full h-full overflow-auto flex items-center justify-center p-6 [background:repeating-conic-gradient(#f5f5f4_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:none] dark:bg-stone-900">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={name} className="max-w-full max-h-full object-contain" />
      </div>
    );
  }
  if (kind === "pdf") {
    return <iframe src={url} title={name} className="w-full h-full border-0" />;
  }
  return <TextPreview url={url} markdown={kind === "markdown"} />;
}

function TextPreview({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (alive) setText(t.length > 500_000 ? t.slice(0, 500_000) + "\n\n…（已截断）" : t);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [url]);

  if (error)
    return (
      <div className="p-6 text-sm text-rose-600 dark:text-rose-400">
        读取失败：{error}
      </div>
    );
  if (text === null)
    return <div className="p-6 text-sm text-stone-400">加载中…</div>;

  if (markdown)
    return (
      <div className="h-full overflow-auto">
        <div className="md-body max-w-3xl mx-auto px-6 py-6 text-stone-800 dark:text-stone-200">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    );

  return (
    <pre className="h-full overflow-auto m-0 p-4 text-[12.5px] leading-relaxed text-stone-800 dark:text-stone-200 font-mono whitespace-pre">
      {text}
    </pre>
  );
}
