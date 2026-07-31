"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { modeStyle } from "@/lib/mode-style";
import type { Mode } from "@/lib/llm";
import {
  approvalAvailable,
  approvalCopy,
  contextModeOptions,
  workspaceRequired,
} from "@/lib/run-config";
import { WorkspaceField } from "./run-config/WorkspaceField";

// Stage 14: the mode picker only appears in the new-session draft state
// (the empty QuestionInput). It edits draftMode + draftWorkspacePath in
// the store; on first submit these get locked into the session row and
// the readonly ModeBadge in the header takes over.
//
// Selecting Project without a workspace_path forces the WorkspacePicker
// open (the user can't leave with an inconsistent draft). Chat clears the
// workspace draft — chat has no cwd binding.

function ChatIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

// 文案在 lib/run-config.ts（任务定义页共用同一份）；这里只负责把 id 映到图标。
const ICONS: Record<Mode, () => React.ReactElement> = {
  chat: ChatIcon,
  project: LinkIcon,
};

export function ModePicker() {
  const mode = useSessionStore((s) => s.draftMode);
  const setMode = useSessionStore((s) => s.setDraftMode);
  const workspacePath = useSessionStore((s) => s.draftWorkspacePath);
  const setWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const provider = useSessionStore((s) => s.provider);
  const requireApproval = useSessionStore((s) => s.draftRequireApproval);
  const setRequireApproval = useSessionStore((s) => s.setDraftRequireApproval);
  const [pickerOpen, setPickerOpen] = useState(false);

  const OPTIONS = contextModeOptions(provider);
  const needsWorkspace = workspaceRequired(mode);
  const showApproval = approvalAvailable(mode, provider);
  const approval = approvalCopy(requireApproval);

  const handleSelect = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (next === "chat") {
      // Chat doesn't bind a cwd — clear any stale draft to keep the
      // submit body coherent.
      setWorkspacePath(null);
    } else if (!workspacePath) {
      // Project needs a path. Open picker; user can't leave it dangling
      // because the submit gate also re-checks.
      setPickerOpen(true);
    }
  };

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Context mode"
        className="inline-flex h-7 rounded-md border border-line-strong bg-surface overflow-hidden shrink-0"
      >
        {OPTIONS.map((opt) => {
          const active = mode === opt.id;
          const Icon = ICONS[opt.id];
          const style = modeStyle(opt.id);
          const activeColor =
            opt.id === "chat"
              ? // chat 的中性淡底贴着外层 surface 对比不足（历史：muted 灰
                // 对纯白底近乎不可见），补一圈 inset ring 给它与 project
                // 同级的视觉重量；色值全走 mode-chat token。
                `${style.activeBg} ${style.text} ring-1 ring-inset ring-mode-chat-line-strong/40`
              : `${style.activeBg} ${style.text}`;
          return (
            <button
              key={opt.id}
              role="radio"
              aria-checked={active}
              title={opt.title}
              onClick={() => handleSelect(opt.id)}
              className={`px-2 text-label font-medium transition-colors inline-flex items-center gap-1.5 border-l border-line-strong first:border-l-0 ${
                active
                  ? activeColor
                  : "text-ink-muted hover:bg-surface-muted"
              }`}
            >
              <Icon />
              <span className="hidden sm:inline">{opt.label}</span>
            </button>
          );
        })}
      </div>

      {needsWorkspace && (
        <WorkspaceField
          value={workspacePath}
          onChange={setWorkspacePath}
          required
          className="max-w-[10rem]"
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      )}

      {showApproval && (
        <button
          onClick={() => setRequireApproval(!requireApproval)}
          title={approval.title}
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-label font-medium transition-colors ${
            requireApproval
              ? "border-accent-line bg-accent-muted text-accent-ink"
              : "border-line-strong bg-surface text-ink-faint hover:bg-surface-muted"
          }`}
        >
          <span aria-hidden>{approval.icon}</span>
          <span>{approval.label}</span>
        </button>
      )}
    </div>
  );
}
