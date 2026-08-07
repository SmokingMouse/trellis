"use client";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Modal } from "./ui/Modal";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "@/lib/markdown-plugins";

type Phase = "idle" | "rendering" | "error";

// Renders this Q&A into a shareable card PNG, then opens a preview dialog
// where the user picks the destination themselves — copy to clipboard or
// download as a file (the old auto-copy-with-silent-download-fallback made
// the outcome unpredictable across browsers).
export function CardImageButton({
  title,
  content,
}: {
  title: string;
  content: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [blob, setBlob] = useState<Blob | null>(null);

  const run = async () => {
    if (phase === "rendering" || !cardRef.current) return;
    setPhase("rendering");
    try {
      // Lazy-load the rasterizer so it stays out of the main bundle.
      const { toBlob } = await import("html-to-image");
      const isDark = document.documentElement.classList.contains("dark");
      const rendered = await toBlob(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: isDark ? "#1c1917" : "#ffffff",
        cacheBust: true,
      });
      if (!rendered) throw new Error("render produced no image");
      setBlob(rendered);
      setPhase("idle");
    } catch (err) {
      console.error("[trellis] card image failed:", err);
      setPhase("error");
      window.setTimeout(() => setPhase("idle"), 2500);
    }
  };

  const label =
    phase === "rendering"
      ? "生成中…"
      : phase === "error"
        ? "✗ 失败"
        : "🖼 卡片图";

  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          void run();
        }}
        disabled={phase === "rendering"}
        title="把这条问答渲染成一张卡片图片"
        className="nodrag px-2.5 py-1 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors disabled:opacity-50"
      >
        {label}
      </button>

      {blob && (
        <CardPreviewDialog
          blob={blob}
          title={title}
          onClose={() => setBlob(null)}
        />
      )}

      {/* Off-screen card laid out (not display:none, which can't be
          rasterized) for html-to-image to capture. Mirrors the app's markdown
          styling so the image matches what the user reads. */}
      <div
        aria-hidden
        style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none" }}
      >
        <div
          ref={cardRef}
          className="w-[680px] bg-surface px-8 py-7"
        >
          <div className="flex items-start gap-3 mb-5">
            <span className="mt-1 w-1 self-stretch rounded-full bg-accent shrink-0" />
            <h3 className="text-title leading-snug font-semibold text-ink-strong">
              {title}
            </h3>
          </div>
          <div className="md-body text-ink">
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={MD_COMPONENTS}
            urlTransform={MD_URL_TRANSFORM}
            >
              {content}
            </ReactMarkdown>
          </div>
          <div className="mt-6 pt-3 border-t border-line/70 text-label text-ink-faint">
            Trellis · 思维树
          </div>
        </div>
      </div>
    </>
  );
}

// Portalled to body: TurnCard lives inside a transformed React Flow node,
// where a plain fixed-position Modal would anchor to the node, not the
// viewport.
function CardPreviewDialog({
  blob,
  title,
  onClose,
}: {
  blob: Blob;
  title: string;
  onClose: () => void;
}) {
  const [url] = useState(() => URL.createObjectURL(blob));
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">(
    "idle",
  );
  useEffect(() => () => URL.revokeObjectURL(url), [url]);

  const copy = async () => {
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("clipboard image write unsupported");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": blob }),
      ]);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch (err) {
      console.error("[trellis] card image copy failed:", err);
      setCopyState("failed");
    }
  };

  return createPortal(
    <div className="nodrag nowheel" onClick={(e) => e.stopPropagation()}>
      <Modal onClose={onClose} size="lg">
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <span className="text-ui font-medium text-ink-strong">卡片图</span>
          <button
            type="button"
            onClick={onClose}
            className="px-2 py-0.5 rounded text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
          >
            ✕
          </button>
        </div>
        <div className="max-h-[60vh] overflow-auto p-4 bg-surface-muted/40">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={url}
            alt={`卡片图预览：${title}`}
            className="w-full rounded border border-line"
          />
        </div>
        <div className="flex gap-2 px-5 py-3 border-t border-line">
          <button
            type="button"
            onClick={() => void copy()}
            className="flex-1 px-3 py-1.5 rounded border border-line text-ui text-ink hover:bg-surface-muted hover:text-ink-strong transition-colors"
          >
            {copyState === "copied"
              ? "✓ 已复制"
              : copyState === "failed"
                ? "复制失败，请用下载"
                : "复制图片"}
          </button>
          <button
            type="button"
            onClick={() => downloadBlob(blob, title)}
            className="flex-1 px-3 py-1.5 rounded bg-accent text-white text-ui hover:opacity-90 transition-opacity"
          >
            下载图片
          </button>
        </div>
      </Modal>
    </div>,
    document.body,
  );
}

function downloadBlob(blob: Blob, title: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  const slug =
    title.slice(0, 40).replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "") ||
    "trellis-card";
  a.download = `${slug}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
