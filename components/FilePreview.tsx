"use client";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "@/lib/markdown-plugins";
import { useSessionStore } from "@/stores/sessionStore";
import { filePreviewUrl, previewKind } from "@/lib/generated-files";
import { copyText } from "@/lib/clipboard";
import { createSvgBlobUrl, downloadSvgFile } from "@/lib/svg";
import { renderMermaidToSvg } from "@/lib/mermaid";

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
  const isSvg = target.name.toLowerCase().endsWith(".svg");

  return createPortal(
    <div className="fixed inset-0 z-[60] flex flex-col bg-scrim/70 backdrop-blur-sm">
      {/* top bar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 bg-surface border-b border-line">
        <span className="text-sm">
          {isSvg ? "🖼" : kind === "mermaid" ? "📊" : "📄"}
        </span>
        <span
          className="flex-1 truncate text-ui font-medium text-ink-strong"
          title={target.path}
        >
          {file.name}
          <span className="ml-2 text-label font-normal text-ink-faint">
            {target.path}
          </span>
        </span>
        <a
          href={url}
          target="_blank"
          rel="noreferrer"
          className="px-2.5 py-1 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted transition-colors"
        >
          ↗ 新标签打开
        </a>
        <button
          onClick={onClose}
          className="px-2.5 py-1 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted transition-colors"
        >
          ✕ 关闭
        </button>
      </div>
      {/* body */}
      <div className="flex-1 min-h-0 bg-surface-canvas overflow-hidden">
        <PreviewBody kind={kind} url={url} name={file.name} isSvg={isSvg} />
      </div>
    </div>,
    document.body,
  );
}

