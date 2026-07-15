"use client";
import { useRef, useState } from "react";
import {
  classifyFile,
  acceptFor,
  mimeForExt,
  extOf,
} from "@/lib/attachments";
import {
  uploadAttachment,
  newPendingId,
  type PendingAttachment,
} from "@/components/AttachmentPreview";
import type { NodeAttachment } from "@/lib/types";

export const MAX_ATTACHMENTS = 6;

// "all" for tool-capable modes (workspace / project / enhanced chat —
// generic files get staged to disk and read by the agent's own tools);
// "chat-safe" for pure chat, which can only consume images (vision) +
// text files (inlined into the prompt).
export type AttachmentPolicy = "all" | "chat-safe";

// Shared composer attachment state: pending list + paste / drop / file
// picker entry points. Consolidates what QuestionInput and BranchPopover
// used to duplicate, so LinearThreadView's composer gets it for free.
export function useAttachmentUploads(policy: AttachmentPolicy) {
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  // Transient rejection notice (unsupported type / over limit / binary in
  // pure chat). Composers surface it near the input; cleared on next add.
  const [notice, setNotice] = useState<string | null>(null);
  // Synchronous mirror of pending.length — a multi-file drop calls
  // startUpload in a loop within one render, where the state value is
  // stale and would let the whole batch through past the cap.
  const count = useRef(0);

  const startUpload = (file: File | Blob, filename: string | null) => {
    if (count.current >= MAX_ATTACHMENTS) {
      setNotice(`最多 ${MAX_ATTACHMENTS} 个附件`);
      return;
    }
    const kind = classifyFile(file.type, filename);
    if (kind === "unsupported") {
      setNotice(`不支持的文件类型：${filename ?? (file.type || "未知")}`);
      return;
    }
    if (policy === "chat-safe" && kind === "binary") {
      setNotice(
        "纯对话模式读不了二进制文件——开启增强模式或改用 Workspace / Project 再传",
      );
      return;
    }
    setNotice(null);
    count.current += 1;
    const localId = newPendingId();
    const previewUrl = URL.createObjectURL(file);
    const mime = file.type.startsWith("image/")
      ? file.type
      : (filename ? mimeForExt(extOf(filename)) : null) ??
        "application/octet-stream";
    setPending((prev) => [
      ...prev,
      { localId, status: "uploading", previewUrl, filename, mime },
    ]);
    uploadAttachment(file, filename)
      .then((att) =>
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? { ...p, status: "done", attachment: att }
              : p,
          ),
        ),
      )
      .catch((err) =>
        setPending((prev) =>
          prev.map((p) =>
            p.localId === localId
              ? {
                  ...p,
                  status: "error",
                  errorMessage:
                    err instanceof Error ? err.message : String(err),
                }
              : p,
          ),
        ),
      );
  };

  const handlePaste = (e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      if (it.kind !== "file") continue; // strings (typed/pasted text) pass through
      const file = it.getAsFile();
      if (!file) continue;
      e.preventDefault();
      // Screenshot pastes are nameless image blobs; Finder-copied files
      // carry a real name the server needs for extension validation.
      startUpload(file, file.name || null);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
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

  const remove = (localId: string) => {
    setPending((prev) => {
      const target = prev.find((p) => p.localId === localId);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        count.current -= 1;
      }
      return prev.filter((p) => p.localId !== localId);
    });
  };

  // For composers that stay mounted after submit (LinearThreadView).
  const clear = () => {
    setPending((prev) => {
      prev.forEach((p) => URL.revokeObjectURL(p.previewUrl));
      return [];
    });
    count.current = 0;
    setNotice(null);
  };

  const doneAttachments: NodeAttachment[] = pending
    .filter(
      (p): p is PendingAttachment & { attachment: NodeAttachment } =>
        p.status === "done" && !!p.attachment,
    )
    .map((p) => p.attachment);

  return {
    pending,
    notice,
    startUpload,
    handlePaste,
    handleDrop,
    handlePicked,
    remove,
    clear,
    doneAttachments,
    hasUploading: pending.some((p) => p.status === "uploading"),
    atLimit: pending.length >= MAX_ATTACHMENTS,
    accept: acceptFor(policy),
  };
}
