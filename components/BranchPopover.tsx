"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { SelectionInfo } from "@/hooks/useSelectionWithin";
import { AttachmentPreview } from "./AttachmentPreview";
import {
  useAttachmentUploads,
  MAX_ATTACHMENTS,
} from "@/hooks/useAttachmentUploads";

type Props = {
  selection: SelectionInfo;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
};

export function BranchPopover({ selection, expanded, onExpand, onClose }: Props) {
  const [q, setQ] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const addNote = useSessionStore((s) => s.addNote);
  const session = useSessionStore((s) => s.session);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  // Same tool-capability gate as the chat route: project (and
  // enhanced chat) can take any whitelisted file; pure chat can't.
  const att = useAttachmentUploads(
    session?.mode !== "chat" || chatEnhanced ? "all" : "chat-safe",
  );

  const captureNote = async () => {
    if (savingNote) return;
    setSavingNote(true);
    try {
      await addNote(selection.nodeId, selection.text);
      window.getSelection()?.removeAllRanges();
      onClose();
    } catch (err) {
      // Swallow — addNote keeps the optimistic row out on failure; user
      // sees nothing happen, can retry. Could surface a toast later.
      console.error("addNote failed", err);
    } finally {
      setSavingNote(false);
    }
  };

  // Global ⌘K / ⌘D / Esc — only meaningful while collapsed (textarea
  // handles its own keys when expanded).
  useEffect(() => {
    if (expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onExpand();
      } else if ((e.key === "d" || e.key === "D") && (e.metaKey || e.ctrlKey)) {
        // Browser default is "bookmark this page" — preventDefault first.
        e.preventDefault();
        captureNote();
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // captureNote captures `selection.text/nodeId` from the closure each
    // render — re-binding is cheap and keeps the handler current. addNote
    // identity is stable (Zustand action).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expanded, onExpand, onClose, selection.nodeId, selection.text]);

  useEffect(() => {
    if (expanded) {
      const t = window.setTimeout(() => inputRef.current?.focus(), 10);
      return () => window.clearTimeout(t);
    }
  }, [expanded]);

  // Keep the source text visibly highlighted while composing. The native
  // selection can't do this once expanded — clicking the textarea to place
  // the caret collapses it (that click is exactly what we un-blocked to fix
  // caret placement). So paint our own via the CSS Custom Highlight API from
  // the snapshotted Range, and clear the native selection so the two don't
  // double-paint. Gracefully no-ops on browsers without the API (old Firefox
  // just shows no highlight — no error).
  useEffect(() => {
    if (!expanded) return;
    const range = selection.range;
    const cssApi = (
      globalThis as unknown as {
        CSS?: { highlights?: { set(k: string, v: unknown): void; delete(k: string): void } };
      }
    ).CSS;
    const HighlightCtor = (globalThis as unknown as { Highlight?: new (r: Range) => unknown })
      .Highlight;
    if (!range || !cssApi?.highlights || !HighlightCtor) return;
    let hl: unknown;
    try {
      hl = new HighlightCtor(range);
    } catch {
      return;
    }
    window.getSelection()?.removeAllRanges();
    cssApi.highlights.set("branch-source", hl);
    return () => cssApi.highlights?.delete("branch-source");
  }, [expanded, selection.range]);

  const { doneAttachments, hasUploading } = att;

  const submit = async () => {
    const text = q.trim();
    if (!text || hasUploading) return;
    const anchor = { selectedText: selection.text };
    const opts =
      doneAttachments.length > 0 ? { attachments: doneAttachments } : undefined;
    window.getSelection()?.removeAllRanges();
    onClose();
    streamBranch(selection.nodeId, text, anchor, opts);
  };

  // Expanded popover height grows with pending attachment previews so it
  // doesn't clip behind the textarea / clobber screen-edge math.
  const pendingHeight = att.pending.length > 0 ? 96 : 0;
  const popoverHeight = expanded ? 130 + pendingHeight : 38;
  const top = Math.max(8, selection.rect.top - popoverHeight - 8);
  const left = selection.rect.left + selection.rect.width / 2;

  return (
    <div
      className="fixed z-50 max-w-[calc(100vw-16px)]"
      style={{ top, left, transform: "translateX(-50%)" }}
      // Collapsed: swallow mousedown so clicking the ⌘K / note buttons keeps
      // the document text selection alive (the buttons act on it). Expanded:
      // the selection is already snapshotted into `selection.text`, and this
      // same preventDefault would block the textarea from placing its caret on
      // click (mouse click dead, arrow keys still work) — so drop it there.
      onMouseDown={expanded ? undefined : (e) => e.preventDefault()}
      onPointerDown={expanded ? undefined : (e) => e.preventDefault()}
    >
      {expanded ? (
        <div className="bg-surface border border-line rounded-lg shadow-pop w-[min(420px,calc(100vw-16px))] overflow-hidden">
          <div className="px-3 py-1.5 bg-fork-muted border-b border-fork-line text-label text-fork-ink truncate">
            针对「
            <span className="font-medium">
              {selection.text.length > 60
                ? selection.text.slice(0, 60) + "…"
                : selection.text}
            </span>
            」
          </div>
          {att.pending.length > 0 && (
            <div className="px-3 pt-2">
              <AttachmentPreview
                pending={att.pending}
                onRemove={att.remove}
              />
            </div>
          )}
          <textarea
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onPaste={att.handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                submit();
              } else if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="进一步追问…（可粘贴图片 / 文件）"
            rows={2}
            className="w-full px-3 py-2 bg-transparent text-ink-strong outline-none resize-none text-sm placeholder:text-ink-faint"
          />
          <input
            ref={fileInputRef}
            type="file"
            accept={att.accept}
            multiple
            onChange={att.handlePicked}
            className="hidden"
          />
          {att.notice && (
            <div className="px-3 pb-1 text-label text-warn-ink">
              {att.notice}
            </div>
          )}
          <div className="border-t border-line-faint px-2.5 py-1.5 flex items-center justify-end gap-2 text-xs">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={att.atLimit}
              title={att.atLimit ? `已到 ${MAX_ATTACHMENTS} 个上限` : "添加图片 / 文件"}
              className="px-2 py-0.5 text-ink-muted hover:text-ink-strong disabled:opacity-40 disabled:cursor-not-allowed inline-flex items-center gap-1 mr-auto"
            >
              <span aria-hidden>📎</span>
            </button>
            <button
              onClick={onClose}
              className="px-2 py-0.5 text-ink-muted hover:text-ink-strong"
            >
              取消
            </button>
            <button
              onClick={submit}
              disabled={!q.trim() || hasUploading}
              title={hasUploading ? "等待附件上传…" : undefined}
              className="px-2.5 py-0.5 rounded bg-accent text-ink-inverse disabled:opacity-40 hover:bg-accent-strong"
            >
              {hasUploading ? "上传中…" : "提问"}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              onExpand();
            }}
            className="bg-accent text-ink-inverse text-xs rounded-lg shadow-pop px-3 py-2 hover:bg-accent-strong flex items-center gap-2 ring-1 ring-accent-strong"
          >
            <kbd className="hidden sm:inline bg-scrim/25 px-1.5 py-0.5 rounded text-nano font-mono">
              ⌘K
            </kbd>
            针对此处提问
          </button>
          <button
            onPointerDown={(e) => {
              e.preventDefault();
              captureNote();
            }}
            disabled={savingNote}
            title="摘到笔记 (⌘D)"
            aria-label="摘到笔记"
            /* 笔记 UI 归一 positive（amber→emerald 有意视觉变化）；positive 无 -strong 档，hover 用 opacity 近似 */
            className="bg-positive text-ink-inverse text-xs rounded-lg shadow-pop px-2.5 py-2 hover:opacity-90 disabled:opacity-50 flex items-center gap-1.5 ring-1 ring-positive-line"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="currentColor"
              aria-hidden
            >
              <path d="M12 2C9.243 2 7 4.243 7 7v6.5l-2.707 2.707A1 1 0 0 0 5 18h4v3a1 1 0 1 0 2 0v-3h2v3a1 1 0 1 0 2 0v-3h4a1 1 0 0 0 .707-1.707L17 13.5V7c0-2.757-2.243-5-5-5z" />
            </svg>
            <kbd className="hidden sm:inline bg-scrim/25 px-1.5 py-0.5 rounded text-nano font-mono">
              ⌘D
            </kbd>
          </button>
        </div>
      )}
    </div>
  );
}
