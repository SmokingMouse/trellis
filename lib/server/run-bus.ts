import "server-only";
import {
  appendNodeResponse,
  appendToolCallStart,
  finalizeNode,
  markToolCallDone,
  mergeAgentMeta,
  patchToolCallAgent,
  setNodeTopicLabel,
  setRootResumeIdForNode,
  setNodeResumeId,
} from "./repo";
import {
  persistPendingInteraction,
  clearPendingInteraction,
} from "./repo";
import type { ToolCall, TaskMeta, PendingInteraction } from "@/lib/types";
import type { ProviderFamily, InteractionDecision } from "@/lib/llm";

// A路②: tools that pause the run and require a user answer. Every other tool
// the CLI surfaces through the stdio permission protocol is auto-allowed so
// project keeps its bypassPermissions YOLO behaviour (zero stall).
const INTERACTIVE_TOOLS = new Set(["AskUserQuestion", "ExitPlanMode"]);

// 权限确认模式的免审名单。agent@0.8.0 起 ask 规则是 "all"（全部工具进回调，
// 否则 MCP 等名单外可变更工具会被用户全局 allowlist 静默放行），「哪些不用弹卡」
// 的判断从 SDK 的 ask 名单挪到这里：只读/纯编排类自动放行，其余一律弹卡。
// Task/Skill/SlashCommand 本体只是派生与读取——它们内部的可变更调用（Bash/Write/
// MCP…）各自再进回调，逐个弹卡，不会因放行外壳而漏审。
const READONLY_AUTO_ALLOW = new Set([
  "Read",
  "Glob",
  "Grep",
  "LS",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "NotebookRead",
  "BashOutput",
  "Task",
  "Skill",
  "SlashCommand",
]);

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
  // Extended thinking chunk (claude). Broadcast-only — never persisted to
  // the node row; the UI shows it live during the思考期 and drops it when
  // the turn finalizes (与 CLI 的 thinking 折叠行为一致).
  | { type: "thinking"; text: string }
  | {
      type: "done";
      usage: {
        input: number;
        output: number;
        cacheRead: number;
        cacheCreation: number;
        contextTokens?: number | null;
      };
      // response 分层偏移（见 lib/types.ts:ChatNode.finalStart）。随终态下发，
      // 客户端不必为它 refetch 节点。0 = 不分层。
      finalStart?: number;
      durationMs?: number;
    }
  | { type: "error"; message: string }
  | { type: "topic_label"; nodeId: string; label: string }
  // 自动命名（体验 D）：post-done 会话标题生成完成。客户端更新当前 session
  // 标题 + bump sessionsRevision 让 sidebar/tabs 重拉。
  | { type: "session_title"; sessionId: string; title: string }
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
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    }
  // Stage 22: sub-agent progress/report patch for the Task/Agent call `id`.
  | { type: "tool_call_update"; id: string; agent: TaskMeta }
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
  // Thinking accumulated so far this run (empty when none / already done).
  // Lets a reconnecting client render the思考期 immediately instead of
  // waiting for the next thinking delta. In-memory only, never in DB.
  thinking: string;
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
  // Stage 22: sub-agent patches whose target tool call hasn't been seen yet.
  // A single generator emits in order (the Agent tool_use always precedes its
  // task_* lines), so this should stay empty — it exists so a CLI version that
  // reorders them degrades to "progress shows up late" instead of "silently
  // dropped". Drained when the matching tool_call_start lands.
  pendingAgentPatches: Map<string, TaskMeta>;
  // Thinking accumulated this run. In-memory only (no DB column) — shipped
  // in catchup so late subscribers see the思考期; dropped with the RunState.
  committedThinking: string;
  // Response 分层状态机（见 lib/types.ts:ChatNode.finalStart）。SDK 逐 token
  // 透传正文、在 content block 边界不发任何事件，所以「text → 工具/思考 → text」
  // 的段落在 committedText 里首尾相连成一坨。这里用结构性事件推断边界：
  // thinking / tool_call_start 到来且中断后已有正文 → pendingBreak 置位；下一个
  // delta 前先把段落分隔（"\n\n"）走完整 delta 路径（commit + DB + broadcast，
  // 三方天然一致），并把 finalStart 推进到新段起点。turn 结束时 finalStart 即
  // 「最终答复」的起始偏移 —— 最后一次中断之后模型说的话。
  // 后端无关：claude/codex/mock 的事件都流经同一分支。
  finalStart: number;
  pendingBreak: boolean;
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
        finalStart?: number;
        durationMs?: number;
      }
    | { type: "error"; message: string };
  topicLabel?: string;
  // 自动命名（体验 D）：post-done 生成的会话标题，供 grace window 内迟到的
  // 订阅者补发（镜像 topicLabel 的语义）。
  sessionTitle?: { sessionId: string; title: string };
  // A路②: the interactive-tool prompt currently awaiting a user answer, plus
  // the resolver that the onCanUseTool promise is parked on. Both null/unset
  // when no interaction is in flight. resolveInteraction() (POST respond) and
  // the abort path call interactionResolver to unpark the promise.
  pendingInteraction: PendingInteraction | null;
  interactionResolver?: (answer: InteractionDecision) => void;
  // 权限确认:本轮内用户点过「总是允许」的工具名。仅存活于这一次 spawn(每轮
  // 新进程,权限记忆随 RunState 丢弃);下一轮同工具会重新弹卡。
  approvedTools: Set<string>;
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
  | { type: "thinking"; text: string }
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
      parentToolUseId?: string | null;
    }
  | {
      type: "tool_call_done";
      id: string;
      output: string | null;
      stderr: string | null;
      isError: boolean;
      endedAt: number;
    }
  | { type: "tool_call_update"; id: string; agent: TaskMeta };

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
  // 权限确认:true = 本 run 的 can_use_tool 一律暂停弹权限卡(除本轮已「总是
  // 允许」的工具),false/缺省 = 现状(非交互工具 auto-allow,YOLO)。来自
  // session.require_approval,只对 interactive(claude 系)run 有意义。
  requireApproval?: boolean;
  // Optional post-done topic generator. Called with the aggregated
  // text; if it returns a non-empty string we write the label and emit
  // a topic_label event to subscribers. Errors are swallowed.
  topicLabel?: (aggregated: string) => Promise<string | null>;
  // 自动命名（体验 D）：post-done 会话标题钩子。闭包自己做全部会话级判定
  // （origin/title_source/触发节奏）与 DB 写入，返回非空即广播 session_title
  // —— run-bus 保持对 session 实体无知。与 topicLabel 并发跑：两个都是最长
  // 8s（codex 20s）的 CLI spawn，串行会顶到 30s grace window。
  sessionTitle?: (
    aggregated: string,
  ) => Promise<{ sessionId: string; title: string } | null>;
  // S88: run 终结钩子 —— 自动化任务的留档 / 通知 / 超时 timer 清理全挂在这。
  //
  // 调用点刻意钉在 finalizeNode **之后**（早了任务层回查 node 拿到旧状态）、
  // 那串 best-effort 的 `await import(...)` 对账块**之前**（晚了通知要等好几秒，
  // 且那些块任一 hang 住通知就永远不来）。
  //
  // ⚠️ 进程被 SIGKILL 时这个回调一次都不跑 —— 所以 sqlite.ts 的 migrate() 里有一条
  // 对称的 boot reap 把残留的 running/pending task_run 收成 error。**两者必须成对**。
  onSettled?: (r: {
    status: "done" | "error";
    errorMessage?: string | null;
    usage: { input: number; output: number; cacheRead: number; cacheCreation: number };
  }) => void;
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
    pendingAgentPatches: new Map(),
    committedThinking: "",
    finalStart: 0,
    pendingBreak: false,
    pendingInteraction: null,
    approvedTools: new Set(),
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
  const startedAt = Date.now();
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
        // Non-interactive tools (Bash/Read/Write/Edit/…):
        //   YOLO(默认) → instant allow。This is the★ invariant: workspace/
        //   project keep their bypass — no UI, no wait, zero stall.
        //   权限确认(requireApproval) → 不放行,落到下面的暂停路径弹权限卡;
        //   例外:只读/编排类免审名单(READONLY_AUTO_ALLOW,ask="all" 后全部
        //   工具都进回调,免审判断在这层做)与本轮内点过「总是允许」的工具名。
        if (
          !INTERACTIVE_TOOLS.has(req.toolName) &&
          (!args.requireApproval ||
            READONLY_AUTO_ALLOW.has(req.toolName) ||
            state.approvedTools.has(req.toolName))
        ) {
          return { behavior: "allow", updatedInput: req.input };
        }
        // Interactive tool / 待审批工具 → pause. Record + persist + broadcast, then park
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
            // 兜底:SDK 的 allow 分支要求 updatedInput 是 record,缺失/非法
            // 会在 SDK 侧抛 ZodError 并打断整个 run。表单层漏传(或手工
            // POST 乱传)时回填原始入参——不改写等价于原样放行。
            const updated = answer.updatedInput;
            const validInput =
              typeof updated === "object" &&
              updated !== null &&
              !Array.isArray(updated);
            resolve(
              answer.behavior === "allow" && !validInput
                ? { ...answer, updatedInput: req.input }
                : answer,
            );
          };
        });
      }
    : undefined;

  try {
    for await (const event of args.factory(state.controller.signal, {
      onCanUseTool,
    })) {
      if (event.type === "delta") {
        // 段落边界消费：上一个结构性事件（thinking/工具）置了 pendingBreak，
        // 新正文落地前先补段落分隔 —— 作为一条普通 delta 走完整路径（commit +
        // DB append + broadcast），流式客户端 / DB 行 / catchup 快照三方自动
        // 一致，无需客户端配合。刻意延迟到「确有新正文」才插：以工具收尾的
        // turn 不会在 response 末尾留下分隔垃圾，finalStart 也恰好钉在最终
        // 答复的第一个字符上。
        if (state.pendingBreak) {
          state.pendingBreak = false;
          const t = state.committedText;
          const sep = !t || t.endsWith("\n\n") ? "" : t.endsWith("\n") ? "\n" : "\n\n";
          if (sep) {
            state.committedText += sep;
            aggregated += sep;
            try {
              appendNodeResponse(args.nodeId, sep);
            } catch {
              /* best-effort，同下 */
            }
            broadcast(state, { type: "delta", text: sep });
          }
          state.finalStart = state.committedText.length;
        }
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
      } else if (event.type === "thinking") {
        // 结构性中断：这段思考之前说的话都是过程叙述（interleaved thinking
        // 下最终答复前必有一段思考，所以「最后一次中断之后」恰是答复）。
        // 只有中断后确有过正文才算数 —— 开场思考（committedText 空）不置位。
        if (state.committedText.length > state.finalStart) {
          state.pendingBreak = true;
        }
        // Commit-before-broadcast, same as delta — but memory-only, no DB
        // write: thinking is ephemeral status, not part of the node row.
        state.committedThinking += event.text;
        broadcast(state, { type: "thinking", text: event.text });
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
        // 结构性中断，同 thinking 分支。不筛 parentToolUseId：子 agent 调工具
        // 期间主 agent 没在写正文（在等 Task 返回），派生它的那条主链调用早已
        // 置过位，重复置位幂等。
        if (state.committedText.length > state.finalStart) {
          state.pendingBreak = true;
        }
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
          parentToolUseId: event.parentToolUseId ?? null,
        };
        // De-dup: if the CLI ever re-emits the same tool_use id (hasn't
        // been observed, but cheap to guard) keep the first.
        if (!state.committedToolCalls.some((c) => c.id === tc.id)) {
          // Stage 22: a patch that arrived before its target (see
          // pendingAgentPatches) folds in now, so it ships with the start
          // event instead of being lost.
          const early = state.pendingAgentPatches.get(tc.id);
          if (early) {
            tc.agent = mergeAgentMeta(undefined, early);
            state.pendingAgentPatches.delete(tc.id);
          }
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
            // Hand-built payload — the field has to be repeated here or the
            // live view stays flat and only a reload shows the nesting.
            parentToolUseId: tc.parentToolUseId,
          });
          if (early) {
            broadcast(state, { type: "tool_call_update", id: tc.id, agent: tc.agent! });
          }
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
      } else if (event.type === "tool_call_update") {
        // Background-task progress/report — sub-agent, long-running Bash, or
        // Workflow; `agent.taskType` says which. Same commit-before-broadcast
        // discipline as the two above. The merged meta is a fresh object —
        // catchup ships a shallow copy of each call, so mutating in place
        // would retroactively edit snapshots already handed to subscribers.
        const idx = state.committedToolCalls.findIndex((c) => c.id === event.id);
        if (idx === -1) {
          state.pendingAgentPatches.set(
            event.id,
            mergeAgentMeta(state.pendingAgentPatches.get(event.id), event.agent),
          );
        } else {
          const cur = state.committedToolCalls[idx];
          const agent = mergeAgentMeta(cur.agent, event.agent);
          state.committedToolCalls[idx] = { ...cur, agent };
          try {
            patchToolCallAgent({
              nodeId: args.nodeId,
              toolCallId: event.id,
              patch: event.agent,
            });
          } catch {
            /* best-effort */
          }
          broadcast(state, { type: "tool_call_update", id: event.id, agent });
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

    const durationMs = Math.max(0, Date.now() - startedAt);

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
        finalStart: state.finalStart,
        durationMs,
        now: Date.now(),
      });
    } catch {
      /* best-effort */
    }

    // S88：见 startRun 的 onSettled 注释 —— 位置是刻意的，别往下挪。
    if (args.onSettled) {
      try {
        args.onSettled({
          status: stoppedWith,
          errorMessage,
          usage: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheCreation: usage.cacheCreation,
          },
        });
      } catch {
        /* 任务层的问题绝不该拖垮一次正常的会话 run */
      }
    }

    state.status = stoppedWith;
    if (stoppedWith === "done") {
      state.finalEvent = { type: "done", usage, finalStart: state.finalStart, durationMs };
      broadcast(state, { type: "done", usage, finalStart: state.finalStart, durationMs });
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
    //
    // 自动命名（体验 D）在这之前先启动、之后再 await —— 两个钩子各是一次
    // CLI spawn，串行最坏 16s/40s 会顶穿 30s grace window，并发则 ≤ 单次上限。
    const sessionTitlePromise =
      stoppedWith === "done" &&
      args.sessionTitle &&
      aggregated.trim().length > 0
        ? args.sessionTitle(aggregated).catch(() => null)
        : null;
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
    if (sessionTitlePromise) {
      const titled = await sessionTitlePromise;
      if (titled) {
        state.sessionTitle = titled;
        broadcast(state, { type: "session_title", ...titled });
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
      // codex 版：回填该轮在 rollout 里的 user-message 序号（分叉下刀坐标）。
      // 函数内部按 origin/已回填自筛，非 codex run 不会有 codex_session_id
      // lineage 可解析，天然 no-op；仍按 family 闸一道少扫一次盘。
      if (args.resumeFamily === "codex") {
        try {
          const { backfillCodexTurnOrdinal } = await import("./codex-fork");
          await backfillCodexTurnOrdinal(args.nodeId);
        } catch {
          /* best-effort —— 同上，降级线性 */
        }
      }
    }

    // S88: session_done 触发器。动态 import 破掉 run-bus ↔ tasks 的循环依赖
    // （tasks 静态 import run-bus），与上面几个对账块同一套 best-effort 纪律。
    // 自触发防护在 onNodeSettled 里 —— 任务自己的节点不当事件源。
    try {
      const { onNodeSettled } = await import("./tasks");
      onNodeSettled(args.nodeId);
    } catch {
      /* 任务层的问题不影响会话 run 收尾 */
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
  // Only ship thinking while still streaming — after terminal it's dropped
  // (与 done 后 UI 丢弃 thinking 的行为一致，catchup 不该复活它).
  const snapshotThinking =
    state.status === "streaming" ? state.committedThinking : "";
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
      thinking: snapshotThinking,
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
    if (state.sessionTitle) {
      try {
        sub.onEvent({ type: "session_title", ...state.sessionTitle });
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
  opts?: {
    // 权限确认:allow 时同时把该工具名记进本轮「总是允许」,后续同名工具不再
    // 弹卡(只影响这一次 spawn,下一轮重置)。
    alwaysAllowTool?: boolean;
  },
): "ok" | "no_run" | "no_pending" | "mismatch" {
  const state = RUNS.get(nodeId);
  if (!state || state.status !== "streaming") return "no_run";
  if (!state.pendingInteraction || !state.interactionResolver) {
    return "no_pending";
  }
  if (state.pendingInteraction.toolUseId !== toolUseId) return "mismatch";
  if (opts?.alwaysAllowTool && answer.behavior === "allow") {
    state.approvedTools.add(state.pendingInteraction.toolName);
  }
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

// Read-only snapshot of every live node run. pendingInteraction distinguishes
// "waiting" from actively generating without exposing the interaction payload.
// Finished runs in the cleanup grace window are intentionally excluded.
export function getActiveRuns(): {
  nodeId: string;
  status: "streaming";
  waiting: boolean;
}[] {
  const out: { nodeId: string; status: "streaming"; waiting: boolean }[] = [];
  for (const [nodeId, state] of RUNS) {
    if (state.status === "streaming") {
      out.push({
        nodeId,
        status: state.status,
        waiting: state.pendingInteraction !== null,
      });
    }
  }
  return out;
}
