"use client";
import { useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { MD_COMPONENTS } from "@/lib/md-components";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];

type Phase = "idle" | "rendering" | "copied" | "downloaded" | "error";

// Replaces the old "存到记忆" action: render this Q&A into a shareable card
// PNG and drop it on the clipboard so the user can paste it straight into
// chat / notes. Falls back to a file download where the browser blocks
// programmatic image clipboard writes (older Safari / Firefox).
export function CardImageButton({
  title,
  content,
}: {
  title: string;
  content: string;
}) {
  const cardRef = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<Phase>("idle");

  const run = async () => {
    if (phase === "rendering" || !cardRef.current) return;
    setPhase("rendering");
    try {
      // Lazy-load the rasterizer so it stays out of the main bundle.
      const { toBlob } = await import("html-to-image");
      const isDark = document.documentElement.classList.contains("dark");
      const blob = await toBlob(cardRef.current, {
        pixelRatio: 2,
        backgroundColor: isDark ? "#1c1917" : "#ffffff",
        cacheBust: true,
      });
      if (!blob) throw new Error("render produced no image");

      // Prefer the clipboard; fall back to a download if it's unavailable
      // or rejected (permissions / unsupported ClipboardItem image type).
      const canClipImage =
        typeof ClipboardItem !== "undefined" &&
        !!navigator.clipboard?.write;
      if (canClipImage) {
        try {
          await navigator.clipboard.write([
            new ClipboardItem({ "image/png": blob }),
          ]);
          setPhase("copied");
        } catch {
          downloadBlob(blob, title);
          setPhase("downloaded");
        }
      } else {
        downloadBlob(blob, title);
        setPhase("downloaded");
      }
      window.setTimeout(() => setPhase("idle"), 2000);
    } catch (err) {
      console.error("[trellis] card image failed:", err);
      setPhase("error");
      window.setTimeout(() => setPhase("idle"), 2500);
    }
  };

  const label =
    phase === "rendering"
      ? "生成中…"
      : phase === "copied"
        ? "✓ 已复制图片"
        : phase === "downloaded"
          ? "✓ 已下载"
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
        title="把这条问答渲染成一张卡片图片并复制到剪贴板"
        className="nodrag px-2.5 py-1 rounded border border-stone-200 dark:border-stone-700 text-[12px] text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100 transition-colors disabled:opacity-50"
      >
        {label}
      </button>

      {/* Off-screen card laid out (not display:none, which can't be
          rasterized) for html-to-image to capture. Mirrors the app's markdown
          styling so the image matches what the user reads. */}
      <div
        aria-hidden
        style={{ position: "fixed", left: -99999, top: 0, pointerEvents: "none" }}
      >
        <div
          ref={cardRef}
          className="w-[680px] bg-white dark:bg-stone-900 px-8 py-7"
        >
          <div className="flex items-start gap-3 mb-5">
            <span className="mt-1 w-1 self-stretch rounded-full bg-indigo-500 shrink-0" />
            <h3 className="text-[19px] leading-snug font-semibold text-stone-900 dark:text-stone-100">
              {title}
            </h3>
          </div>
          <div className="md-body text-stone-800 dark:text-stone-200">
            <ReactMarkdown
              remarkPlugins={REMARK_PLUGINS}
              rehypePlugins={REHYPE_FULL}
              components={MD_COMPONENTS}
            >
              {content}
            </ReactMarkdown>
          </div>
          <div className="mt-6 pt-3 border-t border-stone-200/70 dark:border-stone-700/70 text-[11px] text-stone-400 dark:text-stone-500">
            Trellis · 思维树
          </div>
        </div>
      </div>
    </>
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
