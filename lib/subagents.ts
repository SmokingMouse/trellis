import type { SubagentMeta, ToolCall } from "@/lib/types";

// Stage 22: split a turn's flat tool-call list into "what the main agent did"
// and "what each sub-agent did".
//
// The CLI hands us one flat chain: the sub-agent's own Bash/Read calls sit
// right next to the main agent's, distinguishable only by parentToolUseId
// pointing back at the Task/Agent call that spawned them. Rendering that flat
// is what made tool panels unreadable once an agent delegates.
//
// Everything here is derived — no new state. Robust to the three shapes older
// / degraded data takes: rows with no parentToolUseId at all (pre-Stage-22),
// an Agent call whose task_* lines never arrived (no meta), and children whose
// parent isn't in the list (they fall back to the main chain rather than
// vanishing).

// Tool name the CLI uses for delegation. "Agent" is current (claude 2.x);
// "Task" is what older builds emitted. Name matching is only a fallback —
// a call with children or with task_* metadata is recognised regardless.
const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task"]);

// Guard against a malformed parent chain (a cycle, or absurd nesting) turning
// the transitive-descendant walk into a hang.
const MAX_NEST_DEPTH = 6;

export type SubagentGroup = {
  /** The Task/Agent call itself. */
  call: ToolCall;
  /** task_* metadata, backfilled from the tool input when absent. */
  meta: SubagentMeta;
  /** The sub-agent's own calls, oldest first. */
  children: ToolCall[];
  /** The sub-agent's final report; falls back to the tool's raw output. */
  report: string | null;
  running: boolean;
};

export type ToolChainSplit = {
  /** Main-agent calls only — sub-agent parents and their children removed. */
  main: ToolCall[];
  groups: SubagentGroup[];
};

export function splitToolChain(calls: ToolCall[]): ToolChainSplit {
  const byId = new Map(calls.map((c) => [c.id, c]));
  // Only treat a parent link as real when the target is actually present;
  // otherwise the child would disappear from every list.
  const childrenOf = new Map<string, ToolCall[]>();
  for (const c of calls) {
    const p = c.parentToolUseId;
    if (!p || !byId.has(p) || p === c.id) continue;
    const list = childrenOf.get(p);
    if (list) list.push(c);
    else childrenOf.set(p, [c]);
  }

  const isParent = (c: ToolCall) =>
    childrenOf.has(c.id) || c.agent !== undefined || SUBAGENT_TOOL_NAMES.has(c.name);
  const hasRealParent = (c: ToolCall) =>
    Boolean(c.parentToolUseId && byId.has(c.parentToolUseId));

  const groups: SubagentGroup[] = [];
  const claimed = new Set<string>();
  // Groups form only at the top level. A sub-agent that spawns its own
  // sub-agent (rare) keeps the whole descendant chain in one flat child list
  // rather than nesting boxes — the nested Agent call still shows as a row.
  for (const c of calls) {
    if (hasRealParent(c) || !isParent(c)) continue;
    const children = descendants(c.id, childrenOf);
    for (const ch of children) claimed.add(ch.id);
    claimed.add(c.id);
    groups.push({
      call: c,
      meta: metaFor(c),
      children,
      report: c.agent?.summary ?? c.output,
      running: c.status === "running",
    });
  }

  return { main: calls.filter((c) => !claimed.has(c.id)), groups };
}

function descendants(
  rootId: string,
  childrenOf: Map<string, ToolCall[]>,
): ToolCall[] {
  const out: ToolCall[] = [];
  const seen = new Set<string>([rootId]);
  let frontier = [rootId];
  for (let depth = 0; depth < MAX_NEST_DEPTH && frontier.length; depth++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const child of childrenOf.get(id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        out.push(child);
        next.push(child.id);
      }
    }
    frontier = next;
  }
  return out.sort((a, b) => a.startedAt - b.startedAt);
}

// task_* events carry the richest data, but they only exist on claude runs
// that got far enough. The Agent tool's own input has the same three fields,
// so a denied / pre-Stage-22 / non-claude call still renders with a label.
function metaFor(call: ToolCall): SubagentMeta {
  const input = (call.input ?? {}) as Record<string, unknown>;
  const fromInput: SubagentMeta = {
    subagentType:
      typeof input.subagent_type === "string" ? input.subagent_type : undefined,
    description:
      typeof input.description === "string" ? input.description : undefined,
    prompt: typeof input.prompt === "string" ? input.prompt : undefined,
  };
  return {
    ...fromInput,
    ...stripUndefined(call.agent ?? {}),
    // description is live-updated by task_progress to the *current step*
    // ("Running ls"), which is useful while running but a poor label once
    // finished — the original ask is what you want to read afterwards.
    description:
      call.status === "running"
        ? (call.agent?.description ?? fromInput.description)
        : (fromInput.description ?? call.agent?.description),
  };
}

function stripUndefined(m: SubagentMeta): SubagentMeta {
  const out: SubagentMeta = {};
  for (const [k, v] of Object.entries(m)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

/** Label for a sub-agent: "general-purpose" / "Explore" / fallback. */
export function subagentLabel(meta: SubagentMeta): string {
  return meta.subagentType?.trim() || "子 Agent";
}
