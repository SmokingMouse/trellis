"use client";
import {
  useEffect,
  useRef,
  useState,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import {
  MARKDOWN_PREVIEW_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "@/lib/markdown-plugins";
import { useSessionStore } from "@/stores/sessionStore";
import {
  filePreviewUrl,
  previewKind,
  previewableHref,
  remoteImageHref,
  type PreviewKind,
} from "@/lib/generated-files";

// Hover preview for file links / inline file paths inside rendered markdown:
// linger ~250ms on a previewable target → a floating card shows the content
// (image inline, markdown rendered, text head). Click still opens the full
// FilePreview overlay. The card is pointer-events-none — it's a peek, not a
// surface; anything longer than the card is one click away.

const SHOW_DELAY_MS = 250;
const CARD_W = 380;
const CARD_MAX_H = 300;
// Only the head of text files is fetched (read incrementally, then the
// connection is dropped) — hover must stay cheap even on a huge log/md.
const TEXT_HEAD_CHARS = 6000;

type HoverTarget = { url: string; kind: PreviewKind; name: string };

function useHoverCard(resolve: () => HoverTarget | null) {
  const [state, setState] = useState<{
    target: HoverTarget;
    rect: DOMRect;
  } | null>(null);
  const timer = useRef<number | null>(null);

  const dismiss = () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    setState(null);
  };

  const show = (e: MouseEvent | FocusEvent) => {
    const el = e.currentTarget;
    const target = resolve();
    if (!target) return;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setState({ target, rect: el.getBoundingClientRect() });
    }, SHOW_DELAY_MS);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  // The card is fixed-positioned off a captured rect — scrolling would leave
  // it floating detached from its link, so any scroll dismisses it.
  useEffect(() => {
    if (!state) return;
    const onScroll = () => setState(null);
    window.addEventListener("scroll", onScroll, true);
    return () => window.removeEventListener("scroll", onScroll, true);
  }, [state]);

  return {
    bind: {
      onMouseEnter: show,
      onMouseLeave: dismiss,
      onFocus: show,
      onBlur: dismiss,
    },
    card: state ? <HoverCard target={state.target} anchor={state.rect} /> : null,
    dismiss,
  };
}

function HoverCard({
  target,
  anchor,
}: {
  target: HoverTarget;
  anchor: DOMRect;
}) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const left = Math.min(Math.max(anchor.left, 8), Math.max(8, vw - CARD_W - 8));
  const fitsBelow = anchor.bottom + 8 + CARD_MAX_H <= vh || anchor.top < CARD_MAX_H + 16;
  const style = fitsBelow
    ? { left, top: anchor.bottom + 8 }
    : { left, top: anchor.top - 8, transform: "translateY(-100%)" };

  return createPortal(
    <div
      className="fixed z-[70] pointer-events-none w-[380px] max-h-[300px] overflow-hidden rounded-card border border-line bg-surface shadow-pop"
      style={style}
      aria-hidden
    >
      <div className="px-3 py-1.5 border-b border-line-faint text-label font-mono text-ink-faint truncate">
        {target.name}
      </div>
      <HoverBody target={target} />
    </div>,
    document.body,
  );
}

function HoverBody({ target }: { target: HoverTarget }) {
  if (target.kind === "image") return <ImageBody url={target.url} name={target.name} />;
  if (target.kind === "markdown" || target.kind === "text")
    return <TextBody url={target.url} markdown={target.kind === "markdown"} />;
  // html/pdf: content needs an iframe — too heavy for a peek card.
  return (
    <div className="px-3 py-2.5 text-xs text-ink-faint">
      {target.kind.toUpperCase()} 文件 · 点击打开完整预览
    </div>
  );
}

function ImageBody({ url, name }: { url: string; name: string }) {
  const [failed, setFailed] = useState(false);
  if (failed)
    return <div className="px-3 py-2.5 text-xs text-ink-faint">图片加载失败</div>;
  return (
    <div className="p-2 flex items-center justify-center min-h-[100px] [background:repeating-conic-gradient(var(--surface-muted)_0%_25%,#fff_0%_50%)_50%/12px_12px] dark:[background:repeating-conic-gradient(rgba(255,255,255,0.06)_0%_25%,rgba(0,0,0,0.2)_0%_50%)_50%/12px_12px]">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={url}
        alt={name}
        onError={() => setFailed(true)}
        className="max-w-full max-h-[252px] object-contain"
      />
    </div>
  );
}

function TextBody({ url, markdown }: { url: string; markdown: boolean }) {
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    setText(null);
    setError(false);
    (async () => {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let head = "";
      while (head.length < TEXT_HEAD_CHARS) {
        const { done, value } = await reader.read();
        if (done) break;
        head += decoder.decode(value, { stream: true });
      }
      reader.cancel().catch(() => {});
      setText(head.slice(0, TEXT_HEAD_CHARS));
    })().catch(() => {
      if (!ctrl.signal.aborted) setError(true);
    });
    return () => ctrl.abort();
  }, [url]);

  if (error)
    return (
      <div className="px-3 py-2.5 text-xs text-ink-faint">
        无法读取：文件不存在，或不在本会话可预览范围（workspace + 本会话写过的文件）
      </div>
    );
  if (text === null)
    return <div className="px-3 py-2.5 text-xs text-ink-faint">加载中…</div>;

  if (markdown)
    return (
      <div className="md-body px-3 py-2 text-xs text-ink [&_pre]:!text-[11px]">
        <ReactMarkdown
          remarkPlugins={MARKDOWN_REMARK_PLUGINS}
          rehypePlugins={MARKDOWN_PREVIEW_REHYPE_PLUGINS}
        >
          {text}
        </ReactMarkdown>
      </div>
    );
  return (
    <pre className="m-0 px-3 py-2 text-[11px] leading-relaxed text-ink font-mono whitespace-pre overflow-hidden">
      {text}
    </pre>
  );
}

