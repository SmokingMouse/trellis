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

export type ToolMeta = {
  /** Leading glyph. Keep it one grapheme so rows stay aligned. */
  icon?: string;
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
    icon: "▶",
    summary: (c) => field(c, "command") ?? field(c, "description"),
  },
  // codex names the same thing differently, and hands the command over as a
  // bare string rather than an object.
  shell: {
    icon: "▶",
    title: "Bash",
    summary: (c) => (typeof c.input === "string" ? c.input : field(c, "command")),
  },
  BashOutput: { icon: "▶", summary: (c) => field(c, "bash_id") },
  KillShell: { icon: "◼", summary: (c) => field(c, "shell_id") },

  // ── files ──────────────────────────────────────────────────────────────
  Read: {
    icon: "📄",
    summary: (c) => path(c),
    // The file body is already in the model's answer; showing it again turns
    // the timeline into a wall of source.
    resultPolicy: "hideOnSuccess",
  },
  Write: { icon: "✍", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  Edit: { icon: "✎", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  MultiEdit: { icon: "✎", summary: (c) => path(c), defaultOpen: true, resultPolicy: "hideOnSuccess" },
  NotebookEdit: { icon: "📓", summary: (c) => path(c, "notebook_path") },

  // ── search ─────────────────────────────────────────────────────────────
  Glob: { icon: "🔍", summary: (c) => field(c, "pattern") },
  Grep: {
    icon: "🔍",
    summary: (c) => {
      const p = field(c, "pattern");
      const dir = field(c, "path");
      return p && dir ? `${p}  ·  ${basename(dir)}` : p;
    },
  },
  WebFetch: { icon: "🌐", summary: (c) => field(c, "url") },
  WebSearch: { icon: "🌐", summary: (c) => field(c, "query") },
  web_search: {
    icon: "🌐",
    title: "WebSearch",
    summary: (c) => (typeof c.input === "string" ? c.input : field(c, "query")),
  },
  ToolSearch: { icon: "🧰", summary: (c) => field(c, "query") },

  // ── delegation (bodies come from the view registry) ─────────────────────
  Agent: { icon: "🤖", summary: (c) => field(c, "description") },
  Task: { icon: "🤖", summary: (c) => field(c, "description") },
  Workflow: {
    icon: "⚙",
    // The input is a multi-KB script; JSON-stringifying it (the old fallback)
    // produced an unreadable blob as the summary line.
    summary: () => null,
    defaultOpen: true,
  },

  // ── planning / interaction ─────────────────────────────────────────────
  TodoWrite: {
    icon: "☑",
    summary: (c) => {
      const todos = (c.input as { todos?: unknown[] } | null)?.todos;
      return Array.isArray(todos) ? `${todos.length} 项` : null;
    },
    defaultOpen: true,
    resultPolicy: "hidden",
  },
  ExitPlanMode: { icon: "📋", summary: () => "提交计划待批", defaultOpen: true },
  AskUserQuestion: {
    icon: "❓",
    summary: (c) => {
      const qs = (c.input as { questions?: Array<{ question?: string }> } | null)
        ?.questions;
      return Array.isArray(qs) ? (str(qs[0]?.question) ?? `${qs.length} 个问题`) : null;
    },
  },
  Skill: {
    icon: "🎯",
    summary: (c) => {
      const s = field(c, "skill");
      const args = field(c, "args");
      return s ? (args ? `${s} ${args}` : s) : null;
    },
  },
  SlashCommand: { icon: "／", summary: (c) => field(c, "command") },

  // ── background task bookkeeping ────────────────────────────────────────
  TaskCreate: { icon: "✚", summary: (c) => field(c, "description") ?? field(c, "prompt") },
  TaskUpdate: {
    icon: "✔",
    summary: (c) => {
      const id = field(c, "taskId");
      const st = field(c, "status");
      return [id && `#${id}`, st].filter(Boolean).join(" → ") || null;
    },
    resultPolicy: "hideOnSuccess",
  },
  TaskList: { icon: "≡", summary: () => null },
  TaskGet: { icon: "≡", summary: (c) => field(c, "task_id") },
  TaskOutput: { icon: "≡", summary: (c) => field(c, "task_id") },
  TaskStop: { icon: "◼", summary: (c) => field(c, "task_id") },
  SendMessage: { icon: "✉", summary: (c) => field(c, "to") },
};

// Fallback: pull the most user-meaningful field out of an unknown tool's
// input. Order matters — `command` before `description` so a Bash shows its
// command, not its label.
const DEFAULT_META: ToolMeta = {
  icon: "·",
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
    icon: "🔌",
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

export function toolIcon(call: ToolCall): string {
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
