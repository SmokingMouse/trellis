"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown from "react-markdown";
import { Modal } from "./ui/Modal";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "@/lib/markdown-plugins";
import {
  CARD_DEFAULT_WIDTH,
  CARD_MAX_WIDTH,
  TRANSPARENT_IMAGE_DATA_URL,
  collectImageOverlays,
  computeCardWidth,
  computeExportPixelRatio,
  downloadBlob,
  formatCardDownloadFilename,
  inlineImagesAsDataUrls,
  paintImageOverlays,
  waitForRenderComplete,
} from "@/lib/card-image";

type Phase = "idle" | "rendering" | "preview" | "error";

export function CardImageButton({
  title,
  content,
}: {
  title: string;
  content: string;
}) {
  const [isOpen, setIsOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");

  const openDialog = useCallback(() => {
    setIsOpen(true);
    setPhase("rendering");
  }, []);

  const handleClose = useCallback(() => {
    setIsOpen(false);
    setPhase("idle");
  }, []);

  const buttonLabel =
    phase === "rendering"
      ? "生成中…"
      : phase === "error"
        ? "✗ 失败"
        : "🖼 卡片图";

  return (
    <>
      <button
        type="button"
        data-mobile-target="response-card-image"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          openDialog();
        }}
        disabled={phase === "rendering" && isOpen}
        title="把这条问答渲染成一张卡片图片"
        className="nodrag px-2.5 py-1 max-md:min-h-11 max-md:min-w-11 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors disabled:opacity-50"
      >
        {buttonLabel}
      </button>

      {isOpen && (
        <CardPreviewDialog
          title={title}
          content={content}
          onClose={handleClose}
          onPhaseChange={setPhase}
        />
      )}
    </>
  );
}

