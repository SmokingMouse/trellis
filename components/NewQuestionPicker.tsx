"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Pill } from "@/components/ui/Pill";
import { AttachmentPreview } from "./AttachmentPreview";
import { useAttachmentUploads } from "@/hooks/useAttachmentUploads";

// Modal composer for "新话题（清空上下文）" — adds a parallel root
// (parent_id=NULL) to the current session. This is Trellis's equivalent of the
// CLI `/clear`: the model no longer remembers the existing nodes.
export function NewQuestionPicker({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const ref = useRef<HTMLTextAreaElement>(null);
  const att = useAttachmentUploads(
    sessionMode !== "chat" || chatEnhanced ? "all" : "chat-safe",
  );
  // In project mode a new root also forks a fresh claude session id — the
  // model loses its conversation memory of the existing tree AND starts a
  // brand-new Claude session. In chat there is no resumed claude
  // session, but the new root still carries zero prior context. Either way
  // the "🧹 清空上下文" promise holds, so we surface the badge in every mode.
  const isProject = sessionMode === "project";

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    if (busy || att.hasUploading) return;
    const trimmed = q.trim();
    if (!trimmed) {
      setError("问题不能为空");
      return;
    }
    setError(null);
    setBusy(true);
    // Fire and forget — close immediately so the user sees the new node
    // start streaming on canvas. The store handles the rest via SSE.
    onClose();
    streamRoot(trimmed, {
      attachToCurrentSession: true,
      attachments:
        att.doneAttachments.length > 0 ? att.doneAttachments : undefined,
    });
  };

  return (
    <Modal
      onClose={onClose}
      panelClassName="max-md:max-h-[calc(100dvh-var(--safe-top)-var(--safe-bottom)-1rem)] max-md:flex max-md:flex-col"
    >
      <div className="shrink-0 px-5 py-4 max-md:py-3 border-b border-line-faint flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-reading font-semibold text-ink-strong flex items-center gap-2">
            新树
            <Pill tone="danger">🧹 清空上下文</Pill>
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            在当前会话中开启一棵独立的新树，模型不再记得现有节点（等价 CLI 的{" "}
            <code className="px-1 rounded bg-surface-muted text-label">
              /clear
            </code>
            ）。
            {isProject && " Project 模式下还会同时开启全新的 Claude 会话记忆。"}
            <span className="block mt-1 text-ink-faint">
              不会创建新会话；侧栏的「新会话」才会建立新的会话容器。
            </span>
          </div>
        </div>
        <IconButton
          label="关闭"
          data-mobile-target="new-tree-close"
          onClick={onClose}
        >
          ✕
        </IconButton>
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 max-md:py-3">
        {att.pending.length > 0 && (
          <div className="mb-3">
            <AttachmentPreview pending={att.pending} onRemove={att.remove} />
          </div>
        )}
        <textarea
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onPaste={att.handlePaste}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="为这棵新树输入第一个问题…（可粘贴图片）"
          rows={6}
          className="w-full px-3 py-2 max-md:h-24 rounded-field border border-line-strong bg-surface text-ink text-sm outline-none focus:border-accent-line resize-none leading-relaxed placeholder:text-ink-faint"
          disabled={busy}
        />
        <div className="text-label text-ink-faint mt-1">
          ⌘↩ 提交 · {q.length} 字
        </div>
        {error && (
          <div className="mt-2 text-ui text-danger">
            {error}
          </div>
        )}
        {att.notice && (
          <div className="mt-2 text-ui text-warn-ink">{att.notice}</div>
        )}
      </div>

      <div className="shrink-0 px-5 py-3 border-t border-line-faint flex justify-end gap-2">
        <Button
          variant="ghost"
          data-mobile-target="new-tree-cancel"
          onClick={onClose}
        >
          取消
        </Button>
        <Button
          variant="primary"
          data-mobile-target="new-tree-start"
          onClick={submit}
          disabled={!q.trim() || busy || att.hasUploading}
        >
          {busy ? "提交中…" : att.hasUploading ? "上传中…" : "开始"}
        </Button>
      </div>
    </Modal>
  );
}
