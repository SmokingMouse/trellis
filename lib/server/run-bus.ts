import "server-only";
import {
  appendNodeResponse,
  appendToolCallStart,
  finalizeNode,
  markToolCallDone,
  setNodeTopicLabel,
  setRootResumeIdForNode,
  setNodeResumeId,
} from "./repo";
import {
  persistPendingInteraction,
  clearPendingInteraction,
} from "./repo";
import type { ToolCall, PendingInteraction } from "@/lib/types";
import type { ProviderFamily, InteractionDecision } from "@/lib/llm";

// A路②: tools that pause the run and require a user answer. Every other tool
// the CLI surfaces through the stdio permission protocol is auto-allowed so
// workspace/project keep their bypassPermissions YOLO behaviour (zero stall).
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// A路②: the onCanUseTool callback shape the SDK hands us. Redeclared narrowly
// (same as ProviderEvent) to avoid widening server-only imports.
export type OnCanUseTool = (req: {
  toolName: string;
  toolUseId: string;
  requestId: string;
  input: unknown;
}) => Promise<InteractionDecision>;

// A路②: context handed to the factory so it can plumb the interaction callback
// into the provider's RunOptions. Only claude-family runs receive a non-null
// onCanUseTool (codex/mock have no stdio permission protocol).
export type RunContext = {
  onCanUseTool?: OnCanUseTool;
};

// Stage 17 (durable streams): a module-level pub/sub that decouples LLM
// spawn lifecycles from HTTP requests. Before this, /api/chat held the
// for-await over llm.stream() with `signal: req.signal` — client tab
// hidden / network blip / refresh → req.signal aborted → child process
// killed → DB row finalized with status='error', errorMessage='aborted'.
//
// After: /api/chat starts a Run via startRun() and itself just becomes a
// subscriber. The Run owns its own AbortController; HTTP disconnect only
// removes one subscriber from the set, doesn't touch the underlying
// generator. Late subscribers (refresh, second tab, mobile waking up)
// hit GET /api/nodes/[id]/stream which calls subscribe() to join.
//
// Persistence is unchanged: every delta still goes through
// appendNodeResponse() so the DB row is authoritative even if every
// subscriber unsubscribes mid-stream.

// Event shape mirrors the StreamEvent on the client side; matchKind /
// session_init are server-internal and never forwarded as SSE.
export type RunEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        contextTokens?: number | null;
      };
    }
  | { type: "error"; message: string }
  | { type: "topic_label"; nodeId: string; label: string }
  // CLI 同步 Stage 2：attach 会话续聊完，身份对账把临时节点换成 canonical jsonl-uuid
  // 节点后，让客户端重载该 session 拿到正确 id（详见 progress/cli-sync.md）。
  | { type: "reload_session"; sessionId: string }
  // Stage 17: tool visualization. tool_call_start fires when claude
  // emits a tool_use block; tool_call_done fires when the matching
  // tool_result arrives. Both ride the same bus as deltas, so the
  // chat-route SSE and the reconnect endpoint deliver them in order.
  | {
      type: "tool_call_start";
      id: string;
      name: string;
      input: unknown;
      startedAt: number;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    }
  // A路②: a run paused on an interactive tool, broadcast so the UI renders the
  // waiting form; interaction_resolved when the user's answer continues it.
  | {
      type: "interaction_required";
      toolUseId: string;
      toolName: string;
      input: unknown;
    }
  | { type: "interaction_resolved"; toolUseId: string };

// Special event delivered by subscribe() to fresh subscribers so they
// can sync their UI to the current persisted state before live delta
// events start arriving. Not produced by the runner itself.
export type CatchupEvent = {
  type: "catchup";
  response: string;
  status: "streaming" | "done" | "error";
  // Stage 17: server-authoritative snapshot of every tool call observed
  // so far. Client overwrites its local toolCalls list with this, then
  // applies subsequent tool_call_start / tool_call_done events on top.
  toolCalls: ToolCall[];
  // A路②: if the run is currently paused on an interactive tool, the snapshot
  // carries the pending prompt so a reconnecting / late client immediately
  // renders the waiting form (without waiting for a fresh interaction_required
  // it already missed). null when nothing is pending.
  pendingInteraction: PendingInteraction | null;
  // When status !== "streaming", the terminal events follow immediately
  // (so the subscriber can close out). For "streaming" status, the
  // subscriber stays attached and waits for live RunEvents.
};