function fileTarget(abs: string): HoverTarget | null {
  const session = useSessionStore.getState().session;
  if (!session) return null;
  return {
    url: filePreviewUrl(session.id, abs),
    kind: previewKind(abs),
    name: abs.split("/").pop() || abs,
  };
}

// Markdown <a> renderer. Local-file hrefs (absolute / file:// / relative to
// the session workspace) open the FilePreview overlay instead of navigating
// (the raw href would 404), with a hover peek; everything else keeps its
// link semantics in a new tab, with a hover peek for remote images.
export function MdLink({
  href,
  children,
  node: _node,
  ...props
}: {
  href?: string;
  children?: ReactNode;
  node?: unknown;
} & Record<string, unknown>) {
  const hrefStr = typeof href === "string" ? href : "";
  const { session } = useSessionStore.getState();
  const abs = previewableHref(hrefStr, session?.workspacePath ?? null);
  const sessionId = session?.id ?? null;

  const { bind, card, dismiss } = useHoverCard(() => {
    if (abs) return fileTarget(abs);
    if (remoteImageHref(hrefStr))
      return {
        url: hrefStr,
        kind: "image",
        name: hrefStr.split("/").pop()?.split("?")[0] || hrefStr,
      };
    return null;
  });

  if (abs && sessionId) {
    return (
      <>
        <a
          href={filePreviewUrl(sessionId, abs)}
          title={abs}
          {...bind}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            dismiss();
            useSessionStore.getState().openFilePreview(abs);
          }}
          className="nodrag decoration-dotted cursor-pointer"
        >
          {children}
        </a>
        {card}
      </>
    );
  }
  return (
    <>
      <a
        href={hrefStr}
        target="_blank"
        rel="noreferrer"
        {...props}
        {...bind}
        className="nodrag"
      >
        {children}
      </a>
      {card}
    </>
  );
}

// Markdown <img> renderer. Answers routinely embed generated diagrams by
// their on-disk path (`![图](/Users/…/foo.png)`) — the browser treats that
// as an http path and 404s into a broken-image glyph. Local srcs (absolute /
// file:// / workspace-relative) are rewritten through /api/files (same
// session whitelist as links) and click opens the FilePreview overlay;
// remote srcs keep their URL. Any load failure degrades to a captioned
// placeholder instead of the broken glyph. Inline elements only — markdown
// images live inside <p>.
export function MdImage(props: {
  src?: unknown;
  alt?: string;
  title?: string;
  node?: unknown;
}) {
  const { src, alt, title } = props;
  const [failed, setFailed] = useState(false);
  const srcStr = typeof src === "string" ? src : "";
  const { session } = useSessionStore.getState();
  const abs = previewableHref(srcStr, session?.workspacePath ?? null);
  const sessionId = session?.id ?? null;
  const local = abs !== null && sessionId !== null;

  if (!srcStr || failed) {
    return (
      <span
        className="inline-flex max-w-full items-baseline gap-1.5 px-2 py-1 rounded bg-surface-muted border border-line-faint text-xs text-ink-faint"
        title={abs ?? srcStr}
      >
        <span aria-hidden>🖼</span>
        <span className="truncate">
          {alt || (srcStr.split("/").pop() ?? "图片")}
        </span>
        <span className="shrink-0">
          — 无法预览：文件不存在，或不在本会话可预览范围
        </span>
      </span>
    );
  }

  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={local ? filePreviewUrl(sessionId, abs) : srcStr}
      alt={alt ?? ""}
      title={title ?? (local ? abs : undefined)}
      loading="lazy"
      onError={() => setFailed(true)}
      onClick={
        local
          ? (e) => {
              e.stopPropagation();
              useSessionStore.getState().openFilePreview(abs);
            }
          : undefined
      }
      className={
        "nodrag max-w-full max-h-[420px] rounded-card border border-line-faint object-contain" +
        (local ? " cursor-zoom-in" : "")
      }
    />
  );
}

// Inline-code file path → click-to-preview button (moved here from
// md-components so it shares the hover card).
export function InlineFileButton({
  abs,
  children,
}: {
  abs: string;
  children?: ReactNode;
}) {
  const { bind, card, dismiss } = useHoverCard(() => fileTarget(abs));
  return (
    <>
      <button
        type="button"
        title="点击预览"
        {...bind}
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
          useSessionStore.getState().openFilePreview(abs);
        }}
        className="nodrag px-1 py-0.5 mx-0.5 rounded bg-accent-muted text-[0.9em] font-mono text-accent-ink underline decoration-dotted decoration-accent-line underline-offset-2 hover:bg-accent-line/40 cursor-pointer align-baseline"
      >
        {children}
      </button>
      {card}
    </>
  );
}
