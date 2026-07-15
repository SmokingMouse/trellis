"use client";
import { useEffect, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { isSendCombo, sendHint } from "@/lib/send-key";
import { useSkillSuggestions } from "@/hooks/useSkillSuggestions";
import { SkillPickerList } from "./SkillPickerList";
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
  const isStreaming = targetNode?.status === "streaming";
  // Before the server's `created` event lands, the streaming card is a local
  // optimistic placeholder — there's no run to abort yet.
  const isPending = targetNode ? isOptimisticNodeId(targetNode.id) : false;
  const matchedSkills = useSkillSuggestions(
    text,
    sessionMode !== "chat" || chatEnhanced,
  );

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${Math.min(ref.current.scrollHeight, 160)}px`;
    }
  }, [text]);

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed || !targetNode || isStreaming) return;
    setText("");
    streamBranch(targetNode.id, trimmed, null);
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
    <div className="relative py-3 flex items-end gap-2">
      {matchedSkills.length > 0 && (
        <SkillPickerList
          skills={matchedSkills}
          onPick={(name) => {
            setText(`/${name} `);
            ref.current?.focus();
          }}
        />
      )}
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
        rows={1}
        disabled={!targetNode}
        placeholder={placeholder ?? `继续对话…（${sendHint(sendKey)}）`}
        className="flex-1 min-h-[44px] max-h-[160px] resize-none px-4 py-3 rounded-2xl border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-950 text-[14.5px] text-stone-900 dark:text-stone-100 outline-none focus:border-indigo-400 dark:focus:border-indigo-600 focus:ring-2 focus:ring-indigo-100 dark:focus:ring-indigo-900/40 placeholder:text-stone-400 dark:placeholder:text-stone-500 transition-shadow shadow-sm disabled:opacity-50"
      />
      <button
        onClick={submit}
        disabled={!text.trim() || !targetNode}
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
  );
}
