"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { SelectionInfo } from "@/hooks/useSelectionWithin";
import { AttachmentPreview } from "./AttachmentPreview";
import {
  useAttachmentUploads,
  MAX_ATTACHMENTS,
} from "@/hooks/useAttachmentUploads";
import { useIsMobile, useIsNarrowViewport } from "@/hooks/useIsMobile";
import { Ellipsis, GitBranch, Paperclip, Pin } from "lucide-react";
import { Button, Icon, IconButton } from "@/components/ui";

type Props = {
  selection: SelectionInfo;
  expanded: boolean;
  onExpand: () => void;
  onClose: () => void;
};

export function BranchPopover({ selection, expanded, onExpand, onClose }: Props) {
  const [q, setQ] = useState("");
  const [savingNote, setSavingNote] = useState(false);
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const addNote = useSessionStore((s) => s.addNote);
  const session = useSessionStore((s) => s.session);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const isMobile = useIsMobile();
  const isNarrowViewport = useIsNarrowViewport();
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
        setMobileMoreOpen(false);
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
    const opts = {
      ...(doneAttachments.length > 0
        ? { attachments: doneAttachments }
        : {}),
      ...(isMobile ? { focusNew: true } : {}),
    };
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
  const positionStyle = isNarrowViewport
    ? {
        right: 8,
        bottom: "calc(var(--safe-bottom) + 8px)",
        left: 8,
      }
    : { top, left, transform: "translateX(-50%)" };

  return (
    <div
      data-branch-popover
      className="fixed z-50"
      style={{ ...positionStyle, maxWidth: "calc(100vw - 16px)" }}
      // Collapsed: swallow mousedown so clicking the ⌘K / note buttons keeps
      // the document text selection alive (the buttons act on it). Expanded:
      // the selection is already snapshotted into `selection.text`, and this
      // same preventDefault would block the textarea from placing its caret on
      // click (mouse click dead, arrow keys still work) — so drop it there.
      onMouseDown={expanded ? undefined : (e) => e.preventDefault()}
      onPointerDown={expanded ? undefined : (e) => e.preventDefault()}
    >
      {expanded ? (
        <div
          className="bg-surface-raised border border-line rounded-overlay shadow-pop overflow-hidden"
          style={{ width: "min(420px, calc(100vw - 16px))" }}
        >
          <div className="px-3 py-1.5 bg-fork-muted border-b border-fork-line text-label text-fork-ink flex items-center gap-1.5 min-w-0">
            <Icon icon={GitBranch} size="sm" className="text-fork" />
            <span className="truncate">
              针对「
              <span className="font-medium">
                {selection.text.length > 60
                  ? selection.text.slice(0, 60) + "…"
                  : selection.text}
              </span>
              」
            </span>
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
              // Ignore the Enter that commits an IME composition (e.g. typing
              // "gnss" in a Chinese IME and pressing Enter to accept the raw
              // letters): that keydown reports key "Enter" but isComposing /
              // keyCode 229 — treating it as submit fires the branch mid-input.
              if (e.nativeEvent.isComposing || e.keyCode === 229) return;
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
            className="w-full px-3 py-2 bg-transparent text-ink-strong outline-none resize-none text-ui placeholder:text-ink-faint"
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
          <div className="border-t border-line-faint px-2 py-1.5 flex items-center justify-end gap-1.5">
            <IconButton
              type="button"
              size="sm"
              data-mobile-target="branch-attach"
              label="添加图片 / 文件"
              title={att.atLimit ? `已到 ${MAX_ATTACHMENTS} 个上限` : undefined}
              onClick={() => fileInputRef.current?.click()}
              disabled={att.atLimit}
              className="mr-auto"
            >
              <Icon icon={Paperclip} size="sm" />
            </IconButton>
            <Button
              variant="ghost"
              size="sm"
              data-mobile-target="branch-cancel"
              onClick={onClose}
            >
              取消
            </Button>
            <Button
              variant="primary"
              size="sm"
              data-mobile-target="branch-submit"
              onClick={submit}
              disabled={!q.trim()}
              loading={hasUploading}
              title={hasUploading ? "等待附件上传…" : undefined}
            >
              提问
            </Button>
          </div>
        </div>
      ) : (
        <div className="relative flex items-center justify-center gap-1.5 md:justify-start">
          <Button
            variant="primary"
            data-mobile-target="branch-open"
            onPointerDown={(e) => {
              e.preventDefault();
              setMobileMoreOpen(false);
              onExpand();
            }}
            className="shadow-pop"
          >
            <Icon icon={GitBranch} size="sm" />
            针对此处提问
            <kbd className="hidden sm:inline rounded-sm border border-current/30 px-1 font-mono text-nano opacity-80">
              ⌘K
            </kbd>
          </Button>
          <Button
            data-mobile-target="branch-note"
            onPointerDown={(e) => {
              e.preventDefault();
              captureNote();
            }}
            disabled={savingNote}
            title="摘到笔记 (⌘D)"
            aria-label="摘到笔记"
            // 笔记语义归 positive：只给图标上色，按钮本体是中性描边。
            className="hidden md:inline-flex shadow-pop"
          >
            <Icon icon={Pin} size="sm" className="text-positive" />
            <kbd className="hidden sm:inline rounded-sm border border-line px-1 font-mono text-nano text-ink-faint">
              ⌘D
            </kbd>
          </Button>
          <IconButton
            type="button"
            data-mobile-target="branch-more"
            label="更多选区操作"
            tooltip={false}
            onPointerDown={(e) => {
              e.preventDefault();
              setMobileMoreOpen((open) => !open);
            }}
            aria-expanded={mobileMoreOpen}
            className="border border-line-strong bg-surface shadow-pop md:hidden"
          >
            <Icon icon={Ellipsis} />
          </IconButton>
          {mobileMoreOpen && (
            <div
              data-mobile-branch-menu
              className="absolute bottom-full right-0 mb-2 min-w-40 overflow-hidden rounded-overlay border border-line bg-surface-raised p-1 shadow-pop md:hidden"
            >
              <button
                type="button"
                data-mobile-target="branch-note"
                onPointerDown={(e) => {
                  e.preventDefault();
                  void captureNote();
                }}
                disabled={savingNote}
                className="flex min-h-11 w-full items-center gap-2 rounded-field px-3 text-left text-ui text-ink hover:bg-surface-hover disabled:opacity-50"
              >
                <Icon icon={Pin} size="sm" className="text-positive" />
                摘到笔记
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
