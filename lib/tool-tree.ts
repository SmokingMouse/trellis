import type { TaskKind, TaskMeta, ToolCall } from "@/lib/types";

// The turn's flat tool-call list → the tree the UI actually renders.
//
// The CLI hands us one flat chain: a sub-agent's own Bash/Read calls sit right
// next to the main agent's, distinguishable only by parentToolUseId pointing
// back at the call that spawned them. Rendering that flat is what made tool
// panels unreadable once an agent delegates.
//
// This replaces the older splitToolChain(), which returned two parallel lists
// ({main, groups}) and so had to *remove* delegated work from the timeline to
// show it in a separate box — breaking chronological order. One tree keeps
// everything on one timeline, with delegated work nested under its parent.
//
// Everything here is derived — no new state. Robust to the shapes older /
// degraded data takes: rows with no parentToolUseId at all, a delegation whose
// task_* lines never arrived (no meta), and children whose parent isn't in the
// list (they surface at top level rather than vanishing).

// Tool name the CLI uses for delegation. "Agent" is current (claude 2.x);
// "Task" is what older builds emitted. Name matching is only a fallback —
// taskType is the real judgement.
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

// Guard against a malformed parent chain (a cycle, or absurd nesting) turning
// the recursive walk into a hang.
const MAX_NEST_DEPTH = 6;

/**
 * What a row *is*, which decides how it renders.
 *
 * The distinction that matters: `subagent` and `longRunning` used to be the
 * same bucket, because both carry task_* metadata. They are not remotely the
 * same thing — a sub-agent has a report worth reading and a tool chain worth
 * nesting; a slow Bash has stdout and nothing else.
 */
export type ToolKind = "tool" | "subagent" | "workflow" | "longRunning";

export type ToolNode = {
  call: ToolCall;
  kind: ToolKind;
  /** task_* metadata, backfilled from the tool input when absent. */
  meta: TaskMeta;
  /** Calls this one spawned, oldest first. Empty for everything but subagent. */
  children: ToolNode[];
  running: boolean;
  /**
   * The sub-agent's final report — **only** for kind === "subagent".
   *
   * For local_bash the CLI's `summary` is the description echoed back, and for
   * local_workflow it's 'Dynamic workflow "..." completed'. Rendering either
   * as "the report it handed back" is how a Bash command's real stdout ended
   * up invisible: the summary won, and the output was never shown at all.
   */
  report: string | null;
};

/** taskId's first letter is the CLI's own tag for what kind of task it is. */
const TASK_ID_PREFIX: Record<string, TaskKind> = {
  a: "local_agent",
  b: "local_bash",
  w: "local_workflow",
};

/**
 * Which of the three task kinds this call spawned, or undefined for a plain
 * synchronous tool.
 *
 * `taskType` is the CLI's explicit field but only reaches us via @sm/agent
 * ≥0.3.3; the taskId prefix is an observed regularity (not a documented
 * contract) that covers older SDKs and lets this work before that release
 * lands. Keep both — the prefix is cheap and only consulted as a fallback.
 */
function taskKindOf(meta: TaskMeta | undefined): TaskKind | undefined {
  if (!meta) return undefined;
  if (meta.taskType) return meta.taskType;
  const first = meta.taskId?.[0];
  return first ? TASK_ID_PREFIX[first] : undefined;
}

export function toolKindOf(call: ToolCall, hasChildren: boolean): ToolKind {
  switch (taskKindOf(call.agent)) {
    case "local_agent":
      return "subagent";
    case "local_workflow":
      return "workflow";
    case "local_bash":
      return "longRunning";
  }
  // No task metadata (denied call, non-claude backend, pre-0.3.3 rows). Fall
  // back to the tool's own name, then to "it spawned children, so it must
  // have delegated".
  if (call.name === "Workflow") return "workflow";
  if (SUBAGENT_TOOL_NAMES.has(call.name) || hasChildren) return "subagent";
  return "tool";
}

