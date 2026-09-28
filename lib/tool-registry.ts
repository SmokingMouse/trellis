import type { ToolNode } from "@/lib/tool-tree";
import type { ToolCall } from "@/lib/types";

// Per-tool display metadata — the "90% table".
//
// Before this existed, every tool rendered as `name + JSON.stringify(input)`
// with a pretty-printed <pre> body: a Bash log, a file read and an
// AskUserQuestion payload all looked identical. The fix is NOT a React
// component per tool (that doesn't scale past a handful); it's this table,
// where a tool usually needs one line, plus a much smaller component registry
// (see components/tools/views) for the four or five that genuinely need a
// custom body.
//
// Unknown tools are fine — they get DEFAULT_META, whose summary is the same
// field-sniffing heuristic the old panel used for everything.

/**
 * 行首图标 key。这里只存字符串 key（本文件也被 API route 引用，不能带 React
 * 组件）；key → lucide 组件的映射在 components/ui/Icon.tsx 的 TOOL_ICONS。
 * 原来存的是 emoji（📄🔍🌐🤖…），W2 起换成统一线宽的 lucide 图标。
 */
export type ToolIconKey =
  | "terminal"
  | "stop"
  | "file"
  | "file-pen"
  | "pencil"
  | "notebook"
  | "search"
  | "globe"
  | "toolbox"
  | "bot"
  | "workflow"
  | "list-checks"
  | "clipboard"
  | "question"
  | "target"
  | "slash"
  | "plus"
  | "check"
  | "list"
  | "mail"
  | "plug"
  | "timer"
  | "dot";

export type ToolMeta = {
  /** 行首图标 key（见 ToolIconKey）。 */
  icon?: ToolIconKey;
  /** Row title; defaults to the raw tool name. */
  title?: string | ((call: ToolCall) => string);
  /** One-line summary next to the title. null = show nothing. */
  summary?: (call: ToolCall) => string | null;
  /**
   * Start expanded. Reserved for tools whose *body* is the point (a diff, a
   * todo list, a workflow's phase tree) — for everything else the collapsed
   * one-liner is the whole value of a timeline.
   */
  defaultOpen?: boolean | ((node: ToolNode) => boolean);
  /**
   * What to do with the output block on success. Errors ignore this entirely
   * (see showResult) — a hidden failure is the one thing a tool timeline must
   * never do.
   */
  resultPolicy?: "show" | "hideOnSuccess" | "hidden";
};

const basename = (p: string) => p.split("/").filter(Boolean).pop() ?? p;

const str = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 ? v : null;

function field(call: ToolCall, key: string): string | null {
  const i = call.input;
  if (!i || typeof i !== "object") return null;
  return str((i as Record<string, unknown>)[key]);
}

function path(call: ToolCall, key = "file_path"): string | null {
  const p = field(call, key);
  return p ? basename(p) : null;
}

