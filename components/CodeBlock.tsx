"use client";
import {
  useContext,
  useMemo,
  useState,
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
  Palette,
  TriangleAlert,
  X,
} from "lucide-react";
import { copyText } from "@/lib/clipboard";
import {
  Button,
  Dots,
  Icon,
  IconButton,
  SegmentedControl,
  Spinner,
  cn,
  toast,
} from "@/components/ui";
import {
  isSvgCode,
  downloadSvgFile,
  normalizeSvg,
  readSvgSize,
  svgToDataUrl,
  toWellFormedSvg,
  validateSvgSyntax,
} from "@/lib/svg";
import { isMermaidCode, renderMermaidForExport } from "@/lib/mermaid";
import { MarkdownStreamingContext } from "@/lib/markdown-streaming";
import { useMermaidSvg } from "@/hooks/useMermaidSvg";
import { DiagramPreview } from "@/components/diagram/DiagramPreview";
import { DiagramViewer } from "@/components/diagram/DiagramViewer";
import {
  DIAGRAM_BACKGROUND_CLASS,
  type DiagramBackground,
} from "@/components/diagram/DiagramCanvas";

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

type Mode = "preview" | "code";

export function CodeBlock({
  children,
}: {
  children?: ReactNode;
  node?: unknown;
}) {
  const lang = langOf(children);
  const codeText = extractText(children);
  if (isSvgCode(codeText, lang)) return <SvgBlock code={codeText}>{children}</SvgBlock>;
  if (isMermaidCode(codeText, lang)) return <MermaidBlock code={codeText}>{children}</MermaidBlock>;

  return <PlainCodeBlock lang={lang} code={codeText}>{children}</PlainCodeBlock>;
}