type Subscriber = {
  onEvent: (event: RunEvent | CatchupEvent) => void;
  onClose: () => void;
};

type RunState = {
  nodeId: string;
  // The runner's abort signal. abort(nodeId) flips this; the provider
  // generator observes it via its `signal` arg and tears down cleanly.
  controller: AbortController;
  status: "streaming" | "done" | "error";
  // Live mirror of the DB's response column for this run. Snapshotted
  // and shipped as the catchup payload to new subscribers; ALSO grown
  // before each delta broadcast so the snapshot can't lag a delta the
  // subscriber would otherwise miss.
  committedText: string;
  // Stage 17: in-memory mirror of the tool_calls_json column. Same
  // commit-before-broadcast discipline as committedText — a tool event
  // updates this BEFORE going to subscribers, so a racing subscribe()
  // snapshot can't miss a tool call that's already been persisted.
  committedToolCalls: ToolCall[];
  // Final-state cache so late subscribers (joining after the runner
  // terminated but within the cleanup window) still get the right
  // terminal event sequence.
  finalEvent?:
    | {
        type: "done";
        usage: {
          input: number;
          output: number;
          cacheRead: number;
          cacheCreation: number;
        };
      }
    | { type: "error"; message: string };
  topicLabel?: string;
  // A路②: the interactive-tool prompt currently awaiting a user answer, plus
  // the resolver that the onCanUseTool promise is parked on. Both null/unset
  // when no interaction is in flight. resolveInteraction() (POST respond) and
  // the abort path call interactionResolver to unpark the promise.
  pendingInteraction: PendingInteraction | null;
  interactionResolver?: (answer: InteractionDecision) => void;
  subscribers: Set<Subscriber>;
  // Drop the RunState 30s after terminal so memory doesn't accrete. New
  // subscribers after that window go through /api/nodes/[id]/stream
  // which falls back to a pure DB read.
  cleanupTimer?: ReturnType<typeof setTimeout>;
};

const RUNS = new Map<string, RunState>();
const CLEANUP_GRACE_MS = 30_000;

// Provider event shape mirrors what llm.stream() yields. Importing the
// type from the provider module would pull "server-only" into more
// places; we redeclare here narrowly enough.
export type ProviderEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        contextTokens?: number | null;
      };
    }
  | { type: "error"; message: string }
  | { type: "session_init"; sessionId: string }
  | {
      type: "tool_call_start";
      id: string;
      name: string;
      input: unknown;
      startedAt: number;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    };

// Caller hands us:
//   - the nodeId (where deltas accumulate via appendNodeResponse)
//   - a factory that yields ProviderEvent given an AbortSignal
//   - mode + (optional) topicLabel hook so we can do post-done work
//     without the route handler holding a reference to anything
//
// We return immediately after kicking off the runner. The caller's only
// responsibility is to subscribe() if it wants live events.
export function startRun(args: {
  nodeId: string;
  // Where session_init writes the freshly-spawned CLI session id:
  //   "root" — walk to root, store there (project: whole tree shares one id).
  //   "node" — store on this node itself (chat B-fork: each node owns its
  //            forked session; children resume the parent's via --fork-session).
  //   undefined — don't persist (codex/mock, or project non-first-turn where
  //            the root id already exists and shouldn't be overwritten).
  sessionIdTarget?: "root" | "node";
  // Which provider family this run belongs to — decides which resume-id
  // column session_init writes (claude_session_id vs codex_session_id; mock
  // is a no-op). Resume ids are family-scoped and must not cross families.
  resumeFamily: ProviderFamily;
  // Async generator factory. Receives the run's abort signal — the
  // provider should plumb this into its child_process kill path so
  // abort() actually tears the spawn down.
  // A路②: also receives a RunContext whose onCanUseTool the factory threads
  // into the provider RunOptions (claude family only). run-bus builds that
  // callback here (closure over `state`) so it can broadcast + persist + park
  // a resolver. Non-interactive tools auto-allow inside it; only
  // AskUserQuestion / ExitPlanMode actually pause.
  factory: (
    signal: AbortSignal,
    ctx: RunContext,
  ) => AsyncIterable<ProviderEvent>;
  // A路②: whether this run should open the interaction protocol. True only for
  // the claude family — codex/mock have no stdio permission control. When
  // false, ctx.onCanUseTool is undefined and the provider never opens it.
  interactive?: boolean;
  // Optional post-done topic generator. Called with the aggregated
  // text; if it returns a non-empty string we write the label and emit
  // a topic_label event to subscribers. Errors are swallowed.
  topicLabel?: (aggregated: string) => Promise<string | null>;
}): void {
  const existing = RUNS.get(args.nodeId);
  if (existing && existing.status === "streaming") {
    // Already running — startRun is idempotent for in-flight runs.
    // (Retry path resets the row before calling startRun, so a
    // second startRun for the same nodeId after a finalize is fine.)
    return;
  }
  if (existing?.cleanupTimer) clearTimeout(existing.cleanupTimer);

  const controller = new AbortController();
  const state: RunState = {
    nodeId: args.nodeId,
    controller,
    status: "streaming",
    committedText: "",
    committedToolCalls: [],
    pendingInteraction: null,
    subscribers: new Set(),
  };
  RUNS.set(args.nodeId, state);

  // Fire off the generator on the next microtask. Doing it inside the
  // current sync call would mean startRun resolves before any subscribe
  // could attach — that's fine because subscribers always see catchup
  // first, but doing it lazily also lets the caller add its first
  // subscriber before the first delta lands.
  queueMicrotask(() => runLoop(state, args).catch(() => {
    // runLoop has its own try/catch — this is a defense-in-depth no-op.
  }));
}