function PreviewBody({
  kind,
  url,
  name,
  isSvg,
}: {
  kind: ReturnType<typeof previewKind>;
  url: string;
  name: string;
  isSvg?: boolean;
}) {
  if (isSvg) {
    return <SvgFilePreview url={url} name={name} />;
  }
  if (kind === "mermaid") {
    return <MermaidFilePreview url={url} name={name} />;
  }

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
      <div className="w-full h-full overflow-auto flex items-center justify-center p-6 [background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:none] dark:bg-surface">
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

type BgMode = "checkered" | "white" | "dark";

function MermaidFilePreview({ url, name }: { url: string; name: string }) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [scale, setScale] = useState(1);
  const [bg, setBg] = useState<BgMode>("checkered");
  const [codeText, setCodeText] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (!alive) return;
        setCodeText(t);
        const isDark =
          typeof document !== "undefined" &&
          document.documentElement.classList.contains("dark");
        return renderMermaidToSvg(t, isDark);
      })
      .then((res) => {
        if (!alive || !res) return;
        if (res.error || !res.svg) {
          setError(res.error || "Mermaid 图表解析失败");
        } else {
          const bUrl = createSvgBlobUrl(res.svg);
          setBlobUrl(bUrl);
          setError(null);
        }
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [url]);

  const bgClasses: Record<BgMode, string> = {
    checkered:
      "[background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.3)_0%_50%)_50%/20px_20px]",
    white: "bg-white",
    dark: "bg-[#141414]",
  };

  const handleCopy = async () => {
    if (!codeText) return;
    try {
      await copyText(codeText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    if (blobUrl) {
      fetch(blobUrl)
        .then((r) => r.text())
        .then((svg) => downloadSvgFile(svg, `${name}.svg`))
        .catch(() => downloadSvgFile(codeText || "", `${name}.txt`));
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Sub-toolbar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-surface border-b border-line text-ui">
        {/* Left: Mode switcher */}
        <div className="inline-flex rounded-md p-0.5 bg-surface-muted border border-line text-label">
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`px-3 py-1 rounded transition-colors ${
              mode === "preview"
                ? "bg-accent text-white font-medium shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            👁 视觉图表
          </button>
          <button
            type="button"
            onClick={() => setMode("code")}
            className={`px-3 py-1 rounded transition-colors ${
              mode === "code"
                ? "bg-accent text-white font-medium shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            📄 源码查看
          </button>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {mode === "preview" && (
            <>
              {/* Zoom controls */}
              <div className="inline-flex items-center rounded-md border border-line bg-surface p-0.5 text-label">
                <button
                  type="button"
                  onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink"
                  title="缩小"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => setScale(1)}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink font-mono text-nano"
                  title="重置"
                >
                  {Math.round(scale * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => setScale((s) => Math.min(4, s + 0.2))}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink"
                  title="放大"
                >
                  +
                </button>
              </div>

              {/* Background switch */}
              <button
                type="button"
                onClick={() =>
                  setBg((b) =>
                    b === "checkered"
                      ? "white"
                      : b === "white"
                        ? "dark"
                        : "checkered",
                  )
                }
                className="px-2.5 py-1 rounded border border-line bg-surface text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
              >
                {bg === "checkered"
                  ? "🎨 网格底"
                  : bg === "white"
                    ? "🎨 白底"
                    : "🎨 暗底"}
              </button>
            </>
          )}

          {codeText && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="px-2.5 py-1 rounded border border-line bg-surface text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
              >
                {copied ? "✓ 已复制源码" : "复制源码"}
              </button>
              <button
                type="button"
                onClick={handleDownload}
                className="px-2.5 py-1 rounded bg-accent text-white text-label hover:opacity-90 transition-opacity"
              >
                ⤓ 下载 SVG
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body Viewport */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === "preview" ? (
          <div
            className={`w-full h-full min-h-[300px] overflow-auto flex items-center justify-center p-8 transition-colors ${bgClasses[bg]}`}
          >
            {error ? (
              <div className="p-4 bg-warn-muted/80 border border-warn-line rounded-lg text-warn-ink text-ui max-w-md text-center">
                <div className="font-semibold mb-1">⚠️ 图表渲染失败</div>
                <div className="text-label mb-2">{error}</div>
                <button
                  type="button"
                  onClick={() => setMode("code")}
                  className="px-2.5 py-1 rounded bg-surface border border-line text-ink text-label hover:bg-surface-muted"
                >
                  查看源码
                </button>
              </div>
            ) : blobUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={blobUrl}
                alt={name}
                style={{
                  transform: `scale(${scale})`,
                  transformOrigin: "center center",
                  transition: "transform 120ms ease-out",
                }}
                className="max-w-full max-h-full object-contain"
              />
            ) : (
              <div className="text-ink-faint text-label">渲染图表中…</div>
            )}
          </div>
        ) : (
          <pre className="h-full overflow-auto m-0 p-4 text-ui leading-relaxed text-ink font-mono whitespace-pre bg-surface">
            {codeText || "加载源码中…"}
          </pre>
        )}
      </div>
    </div>
  );
}

function SvgFilePreview({ url, name }: { url: string; name: string }) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [scale, setScale] = useState(1);
  const [bg, setBg] = useState<BgMode>("checkered");
  const [svgText, setSvgText] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then((t) => {
        if (alive) setSvgText(t);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
    };
  }, [url]);

  const bgClasses: Record<BgMode, string> = {
    checkered:
      "[background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.3)_0%_50%)_50%/20px_20px]",
    white: "bg-white",
    dark: "bg-[#141414]",
  };

  const handleCopy = async () => {
    if (!svgText) return;
    try {
      await copyText(svgText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  if (error) {
    return (
      <div className="p-6 text-sm text-danger">
        {error.includes("404")
          ? "无法读取：文件不存在，或不在本会话可预览范围"
          : `读取失败：${error}`}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Sub-toolbar */}
      <div className="shrink-0 flex items-center justify-between px-4 py-2 bg-surface border-b border-line text-ui">
        {/* Left: Mode switcher */}
        <div className="inline-flex rounded-md p-0.5 bg-surface-muted border border-line text-label">
          <button
            type="button"
            onClick={() => setMode("preview")}
            className={`px-3 py-1 rounded transition-colors ${
              mode === "preview"
                ? "bg-accent text-white font-medium shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            👁 视觉预览
          </button>
          <button
            type="button"
            onClick={() => setMode("code")}
            className={`px-3 py-1 rounded transition-colors ${
              mode === "code"
                ? "bg-accent text-white font-medium shadow-sm"
                : "text-ink-muted hover:text-ink"
            }`}
          >
            📄 源码查看
          </button>
        </div>

        {/* Right controls */}
        <div className="flex items-center gap-2">
          {mode === "preview" && (
            <>
              {/* Zoom controls */}
              <div className="inline-flex items-center rounded-md border border-line bg-surface p-0.5 text-label">
                <button
                  type="button"
                  onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink"
                  title="缩小"
                >
                  −
                </button>
                <button
                  type="button"
                  onClick={() => setScale(1)}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink font-mono text-nano"
                  title="重置"
                >
                  {Math.round(scale * 100)}%
                </button>
                <button
                  type="button"
                  onClick={() => setScale((s) => Math.min(4, s + 0.2))}
                  className="px-2 py-0.5 hover:bg-surface-muted rounded text-ink"
                  title="放大"
                >
                  +
                </button>
              </div>

              {/* Background switch */}
              <button
                type="button"
                onClick={() =>
                  setBg((b) =>
                    b === "checkered"
                      ? "white"
                      : b === "white"
                        ? "dark"
                        : "checkered",
                  )
                }
                className="px-2.5 py-1 rounded border border-line bg-surface text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
              >
                {bg === "checkered"
                  ? "🎨 网格底"
                  : bg === "white"
                    ? "🎨 白底"
                    : "🎨 暗底"}
              </button>
            </>
          )}

          {svgText && (
            <>
              <button
                type="button"
                onClick={handleCopy}
                className="px-2.5 py-1 rounded border border-line bg-surface text-label text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
              >
                {copied ? "✓ 已复制源码" : "复制 SVG"}
              </button>
              <button
                type="button"
                onClick={() => downloadSvgFile(svgText, name)}
                className="px-2.5 py-1 rounded bg-accent text-white text-label hover:opacity-90 transition-opacity"
              >
                ⤓ 下载
              </button>
            </>
          )}
        </div>
      </div>

      {/* Body Viewport */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === "preview" ? (
          <div
            className={`w-full h-full min-h-[300px] overflow-auto flex items-center justify-center p-8 transition-colors ${bgClasses[bg]}`}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={url}
              alt={name}
              style={{
                transform: `scale(${scale})`,
                transformOrigin: "center center",
                transition: "transform 120ms ease-out",
              }}
              className="max-w-full max-h-full object-contain"
            />
          </div>
        ) : (
          <pre className="h-full overflow-auto m-0 p-4 text-ui leading-relaxed text-ink font-mono whitespace-pre bg-surface">
            {svgText || "加载源码中…"}
          </pre>
        )}
      </div>
    </div>
  );
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
      <div className="p-6 text-sm text-danger">
        {error.includes("404")
          ? "无法读取：文件不存在，或不在本会话可预览范围（workspace + 本会话写过的文件）"
          : `读取失败：${error}`}
      </div>
    );
  if (text === null)
    return <div className="p-6 text-sm text-ink-faint">加载中…</div>;

  if (markdown)
    return (
      <div className="h-full overflow-auto">
        <div className="md-body max-w-3xl mx-auto px-6 py-6 text-ink">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_REMARK_PLUGINS}
            rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
            components={MD_COMPONENTS}
            urlTransform={MD_URL_TRANSFORM}
          >
            {text}
          </ReactMarkdown>
        </div>
      </div>
    );

  return (
    <pre className="h-full overflow-auto m-0 p-4 text-ui leading-relaxed text-ink font-mono whitespace-pre">
      {text}
    </pre>
  );
}