export function buildToolTree(calls: ToolCall[]): ToolNode[] {
  const byId = new Map(calls.map((c) => [c.id, c]));
  const childrenOf = new Map<string, ToolCall[]>();
  const roots: ToolCall[] = [];
  for (const c of calls) {
    const p = c.parentToolUseId;
    // Only honour a parent link when the target is actually present —
    // otherwise the child would disappear from every list.
    if (p && p !== c.id && byId.has(p)) {
      const list = childrenOf.get(p);
      if (list) list.push(c);
      else childrenOf.set(p, [c]);
    } else {
      roots.push(c);
    }
  }

  // A cycle in parentToolUseId would otherwise recurse forever; visiting each
  // call at most once also means a malformed chain drops rows instead of
  // duplicating them.
  const visited = new Set<string>();
  const build = (call: ToolCall, depth: number): ToolNode => {
    visited.add(call.id);
    const kids =
      depth >= MAX_NEST_DEPTH
        ? []
        : (childrenOf.get(call.id) ?? [])
            .filter((k) => !visited.has(k.id))
            .sort((a, b) => a.startedAt - b.startedAt)
            .map((k) => build(k, depth + 1));
    const kind = toolKindOf(call, kids.length > 0);
    return {
      call,
      kind,
      meta: metaFor(call, kind),
      children: kids,
      running: call.status === "running",
      report: kind === "subagent" ? (call.agent?.summary ?? call.output) : null,
    };
  };

  return roots
    .filter((c) => !visited.has(c.id))
    .sort((a, b) => a.startedAt - b.startedAt)
    .map((c) => build(c, 0));
}

// task_* events carry the richest data, but they only exist on claude runs
// that got far enough. The Agent tool's own input has the same three fields,
// so a denied / non-claude call still renders with a label.
function metaFor(call: ToolCall, kind: ToolKind): TaskMeta {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const fromInput: TaskMeta = {
    subagentType:
      typeof input.subagent_type === "string" ? input.subagent_type : undefined,
    description:
      typeof input.description === "string" ? input.description : undefined,
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
  };
  const merged: TaskMeta = {
    ...fromInput,
    ...stripUndefined(call.agent ?? {}),
    // description is live-updated by task_progress to the *current step*
    // ("Running ls" / "Beta: beta-1"), which is useful while running but a
    // poor label once finished — the original ask is what you want to read
    // afterwards.
    description:
      call.status === "running"
        ? (call.agent?.description ?? fromInput.description)
        : (fromInput.description ?? call.agent?.description),
  };
  if (kind === "workflow") {
    if (!merged.description) merged.description = merged.workflowName;
    // The CLI puts the whole script in task_started's `prompt`, but a run that
    // never got that far (or a non-claude backend) still has it in the tool
    // input — under `script`, or on disk at `scriptPath` for a resume.
    if (!merged.prompt) {
      merged.prompt =
        (typeof input.script === "string" ? input.script : undefined) ??
        (typeof input.scriptPath === "string" ? input.scriptPath : undefined);
    }
  }
  return merged;
}

function stripUndefined(m: TaskMeta): TaskMeta {
  const out: TaskMeta = {};
  for (const [k, v] of Object.entries(m)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Label for a sub-agent: "general-purpose" / "Explore" / fallback. */
export function subagentLabel(meta: TaskMeta): string {
  return meta.subagentType?.trim() || "子 Agent";
}

/** Depth-first walk, parents before children. */
export function walkToolTree(nodes: ToolNode[]): ToolNode[] {
  const out: ToolNode[] = [];
  const push = (n: ToolNode) => {
    out.push(n);
    for (const c of n.children) push(c);
  };
  for (const n of nodes) push(n);
  return out;
}

export type ToolTreeCounts = {
  /** Every call in the tree, nested ones included. */
  total: number;
  subagents: number;
  workflows: number;
  running: number;
  errors: number;
};

export function countToolTree(nodes: ToolNode[]): ToolTreeCounts {
  const all = walkToolTree(nodes);
  return {
    total: all.length,
    subagents: all.filter((n) => n.kind === "subagent").length,
    workflows: all.filter((n) => n.kind === "workflow").length,
    running: all.filter((n) => n.running).length,
    errors: all.filter((n) => n.call.status === "error").length,
  };
}
