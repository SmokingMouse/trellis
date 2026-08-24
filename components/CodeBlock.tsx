"use client";
import {
  useRef,
  useState,
  useEffect,
  isValidElement,
  type ReactNode,
  type MouseEvent,
} from "react";
import { createPortal } from "react-dom";
import { copyText } from "@/lib/clipboard";
import {
  isSvgCode,
  createSvgBlobUrl,
  downloadSvgFile,
  validateSvgSyntax,
} from "@/lib/svg";
import { isMermaidCode, renderMermaidToSvg } from "@/lib/mermaid";

function langOf(children: ReactNode): string {
  if (isValidElement(children)) {
    const cn = (children.props as { className?: string }).className ?? "";
    const m = /language-([\w-]+)/.exec(cn);
    if (m) return m[1];
  }
  return "";
}

function extractText(node: ReactNode): string {
  if (node === null || node === undefined) return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(extractText).join("");
  if (isValidElement(node)) {
    return extractText((node.props as { children?: ReactNode }).children);
  }
  return "";
}

type BgMode = "checkered" | "white" | "dark";

export function CodeBlock({
  children,
}: {
  children?: ReactNode;
  node?: unknown;
}) {
  const preRef = useRef<HTMLPreElement>(null);
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const lang = langOf(children);

  // Extract raw text to detect if this block is an SVG or Mermaid diagram
  const codeText = extractText(children);
  const isSvg = isSvgCode(codeText, lang);
  const isMermaid = !isSvg && isMermaidCode(codeText, lang);
  const isDiagram = isSvg || isMermaid;

  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [bg, setBg] = useState<BgMode>("checkered");
  const [isZoomed, setIsZoomed] = useState(false);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [diagramError, setDiagramError] = useState<string | null>(null);

  // Generate safe SVG Blob URL for SVG or Mermaid diagrams
  useEffect(() => {
    if (!isDiagram || !codeText) return;
    let active = true;
    let createdUrl: string | null = null;

    if (isSvg) {
      const validation = validateSvgSyntax(codeText);
      if (!validation.valid) {
        setDiagramError(validation.error || "SVG 语法格式有误");
        return;
      }
      try {
        createdUrl = createSvgBlobUrl(codeText);
        setBlobUrl(createdUrl);
        setDiagramError(null);
      } catch {
        setDiagramError("SVG 解析生成失败");
      }
    } else if (isMermaid) {
      const isDark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");

      void renderMermaidToSvg(codeText, isDark).then(({ svg, error }) => {
        if (!active) return;
        if (error || !svg) {
          setDiagramError(error || "Mermaid 语法格式错误");
          setBlobUrl(null);
        } else {
          try {
            createdUrl = createSvgBlobUrl(svg);
            setBlobUrl(createdUrl);
            setDiagramError(null);
          } catch {
            setDiagramError("Mermaid SVG 生成失败");
          }
        }
      });
    }

    return () => {
      active = false;
      if (createdUrl) {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [isDiagram, isSvg, isMermaid, codeText]);

  const copy = async (e: MouseEvent) => {
    e.stopPropagation();
    const text = codeText || (preRef.current?.textContent ?? "");
    if (!text) return;
    try {
      await copyText(text);
      setFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("[trellis] code copy failed:", err);
      setFailed(true);
      window.setTimeout(() => setFailed(false), 2000);
    }
  };

  const cycleBg = (e: MouseEvent) => {
    e.stopPropagation();
    setBg((prev) =>
      prev === "checkered" ? "white" : prev === "white" ? "dark" : "checkered",
    );
  };

  const handleDownload = (e: MouseEvent) => {
    e.stopPropagation();
    if (isSvg) {
      downloadSvgFile(codeText, "diagram.svg");
    } else if (isMermaid) {
      // If we have rendered the diagram, fetch the blob and download
      if (blobUrl) {
        fetch(blobUrl)
          .then((r) => r.text())
          .then((svgStr) => downloadSvgFile(svgStr, "mermaid-diagram.svg"))
          .catch(() => downloadSvgFile(codeText, "diagram.txt"));
      }
    }
  };

  // If this is not a diagram codeblock, render the standard code block
  if (!isDiagram) {
    return (
      <div className="md-codeblock">
        <div className="md-codeblock-bar" contentEditable={false}>
          <span className="md-codeblock-lang">{lang || "code"}</span>
          <button
            type="button"
            onClick={copy}
            className="md-codeblock-copy nodrag"
            aria-label="复制代码"
          >
            {failed ? "✗ 失败" : copied ? "✓ 已复制" : "复制"}
          </button>
        </div>
        <pre ref={preRef}>{children}</pre>
      </div>
    );
  }

  const bgClasses: Record<BgMode, string> = {
    checkered:
      "[background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/16px_16px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.2)_0%_50%)_50%/16px_16px]",
    white: "bg-white",
    dark: "bg-[#141414]",
  };

  const bgLabels: Record<BgMode, string> = {
    checkered: "背景: 网格",
    white: "背景: 亮色",
    dark: "背景: 暗色",
  };

  const badgeText = isSvg ? "SVG" : "Mermaid";

  return (
    <div className="md-codeblock my-3 rounded-card border border-line overflow-hidden shadow-raise">
      {/* Top action bar */}
      <div
        className="md-codeblock-bar flex items-center justify-between gap-2 px-3 py-1.5 bg-surface-muted/90 border-b border-line text-ui text-ink select-none"
        contentEditable={false}
      >
        {/* Left: Diagram badge + Mode switcher */}
        <div className="flex items-center gap-1.5">
          <span className="px-1.5 py-0.5 rounded text-nano font-mono font-semibold bg-accent-muted text-accent-ink border border-accent-line">
            {badgeText}
          </span>
          <div className="inline-flex rounded-md p-0.5 bg-surface border border-line text-label">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMode("preview");
              }}
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === "preview"
                  ? "bg-accent text-ink-inverse font-medium shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              👁 预览
            </button>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                setMode("code");
              }}
              className={`px-2 py-0.5 rounded transition-colors ${
                mode === "code"
                  ? "bg-accent text-ink-inverse font-medium shadow-sm"
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              📄 源码
            </button>
          </div>
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-1.5">
          {mode === "preview" && (
            <>
              <button
                type="button"
                onClick={cycleBg}
                title="切换图形预览背景（网格 / 亮色 / 暗色）"
                className="px-2 py-0.5 rounded text-label text-ink-muted bg-surface hover:bg-surface-raised border border-line transition-colors"
              >
                {bgLabels[bg]}
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsZoomed(true);
                }}
                title="全屏放大查看"
                className="px-2 py-0.5 rounded text-label text-ink-muted bg-surface hover:bg-surface-raised border border-line transition-colors"
              >
                🔍 放大
              </button>
              <button
                type="button"
                onClick={handleDownload}
                title="下载为 .svg 矢量图"
                className="px-2 py-0.5 rounded text-label text-ink-muted bg-surface hover:bg-surface-raised border border-line transition-colors"
              >
                ⤓ 下载
              </button>
            </>
          )}
          <button
            type="button"
            onClick={copy}
            className="md-codeblock-copy nodrag text-label"
            aria-label="复制代码"
          >
            {failed ? "✗ 失败" : copied ? "✓ 已复制" : "复制"}
          </button>
        </div>
      </div>

      {/* Main body: Preview or Code */}
      {mode === "preview" ? (
        <div
          className={`relative min-h-[160px] max-h-[520px] overflow-auto flex items-center justify-center p-6 transition-colors ${bgClasses[bg]}`}
        >
          {diagramError ? (
            <div className="text-center p-4 bg-warn-muted/80 border border-warn-line rounded-lg text-warn-ink text-ui max-w-md">
              <div className="font-semibold mb-1">⚠️ {diagramError}</div>
              <p className="text-label opacity-90 mb-2">
                当前图表语法有误或模型尚未完全输出闭合标签。
              </p>
              <button
                type="button"
                onClick={() => setMode("code")}
                className="px-2.5 py-1 rounded bg-surface border border-line text-ink text-label hover:bg-surface-muted"
              >
                查看代码源码
              </button>
            </div>
          ) : blobUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={blobUrl}
              alt={`${badgeText} Diagram Preview`}
              onClick={() => setIsZoomed(true)}
              className="max-w-full max-h-[460px] object-contain cursor-zoom-in transition-transform duration-150 hover:scale-[1.01]"
              title="点击放大查看"
            />
          ) : (
            <div className="text-ink-faint text-label">图表渲染中…</div>
          )}
        </div>
      ) : (
        <pre ref={preRef} className="m-0 !rounded-none">
          {children}
        </pre>
      )}

      {/* Zoom Modal */}
      {isZoomed && blobUrl && (
        <DiagramZoomModal
          title={`${badgeText} 图表预览`}
          blobUrl={blobUrl}
          code={codeText}
          isSvg={isSvg}
          bg={bg}
          onBgChange={setBg}
          onClose={() => setIsZoomed(false)}
        />
      )}
    </div>
  );
}

function DiagramZoomModal({
  title,
  blobUrl,
  code,
  isSvg,
  bg,
  onBgChange,
  onClose,
}: {
  title: string;
  blobUrl: string;
  code: string;
  isSvg: boolean;
  bg: BgMode;
  onBgChange: (bg: BgMode) => void;
  onClose: () => void;
}) {
  const [scale, setScale] = useState(1);
  const [copied, setCopied] = useState(false);

  const bgClasses: Record<BgMode, string> = {
    checkered:
      "[background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.3)_0%_50%)_50%/20px_20px]",
    white: "bg-white",
    dark: "bg-[#141414]",
  };

  const handleCopy = async () => {
    try {
      await copyText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  };

  const handleDownload = () => {
    if (isSvg) {
      downloadSvgFile(code, "diagram.svg");
    } else {
      fetch(blobUrl)
        .then((r) => r.text())
        .then((svgStr) => downloadSvgFile(svgStr, "mermaid-diagram.svg"))
        .catch(() => downloadSvgFile(code, "diagram.txt"));
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center p-4 bg-scrim/70 backdrop-blur-sm ui-enter-fade"
      onClick={onClose}
    >
      <div
        className="w-full max-w-5xl h-[85vh] flex flex-col bg-surface rounded-overlay shadow-overlay overflow-hidden border border-line ui-enter-pop"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {/* Modal Top Bar */}
        <div className="shrink-0 flex items-center justify-between px-5 h-13 border-b border-line bg-surface-muted/60">
          <div className="flex items-center gap-2">
            <span className="font-semibold text-ui text-ink-strong">
              {title}
            </span>
            <span className="text-label text-ink-faint">
              ({Math.round(scale * 100)}%)
            </span>
          </div>

          <div className="flex items-center gap-2">
            {/* Zoom Controls */}
            <div className="inline-flex items-center rounded-md border border-line bg-surface p-0.5 text-label">
              <button
                type="button"
                onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}
                className="px-2 py-1 hover:bg-surface-muted rounded text-ink"
                title="缩小"
              >
                −
              </button>
              <button
                type="button"
                onClick={() => setScale(1)}
                className="px-2 py-1 hover:bg-surface-muted rounded text-ink font-mono"
                title="重置 100%"
              >
                1:1
              </button>
              <button
                type="button"
                onClick={() => setScale((s) => Math.min(4, s + 0.2))}
                className="px-2 py-1 hover:bg-surface-muted rounded text-ink"
                title="放大"
              >
                +
              </button>
            </div>

            {/* Background toggle */}
            <button
              type="button"
              onClick={() =>
                onBgChange(
                  bg === "checkered"
                    ? "white"
                    : bg === "white"
                      ? "dark"
                      : "checkered",
                )
              }
              className="px-2.5 py-1 rounded border border-line bg-surface text-ui text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
            >
              {bg === "checkered"
                ? "🎨 网格底"
                : bg === "white"
                  ? "🎨 白底"
                  : "🎨 暗底"}
            </button>

            {/* Copy button */}
            <button
              type="button"
              onClick={handleCopy}
              className="px-2.5 py-1 rounded border border-line bg-surface text-ui text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
            >
              {copied ? "✓ 已复制源码" : "复制代码"}
            </button>

            {/* Download button */}
            <button
              type="button"
              onClick={handleDownload}
              className="px-2.5 py-1 rounded bg-accent text-white text-ui hover:opacity-90 transition-opacity"
            >
              ⤓ 下载 SVG
            </button>

            {/* Close button */}
            <button
              type="button"
              onClick={onClose}
              className="ml-2 w-8 h-8 flex items-center justify-center rounded text-ink-muted hover:bg-surface-muted hover:text-ink transition-colors"
              aria-label="关闭"
            >
              ✕
            </button>
          </div>
        </div>

        {/* Modal Canvas Viewport */}
        <div
          className={`flex-1 overflow-auto flex items-center justify-center p-8 select-none transition-colors ${bgClasses[bg]}`}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={blobUrl}
            alt="Full Diagram Preview"
            style={{
              transform: `scale(${scale})`,
              transformOrigin: "center center",
              transition: "transform 120ms ease-out",
            }}
            className="max-w-full max-h-full object-contain pointer-events-auto"
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
