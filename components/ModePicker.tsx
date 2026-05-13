"use client";
import { useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import type { Mode, ProviderId } from "@/lib/llm";
import { WorkspacePicker } from "./WorkspacePicker";

// Stage 14: the mode picker only appears in the new-session draft state
// (the empty QuestionInput). It edits draftMode + draftWorkspacePath in
// the store; on first submit these get locked into the session row and
// the readonly ModeBadge in the header takes over.
//
// Selecting Workspace or Project without a workspace_path forces the
// WorkspacePicker open (the user can't leave with an inconsistent draft).
// Chat clears the workspace draft — chat has no cwd binding.

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

function TerminalIcon() {
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
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
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
  if (provider === "codex") {
    return [
      {
        id: "chat",
        label: "Chat",
        Icon: ChatIcon,
        title:
          "Chat：纯文本回复，沙箱 read-only，禁用所有 tools / MCP。codex 暂无 WebSearch 等价，无联网。",
      },
      {
        id: "workspace",
        label: "Workspace",
        Icon: TerminalIcon,
        title:
          "Workspace：在所选 cwd 中加载 ~/.codex/config.toml + MCP servers/plugins，YOLO 沙箱（含 Bash/Write/Edit）。每次提问独立。",
      },
      {
        id: "project",
        label: "Project",
        Icon: LinkIcon,
        title:
          "Project：整棵 trellis 树共享一个 codex session（线性多轮历史）。MCP/tools 全开。rollout 在 ~/.codex/sessions/。",
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
      id: "workspace",
      label: "Workspace",
      Icon: TerminalIcon,
      title:
        "Workspace：在所选仓库 cwd 中加载 skills + CLAUDE.md，工具自动放行（含 Bash/Write/Edit）。每次提问独立，分支上下文隔离。",
    },
    {
      id: "project",
      label: "Project",
      Icon: LinkIcon,
      title:
        "Project：整棵 trellis 树共享一个 claude session（线性多轮历史）。skills/tools 全开。删除 trellis session 时清理对应 jsonl。",
    },
  ];
}

export function ModePicker() {
  const mode = useSessionStore((s) => s.draftMode);
  const setMode = useSessionStore((s) => s.setDraftMode);
  const workspacePath = useSessionStore((s) => s.draftWorkspacePath);
  const setWorkspacePath = useSessionStore((s) => s.setDraftWorkspacePath);
  const provider = useSessionStore((s) => s.provider);
  const [pickerOpen, setPickerOpen] = useState(false);

  const OPTIONS = optionsFor(provider);
  const needsWorkspace = mode === "workspace" || mode === "project";

  const handleSelect = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (next === "chat") {
      // Chat doesn't bind a cwd — clear any stale draft to keep the
      // submit body coherent.
      setWorkspacePath(null);
    } else if (!workspacePath) {
      // Workspace / Project need a path. Open picker; user can't leave
      // it dangling because the submit gate also re-checks.
      setPickerOpen(true);
    }
  };

  return (
    <div className="inline-flex flex-wrap items-center gap-2">
      <div
        role="radiogroup"
        aria-label="Context mode"
        className="inline-flex h-7 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 overflow-hidden shrink-0"
      >
        {OPTIONS.map((opt) => {
          const active = mode === opt.id;
          const { Icon } = opt;
          const activeColor =
            opt.id === "project"
              ? "bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200"
              : opt.id === "workspace"
                ? "bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
                : // chat needs higher contrast against the white/stone-900
                  // outer surface — stone-100 vs white was nearly invisible
                  // in light mode. stone-200 + a 1px inset ring gives it
                  // the same visual weight as amber/rose without departing
                  // from its neutral identity.
                  "bg-stone-200 dark:bg-stone-700 text-stone-900 dark:text-stone-100 ring-1 ring-inset ring-stone-400/40 dark:ring-stone-500/40";
          return (
            <button
              key={opt.id}
              role="radio"
              aria-checked={active}
              title={opt.title}
              onClick={() => handleSelect(opt.id)}
              className={`px-2 text-[11px] font-medium transition-colors inline-flex items-center gap-1.5 border-l border-stone-300 dark:border-stone-700 first:border-l-0 ${
                active
                  ? activeColor
                  : "text-stone-500 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800"
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
          className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border text-[11px] font-medium transition-colors ${
            workspacePath
              ? "border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-200 hover:bg-stone-50 dark:hover:bg-stone-800"
              : "border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-700 dark:text-rose-200 animate-pulse"
          }`}
        >
          <span aria-hidden>📁</span>
          <span className="truncate max-w-[10rem] font-mono">
            {workspacePath ? basename(workspacePath) : "选择工作区"}
          </span>
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
