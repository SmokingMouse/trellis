"use client";
import { useSessionStore } from "@/stores/sessionStore";
import type { Mode, ProviderId } from "@/lib/llm";

// Inline SVG paths instead of emoji — emoji rendering varies across OS / font
// stacks (variation selectors, color font fallback, baseline drift), and the
// three were visually mismatched. SVG keeps everything aligned + uses
// currentColor so the active-state coloring works.
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

// Picker shows the same three modes regardless of provider, but the
// tooltips reference whichever local CLI is actually being driven (claude
// vs codex) — paths, capability names, and "session" semantics differ.
function optionsFor(provider: ProviderId): Option[] {
  if (provider === "codex") {
    return [
      {
        id: "lean",
        label: "lean",
        Icon: ChatIcon,
        title:
          "Lean 模式：纯文本回复，沙箱 read-only，禁用所有 tools，不加载用户配置/MCP。最便宜。",
      },
      {
        id: "cli-single",
        label: "CLI 单轮",
        Icon: TerminalIcon,
        title:
          "CLI 单轮：加载 ~/.codex/config.toml + MCP servers/plugins，YOLO 沙箱工具自动放行（含 Bash/Write/Edit）。每次提问独立，trellis 自己折叠历史；分支上下文隔离。",
      },
      {
        id: "cli-multi",
        label: "CLI 多轮",
        Icon: LinkIcon,
        title:
          "CLI 多轮：整棵 trellis 树共享一个 codex session（线性多轮历史）。MCP/tools 全开。分支不再隔离——codex 看到的是平铺的对话历史。session 持久化在 ~/.codex/sessions/ 下。",
      },
    ];
  }
  // Claude (default for sonnet/opus/haiku, also fallback for mock).
  return [
    {
      id: "lean",
      label: "lean",
      Icon: ChatIcon,
      title:
        "Lean 模式：纯文本回复，禁用所有 tools，不加载 skills/CLAUDE.md。最便宜。",
    },
    {
      id: "cli-single",
      label: "CLI 单轮",
      Icon: TerminalIcon,
      title:
        "CLI 单轮：加载 skills + ~/.claude/CLAUDE.md，工具自动放行（含 Bash/Write/Edit）。每次提问独立，trellis 自己折叠历史；分支上下文隔离。",
    },
    {
      id: "cli-multi",
      label: "CLI 多轮",
      Icon: LinkIcon,
      title:
        "CLI 多轮：整棵 trellis 树共享一个 claude session（线性多轮历史）。skills/tools 全开。分支不再隔离——claude 看到的是平铺的对话历史。删除 trellis session 时会自动清理 ~/.claude/projects 下的对应 jsonl。",
    },
  ];
}

export function ModePicker() {
  const mode = useSessionStore((s) => s.mode);
  const setMode = useSessionStore((s) => s.setMode);
  const provider = useSessionStore((s) => s.provider);
  const OPTIONS = optionsFor(provider);
  const cliName = provider === "codex" ? "codex" : "claude";

  return (
    <div
      role="radiogroup"
      aria-label="Context mode"
      className="inline-flex h-7 rounded-md border border-stone-300 dark:border-stone-700 bg-white dark:bg-stone-900 overflow-hidden shrink-0"
    >
      {OPTIONS.map((opt) => {
        const active = mode === opt.id;
        const { Icon } = opt;
        const activeColor =
          opt.id === "cli-multi"
            ? "bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200"
            : opt.id === "cli-single"
              ? "bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200"
              : "bg-stone-100 dark:bg-stone-700 text-stone-900 dark:text-stone-100";
        return (
          <button
            key={opt.id}
            role="radio"
            aria-checked={active}
            title={opt.title}
            onClick={() => {
              if (mode === opt.id) return;
              if (opt.id === "cli-multi" && mode !== "cli-multi") {
                const ok = window.confirm(
                  `切到 CLI 多轮模式？\n\n之前的对话不会被新模式继承——你的下一问会是 ${cliName} 视角的第一轮。后续此 trellis session 内所有节点共享一个 ${cliName} session（树形分支不再隔离上下文）。`,
                );
                if (!ok) return;
              }
              setMode(opt.id);
            }}
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
  );
}