async function runLoop(
  state: RunState,
  args: Parameters<typeof startRun>[0],
): Promise<void> {
  let aggregated = "";
  let usage: {
    input: number;
    output: number;
    cacheRead: number;
    cacheCreation: number;
    contextTokens?: number | null;
  } = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, contextTokens: null };
  let stoppedWith: "done" | "error" = "done";
  let errorMessage: string | undefined;

  // A路②: build the interaction dispatcher once per run. Only claude-family
  // runs (args.interactive) get a live callback; others pass undefined so the
  // provider never opens the stdio permission protocol.
  const onCanUseTool: OnCanUseTool | undefined = args.interactive
    ? async (req) => {
        // Non-interactive tools (Bash/Read/Write/Edit/…) → instant allow.
        // This is the★ invariant: workspace/project keep their YOLO bypass —
        // no UI, no wait, zero stall. Echo input back unchanged.
        if (!INTERACTIVE_TOOLS.has(req.toolName)) {
          return { behavior: "allow", updatedInput: req.input };
        }
        // Interactive tool → pause. Record + persist + broadcast, then park
        // on a promise the user (POST respond) or abort will resolve.
        const pending: PendingInteraction = {
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          input: req.input,
        };
        state.pendingInteraction = pending;
        try {
          persistPendingInteraction(args.nodeId, pending);
        } catch {
          /* best-effort — broadcast still lets live clients respond */
        }
        broadcast(state, {
          type: "interaction_required",
          toolUseId: req.toolUseId,
          toolName: req.toolName,
          input: req.input,
        });
        return await new Promise<InteractionDecision>((resolve) => {
          state.interactionResolver = (answer) => {
            // Single-shot: clear resolver + pending before resolving so a
            // duplicate respond / abort can't double-fire.
            state.interactionResolver = undefined;
            state.pendingInteraction = null;
            try {
              clearPendingInteraction(args.nodeId);
            } catch {
              /* best-effort */
            }
            broadcast(state, {
              type: "interaction_resolved",
              toolUseId: req.toolUseId,
            });
            resolve(answer);
          };
        });
      }
    : undefined;

  try {
    for await (const event of args.factory(state.controller.signal, {
      onCanUseTool,
    })) {
      if (event.type === "delta") {
        // Order matters: grow committedText BEFORE broadcasting, so a
        // subscriber that races in concurrently can't snapshot pre-delta
        // and then also miss the broadcast (JS is single-threaded so
        // subscribe() can't interleave with this block, but committing
        // first is the invariant readers rely on).
        state.committedText += event.text;
        aggregated += event.text;
        try {
          appendNodeResponse(args.nodeId, event.text);
        } catch {
          // best-effort; DB hiccup shouldn't kill the stream
        }
        broadcast(state, { type: "delta", text: event.text });
      } else if (event.type === "done") {
        usage = event.usage ?? usage;
      } else if (event.type === "error") {
        stoppedWith = "error";
        errorMessage = event.message;
        broadcast(state, { type: "error", message: event.message });
      } else if (event.type === "session_init") {
        try {
          if (args.sessionIdTarget === "node") {
            // chat B-fork: this node's forked session id sticks to the node.
            setNodeResumeId(args.nodeId, args.resumeFamily, event.sessionId);
          } else if (args.sessionIdTarget === "root") {
            // project: first turn of a root populates the tree-shared id.
            setRootResumeIdForNode(
              args.nodeId,
              args.resumeFamily,
              event.sessionId,
            );
          }
        } catch {
          // best-effort — next turn will get a fresh session
        }
        // Not forwarded to subscribers — server-internal.
      } else if (event.type === "tool_call_start") {
        // Mirror to committedToolCalls + DB BEFORE broadcasting, same
        // discipline as the delta path so a concurrent subscribe() can't
        // catchup-snapshot pre-event then miss the broadcast.
        const tc: ToolCall = {
          id: event.id,
          name: event.name,
          input: event.input,
          output: null,
          stderr: null,
          status: "running",
          durationMs: null,
          startedAt: event.startedAt,
          endedAt: null,
        };
        // De-dup: if the CLI ever re-emits the same tool_use id (hasn't
        // been observed, but cheap to guard) keep the first.
        if (!state.committedToolCalls.some((c) => c.id === tc.id)) {
          state.committedToolCalls.push(tc);
          try {
            appendToolCallStart({ nodeId: args.nodeId, call: tc });
          } catch {
            /* best-effort */
          }
          broadcast(state, {
            type: "tool_call_start",
            id: tc.id,
            name: tc.name,
            input: tc.input,
            startedAt: tc.startedAt,
          });
        }
      } else if (event.type === "tool_call_done") {
        const idx = state.committedToolCalls.findIndex(
          (c) => c.id === event.id,
        );
        if (idx !== -1) {
          const cur = state.committedToolCalls[idx];
          const next: ToolCall = {
            ...cur,
            output: event.output,
            stderr: event.stderr,
            status: event.isError ? "error" : "done",
            endedAt: event.endedAt,
            durationMs: Math.max(0, event.endedAt - cur.startedAt),
          };
          state.committedToolCalls[idx] = next;
          try {
            markToolCallDone({
              nodeId: args.nodeId,
              toolCallId: event.id,
              output: event.output,
              stderr: event.stderr,
              status: event.isError ? "error" : "done",
              endedAt: event.endedAt,
            });
          } catch {
            /* best-effort */
          }
          broadcast(state, {
            type: "tool_call_done",
            id: event.id,
            output: event.output,
            stderr: event.stderr,
            isError: event.isError,
            endedAt: event.endedAt,
          });
        }
      }
    }
  } catch (err) {
    stoppedWith = "error";
    errorMessage = err instanceof Error ? err.message : String(err);
    broadcast(state, { type: "error", message: errorMessage });
  } finally {
    // A路②: defensive — if the generator ended while an interaction was still
    // parked (e.g. provider threw before the SDK called back), unpark it deny
    // and clear the pending state so nothing leaks. Normal abort/respond paths
    // already cleared it.
    if (state.interactionResolver) {
      state.interactionResolver({ behavior: "deny", message: "stream ended" });
    } else if (state.pendingInteraction) {
      state.pendingInteraction = null;
      try {
        clearPendingInteraction(args.nodeId);
      } catch {
        /* best-effort */
      }
    }

    if (state.controller.signal.aborted && stoppedWith === "done") {
      // Generator returned without an explicit error event — the
      // subprocess provider exits cleanly on SIGTERM. Surface as error
      // so DB + late subscribers see the abort uniformly.
      stoppedWith = "error";
      errorMessage = errorMessage ?? "aborted";
      broadcast(state, { type: "error", message: errorMessage });
    }

    try {
      finalizeNode({
        nodeId: args.nodeId,
        status: stoppedWith,
        errorMessage,
        tokenInput: usage.input,
        tokenOutput: usage.output,
        tokenCacheRead: usage.cacheRead,
        tokenCacheCreation: usage.cacheCreation,
        tokenContext: usage.contextTokens ?? null,
        now: Date.now(),
      });
    } catch {
      /* best-effort */
    }

    state.status = stoppedWith;
    if (stoppedWith === "done") {
      state.finalEvent = { type: "done", usage };
      broadcast(state, { type: "done", usage });
    } else {
      state.finalEvent = {
        type: "error",
        message: errorMessage ?? "stream ended without terminal event",
      };
      // Error event already broadcast above (in the catch/abort branch);
      // don't double-emit. Subscribers joining LATER will see the
      // finalEvent in the catchup path instead.
    }

    // Topic label runs out-of-band post-done. Only attempt on success
    // with non-empty aggregated text. Late subscribers joining within
    // the grace window will see topic_label as a live event; ones
    // joining after won't get it (it's in the DB anyway).
    if (
      stoppedWith === "done" &&
      args.topicLabel &&
      aggregated.trim().length > 0
    ) {
      try {
        const label = await args.topicLabel(aggregated);
        if (label) {
          try {
            setNodeTopicLabel(args.nodeId, label);
          } catch {
            /* best-effort */
          }
          state.topicLabel = label;
          broadcast(state, {
            type: "topic_label",
            nodeId: args.nodeId,
            label,
          });
        }
      } catch {
        /* best-effort */
      }
    }

    // CLI 同步 Stage 2：若这轮跑在 attach 的 CLI 会话上，续聊已写回真实 jsonl。
    // 做身份对账（删临时节点、让 canonical jsonl-uuid 节点接管），再让客户端重载。
    // 动态 import 避免 run-bus（核心）静态依赖 cli 同步（feature）层。
    if (stoppedWith === "done") {
      try {
        const { reconcileAttachedTurn } = await import("./cli-import-db");
        const reloadSessionId = await reconcileAttachedTurn(args.nodeId);
        if (reloadSessionId) {
          broadcast(state, { type: "reload_session", sessionId: reloadSessionId });
        }
      } catch {
        /* 对账失败不影响主流程；临时节点保留，watcher 兜底 */
      }
      // Per-lineage 隔离：native isolated project 节点回填 turn uuid（后续在该点
      // 分叉的下刀坐标）。非目标节点在函数内直接 no-op；与上面的 reconcile 按
      // origin 互斥。动态 import 同理——run-bus（核心）不静态依赖 lineage 层。
      try {
        const { backfillNativeTurnUuid } = await import("./cli-fork");
        await backfillNativeTurnUuid(args.nodeId);
      } catch {
        /* best-effort —— 缺失只让该点分叉降级线性 resume */
      }
    }

    // Close every still-attached subscriber and drop the state after a
    // grace window. New subscribers in the grace window get the cached
    // catchup + finalEvent without a fresh DB roundtrip.
    closeAll(state);
    state.cleanupTimer = setTimeout(() => {
      // Only delete if no new run reused the slot (retry path).
      const cur = RUNS.get(args.nodeId);
      if (cur === state) RUNS.delete(args.nodeId);
    }, CLEANUP_GRACE_MS);
  }
}

