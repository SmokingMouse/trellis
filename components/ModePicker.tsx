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
import { ShieldCheck, Zap } from "lucide-react";
import { Icon } from "./ui/Icon";

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
    <div
      data-mobile-target="new-session-mode-config"
      className="inline-flex flex-wrap items-center gap-2 max-md:w-full max-md:flex-col max-md:items-stretch"
    >
      <div
        role="radiogroup"
        aria-label="Context mode"
        // bui segmented：surface-muted 凹槽轨道，选中段浮起（surface-raised + shadow-btn），文字取模式色
        className="inline-flex h-7 max-md:h-12 max-md:w-full gap-0.5 rounded-full bg-surface-muted p-0.5 shadow-inset-field shrink-0"
      >
        {OPTIONS.map((opt) => {
          const active = mode === opt.id;
          const Icon = ICONS[opt.id];
          const style = modeStyle(opt.id);
          // 选中段统一浮起；模式身份由图标 + mode-* 文字色承担（色值全走 mode token）。
          const activeColor = `bg-surface-raised shadow-btn ${style.text}`;
          return (
            <button
              key={opt.id}
              type="button"
              role="radio"
              aria-checked={active}
              title={opt.title}
              onClick={() => handleSelect(opt.id)}
              className={`press px-2.5 max-md:flex-1 max-md:justify-center rounded-full text-[12.5px] font-medium transition-[background-color,color,box-shadow] duration-150 ease-out inline-flex items-center gap-1.5 ${
                active
                  ? activeColor
                  : "text-ink-muted hover:text-ink"
              }`}
            >
              <Icon />
              <span>{opt.label}</span>
            </button>
          );
        })}
      </div>

      {needsWorkspace && (
        <WorkspaceField
          value={workspacePath}
          onChange={setWorkspacePath}
          placeholder="空白沙箱（自动）"
          className="max-w-[10rem] max-md:max-w-none max-md:w-full"
          open={pickerOpen}
          onOpenChange={setPickerOpen}
        />
      )}

      {showApproval && (
        <button
          type="button"
          onClick={() => setRequireApproval(!requireApproval)}
          title={approval.title}
          className={`press inline-flex items-center gap-1.5 h-7 max-md:min-h-11 max-md:w-full max-md:justify-center px-2.5 rounded-full text-[12.5px] font-medium transition-colors duration-100 ${
            requireApproval
              ? "bg-accent-muted text-accent-ink ring-1 ring-inset ring-accent-line"
              : "bg-surface-raised text-ink-muted shadow-btn hover:bg-surface-hover hover:text-ink"
          }`}
        >
          <Icon icon={approval.icon === "shield" ? ShieldCheck : Zap} size="sm" />
          <span>{approval.label}</span>
        </button>
      )}
    </div>
  );
}
