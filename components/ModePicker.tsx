"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { modeStyle } from "@/lib/mode-style";
import { providerFamily } from "@/lib/llm";
import type { Mode, ProviderId } from "@/lib/llm";
import { WorkspacePicker } from "./WorkspacePicker";

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

type Option = {
  id: Mode;
  label: string;
  Icon: () => React.ReactElement;
  title: string;
};

function optionsFor(provider: ProviderId): Option[] {
  if (providerFamily(provider) === "codex") {
    return [
      {
        id: "chat",
        label: "Chat",
        Icon: ChatIcon,
        title:
          "Chat：纯文本回复，沙箱 read-only，禁用所有 tools / MCP。codex 暂无 WebSearch 等价，无联网。",
      },
      {
        id: "project",
        label: "Project",
        Icon: LinkIcon,
        title:
          "Project：一条岔一个 codex session（分叉=前缀 rollout 新 lineage）。MCP/tools 全开。rollout 在 ~/.codex/sessions/，删除 trellis session 时清理。",
      },
    ];
  }
  // Claude (default).
  return [
    {
      id: "chat",
      label: "Chat",
      Icon: ChatIcon,
      title:
        "Chat：纯文本 + WebSearch / WebFetch 联网。不加载 skills / CLAUDE.md。最便宜，对标 GPT 网页客户端。",
    },
    {
      id: "project",
      label: "Project",
      Icon: LinkIcon,
      title:
        "Project：在所选仓库 cwd 中加载 skills + CLAUDE.md，一条岔一个 claude session（分叉=前缀 jsonl 新 lineage）。skills/tools 全开。删除 trellis session 时清理对应 jsonl。",
    },
  ];
}

export function ModePicker() {
  const mode = useSessionStore((s) => s.draftMode);
  const setMode = useSessionStore((s) => s.setDraftMode);
  const workspacePath = useSessionStore((s) => s.draftWorkspacePath);
  const setWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const provider = useSessionStore((s) => s.provider);
  const requireApproval = useSessionStore((s) => s.draftRequireApproval);
  const setRequireApproval = useSessionStore((s) => s.setDraftRequireApproval);
  const [pickerOpen, setPickerOpen] = useState(false);

  const OPTIONS = optionsFor(provider);
  const needsWorkspace = mode === "project";
  // 权限确认开关：仅 claude 系的 project 有意义（chat 无文件工具；
  // codex 无 stdio 审批协议，显示了也是谎言）。服务端创建时还会再钳一道。
  const approvalAvailable = needsWorkspace && providerFamily(provider) === "claude";

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
          const { Icon } = opt;
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
        <button
          onClick={() => setPickerOpen(true)}
          title={workspacePath ?? "请选择工作区目录"}
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-label font-medium transition-colors ${
            workspacePath
              ? "border-line-strong bg-surface text-ink hover:bg-surface-muted"
              : "border-danger-line bg-danger-muted text-danger-ink animate-pulse"
          }`}
        >
          <span aria-hidden>📁</span>
          <span className="truncate max-w-[10rem] font-mono">
            {workspacePath ? basename(workspacePath) : "选择工作区"}
          </span>
        </button>
      )}

      {approvalAvailable && (
        <button
          onClick={() => setRequireApproval(!requireApproval)}
          title={
            requireApproval
              ? "需确认：Bash/Write/Edit 等可变更工具逐个弹卡，等你允许/拒绝后才执行（创建会话时锁定）"
              : "YOLO：工具自动放行（现状默认）。点击切换为需确认——可变更工具执行前先问你"
          }
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-label font-medium transition-colors ${
            requireApproval
              ? "border-accent-line bg-accent-muted text-accent-ink"
              : "border-line-strong bg-surface text-ink-faint hover:bg-surface-muted"
          }`}
        >
          <span aria-hidden>{requireApproval ? "🛡️" : "⚡"}</span>
          <span>{requireApproval ? "需确认" : "YOLO"}</span>
        </button>
      )}

      {pickerOpen && (
        <WorkspacePicker
          currentPath={workspacePath}
          onPick={(p) => setWorkspacePath(p)}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  );
}

function basename(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}