function broadcast(state: RunState, event: RunEvent): void {
  // Snapshot the set so subscribers added during iteration aren't
  // re-notified for an event they'll already see via the next pass /
  // their initial catchup.
  for (const sub of [...state.subscribers]) {
    try {
      sub.onEvent(event);
    } catch {
      /* a subscriber that throws shouldn't break others */
    }
  }
}

function closeAll(state: RunState): void {
  for (const sub of [...state.subscribers]) {
    try {
      sub.onClose();
    } catch {
      /* ignore */
    }
  }
  state.subscribers.clear();
}

// Subscribe to a run. Always delivers a `catchup` event first (snapshot
// of the response so far + current status), then live events. If the
// run already terminated, fires the terminal event and onClose
// synchronously after catchup. Returns an unsubscribe function — call
// it on HTTP disconnect so the runner doesn't leak references.
//
// Returns null if there's no in-memory state for nodeId (e.g. run
// finished and got cleaned up, or never started). Caller (the
// reconnect endpoint) falls back to a pure DB read in that case.
export function subscribe(
  nodeId: string,
  sub: Subscriber,
): (() => void) | null {
  const state = RUNS.get(nodeId);
  if (!state) return null;

  // Step order matters (see runLoop comment): snapshot committedText
  // + committedToolCalls first, register sub second, send catchup
  // third. This guarantees every committed event either appears in
  // catchup OR arrives as a future broadcast — never neither, never
  // both. The tool calls snapshot is a deep-ish copy so a subscriber
  // can't accidentally see runner-side mutations of its slot.
  const snapshot = state.committedText;
  const snapshotStatus = state.status;
  const snapshotTools = state.committedToolCalls.map((c) => ({ ...c }));
  // A路②: copy the pending interaction (if any) into the catchup so a tab that
  // joins mid-pause renders the waiting form right away.
  const snapshotPending = state.pendingInteraction
    ? { ...state.pendingInteraction }
    : null;
  state.subscribers.add(sub);
  try {
    sub.onEvent({
      type: "catchup",
      response: snapshot,
      status: snapshotStatus,
      toolCalls: snapshotTools,
      pendingInteraction: snapshotPending,
    });
  } catch {
    /* ignore */
  }

  // Terminal? Replay the final event then close immediately. Don't
  // remove the subscriber from the set first; the closeAll already ran
  // when the runner finished, so the add above was strictly for
  // bookkeeping symmetry — we close it ourselves here.
  if (state.status !== "streaming" && state.finalEvent) {
    try {
      sub.onEvent(state.finalEvent);
    } catch {
      /* ignore */
    }
    if (state.topicLabel) {
      try {
        sub.onEvent({
          type: "topic_label",
          nodeId,
          label: state.topicLabel,
        });
      } catch {
        /* ignore */
      }
    }
    try {
      sub.onClose();
    } catch {
      /* ignore */
    }
    state.subscribers.delete(sub);
    return () => {
      // unsubscribe is idempotent; already cleaned up
    };
  }

  return () => {
    state.subscribers.delete(sub);
  };
}

