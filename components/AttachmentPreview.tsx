"use client";
import { useEffect, useState } from "react";
import type { NodeAttachment } from "@/lib/types";

// Input-time variant: a pending attachment that hasn't finished uploading
// yet. Lives in the composer's local state (useAttachmentUploads) — the
// final NodeAttachment (with hash) only shows up once the upload resolves.
export type PendingAttachment = {
  // Stable id for keying / removing — independent of the server hash
  // (which doesn't exist yet for uploading items).
  localId: string;
  status: "uploading" | "done" | "error";
  // Object URL for instant preview before / regardless of upload result.
  // Only meaningful for images; file chips render from filename/mime.
  previewUrl: string;
  filename: string | null;
  // Canonical mime, known client-side before the upload resolves (from
  // file.type for images, from the extension table for generic files).
  // Drives image-thumbnail vs file-chip rendering during "uploading".
  mime: string;
  // Filled in once status="done"; never present for "uploading" / "error".
  attachment?: NodeAttachment;
  // Surfaced on "error" status so the user knows what went wrong.
  errorMessage?: string;
};

type Props =
  | {
      // Read-only mode: render a node's stored attachments. Images click
      // to lightbox; file chips open the blob URL. No remove buttons.
      attachments: NodeAttachment[];
      readOnly: true;
    }
  | {
      // Edit mode: pending uploads + remove. Used by composers before submit.
      pending: PendingAttachment[];
      onRemove: (localId: string) => void;
      readOnly?: false;
    };

// Blob download/open URL. ?name= drives Content-Disposition so the file
// opens/saves under its original name instead of the bare hash.
function blobUrl(hash: string, filename: string | null): string {
  return `/api/uploads/${hash}${filename ? `?name=${encodeURIComponent(filename)}` : ""}`;
}

function fileIcon(mime: string): string {
  if (
    mime === "text/csv" ||
    mime === "text/tab-separated-values" ||
    mime.includes("spreadsheet") ||
    mime === "application/vnd.ms-excel" ||
    mime === "application/vnd.apache.parquet"
  )
    return "📊";
  if (mime === "application/pdf") return "📕";
  if (mime === "application/zip" || mime === "application/gzip") return "🗜️";
  return "📄";
}

function fmtSize(n: number | undefined): string | null {
  if (typeof n !== "number") return null;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentPreview(props: Props) {
  const [lightbox, setLightbox] = useState<string | null>(null);

  useEffect(() => {
    if (!lightbox) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setLightbox(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lightbox]);

  // Normalize both shapes into a uniform render list.
  const items =
    "readOnly" in props && props.readOnly
      ? props.attachments.map((a) => ({
          key: a.hash,
          url: blobUrl(a.hash, a.filename),
          fullUrl: blobUrl(a.hash, a.filename),
          status: "done" as const,
          filename: a.filename,
          mime: a.mime,
          size: a.size as number | undefined,
          removable: false,
          localId: a.hash,
          errorMessage: undefined as string | undefined,
        }))
      : props.pending.map((p) => ({
          key: p.localId,
          url: p.previewUrl,
          fullUrl: p.previewUrl,
          status: p.status,
          filename: p.filename,
          mime: p.mime,
          size: p.attachment?.size,
          removable: true,
          localId: p.localId,
          errorMessage: p.errorMessage,
        }));

  if (items.length === 0) return null;

  const onRemove =
    "readOnly" in props && props.readOnly ? null : props.onRemove;
  const readOnly = "readOnly" in props && !!props.readOnly;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => {
          const isImage = it.mime.startsWith("image/");
          return (
            <div
              key={it.key}
              className={`relative w-20 h-20 rounded-md overflow-hidden border ${
                it.status === "error"
                  ? "border-rose-400 dark:border-rose-700"
                  : "border-stone-200 dark:border-stone-700"
              } bg-stone-50 dark:bg-stone-900`}
            >
              <button
                type="button"
                onClick={() => {
                  if (it.status !== "done") return;
                  if (isImage) setLightbox(it.fullUrl);
                  // File chips only open once persisted (readonly): the
                  // pending-state object URL would download a nameless blob.
                  else if (readOnly) window.open(it.url, "_blank");
                }}
                disabled={it.status !== "done"}
                title={
                  it.errorMessage ??
                  it.filename ??
                  (it.status === "uploading" ? "uploading…" : "attachment")
                }
                className="w-full h-full block"
              >
                {isImage ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={it.url}
                    alt={it.filename ?? "attachment"}
                    className={`w-full h-full object-cover ${
                      it.status === "uploading" ? "opacity-50" : ""
                    }`}
                  />
                ) : (
                  <span
                    className={`w-full h-full flex flex-col items-center justify-center gap-0.5 px-1 ${
                      it.status === "uploading" ? "opacity-50" : ""
                    }`}
                  >
                    <span className="text-xl leading-none" aria-hidden>
                      {fileIcon(it.mime)}
                    </span>
                    <span className="text-[9px] leading-tight text-stone-600 dark:text-stone-300 break-all line-clamp-2 text-center">
                      {it.filename ?? "file"}
                    </span>
                    {fmtSize(it.size) && (
                      <span className="text-[8px] text-stone-400 dark:text-stone-500">
                        {fmtSize(it.size)}
                      </span>
                    )}
                  </span>
                )}
                {it.status === "uploading" && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-stone-700 dark:text-stone-200 bg-white/40 dark:bg-black/40">
                    ↑
                  </span>
                )}
                {it.status === "error" && (
                  <span className="absolute inset-0 flex items-center justify-center text-[10px] text-rose-700 dark:text-rose-200 bg-rose-100/70 dark:bg-rose-950/70 px-1 text-center">
                    失败
                  </span>
                )}
              </button>
              {onRemove && it.removable && (
                <button
                  type="button"
                  onClick={() => onRemove(it.localId)}
                  title="移除"
                  className="absolute top-0.5 right-0.5 w-5 h-5 rounded-full bg-black/60 hover:bg-black/80 text-white text-xs flex items-center justify-center leading-none"
                >
                  ✕
                </button>
              )}
            </div>
          );
        })}
      </div>

      {lightbox && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-6 cursor-zoom-out"
          onClick={() => setLightbox(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightbox}
            alt="attachment"
            className="max-w-full max-h-full object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </>
  );
}

// Helper: upload a File or Blob, resolve to the stored NodeAttachment.
// Images ship as a raw body (paste flow often has a bare Blob); generic
// files go multipart so the server gets a filename to derive the
// extension from — that's what validates them against the whitelist.
export async function uploadAttachment(
  file: File | Blob,
  filename: string | null,
): Promise<NodeAttachment> {
  let res: Response;
  if (file.type.startsWith("image/")) {
    res = await fetch("/api/uploads", {
      method: "POST",
      headers: { "Content-Type": file.type },
      body: file,
    });
  } else {
    const fd = new FormData();
    fd.append("file", file, filename ?? "file");
    res = await fetch("/api/uploads", { method: "POST", body: fd });
  }
  if (!res.ok) {
    let msg = "";
    try {
      const data = await res.json();
      msg = typeof data?.error === "string" ? data.error : "";
    } catch {
      /* non-JSON error body */
    }
    throw new Error(msg || `HTTP ${res.status}`);
  }
  const data = (await res.json()) as NodeAttachment;
  // Server doesn't always echo filename for raw uploads; fill from
  // client-side data when present so the tooltip reads sensibly.
  if (filename && !data.filename) {
    return { ...data, filename };
  }
  return data;
}

let _localIdCounter = 0;
export function newPendingId(): string {
  return `pending-${Date.now()}-${++_localIdCounter}`;
}
