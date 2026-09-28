"use client";
import {
  useRef,
  useState,
  useEffect,
  isValidElement,
  type ReactNode,
  type MouseEvent,
} from "react";
import {
  Check,
  Code,
  Copy,
  Download,
  Eye,
  Maximize2,
  Minus,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import { copyText } from "@/lib/clipboard";
import { Button, Icon, IconButton, Modal, SegmentedControl } from "@/components/ui";
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

  const copyLabel = failed ? "复制失败" : copied ? "已复制" : "复制";
  const copyIcon = failed ? X : copied ? Check : Copy;

  // If this is not a diagram codeblock, render the standard code block
  if (!isDiagram) {
    return (
      <div className="md-codeblock">
        <div className="md-codeblock-bar" contentEditable={false}>
          <span className="md-codeblock-lang">{lang || "code"}</span>
          <button
            type="button"
            data-mobile-target="code-copy"
            onClick={copy}
            className="md-codeblock-copy nodrag"
            aria-label="复制代码"
          >
            <Icon icon={copyIcon} size="sm" />
            {copyLabel}
          </button>
        </div>
        <pre ref={preRef}>{children}</pre>
      </div>
    );
  }

  const bgLabels: Record<BgMode, string> = {
    checkered: "背景：网格",
    white: "背景：亮色",
    dark: "背景：暗色",
  };

  const badgeText = isSvg ? "SVG" : "Mermaid";

  return (
    <div className="md-codeblock md-codeblock-diagram">
      {/* Top action bar */}
      <div
        className="md-codeblock-bar flex items-center justify-between gap-2 px-2 py-1 bg-surface-muted border-b border-line text-ui text-ink select-none"
        contentEditable={false}
      >
        {/* Left: Diagram badge + Mode switcher */}
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          <span className="px-1.5 font-mono text-label text-ink-muted">
            {badgeText}
          </span>
          <SegmentedControl
            size="sm"
            aria-label="图表视图"
            value={mode}
            onValueChange={setMode}
            options={[
              { value: "preview", label: "预览", icon: Eye },
              { value: "code", label: "源码", icon: Code },
            ]}
          />
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-0.5">
          {mode === "preview" && (
            <>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={cycleBg}
                title="切换图形预览背景（网格 / 亮色 / 暗色）"
              >
                {bgLabels[bg]}
              </Button>
              <IconButton
                size="sm"
                label="全屏放大查看"
                onClick={(e) => {
                  e.stopPropagation();
                  setIsZoomed(true);
                }}
              >
                <Icon icon={Maximize2} size="sm" />
              </IconButton>
              <IconButton size="sm" label="下载为 .svg 矢量图" onClick={handleDownload}>
                <Icon icon={Download} size="sm" />
              </IconButton>
            </>
          )}
          <IconButton size="sm" label={failed ? "复制失败" : copied ? "已复制" : "复制代码"} onClick={copy} className="nodrag">
            <Icon icon={copyIcon} size="sm" />
          </IconButton>
        </div>
      </div>

      {/* Main body: Preview or Code */}
      {mode === "preview" ? (
        <div
          className={`relative min-h-40 max-h-128 overflow-auto flex items-center justify-center p-6 transition-colors ${DIAGRAM_BG[bg]}`}
        >
          {diagramError ? (
            <div className="text-center p-4 bg-surface border border-warn-line rounded-card text-ink text-ui max-w-md">
              <div className="font-medium mb-1 flex items-center justify-center gap-1.5 text-warn-ink">
                <Icon icon={TriangleAlert} size="sm" />
                {diagramError}
              </div>
              <p className="text-label text-ink-muted mb-2">
                当前图表语法有误或模型尚未完全输出闭合标签。
              </p>
              <Button type="button" size="sm" onClick={() => setMode("code")}>
                查看源码
              </Button>
            </div>
          ) : blobUrl ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={blobUrl}
              alt={`${badgeText} Diagram Preview`}
              onClick={() => setIsZoomed(true)}
              className="max-w-full max-h-116 object-contain cursor-zoom-in"
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

// 图表预览背景：网格 / 亮色 / 暗色。网格与暗色在 globals.css 里取主题变量。
const DIAGRAM_BG: Record<BgMode, string> = {
  checkered: "diagram-bg-checkered",
  white: "bg-white",
  dark: "code-surface",
};

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

  return (
    <Modal
      onClose={onClose}
      size="lg"
      title={title}
      closeOnEsc="always"
      panelClassName="flex h-5/6 flex-col md:max-w-5xl"
    >
      {/* Modal Top Bar */}
      <div className="shrink-0 flex items-center justify-between gap-2 px-4 h-12 border-b border-line">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-ui text-ink-strong truncate">
            {title}
          </span>
          <span className="text-label text-ink-faint tabular-nums">
            {Math.round(scale * 100)}%
          </span>
        </div>

        <div className="flex items-center gap-1">
          <IconButton size="sm" label="缩小" onClick={() => setScale((s) => Math.max(0.2, s - 0.2))}>
            <Icon icon={Minus} size="sm" />
          </IconButton>
          <Button type="button" variant="ghost" size="sm" className="font-mono" onClick={() => setScale(1)} title="重置 100%">
            1:1
          </Button>
          <IconButton size="sm" label="放大" onClick={() => setScale((s) => Math.min(4, s + 0.2))}>
            <Icon icon={Plus} size="sm" />
          </IconButton>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() =>
              onBgChange(
                bg === "checkered" ? "white" : bg === "white" ? "dark" : "checkered",
              )
            }
          >
            {bg === "checkered" ? "网格底" : bg === "white" ? "白底" : "暗底"}
          </Button>
          <Button type="button" variant="ghost" size="sm" onClick={handleCopy}>
            <Icon icon={copied ? Check : Copy} size="sm" />
            {copied ? "已复制源码" : "复制源码"}
          </Button>
          <Button type="button" variant="secondary" size="sm" onClick={handleDownload}>
            <Icon icon={Download} size="sm" />
            下载 SVG
          </Button>
          <IconButton size="sm" label="关闭" shortcut="Esc" onClick={onClose} className="ml-1">
            <Icon icon={X} size="sm" />
          </IconButton>
        </div>
      </div>

      {/* Modal Canvas Viewport */}
      <div
        className={`flex-1 min-h-0 overflow-auto flex items-center justify-center p-8 select-none transition-colors ${DIAGRAM_BG[bg]}`}
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
    </Modal>
  );
}
