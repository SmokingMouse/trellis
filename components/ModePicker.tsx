"use client";
import { useRef, useState } from "react";
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
import { ChevronDown, ShieldCheck, Zap } from "lucide-react";
import { Icon } from "./ui/Icon";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "./ui/DropdownMenu";
import { COMPOSER_TOOL_PILL } from "./ComposerShell";

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

export function ModePicker({
  variant = "default",
}: {
  /** default = 分段器 + 工作区 + 审批（手机「更多设置」sheet 用）；
   *  toolbar = 桌面输入框底栏里的紧凑胶囊（原型 .c-bar 的「Chat ⌄」），点开是同一组单选 */
  variant?: "default" | "toolbar";
} = {}) {
  const mode = useSessionStore((s) => s.draftMode);
  const setMode = useSessionStore((s) => s.setDraftMode);
  const workspacePath = useSessionStore((s) => s.draftWorkspacePath);
  const setWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const provider = useSessionStore((s) => s.provider);
  const requireApproval = useSessionStore((s) => s.draftRequireApproval);
  const setRequireApproval = useSessionStore((s) => s.setDraftRequireApproval);
  const [pickerOpen, setPickerOpen] = useState(false);
  // 工具栏胶囊：选 Project 时要自动弹出工作区选择框，别让菜单关闭时把焦点抢回触发钮
  const skipMenuFocusRestore = useRef(false);

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
      skipMenuFocusRestore.current = true;
      setPickerOpen(true);
    }
  };

  const workspaceField = needsWorkspace && (
    <WorkspaceField
      value={workspacePath}
      onChange={setWorkspacePath}
      placeholder="空白沙箱（自动）"
      className={
        variant === "toolbar"
          ? "max-w-32 rounded-full!"
          : "max-w-[10rem] max-md:max-w-none max-md:w-full"
      }
      open={pickerOpen}
      onOpenChange={setPickerOpen}
    />
  );

  if (variant === "toolbar") {
    const current = OPTIONS.find((opt) => opt.id === mode) ?? OPTIONS[0];
    const CurrentIcon = ICONS[current.id];
    return (
      <div data-mode-picker="toolbar" className="inline-flex min-w-0 items-center gap-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button
              type="button"
              aria-label={`Context mode：${current.label}`}
              title={current.title}
              className={COMPOSER_TOOL_PILL}
            >
              <span className={`inline-flex ${modeStyle(current.id).text}`}>
                <CurrentIcon />
              </span>
              <span>{current.label}</span>
              <ChevronDown size={12} strokeWidth={2} aria-hidden className="shrink-0 text-ink-faint" />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-72"
            onCloseAutoFocus={(e) => {
              if (!skipMenuFocusRestore.current) return;
              skipMenuFocusRestore.current = false;
              e.preventDefault();
            }}
          >
            <DropdownMenuLabel>Context mode</DropdownMenuLabel>
            <DropdownMenuRadioGroup value={mode} onValueChange={(v) => handleSelect(v as Mode)}>
              {OPTIONS.map((opt) => {
                const OptIcon = ICONS[opt.id];
                return (
                  <DropdownMenuRadioItem key={opt.id} value={opt.id} title={opt.title} className="py-1.5">
                    <span className="flex min-w-0 items-start gap-2">
                      <span className={`mt-0.5 inline-flex shrink-0 ${modeStyle(opt.id).text}`}>
                        <OptIcon />
                      </span>
                      <span className="min-w-0">
                        <span className="block font-medium">{opt.label}</span>
                        <span className="block truncate text-label text-ink-faint">{opt.short}</span>
                      </span>
                    </span>
                  </DropdownMenuRadioItem>
                );
              })}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {workspaceField}
        {showApproval && (
          <button
            type="button"
            onClick={() => setRequireApproval(!requireApproval)}
            title={approval.title}
            aria-pressed={requireApproval}
            className={
              requireApproval
                ? "press inline-flex h-7 items-center gap-1.5 rounded-full bg-accent-muted px-2 text-[12.5px] font-medium text-accent-ink ring-1 ring-inset ring-accent-line transition-colors duration-100"
                : COMPOSER_TOOL_PILL
            }
          >
            <Icon icon={approval.icon === "shield" ? ShieldCheck : Zap} size="sm" />
            <span>{approval.label}</span>
          </button>
        )}
      </div>
    );
  }

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

      {workspaceField}

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
