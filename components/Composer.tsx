"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { useAttachmentUploads } from "@/hooks/useAttachmentUploads";
import { SkillPickerList } from "./SkillPickerList";
import { AttachmentPreview } from "./AttachmentPreview";
import { isOptimisticNodeId } from "@/stores/sessionStore";
import type { ChatNode } from "@/lib/types";

// #3/#7: the shared always-docked composer. Used by the linear thread's
// sticky footer and the canvas's fixed bottom bar — one input surface with a
// STABLE height: while the target streams, the textarea swaps to an
// equal-height stop button instead of disappearing/resizing, so the bottom
// region never jumps.
export function Composer({
  targetNode,
  placeholder,
}: {
  // The node a submit branches from (thread tip in linear view, the active
  // node on canvas). null → composer renders disabled.
  targetNode: ChatNode | null;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const streamBranch = useSessionStore((s) => s.streamBranch);
  const abortStream = useSessionStore((s) => s.abortStream);
  const sendKey = useSessionStore((s) => s.sendKey);
  const sessionMode = useSessionStore((s) => s.session?.mode);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const ref = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isStreaming = targetNode?.status === "streaming";
  // Before the server's `created` event lands, the streaming card is a local
  // optimistic placeholder — there's no run to abort yet.
  const isPending = targetNode ? isOptimisticNodeId(targetNode.id) : false;
  // Same tool-capability gate as skills (and the chat route's attachment
  // handling): workspace/project/enhanced chat take any whitelisted file
  // (staged to disk for the agent); pure chat only images + inlineable text.
  const toolCapable = sessionMode !== "chat" || chatEnhanced;
  const matchedSkills = useSkillSuggestions(text, toolCapable);
  const att = useAttachmentUploads(toolCapable ? "all" : "chat-safe");

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !targetNode || isStreaming || att.hasUploading) return;
    const attachments =
      att.doneAttachments.length > 0 ? att.doneAttachments : undefined;
    setText("");
    // This composer stays mounted after submit — clear so the next turn
    // starts fresh.
    att.clear();
    streamBranch(targetNode.id, trimmed, null, { attachments });
  };

  if (isStreaming && targetNode) {
    return (
      <div className="py-3">
        <button
          onClick={() => abortStream(targetNode.id)}
          disabled={isPending}
          className="w-full h-[44px] rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:bg-stone-900 hover:text-white hover:border-stone-900 dark:hover:bg-stone-100 dark:hover:text-stone-900 dark:hover:border-stone-100 active:scale-[0.99] transition-colors flex items-center justify-center gap-2 text-[13px] disabled:opacity-60 disabled:hover:bg-white dark:disabled:hover:bg-stone-900 disabled:hover:text-stone-700"
          aria-label="停止生成"
          title={isPending ? "正在建立连接…" : "停止生成 (Esc)"}
        >
          <span className="inline-block w-2.5 h-2.5 bg-current rounded-[2px]" />
          {isPending ? "连接中…" : "停止生成"}
          {!isPending && (
            <span className="opacity-60 text-[11px] hidden sm:inline">
              （Esc）
            </span>
          )}
        </button>
      </div>
    );
  }

  return (
    <div className="relative py-3">
      {matchedSkills.length > 0 && (
        <SkillPickerList
          skills={matchedSkills}
          onPick={(name) => {
            setText(`/${name} `);
            ref.current?.focus();
          }}
        />
      )}
      {att.pending.length > 0 && (
        <div className="mb-2">
          <AttachmentPreview pending={att.pending} onRemove={att.remove} />
        </div>
      )}
      {att.notice && (
        <div className="mb-1.5 text-[11px] text-amber-700 dark:text-amber-300">
          {att.notice}
        </div>
      )}
      <div className="flex items-end gap-2">
        <textarea
          ref={ref}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (isSendCombo(e, sendKey)) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={att.handlePaste}
          rows={1}
          disabled={!targetNode}
          placeholder={placeholder ?? `继续对话…（${sendHint(sendKey)}，可粘贴图片 / 文件）`}
          className="flex-1 min-h-[44px] max-h-[160px] resize-none px-4 py-3 rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-[14.5px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 placeholder:text-stone-400 dark:placeholder:text-stone-500 transition-shadow shadow-sm disabled:opacity-50"
        />
        <input
          ref={fileInputRef}
          type="file"
          accept={att.accept}
          multiple
          onChange={att.handlePicked}
          className="hidden"
        />
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={!targetNode || att.atLimit}
          title={att.atLimit ? "已到附件上限" : "添加图片 / 文件"}
          className="shrink-0 h-[44px] w-[44px] rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-stone-500 dark:text-stone-400 flex items-center justify-center disabled:opacity-30 hover:text-stone-800 dark:hover:text-stone-200 hover:border-stone-400 dark:hover:border-stone-500 active:scale-95 transition-all shadow-sm"
          aria-label="添加附件"
        >
          <span aria-hidden>📎</span>
        </button>
        <button
          onClick={submit}
          disabled={!text.trim() || !targetNode || att.hasUploading}
          title={att.hasUploading ? "等待附件上传…" : undefined}
          className="shrink-0 h-[44px] w-[44px] rounded-2xl bg-indigo-600 text-white flex items-center justify-center disabled:opacity-30 hover:bg-indigo-700 active:scale-95 transition-all shadow-sm"
          aria-label="发送"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 19V5M5 12l7-7 7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
}