const REGISTRY: Record<string, ToolMeta> = {
  // ── shell ──────────────────────────────────────────────────────────────
  Bash: {
    icon: "terminal",
    summary: (c) => field(c, "command") ?? field(c, "description"),
  },
  // codex names the same thing differently, and hands the command over as a
  // bare string rather than an object.
  shell: {
    icon: "terminal",
    title: "Bash",
    summary: (c) => (typeof c.input === "string" ? c.input : field(c, "command")),
  },
  BashOutput: { icon: "terminal", summary: (c) => field(c, "bash_id") },
  KillShell: { icon: "stop", summary: (c) => field(c, "shell_id") },

  // ── files ──────────────────────────────────────────────────────────────
  Read: {
    icon: "file",
    summary: (c) => path(c),
    // The file body is already in the model's answer; showing it again turns
    // the timeline into a wall of source.
    resultPolicy: "hideOnSuccess",
  },
  Write: { icon: "file-pen", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  Edit: { icon: "pencil", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  MultiEdit: { icon: "pencil", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  NotebookEdit: { icon: "notebook", summary: (c) => path(c, "notebook_path") },

  // ── search ─────────────────────────────────────────────────────────────
  Glob: { icon: "search", summary: (c) => field(c, "pattern") },
  Grep: {
    icon: "search",
    summary: (c) => {
      const p = field(c, "pattern");
      const dir = field(c, "path");
      return p && dir ? `${p}  ·  ${basename(dir)}` : p;
    },
  },
  WebFetch: { icon: "globe", summary: (c) => field(c, "url") },
  WebSearch: { icon: "globe", summary: (c) => field(c, "query") },
  web_search: {
    icon: "globe",
    title: "WebSearch",
    summary: (c) => (typeof c.input === "string" ? c.input : field(c, "query")),
  },
  ToolSearch: { icon: "toolbox", summary: (c) => field(c, "query") },

  // ── delegation (bodies come from the view registry) ─────────────────────
  Agent: { icon: "bot", summary: (c) => field(c, "description") },
  Task: { icon: "bot", summary: (c) => field(c, "description") },
  Workflow: {
    icon: "workflow",
    // The input is a multi-KB script; JSON-stringifying it (the old fallback)
    // produced an unreadable blob as the summary line.
    summary: () => null,
    // 没有 defaultOpen 是有意的：跑着的时候 rowAutoOpen 已经让它保持展开并随
    // 快照刷新，跑完就该收成一行摘要 —— 表头本身说得完（名称 · 状态 · 进度 ·
    // agents · 用时 · token），再摊开一整棵已经凉了的阶段树只是占屏。
  },

  // ── planning / interaction ─────────────────────────────────────────────
  TodoWrite: {
    icon: "list-checks",
    summary: (c) => {
      const todos = (c.input as { todos?: unknown[] } | null)?.todos;
      return Array.isArray(todos) ? `${todos.length} 项` : null;
    },
    defaultOpen: true,
    resultPolicy: "hidden",
  },
  ExitPlanMode: { icon: "clipboard", summary: () => "提交计划待批", defaultOpen: true },
  AskUserQuestion: {
    icon: "question",
    summary: (c) => {
      const qs = (c.input as { questions?: Array<{ question?: string }> } | null)
        ?.questions;
      return Array.isArray(qs) ? (str(qs[0]?.question) ?? `${qs.length} 个问题`) : null;
    },
  },
  Skill: {
    icon: "target",
    summary: (c) => {
      const s = field(c, "skill");
      const args = field(c, "args");
      return s ? (args ? `${s} ${args}` : s) : null;
    },
  },
  SlashCommand: { icon: "slash", summary: (c) => field(c, "command") },

  // ── background task bookkeeping ────────────────────────────────────────
  TaskCreate: { icon: "plus", summary: (c) => field(c, "description") ?? field(c, "prompt") },
  TaskUpdate: {
    icon: "check",
    summary: (c) => {
      const id = field(c, "taskId");
      const st = field(c, "status");
      return [id && `#${id}`, st].filter(Boolean).join(" → ") || null;
    },
    resultPolicy: "hideOnSuccess",
  },
  TaskList: { icon: "list", summary: () => null },
  TaskGet: { icon: "list", summary: (c) => field(c, "task_id") },
  TaskOutput: { icon: "list", summary: (c) => field(c, "task_id") },
  TaskStop: { icon: "stop", summary: (c) => field(c, "task_id") },
  SendMessage: { icon: "mail", summary: (c) => field(c, "to") },
};

// Fallback: pull the most user-meaningful field out of an unknown tool's
// input. Order matters — `command` before `description` so a Bash shows its
// command, not its label.
const DEFAULT_META: ToolMeta = {
  icon: "dot",
  summary: (call) => {
    const i = call.input;
    if (typeof i === "string") return i || null;
    if (i && typeof i === "object") {
      const o = i as Record<string, unknown>;
      for (const k of ["command", "file_path", "url", "query", "pattern", "description"]) {
        const v = str(o[k]);
        if (v) return v;
      }
    }
    const flat = JSON.stringify(i);
    if (!flat) return null;
    return flat.length > 80 ? flat.slice(0, 80) + "…" : flat;
  },
};

/** `mcp__linear__create_issue` → `MCP linear · create issue`. */
function mcpMeta(name: string): ToolMeta | null {
  if (!name.startsWith("mcp__")) return null;
  const [, server, ...rest] = name.split("__");
  const tool = rest.join("__").replace(/_/g, " ");
  return {
    icon: "plug",
    title: `MCP ${server}`,
    summary: () => tool || null,
  };
}

export function toolMeta(name: string): ToolMeta {
  return REGISTRY[name] ?? mcpMeta(name) ?? DEFAULT_META;
}

export function toolTitle(call: ToolCall): string {
  const t = toolMeta(call.name).title;
  if (typeof t === "function") return t(call);
  return t ?? call.name;
}

export function toolSummary(call: ToolCall): string | null {
  const meta = toolMeta(call.name);
  const s = (meta.summary ?? DEFAULT_META.summary)!(call);
  return s ?? null;
}

export function toolIcon(call: ToolCall): ToolIconKey {
  return toolMeta(call.name).icon ?? DEFAULT_META.icon!;
}

export function defaultOpen(node: ToolNode): boolean {
  const d = toolMeta(node.call.name).defaultOpen;
  if (typeof d === "function") return d(node);
  return d ?? false;
}

/**
 * Whether to render the output block. A failed call always shows it, no
 * matter what the table says — hiding the one row that explains why the turn
 * went sideways is strictly worse than a bit of noise.
 */
export function showResult(call: ToolCall): boolean {
  if (call.status === "error" || call.stderr) return true;
  switch (toolMeta(call.name).resultPolicy) {
    case "hidden":
      return false;
    case "hideOnSuccess":
      return call.status !== "done";
    default:
      return true;
  }
}
