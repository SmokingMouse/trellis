"use client";
import { useEffect, useState } from "react";
import type { NodeAttachment } from "@/lib/types";

// Input-time variant: a pending attachment that hasn't finished uploading
// yet. Lives in QuestionInput / BranchPopover local state — the final
// NodeAttachment (with hash) only shows up once the upload resolves.
export type PendingAttachment = {
  // Stable id for keying / removing — independent of the server hash
  // (which doesn't exist yet for uploading items).
  localId: string;
  status: "uploading" | "done" | "error";
  // Object URL for instant preview before / regardless of upload result.
  previewUrl: string;
  filename: string | null;
  // Filled in once status="done"; never present for "uploading" / "error".
  attachment?: NodeAttachment;
  // Surfaced on "error" status so the user knows what went wrong.
  errorMessage?: string;
};

type Props =
  | {
      // Read-only mode: render a node's stored attachments. Click to
      // lightbox. No remove buttons.
      attachments: NodeAttachment[];
      readOnly: true;
    }
  | {
      // Edit mode: pending uploads + remove. Used in QuestionInput /
      // BranchPopover before submit.
      pending: PendingAttachment[];
      onRemove: (localId: string) => void;
      readOnly?: false;
    };

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
          url: `/api/uploads/${a.hash}`,
          fullUrl: `/api/uploads/${a.hash}`,
          status: "done" as const,
          filename: a.filename,
          width: a.width,
          height: a.height,
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
          width: p.attachment?.width,
          height: p.attachment?.height,
          removable: true,
          localId: p.localId,
          errorMessage: p.errorMessage,
        }));

  if (items.length === 0) return null;

  const onRemove =
    "readOnly" in props && props.readOnly ? null : props.onRemove;

  return (
    <>
      <div className="flex flex-wrap gap-2">
        {items.map((it) => (
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
              onClick={() => it.status === "done" && setLightbox(it.fullUrl)}
              disabled={it.status !== "done"}
              title={
                it.errorMessage ??
                it.filename ??
                (it.status === "uploading" ? "uploading…" : "image")
              }
              className="w-full h-full block"
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={it.url}
                alt={it.filename ?? "attachment"}
                className={`w-full h-full object-cover ${
                  it.status === "uploading" ? "opacity-50" : ""
                }`}
              />
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
        ))}
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

// Helper: kick off an upload for a File or Blob, return a PendingAttachment.
// QuestionInput / BranchPopover use this to add to their local pending list,
// then mutate the row when the promise resolves.
export async function uploadAttachment(
  file: File | Blob,
  filename: string | null,
): Promise<NodeAttachment> {
  const res = await fetch("/api/uploads", {
    method: "POST",
    headers: { "Content-Type": file.type },
    body: file,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `HTTP ${res.status}`);
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
