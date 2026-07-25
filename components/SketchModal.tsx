"use client";
import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import dynamic from "next/dynamic";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

// The multi-MB Excalidraw bundle loads only on first open — the modal is
// conditionally mounted by its callers, so idle sessions pay nothing.
const Excalidraw = dynamic(
  () => import("@excalidraw/excalidraw").then((m) => m.Excalidraw),
  {
    ssr: false,
    loading: () => (
      <div className="w-full h-full flex items-center justify-center text-ui text-ink-faint">
        画板加载中…
      </div>
    ),
  },
);

// 画板：嵌 Excalidraw 画草图，导出 PNG 交给 composer 的附件链路（vision）。
// 布局走 FilePreview 模式（portal + 近全屏）而非 ui/Modal——画板需要全屏
// 工作区，且 Excalidraw 内部重度使用 Esc（取消选择/收起面板），Esc-close
// 会误伤，只允许 ✕ 关闭；画布非空时 ✕ 先 confirm 防误丢。
// 根节点标 data-keys-yield：app 的全局单字母/Esc 快捷键在画板内全部让位
// （Excalidraw 自带整套键盘交互，r/o/a/t/Esc… 与 J/K/B/F 会互相踩）。
export function SketchModal({
  onClose,
  onExport,
}: {
  onClose: () => void;
  // 导出的 PNG blob——调用方接 useAttachmentUploads.startUpload。
  onExport: (blob: Blob) => void;
}) {
  const apiRef = useRef<ExcalidrawImperativeAPI | null>(null);
  const [hasContent, setHasContent] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 打开时读一次明暗；modal 生命周期内不跟随主题切换（够用）。
  const [dark] = useState(
    () =>
      typeof document !== "undefined" &&
      document.documentElement.classList.contains("dark"),
  );

  const close = () => {
    if (hasContent && !window.confirm("丢弃当前草图？")) return;
    onClose();
  };

  const insert = async () => {
    const api = apiRef.current;
    if (!api || exporting) return;
    const elements = api.getSceneElements();
    if (elements.length === 0) return;
    setExporting(true);
    setError(null);
    try {
      // 与 Excalidraw 本体同 chunk——此时必已加载，await 即取。
      const { exportToBlob } = await import("@excalidraw/excalidraw");
      const blob = await exportToBlob({
        elements,
        // 导出永远白底亮色——给模型看的图不该受 UI 主题影响。
        appState: {
          ...api.getAppState(),
          exportBackground: true,
          exportWithDarkMode: false,
        },
        files: api.getFiles(),
        mimeType: "image/png",
      });
      onExport(blob);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[60] flex flex-col bg-scrim/70 backdrop-blur-sm"
      data-keys-yield
    >
      {/* top bar */}
      <div className="shrink-0 flex items-center gap-3 px-4 h-12 bg-surface border-b border-line">
        <span className="text-sm" aria-hidden>
          ✏️
        </span>
        <span className="flex-1 truncate text-ui font-medium text-ink-strong">
          画个草图
          <span className="ml-2 text-label font-normal text-ink-faint hidden sm:inline">
            插入后作为图片附件发送
          </span>
        </span>
        {error && (
          <span
            className="text-label text-danger truncate max-w-[40%]"
            title={error}
          >
            导出失败：{error}
          </span>
        )}
        <button
          onClick={insert}
          disabled={!hasContent || exporting}
          title={hasContent ? undefined : "画布还是空的"}
          className="px-3 py-1 rounded bg-accent text-ink-inverse text-ui disabled:opacity-30 hover:bg-accent-strong"
        >
          {exporting ? "导出中…" : "插入草图"}
        </button>
        <button
          onClick={close}
          className="px-2.5 py-1 rounded border border-line text-ui text-ink-muted hover:bg-surface-muted"
        >
          ✕ 关闭
        </button>
      </div>
      {/* board */}
      <div className="flex-1 min-h-0">
        <Excalidraw
          excalidrawAPI={(api) => {
            apiRef.current = api;
          }}
          theme={dark ? "dark" : "light"}
          langCode="zh-CN"
          onChange={(elements) =>
            setHasContent(elements.some((el) => !el.isDeleted))
          }
          UIOptions={{
            // 嵌入态砍掉误导项：打开/存文件/自带导出（导出走顶栏「插入草图」）。
            canvasActions: {
              loadScene: false,
              saveToActiveFile: false,
              export: false,
              saveAsImage: false,
            },
          }}
        />
      </div>
    </div>,
    document.body,
  );
}