function CardPreviewDialog({
  title,
  content,
  onClose,
  onPhaseChange,
}: {
  title: string;
  content: string;
  onClose: () => void;
  onPhaseChange: (phase: Phase) => void;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [dialogPhase, setDialogPhase] = useState<"generating" | "preview" | "error">("generating");
  const [previewDataUrl, setPreviewDataUrl] = useState<string | null>(null);
  const [previewBlob, setPreviewBlob] = useState<Blob | null>(null);
  const [errorMessage, setErrorMessage] = useState("");
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  const updatePhase = useCallback(
    (p: "generating" | "preview" | "error") => {
      setDialogPhase(p);
      if (p === "generating") onPhaseChange("rendering");
      else if (p === "preview") onPhaseChange("preview");
      else if (p === "error") onPhaseChange("error");
    },
    [onPhaseChange],
  );

  const generate = useCallback(async () => {
    updatePhase("generating");
    setPreviewDataUrl(null);
    setPreviewBlob(null);
    setErrorMessage("");

    // Wait 100ms for ReactMarkdown and offscreen DOM nodes to mount
    await new Promise((r) => setTimeout(r, 100));

    const cardEl = cardRef.current;
    if (!cardEl) {
      updatePhase("error");
      setErrorMessage("渲染容器未就绪");
      return;
    }

    try {
      // 1. Initial expansion to measure widest tables (prevent horizontal clipping)
      cardEl.style.width = `${CARD_MAX_WIDTH}px`;
      await new Promise((r) => requestAnimationFrame(r));

      // 2. Wait for Mermaid async SVG and all images to settle
      await waitForRenderComplete(cardEl);

      // 3. Pre-inline blob: and same-origin <img> resources as Data URLs
      await inlineImagesAsDataUrls(cardEl);
      await waitForRenderComplete(cardEl);

      // 4. Calculate optimal width based on table scrollWidths
      const tables = cardEl.querySelectorAll("table");
      const tableWidths: number[] = [];
      tables.forEach((t) => tableWidths.push(t.scrollWidth));
      const cardWidth = computeCardWidth(tableWidths, {
        defaultWidth: CARD_DEFAULT_WIDTH,
        maxWidth: CARD_MAX_WIDTH,
      });
      cardEl.style.width = `${cardWidth}px`;
      await new Promise((r) => requestAnimationFrame(r));

      // 5. Compute safe pixel ratio (guards against iOS 14M canvas memory limits)
      const rect = cardEl.getBoundingClientRect();
      const pixelRatio = computeExportPixelRatio({
        width: rect.width || cardEl.offsetWidth || cardWidth,
        height: rect.height || cardEl.offsetHeight || 1,
      });

      // 6. Collect safe image overlays to re-draw onto canvas later
      const imageOverlays = collectImageOverlays(cardEl);

      // 7. Rasterize via html-to-image toCanvas
      const { toCanvas } = await import("html-to-image");
      const isDark =
        typeof document !== "undefined" &&
        document.documentElement.classList.contains("dark");
      const canvas = await toCanvas(cardEl, {
        pixelRatio,
        backgroundColor: isDark ? "#1c1917" : "#ffffff",
        cacheBust: false,
        imagePlaceholder: TRANSPARENT_IMAGE_DATA_URL,
        includeQueryParams: true,
        fetchRequestInit: { credentials: "include" },
        onImageErrorHandler: (err) => {
          console.warn("[trellis] card image load warning:", err);
        },
      });

      // 8. Re-paint overlays on 2D context for crisp rendering
      await paintImageOverlays(canvas, cardEl, imageOverlays);

      const dataUrl = canvas.toDataURL("image/png");
      const res = await fetch(dataUrl);
      const blob = await res.blob();

      setPreviewDataUrl(dataUrl);
      setPreviewBlob(blob);
      updatePhase("preview");
    } catch (err) {
      console.error("[trellis] card image failed:", err);
      const msg = err instanceof Error ? err.message : "生成卡片图失败";
      setErrorMessage(msg);
      updatePhase("error");
    }
  }, [updatePhase]);

  useEffect(() => {
    void generate();
  }, [generate]);

  const copy = async () => {
    if (!previewBlob) return;
    try {
      if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) {
        throw new Error("clipboard image write unsupported");
      }
      await navigator.clipboard.write([
        new ClipboardItem({ "image/png": previewBlob }),
      ]);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch (err) {
      console.error("[trellis] card image copy failed:", err);
      setCopyState("failed");
      window.setTimeout(() => setCopyState("idle"), 2500);
    }
  };

  const download = () => {
    if (!previewBlob) return;
    const filename = formatCardDownloadFilename(title);
    downloadBlob(previewBlob, filename);
  };

  return createPortal(
    <div
      className="nodrag nowheel"
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <Modal onClose={onClose} size="lg">
        <div className="flex items-center justify-between px-5 py-3 border-b border-line">
          <span className="text-ui font-medium text-ink-strong">卡片图</span>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="px-2 py-0.5 rounded text-ui text-ink-muted hover:bg-surface-muted hover:text-ink-strong transition-colors"
          >
            ✕
          </button>
        </div>

        <div className="max-h-[65vh] overflow-auto p-4 bg-surface-muted/40">
          {dialogPhase === "generating" && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-6 h-6 border-2 border-accent border-t-transparent rounded-full animate-spin" />
              <span className="text-ui text-ink-muted">正在渲染卡片图…</span>
            </div>
          )}

          {dialogPhase === "error" && (
            <div className="flex flex-col items-center justify-center py-12 gap-3 px-6 text-center">
              <span className="text-ui text-warn-ink">
                {errorMessage || "卡片图生成失败"}
              </span>
              <button
                type="button"
                onClick={() => void generate()}
                className="px-4 py-1.5 rounded bg-accent text-white text-ui hover:opacity-90 transition-opacity"
              >
                重试
              </button>
            </div>
          )}

          {dialogPhase === "preview" && previewDataUrl && (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={previewDataUrl}
              alt={`卡片图预览：${title}`}
              className="w-full rounded border border-line shadow-sm"
            />
          )}
        </div>

        {dialogPhase === "preview" && (
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
              onClick={download}
              className="flex-1 px-3 py-1.5 rounded bg-accent text-white text-ui hover:opacity-90 transition-opacity"
            >
              下载图片
            </button>
          </div>
        )}
      </Modal>

      {/* Off-screen card container: portalled directly to document.body, avoiding
          React Flow transform and mobile menu containing block clipping. */}
      <div
        aria-hidden="true"
        style={{
          position: "fixed",
          left: 0,
          top: 0,
          zIndex: -9999,
          pointerEvents: "none",
        }}
      >
        <div
          ref={cardRef}
          className="w-[680px] bg-surface px-8 py-7 font-sans"
        >
          <div className="flex items-start gap-3 mb-5">
            <span className="mt-1 w-1 self-stretch rounded-full bg-accent shrink-0" />
            <h3 className="text-title leading-snug font-semibold text-ink-strong">
              {title}
            </h3>
          </div>
          <div className="md-body text-ink [&_.md-codeblock-copy]:hidden [&_.md-codeblock-bar_button]:hidden">
            <ReactMarkdown
              remarkPlugins={MARKDOWN_REMARK_PLUGINS}
              rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
              components={MD_COMPONENTS}
              urlTransform={MD_URL_TRANSFORM}
            >
              {content}
            </ReactMarkdown>
          </div>
          <div className="mt-6 pt-3 border-t border-line/70 text-label text-ink-faint flex items-center justify-between">
            <span>Trellis · 思维树</span>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
