"use client";
import { useState, useRef, useEffect } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ReferencePicker } from "./ReferencePicker";
import { ModePicker } from "./ModePicker";
import {
  AttachmentPreview,
  uploadAttachment,
  newPendingId,
  type PendingAttachment,
} from "./AttachmentPreview";
import type { NodeAttachment } from "@/lib/types";

const MAX_ATTACHMENTS = 6;

export function QuestionInput() {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const draftMode = useSessionStore((s) => s.draftMode);
  const draftWorkspacePath = useSessionStore((s) => s.draftWorkspacePath);

  useEffect(() => {
    ref.current?.focus();
  }, []);

  // Stage 14: Workspace / Project draft modes need a workspace path
  // chosen before submit.
  const needsWorkspace = draftMode !== "chat" && !draftWorkspacePath;
  const hasUploading = pending.some((p) => p.status === "uploading");
  const doneAttachments: NodeAttachment[] = pending
    .filter((p): p is PendingAttachment & { attachment: NodeAttachment } =>
      p.status === "done" && !!p.attachment,
    )
    .map((p) => p.attachment);

  const submit = async () => {
    const trimmed = q.trim();
    if (!trimmed || busy || needsWorkspace || hasUploading) return;
    setBusy(true);
    streamRoot(trimmed, {
      attachments: doneAttachments.length > 0 ? doneAttachments : undefined,
    });
  };

  const startUpload = (file: File | Blob, filename: string | null) => {
    if (pending.length >= MAX_ATTACHMENTS) return;
    if (!file.type.startsWith("image/")) return;
    const localId = newPendingId();
    const previewUrl = URL.createObjectURL(file);
    setPending((prev) => [
      ...prev,
      {
        localId,
        status: "uploading",
        previewUrl,
        filename,
      },
    ]);
    uploadAttachment(file, filename)
      .then((att) => {
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? { ...p, status: "done", attachment: att }
              : p,
          ),
        );
      })
      .catch((err) => {
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? {
                  ...p,
                  status: "error",
                  errorMessage: err instanceof Error ? err.message : String(err),
                }
              : p,
          ),
        );
      });
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (!it.type.startsWith("image/")) continue;
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      startUpload(file, null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      startUpload(files[i], files[i].name);
    }
  };

  const handlePicked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      startUpload(files[i], files[i].name);
    }
    // Allow re-picking the same file later.
    e.target.value = "";
  };

  const handleRemove = (localId: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((p) => p.localId !== localId);
    });
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      submit();
    }
  };

  const atLimit = pending.length >= MAX_ATTACHMENTS;
  const submitDisabled =
    !q.trim() || busy || needsWorkspace || hasUploading;
  const submitLabel = busy
    ? "提交中…"
    : needsWorkspace
      ? "先选工作区"
      : hasUploading
        ? "等待图片上传…"
        : "开始探索";

  return (
    <div className="min-h-screen flex flex-col items-center justify-center px-6">
      <div className="w-full max-w-2xl">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400" />
          <h1 className="text-2xl font-semibold tracking-tight">Trellis</h1>
        </div>
        <p className="text-center text-stone-500 dark:text-stone-400 mb-6 text-sm">
          想深入探索什么？任何问题都可以——后续可以选中回复里的任意文字继续追问。
        </p>
        <div className="mb-3 flex justify-center">
          <ModePicker />
        </div>
        <div
          className={`bg-white dark:bg-stone-900 border rounded-xl shadow-sm overflow-hidden transition-colors ${
            dragOver
              ? "border-indigo-400 dark:border-indigo-500 ring-2 ring-indigo-200 dark:ring-indigo-900"
              : "border-stone-200 dark:border-stone-800"
          }`}
          onDragOver={(e) => {
            // Only react to file drags (Files type), ignore text drags.
            if (e.dataTransfer.types.includes("Files")) {
              e.preventDefault();
              setDragOver(true);
            }
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={handleDrop}
        >
          {pending.length > 0 && (
            <div className="px-4 pt-3">
              <AttachmentPreview
                pending={pending}
                onRemove={handleRemove}
              />
            </div>
          )}
          <textarea
            ref={ref}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKey}
            onPaste={handlePaste}
            placeholder="例如：Rust 的 ownership 系统在汇编层面是怎么实现的？粘贴图片可加入提问。"
            rows={4}
            className="w-full px-5 py-4 outline-none resize-none text-[15px] leading-relaxed bg-transparent text-stone-900 dark:text-stone-100 placeholder:text-stone-400 dark:placeholder:text-stone-500"
            disabled={busy}
          />
          <div className="border-t border-stone-100 dark:border-stone-800 px-4 py-2 flex items-center justify-between gap-3">
            <div className="text-xs text-stone-400 dark:text-stone-500 flex-1 min-w-0">
              <kbd className="bg-stone-100 dark:bg-stone-800 dark:text-stone-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
                ⌘↩
              </kbd>{" "}
              提交 ·{" "}
              <kbd className="bg-stone-100 dark:bg-stone-800 dark:text-stone-300 px-1.5 py-0.5 rounded text-[10px] font-mono">
                Enter
              </kbd>{" "}
              换行
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              onChange={handlePicked}
              className="hidden"
            />
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={busy || atLimit}
              title={
                atLimit
                  ? `已到 ${MAX_ATTACHMENTS} 张上限`
                  : "添加图片（粘贴 / 拖拽 / 点击选）"
              }
              className="text-xs text-stone-500 dark:text-stone-400 hover:text-stone-800 dark:hover:text-stone-200 disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 px-2 py-1 rounded hover:bg-stone-100 dark:hover:bg-stone-800"
            >
              <span aria-hidden>🖼️</span>
              <span className="hidden sm:inline">图片</span>
            </button>
            <button
              onClick={submit}
              disabled={submitDisabled}
              title={
                needsWorkspace
                  ? `${draftMode === "workspace" ? "Workspace" : "Project"} 模式需要先选择工作区`
                  : undefined
              }
              className="bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 text-sm px-4 py-1.5 rounded-md hover:bg-stone-800 dark:hover:bg-stone-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {submitLabel}
            </button>
          </div>
        </div>
        <div className="mt-5 flex items-center gap-3 justify-center text-xs">
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
          <span className="text-stone-400 dark:text-stone-500">或</span>
          <div className="h-px flex-1 max-w-[80px] bg-stone-200 dark:bg-stone-800" />
        </div>
        <div className="mt-3 flex justify-center">
          <button
            onClick={() => setPickerOpen(true)}
            className="px-4 py-2 rounded-md text-sm border border-amber-300 dark:border-amber-800 bg-amber-50/60 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200 hover:bg-amber-100 dark:hover:bg-amber-950/60 active:scale-95 transition-colors flex items-center gap-2"
          >
            <span aria-hidden>📄</span>
            <span>从背景材料开始（粘贴 / URL）</span>
          </button>
        </div>
        <div className="text-center text-xs text-stone-400 dark:text-stone-500 mt-4">
          模型在右上角切换 · 默认 Claude Sonnet
        </div>
      </div>
      {pickerOpen && (
        <ReferencePicker onClose={() => setPickerOpen(false)} />
      )}
    </div>
  );
}