// Explicit abort. Used by POST /api/chat/[id]/abort (the ⏹/Esc path).
// Idempotent — calling on an already-terminal run is a no-op.
export function abortRun(nodeId: string): boolean {
  const state = RUNS.get(nodeId);
  if (!state || state.status !== "streaming") return false;
  // A路②: if the run is parked on an interactive prompt, the abort signal
  // alone won't unpark the onCanUseTool promise (it's a plain Promise, not
  // signal-aware). Resolve it with deny so the SDK control loop can tear down
  // cleanly instead of leaving the promise — and the spawn — hung forever.
  if (state.interactionResolver) {
    state.interactionResolver({ behavior: "deny", message: "aborted" });
  }
  state.controller.abort();
  return true;
}

// A路②: deliver a user's answer to a paused interactive tool. Looks up the
// live run, validates the pending toolUseId matches, and resolves the parked
// onCanUseTool promise so the model continues. Returns:
//   - "ok"        → resolved, run continues
//   - "no_run"    → no live run for this node (cleaned up / never started)
//   - "no_pending"→ live run but nothing is awaiting (already answered / raced)
//   - "mismatch"  → a different toolUseId is pending (stale client)
export function resolveInteraction(
  nodeId: string,
  toolUseId: string,
  answer: InteractionDecision,
): "ok" | "no_run" | "no_pending" | "mismatch" {
  const state = RUNS.get(nodeId);
  if (!state || state.status !== "streaming") return "no_run";
  if (!state.pendingInteraction || !state.interactionResolver) {
    return "no_pending";
  }
  if (state.pendingInteraction.toolUseId !== toolUseId) return "mismatch";
  state.interactionResolver(answer);
  return "ok";
}

// Returns true if we have a live in-memory run for this node (still
// streaming). Used by the reconnect endpoint to decide between "join
// the live bus" and "this is over — read DB and return".
export function hasLiveRun(nodeId: string): boolean {
  const s = RUNS.get(nodeId);
  return !!s && s.status === "streaming";
}

// Wave 1 / A2: read-only snapshot of every node that currently has an
// active (streaming) run. GET /api/runs maps each nodeId → sessionId so
// the tab bar can show a "this pane is busy" pulse. Pure read — does not
// touch RunState lifecycle. Only "streaming" runs are reported; finished
// ones (in the 30s cleanup grace window) are not active.
export function getActiveRuns(): { nodeId: string; status: string }[] {
  const out: { nodeId: string; status: string }[] = [];
  for (const [nodeId, state] of RUNS) {
    if (state.status === "streaming") {
      out.push({ nodeId, status: state.status });
    }
  }
  return out;
}
