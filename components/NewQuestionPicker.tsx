"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { IconButton } from "@/components/ui/IconButton";
import { Pill } from "@/components/ui/Pill";

// Modal composer for "新话题（清空上下文）" — adds a parallel root
// (parent_id=NULL) to the current session. This is Trellis's equivalent of the
// CLI `/clear`: the model no longer remembers the existing nodes.
export function NewQuestionPicker({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamRoot = useSessionStore((s) => s.streamRoot);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const ref = useRef<HTMLTextAreaElement>(null);
  // In project mode a new root also forks a fresh claude session id — the
  // model loses its conversation memory of the existing tree AND starts a
  // brand-new Claude session. In chat/workspace there's no resumed claude
  // session, but the new root still carries zero prior context. Either way
  // the "🧹 清空上下文" promise holds, so we surface the badge in every mode.
  const isProject = sessionMode === "project";

  useEffect(() => {
    ref.current?.focus();
  }, []);

  const submit = async () => {
    if (busy) return;
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
    streamRoot(trimmed, { attachToCurrentSession: true });
  };

  return (
    <Modal onClose={onClose}>
      <div className="px-5 py-4 border-b border-line-faint flex items-center justify-between">
        <div>
          <div className="text-reading font-semibold text-ink-strong flex items-center gap-2">
            新话题
            <Pill tone="danger">🧹 清空上下文</Pill>
          </div>
          <div className="text-ui text-ink-muted mt-0.5">
            起一条全新上下文的根问答，模型不再记得现有节点（等价 CLI 的{" "}
            <code className="px-1 rounded bg-surface-muted text-label">
              /clear
            </code>
            ）。
            {isProject && " Project 模式下还会同时开启全新的 Claude 会话记忆。"}
          </div>
        </div>
        <IconButton label="关闭" onClick={onClose}>
          ✕
        </IconButton>
      </div>

      <div className="px-5 py-4">
        <textarea
          ref={ref}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
          placeholder="想问点什么？例如：这个 session 之外的另一个角度…"
          rows={6}
          className="w-full px-3 py-2 rounded-field border border-line-strong bg-surface text-ink text-sm outline-none focus:border-accent-line resize-none leading-relaxed placeholder:text-ink-faint"
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
      </div>

      <div className="px-5 py-3 border-t border-line-faint flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          取消
        </Button>
        <Button variant="primary" onClick={submit} disabled={!q.trim() || busy}>
          {busy ? "提交中…" : "开始"}
        </Button>
      </div>
    </Modal>
  );
}
