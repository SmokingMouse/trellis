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
import {
  Code,
  Download,
  ExternalLink,
  Eye,
  FileText,
  Image as ImageIcon,
  Minus,
  Palette,
  Plus,
  Workflow,
  X,
} from "lucide-react";
import {
  Button,
  ErrorCallout,
  Icon,
  IconButton,
  SegmentedControl,
  Spinner,
  toast,
} from "@/components/ui";

// Global file-preview overlay, mounted once at the app root and driven by the
// store's `filePreview` target. Every entry point (chips, clickable inline
// paths, …) just calls openFilePreview(relPath); this renders whenever that's
// set for the active session.
//
// 外壳保留手写全屏层而不是 ui/Modal：这是铺满视口的查看器（HTML / PDF / 大图），
// Modal 只有 md / lg 两档居中宽度。z-60 与 Modal 同层，能盖在工作区文件抽屉（z-50）上。
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
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`预览 ${file.name}`}
      className="fixed inset-0 z-60 flex flex-col bg-scrim/70 backdrop-blur-sm"
    >
      {/* top bar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 bg-surface border-b border-line">
        <Icon
          icon={isSvg || kind === "image" ? ImageIcon : kind === "mermaid" ? Workflow : FileText}
          className="text-ink-faint"
        />
        <span
          className="flex-1 min-w-0 truncate text-ui font-medium text-ink-strong"
          title={target.path}
        >
          {file.name}
          <span className="ml-2 text-label font-normal text-ink-faint">
            {target.path}
          </span>
        </span>
        <Button asChild size="sm" variant="ghost">
          <a href={url} target="_blank" rel="noreferrer">
            <Icon icon={ExternalLink} size="sm" />
            新标签打开
          </a>
        </Button>
        <IconButton label="关闭预览" shortcut="Esc" onClick={onClose} autoFocus>
          <Icon icon={X} />
        </IconButton>
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

// 透明图的衬底：刻意用固定的黑 / 白 / 棋盘格（看图用的「画布」，不随皮肤走）。
const BG_CLASSES: Record<BgMode, string> = {
  checkered:
    "[background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/20px_20px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.3)_0%_50%)_50%/20px_20px]",
  white: "bg-white",
  dark: "bg-[#141414]",
};
const BG_LABEL: Record<BgMode, string> = { checkered: "棋盘格底", white: "白底", dark: "深色底" };
const NEXT_BG: Record<BgMode, BgMode> = { checkered: "white", white: "dark", dark: "checkered" };

// SVG / Mermaid 共用的查看器工具条：预览 / 源码切换、缩放、衬底、复制源码、下载。
function ViewerToolbar({
  mode,
  onMode,
  scale,
  onScale,
  bg,
  onBg,
  source,
  onDownload,
  downloadLabel,
}: {
  mode: "preview" | "code";
  onMode: (m: "preview" | "code") => void;
  scale: number;
  onScale: (fn: (s: number) => number) => void;
  bg: BgMode;
  onBg: (b: BgMode) => void;
  source: string | null;
  onDownload: () => void;
  downloadLabel: string;
}) {
  const copy = async () => {
    if (!source) return;
    try {
      await copyText(source);
      toast.success("已复制源码");
    } catch {
      toast.error("复制失败", { description: "浏览器拒绝了剪贴板访问，手动选中源码复制。" });
    }
  };
  return (
    <div className="shrink-0 flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-surface border-b border-line">
      <SegmentedControl
        size="sm"
        aria-label="查看方式"
        value={mode}
        onValueChange={onMode}
        options={[
          { value: "preview", label: "预览", icon: Eye },
          { value: "code", label: "源码", icon: Code },
        ]}
      />
      <div className="flex items-center gap-1.5">
        {mode === "preview" && (
          <>
            <IconButton label="缩小" size="sm" onClick={() => onScale((s) => Math.max(0.2, s - 0.2))}>
              <Icon icon={Minus} size="sm" />
            </IconButton>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => onScale(() => 1)}
              title="重置缩放"
              className="font-mono tabular-nums"
            >
              {Math.round(scale * 100)}%
            </Button>
            <IconButton label="放大" size="sm" onClick={() => onScale((s) => Math.min(4, s + 0.2))}>
              <Icon icon={Plus} size="sm" />
            </IconButton>
            <Button size="sm" variant="ghost" onClick={() => onBg(NEXT_BG[bg])} title="切换衬底">
              <Icon icon={Palette} size="sm" />
              {BG_LABEL[bg]}
            </Button>
          </>
        )}
        {source && (
          <>
            <Button size="sm" onClick={() => void copy()}>
              复制源码
            </Button>
            <Button size="sm" variant="primary" onClick={onDownload}>
              <Icon icon={Download} size="sm" />
              {downloadLabel}
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

function MermaidFilePreview({ url, name }: { url: string; name: string }) {
  const [mode, setMode] = useState<"preview" | "code">("preview");
  const [scale, setScale] = useState(1);
  const [bg, setBg] = useState<BgMode>("checkered");
  const [codeText, setCodeText] = useState<string | null>(null);
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      <ViewerToolbar
        mode={mode}
        onMode={setMode}
        scale={scale}
        onScale={setScale}
        bg={bg}
        onBg={setBg}
        source={codeText}
        onDownload={handleDownload}
        downloadLabel="下载 SVG"
      />

      {/* Body Viewport */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === "preview" ? (
          <div
            className={`w-full h-full min-h-75 overflow-auto flex items-center justify-center p-8 transition-colors ${BG_CLASSES[bg]}`}
          >
            {error ? (
              <ErrorCallout
                className="max-w-md"
                error={error}
                title="图表渲染失败"
                hint="Mermaid 语法可能有误，切到源码看看。"
                action={
                  <Button size="sm" onClick={() => setMode("code")}>
                    查看源码
                  </Button>
                }
              />
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
              <Spinner label="正在渲染图表" />
            )}
          </div>
        ) : codeText === null ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <pre className="h-full overflow-auto m-0 p-4 text-ui leading-relaxed text-ink font-mono whitespace-pre bg-surface">
            {codeText}
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

  if (error) return <ReadError error={error} />;

  return (
    <div className="flex flex-col h-full">
      <ViewerToolbar
        mode={mode}
        onMode={setMode}
        scale={scale}
        onScale={setScale}
        bg={bg}
        onBg={setBg}
        source={svgText}
        onDownload={() => svgText && downloadSvgFile(svgText, name)}
        downloadLabel="下载"
      />

      {/* Body Viewport */}
      <div className="flex-1 min-h-0 overflow-auto">
        {mode === "preview" ? (
          <div
            className={`w-full h-full min-h-75 overflow-auto flex items-center justify-center p-8 transition-colors ${BG_CLASSES[bg]}`}
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
        ) : svgText === null ? (
          <div className="p-6">
            <Spinner />
          </div>
        ) : (
          <pre className="h-full overflow-auto m-0 p-4 text-ui leading-relaxed text-ink font-mono whitespace-pre bg-surface">
            {svgText}
          </pre>
        )}
      </div>
    </div>
  );
}

// 读文件失败：404 多半是路径越出了本会话可预览范围，单独给一句能看懂的话。
function ReadError({ error }: { error: string }) {
  const notFound = error.includes("404");
  return (
    <div className="p-6 max-w-xl">
      <ErrorCallout
        error={error}
        title={notFound ? "读不到这个文件" : "读取文件失败"}
        hint={
          notFound
            ? "文件不存在，或不在本会话的可预览范围内（工作区目录 + 本会话写过的文件）。"
            : undefined
        }
      />
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

  if (error) return <ReadError error={error} />;
  if (text === null)
    return (
      <div className="p-6">
        <Spinner />
      </div>
    );

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