function useCopyFeedback(text: string) {
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  const copy = async (e?: MouseEvent) => {
    e?.stopPropagation();
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
  return {
    copy,
    copied,
    failed,
    icon: failed ? X : copied ? Check : Copy,
  };
}

function PlainCodeBlock({
  lang,
  code,
  children,
}: {
  lang: string;
  code: string;
  children?: ReactNode;
}) {
  const { copy, copied, failed, icon } = useCopyFeedback(code);
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
          <Icon icon={icon} size="sm" />
          {failed ? "复制失败" : copied ? "已复制" : "复制"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

// 图表块外壳：标题条（类型 + 预览 / 源码切换 + 动作）+ 预览区或源码。
function DiagramShell({
  badge,
  mode,
  onMode,
  actions,
  code,
  highlighted,
  preview,
  children,
}: {
  badge: string;
  mode: Mode;
  onMode: (m: Mode) => void;
  /** 仅预览模式显示的动作（衬底 / 全屏 / 下载） */
  actions?: ReactNode;
  code: string;
  /** 源码模式下放进 <pre> 的（已高亮）代码节点 */
  highlighted?: ReactNode;
  preview: ReactNode;
  /** 叠加层（全屏查看器） */
  children?: ReactNode;
}) {
  const { copy, copied, failed, icon } = useCopyFeedback(code);
  return (
    <div className="md-codeblock md-codeblock-diagram">
      <div
        className="md-codeblock-bar flex items-center justify-between gap-2 px-2 py-1 bg-surface-muted border-b border-line text-ui text-ink select-none"
        contentEditable={false}
      >
        <div className="flex items-center gap-2" onClick={(e) => e.stopPropagation()}>
          {/* 手机上工具条挤：类型角标让位，预览 / 源码不折行 */}
          <span className="px-1.5 font-mono text-label text-ink-muted max-md:hidden">{badge}</span>
          <SegmentedControl
            size="sm"
            className="shrink-0 whitespace-nowrap"
            aria-label="图表视图"
            value={mode}
            onValueChange={onMode}
            options={[
              { value: "preview", label: "预览", icon: Eye },
              { value: "code", label: "源码", icon: Code },
            ]}
          />
        </div>
        <div className="flex items-center gap-0.5">
          {mode === "preview" && actions}
          <IconButton
            size="sm"
            label={failed ? "复制失败" : copied ? "已复制" : "复制代码"}
            onClick={copy}
            className="nodrag"
          >
            <Icon icon={icon} size="sm" />
          </IconButton>
        </div>
      </div>
      {mode === "preview" ? preview : <pre className="m-0 !rounded-none">{highlighted}</pre>}
      {children}
    </div>
  );
}

function MermaidBlock({ code, children }: { code: string; children?: ReactNode }) {
  const streaming = useContext(MarkdownStreamingContext);
  const { result, pending } = useMermaidSvg(code, { streaming });
  const [mode, setMode] = useState<Mode>("preview");
  const [open, setOpen] = useState(false);
  const diagram = result?.ok ? result : null;
  const src = useMemo(() => (diagram ? svgToDataUrl(diagram.svg) : null), [diagram]);

  const download = async (e?: MouseEvent) => {
    e?.stopPropagation();
    const svg = await renderMermaidForExport(code);
    if (svg) downloadSvgFile(svg, "mermaid-diagram.svg");
    else toast.error("下载失败", { description: "图表没有渲染成功，切到源码看看。" });
  };
  const copySource = async () => {
    try {
      await copyText(code);
      toast.success("已复制源码");
    } catch {
      toast.error("复制失败", { description: "浏览器拒绝了剪贴板访问，手动选中源码复制。" });
    }
  };

  let body: ReactNode;
  if (diagram && src) {
    body = (
      <DiagramPreview
        src={src}
        width={diagram.width}
        height={diagram.height}
        alt="Mermaid 图表"
        stale={pending}
        onOpen={() => setOpen(true)}
      />
    );
  } else if (result && !result.ok && !pending && !streaming) {
    body = (
      <div className="mx-auto max-w-md rounded-card border border-warn-line bg-surface p-4 text-center text-ui text-ink">
        <div className="mb-1 flex items-center justify-center gap-1.5 font-medium text-warn-ink">
          <Icon icon={TriangleAlert} size="sm" />
          {result.error}
        </div>
        <p className="mb-2 text-label text-ink-muted">
          模型写的 Mermaid 语法不规范，图没画出来；源码可以照常查看和复制。
        </p>
        {result.detail && (
          <details className="mb-3 text-left text-label text-ink-faint">
            <summary className="cursor-pointer select-none text-center hover:text-ink-muted">
              错误详情
            </summary>
            {/* 不用 <pre>：.md-body pre 会强制套上恒暗代码底 */}
            <div className="mt-1 max-h-40 overflow-auto whitespace-pre rounded-md bg-surface-muted px-2 py-1.5 font-mono text-nano text-ink-muted">
              {result.detail}
            </div>
          </details>
        )}
        <Button type="button" size="sm" onClick={() => setMode("code")}>
          查看源码
        </Button>
      </div>
    );
  } else {
    // 卡片图导出（lib/card-image.ts）靠 data-diagram-pending / 「图表渲染中…」等出图
    body = (
      <div data-diagram-pending className="flex items-center gap-2 text-label text-ink-faint">
        {streaming ? <Dots label="图表生成中" /> : <Spinner size="sm" label={null} />}
        {streaming ? "图表生成中…" : "图表渲染中…"}
      </div>
    );
  }

  return (
    <DiagramShell
      badge="Mermaid"
      mode={mode}
      onMode={setMode}
      code={code}
      highlighted={children}
      actions={
        diagram && (
          <>
            <IconButton size="sm" label="全屏查看" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
              <Icon icon={Maximize2} size="sm" />
            </IconButton>
            <IconButton size="sm" label="下载 SVG（浅色）" onClick={download}>
              <Icon icon={Download} size="sm" />
            </IconButton>
          </>
        )
      }
      preview={
        <div className="relative flex min-h-24 items-center justify-center bg-surface p-4">
          {body}
        </div>
      }
    >
      {open && diagram && (
        <DiagramViewer
          title="Mermaid 图表"
          source={{ kind: "inline", svg: diagram.svg, width: diagram.width, height: diagram.height }}
          onClose={() => setOpen(false)}
          actions={
            <>
              <Button type="button" size="sm" variant="ghost" onClick={() => void copySource()}>
                <Icon icon={Copy} size="sm" />
                复制源码
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => void download()}>
                <Icon icon={Download} size="sm" />
                下载 SVG
              </Button>
            </>
          }
        />
      )}
    </DiagramShell>
  );
}

const BG_LABEL: Record<DiagramBackground, string> = {
  grid: "点阵底",
  checkered: "网格底",
  white: "白底",
  dark: "暗底",
};
const NEXT_BG: Record<DiagramBackground, DiagramBackground> = {
  grid: "checkered",
  checkered: "white",
  white: "dark",
  dark: "checkered",
};

// 透明 SVG 的衬底（网格 / 白 / 暗）可切；内容来自模型，走 <img> 隔离、不内联。
function SvgBlock({ code, children }: { code: string; children?: ReactNode }) {
  const [mode, setMode] = useState<Mode>("preview");
  const [bg, setBg] = useState<DiagramBackground>("checkered");
  const [open, setOpen] = useState(false);
  const parsed = useMemo<
    | { ok: false; error: string }
    | { ok: true; svg: string; src: string; width: number; height: number }
  >(() => {
    // 宽进严出：模型手写 SVG 常带裸 & / &nbsp; / 不闭合的 <br>，先按 HTML 宽松解析再转良构 XML
    const svg = toWellFormedSvg(normalizeSvg(code));
    const validation = validateSvgSyntax(svg);
    if (!validation.valid) return { ok: false, error: validation.error || "SVG 语法格式有误" };
    const size = readSvgSize(svg);
    return { ok: true, svg, src: svgToDataUrl(svg), width: size?.width ?? 0, height: size?.height ?? 0 };
  }, [code]);

  const cycleBg = (e?: MouseEvent) => {
    e?.stopPropagation();
    setBg((prev) => NEXT_BG[prev]);
  };
  const download = (e?: MouseEvent) => {
    e?.stopPropagation();
    downloadSvgFile(parsed.ok ? parsed.svg : code, "diagram.svg");
  };
  const bgButton = (
    <Button type="button" variant="ghost" size="sm" onClick={cycleBg} title="切换透明图的衬底">
      <Icon icon={Palette} size="sm" />
      {BG_LABEL[bg]}
    </Button>
  );

  return (
    <DiagramShell
      badge="SVG"
      mode={mode}
      onMode={setMode}
      code={code}
      highlighted={children}
      actions={
        parsed.ok && (
          <>
            {bgButton}
            <IconButton size="sm" label="全屏查看" onClick={(e) => { e.stopPropagation(); setOpen(true); }}>
              <Icon icon={Maximize2} size="sm" />
            </IconButton>
            <IconButton size="sm" label="下载为 .svg 矢量图" onClick={download}>
              <Icon icon={Download} size="sm" />
            </IconButton>
          </>
        )
      }
      preview={
        <div
          className={cn(
            "relative flex min-h-24 items-center justify-center p-4 transition-colors",
            DIAGRAM_BACKGROUND_CLASS[bg],
          )}
        >
          {parsed.ok ? (
            <DiagramPreview
              src={parsed.src}
              width={parsed.width}
              height={parsed.height}
              alt="SVG 图形"
              onOpen={() => setOpen(true)}
            />
          ) : (
            <div className="mx-auto max-w-md rounded-card border border-warn-line bg-surface p-4 text-center text-ui text-ink">
              <div className="mb-1 flex items-center justify-center gap-1.5 font-medium text-warn-ink">
                <Icon icon={TriangleAlert} size="sm" />
                SVG 语法有误
              </div>
              <p className="mb-2 break-all text-label text-ink-muted">{parsed.error}</p>
              <Button type="button" size="sm" onClick={() => setMode("code")}>
                查看源码
              </Button>
            </div>
          )}
        </div>
      }
    >
      {open && parsed.ok && (
        <DiagramViewer
          title="SVG 图形"
          source={{
            kind: "image",
            src: parsed.src,
            // 没写尺寸的 SVG 浏览器按 300×150 排，查看器给个更宽松的默认画框
            width: parsed.width || 800,
            height: parsed.height || 600,
          }}
          background={bg}
          onClose={() => setOpen(false)}
          actions={
            <>
              {bgButton}
              <Button type="button" size="sm" variant="secondary" onClick={() => download()}>
                <Icon icon={Download} size="sm" />
                下载 SVG
              </Button>
            </>
          }
        />
      )}
    </DiagramShell>
  );
}
