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

// Tools whose call marks a *narrative beat* of the turn (a plan update, a plan
// submission, a question to the human) rather than a unit of mechanical work.
// They never fold into a cold segment: a TodoWrite between two runs of file
// edits — or the AskUserQuestion whose answer redirected the turn — is the
// chapter heading that makes the compressed skeleton readable.
const CHECKPOINT_TOOL_NAMES = new Set([
  "TodoWrite",
  "ExitPlanMode",
  "AskUserQuestion",
]);

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

// ── 冷热分段 ──────────────────────────────────────────────────────────────
//
// The timeline's attention problem: a 40-step turn rendered one row per call
// puts 40 rows of *history* (cold) in the same visual register as the one
// thing that's actually happening (hot). The fix is structural, not styling:
// runs of completed plain tool calls compress into one "segment" entry the UI
// renders as a single dimmed chip, while everything a reader navigates by —
// delegations, checkpoints, failures, whatever is running right now — stays a
// standalone entry.
//
// What is *never* swallowed into a segment:
//   - delegations (subagent / workflow / longRunning): they're the skeleton
//   - running calls: the hot tail — history folds up, the live row stays out
//   - errors: a chip that hides a failure makes "errors are never hidden" a lie
//   - checkpoint tools (TodoWrite / ExitPlanMode): the chapter headings

/** Fewer consecutive foldable calls than this render as plain rows — a chip
 * that replaces one or two one-line rows costs a click and saves nothing. */
export const MIN_SEGMENT = 3;

export type TimelineEntry =
  | { type: "node"; node: ToolNode }
  | { type: "segment"; nodes: ToolNode[] };

function segmentable(node: ToolNode): boolean {
  return (
    node.kind === "tool" &&
    !node.running &&
    node.call.status !== "error" &&
    !CHECKPOINT_TOOL_NAMES.has(node.call.name)
  );
}

/** One sibling list → the entries the UI renders, chronological order kept. */
export function segmentTimeline(nodes: ToolNode[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let run: ToolNode[] = [];
  const flush = () => {
    if (run.length >= MIN_SEGMENT) out.push({ type: "segment", nodes: run });
    else for (const n of run) out.push({ type: "node", node: n });
    run = [];
  };
  for (const n of nodes) {
    if (segmentable(n)) run.push(n);
    else {
      flush();
      out.push({ type: "node", node: n });
    }
  }
  flush();
  return out;
}

/**
 * The deepest currently-running chain, root first — the breadcrumb the header
 * shows while streaming. Among parallel running siblings the most recently
 * started wins (siblings are already sorted by startedAt): what the user wants
 * to see is the newest thing the run reached for.
 */
export function runningChain(tree: ToolNode[]): ToolNode[] {
  const chain: ToolNode[] = [];
  let level = tree;
  for (let depth = 0; depth <= MAX_NEST_DEPTH; depth++) {
    const running = level.filter((n) => n.running);
    if (running.length === 0) break;
    const pick = running[running.length - 1];
    chain.push(pick);
    level = pick.children;
  }
  return chain;
}

/** Failures anywhere under this node (children and deeper, self excluded) —
 * so a collapsed delegation row can still confess its nested failures. */
export function nestedErrorCount(node: ToolNode): number {
  return walkToolTree(node.children).filter((n) => n.call.status === "error")
    .length;
}
