import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentClient } from "@smokingmouse/agent-server/client";
import { NotificationSchemas, type NotificationMethod, type ServerNotification, type AttachResult, type Turn, type StartTurnParams, type StartThreadParams } from "@smokingmouse/agent-server/protocol";
import { createProjectClient, withProjectLease, setProjectPermission } from "./as-client";
import { daemonIdentity, getAsTurn, bindAsThread, bindAsTurn, updateAsTurn, resolveSessionBinding, removeAsTurn, pruneAsThreads } from "./session-binding";
import { getDB } from "./sqlite";
import { getNode, getSession, appendNodeResponse, appendToolCallStart, markToolCallDone, finalizeNode, persistPendingInteraction, clearPendingInteraction, patchToolCallAgent, buildHistoryForNode, getSessionTitleContext, applyAutoTitle, setNodeTopicLabel, resetNodeForRetry } from "./repo";
import { providerFamily } from "../llm/providers";
import { emptyThreadLog, applyShadowEvent } from "../as-log";
import { itemToolCall, projectInteraction, projectResponse, projectThreadOptions, turnRunEvent } from "../as-project-events";
import type { RunEvent, CatchupEvent } from "./run-bus";
import { isShadowEnabled } from "../as-config";

type Subscriber = { onEvent: (event: RunEvent | CatchupEvent) => void; onClose: () => void };
const state = globalThis as typeof globalThis & { asProjectRuns?: Map<string, ProjectRun>; asProjectStarts?: Map<string, Promise<unknown>> };
const runs = state.asProjectRuns ??= new Map<string, ProjectRun>();
const starts = state.asProjectStarts ??= new Map<string, Promise<unknown>>();

export class ProjectRun {
  readonly client: AgentClient = createProjectClient();
  log = emptyThreadLog();
  turnId?: string;
  terminal?: RunEvent;
  private subscribers = new Set<Subscriber>();
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private closing = false;
  private toolVersions = new Map<string, string>();
  private starting?: Promise<void>;
  private retryResolutions: string[] = [];
  constructor(readonly nodeId: string, readonly threadId: string, readonly params: StartTurnParams, private replacing = false) {
    this.turnId = replacing ? undefined : getAsTurn(nodeId)?.turn_id ?? undefined;
    this.client.onSnapshot(snapshot => this.snapshot(snapshot));
    this.client.onError(error => console.warn(`[trellis/as] ${nodeId}: ${error.message}`));
    for (const method of Object.keys(NotificationSchemas) as NotificationMethod[]) {
      this.client.onNotification(method, params => this.notification({ jsonrpc: "2.0", method, params } as ServerNotification));
    }
    for (const method of ["item/commandExecution/requestApproval", "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput"] as const) {
      this.client.onServerRequest(method, request => {
        if (request.params.threadId !== threadId || (this.turnId && request.params.turnId !== this.turnId)) return;
        const interaction = projectInteraction(request);
        persistPendingInteraction(nodeId, interaction);
        this.emit({ type: "interaction_required", ...interaction });
      });
    }
  }
  private emit(event: RunEvent | CatchupEvent) {
    for (const sub of this.subscribers) { try { sub.onEvent(event); } catch {} }
  }
  private items() { return Object.values(this.log.items).filter(i => i.turnId === this.turnId); }
  private project() {
    if (!this.turnId || this.replacing) return;
    const items = this.items();
    const { response } = projectResponse(items);
    const node = getNode(this.nodeId);
    if (!node) return;
    if (response.startsWith(node.response)) {
      const delta = response.slice(node.response.length);
      if (delta) { appendNodeResponse(this.nodeId, delta); this.emit({ type: "delta", text: delta }); }
    } else if (response !== node.response) {
      // Snapshot is authoritative after a daemon crash or a completed payload correction.
      console.warn(`[trellis/as] projection correction ${this.nodeId}`);
      getDB().prepare("UPDATE nodes SET response=? WHERE id=?").run(response, this.nodeId);
      this.emit(this.catchup());
    }
    for (const item of items) {
      const call = itemToolCall(item);
      if (call) {
        if (!this.toolVersions.has(call.id)) {
          appendToolCallStart({ nodeId: this.nodeId, call });
          this.emit({ type: "tool_call_start", id: call.id, name: call.name, input: call.input, startedAt: call.startedAt });
        }
        const version = JSON.stringify(call);
        if (call.endedAt !== null && version !== this.toolVersions.get(call.id)) {
          markToolCallDone({ nodeId: this.nodeId, toolCallId: call.id, output: call.output, stderr: call.stderr, status: call.status === "error" ? "error" : "done", endedAt: call.endedAt });
          this.emit({ type: "tool_call_done", id: call.id, output: call.output, stderr: call.stderr, isError: call.status === "error", endedAt: call.endedAt });
        }
        this.toolVersions.set(call.id, version);
      }
      if (item.type === "subAgent") {
        const agent: import("../types").TaskMeta = { taskType: item.payload.kind === "agent" ? "local_agent" : item.payload.kind === "bash" ? "local_bash" : "local_workflow", phase: item.payload.phase, summary: item.payload.text ?? undefined };
        patchToolCallAgent({ nodeId: this.nodeId, toolCallId: item.payload.parentItemId, patch: agent });
        this.emit({ type: "tool_call_update", id: item.payload.parentItemId, agent });
      }
    }
    const last = items.filter(i => i.type !== "userMessage" && i.completedSeq).sort((a,b) => a.seq-b.seq).at(-1);
    updateAsTurn(this.nodeId, this.turnId, last?.id);
  }
  private snapshot(snapshot: AttachResult) {
    if (snapshot.thread.id !== this.threadId) return;
    this.log = applyShadowEvent(this.log, { type: "snapshot", snapshot });
    if (!this.turnId) {
      const user = snapshot.items.find(i => i.type === "userMessage" && i.payload.clientTurnId === this.params.clientTurnId);
      this.turnId = user?.turnId;
    }
    this.project();
    const pending = snapshot.pendingRequests.find(r => r.params.turnId === this.turnId);
    if (pending) persistPendingInteraction(this.nodeId, projectInteraction(pending));
    else clearPendingInteraction(this.nodeId);
    this.emit(this.catchup());
  }
  private notification(notification: ServerNotification) {
    const { method, params } = notification;
    if (!("threadId" in params) || params.threadId !== this.threadId) return;
    if (method === "turn/started" && params.turn.clientTurnId === this.params.clientTurnId) this.turnId = params.turnId;
    if ("turnId" in params && params.turnId && this.turnId && params.turnId !== this.turnId) return;
    this.log = applyShadowEvent(this.log, { type: "notification", notification });
    if (method === "item/reasoning/textDelta" || method === "item/reasoning/summaryTextDelta") this.emit({ type: "thinking", text: params.delta });
    if (method === "serverRequest/resolved" || method === "serverRequest/expired") {
      clearPendingInteraction(this.nodeId);
      if (method === "serverRequest/resolved") {
        const receipts = [`已由 ${params.decidedBy.label} 处理`];
        if (this.replacing) this.retryResolutions = receipts;
        else getDB().prepare("UPDATE as_turns SET resolved_json=? WHERE node_id=?").run(JSON.stringify(receipts), this.nodeId);
      }
      this.emit({ type: "interaction_resolved", toolUseId: params.requestId });
    }
    this.project();
    if (method === "turn/completed" && params.turnId === this.turnId) this.finish(params.turn);
  }
  private finish(turn: Turn) {
    if (this.terminal) return;
    if (this.replacing) {
      if (turn.status !== "completed") {
        // The previous answer and its turn binding remain authoritative.
        this.terminal = turnRunEvent(turn, 0);
        this.emit(this.terminal);
        for (const sub of this.subscribers) sub.onClose();
        this.subscribers.clear();
        this.close();
        if (runs.get(this.nodeId) === this) runs.delete(this.nodeId);
        return;
      }
      getDB().transaction(() => {
        resetNodeForRetry(this.nodeId);
        bindAsThread(getNode(this.nodeId)!.sessionId, this.threadId);
        bindAsTurn(this.nodeId, this.threadId, this.params.clientTurnId!);
        getDB().prepare("UPDATE as_turns SET request_json=? WHERE node_id=?").run(JSON.stringify(this.params), this.nodeId);
        if (this.retryResolutions.length) getDB().prepare("UPDATE as_turns SET resolved_json=? WHERE node_id=?").run(JSON.stringify(this.retryResolutions), this.nodeId);
        this.replacing = false;
        this.project();
        pruneAsThreads(getNode(this.nodeId)!.sessionId);
      })();
      this.emit(this.catchup());
    }
    this.project();
    const { response, finalStart } = projectResponse(this.items());
    if (getNode(this.nodeId)?.response.length !== response.length) console.warn(`[trellis/as] turn/completed projection drift ${this.nodeId}`);
    const event = turnRunEvent(turn, finalStart), u = turn.usage;
    finalizeNode({ nodeId: this.nodeId, status: turn.status === "completed" ? "done" : "error", errorMessage: event.type === "error" ? event.message : undefined,
      tokenInput: u?.inputTokens ?? 0, tokenOutput: u?.outputTokens ?? 0, tokenCacheRead: u?.cachedTokens ?? 0, tokenCacheCreation: u?.cacheCreation ?? 0,
      tokenContext: u?.contextTokens, finalStart, durationMs: turn.durationMs, now: Date.now() });
    this.terminal = event;
    this.emit(event);
    void this.settled(turn, response).finally(() => {
      for (const sub of this.subscribers) sub.onClose();
      this.subscribers.clear();
    });
    clearInterval(this.poll);
    // Let the start RPC finish before closing the wire (a mock can finish synchronously).
    const cleanup = setTimeout(() => { this.client.close(); if (runs.get(this.nodeId) === this) runs.delete(this.nodeId); }, 1000);
    cleanup.unref?.();
  }
  private async settled(turn: Turn, response: string) {
    const node = getNode(this.nodeId), session = node && getSession(node.sessionId);
    if (!node || !session) return;
    if (turn.status === "completed" && response.trim() && session.model !== "mock") {
      const family = providerFamily(session.model ?? "claude-opus");
      const { generateTopicLabel, generateSessionTitle } = await import("../llm/topic");
      await Promise.allSettled([
        generateTopicLabel(node.question, response, family).then(label => {
          if (label) { setNodeTopicLabel(node.id, label); this.emit({type:"topic_label",nodeId:node.id,label}); }
        }),
        (async () => {
          const ctx = getSessionTitleContext(session.id);
          if (!ctx || ctx.origin !== "native" || ctx.titleSource === "user" || !(ctx.doneCount === 1 || ctx.doneCount > 1 && ctx.doneCount % 8 === 0) || !ctx.turns.length) return;
          const title = await generateSessionTitle(ctx.turns, family);
          if (title && applyAutoTitle(session.id,title)) this.emit({type:"session_title",sessionId:session.id,title});
        })(),
      ]);
    }
    try { const { onNodeSettled } = await import("./tasks"); onNodeSettled(node.id); } catch (error) { console.warn(`[trellis/as] settlement: ${error}`); }
  }
  catchup(): CatchupEvent {
    const n = getNode(this.nodeId)!;
    return { type: "catchup", response: n.response, status: n.status, toolCalls: n.toolCalls,
      thinking: this.items().filter(i => i.type === "reasoning").map(i => i.payload.text ?? i.payload.summary ?? "").join("\n"), pendingInteraction: n.pendingInteraction };
  }
  subscribe(sub: Subscriber) {
    this.subscribers.add(sub); sub.onEvent(this.catchup());
    if (this.terminal) { sub.onEvent(this.terminal); sub.onClose(); this.subscribers.delete(sub); }
    return () => { this.subscribers.delete(sub); };
  }
  start() { return this.starting ??= this.startOnce(); }
  private async startOnce() {
    try {
      await this.client.connect();
      await this.client.request("thread/attach", { threadId: this.threadId, sinceSeq: 0 });
    } catch (error) { throw new DaemonUnavailable(String(error)); }
    const result = await this.client.request("turn/start", this.params);
    this.turnId = result.turn.id;
    if (!this.replacing) updateAsTurn(this.nodeId, result.turn.id);
    this.project();
    if (["completed", "interrupted", "failed", "cancelled"].includes(result.turn.status)) this.finish(result.turn);
    if (!this.terminal) {
      this.poll = setInterval(() => {
        if (this.polling || this.closing) return;
        this.polling = true;
        void this.reconcile().catch(error => console.warn(`[trellis/as] reconcile: ${error}`)).finally(() => { this.polling = false; });
      }, 2000);
      this.poll.unref?.();
    }
  }
  async reconcile() {
    await this.client.connect();
    await this.client.request("thread/attach", { threadId: this.threadId, sinceSeq: 0 });
    // Idempotent replay also supplies the terminal Turn missed while disconnected.
    const { turn } = await this.client.request("turn/start", this.params);
    if (["completed", "interrupted", "failed", "cancelled"].includes(turn.status)) this.finish(turn);
  }
  close() {
    this.closing = true; clearInterval(this.poll); this.client.close();
    if (runs.get(this.nodeId) === this) runs.delete(this.nodeId);
  }
}

export async function startProjectRun(args: { nodeId: string; prompt: string; attachments: { path: string; mime: string }[]; retry?: boolean; fork?: boolean; permission?: StartThreadParams["permission"]; effort?: string }) {
  if (!isShadowEnabled()) throw new DaemonUnavailable("Agent 服务已关闭");
  const node = getNode(args.nodeId)!, session = getSession(node.sessionId)!;
  if (starts.has(session.id)) throw new Error("session request is starting; retry shortly");
  const job = (async () => {
    let setup: AgentClient;
    try {
      setup = createProjectClient();
      await setup.connect(); // Only this preflight may fall back to the legacy engine.
    } catch (error) { setup!?.close(); throw new DaemonUnavailable(String(error)); }
    try {
      const options = projectThreadOptions(session, { permission: args.permission, effort: args.effort });
      if (args.retry && !args.permission) {
        const previous = getAsTurn(node.id);
        if (previous) {
          if (previous.daemon_id !== daemonIdentity()) throw new Error("session daemon mapping changed");
          options.permission = (await setup.request("thread/read", {threadId:previous.thread_id})).thread.permission;
        }
      }
      if (!setup.initializeResult?.capabilities.backends.includes(options.backend)) throw new Error("daemon backend unavailable");
      let parentId = args.retry ? node.id : node.parentId;
      let parent = parentId ? getAsTurn(parentId) : null;
      // @mention is intentionally ephemeral. A legacy fallback answer is not:
      // seed a fresh thread with that history instead of silently omitting it.
      while (parentId && !parent && getNode(parentId)?.agentScope === "mention") { parentId = getNode(parentId)?.parentId ?? null; parent = parentId ? getAsTurn(parentId) : null; }
      if (parent && parent.daemon_id !== daemonIdentity()) throw new Error("session daemon mapping changed");
      if (parent && getNode(parent.node_id)?.status === "streaming") throw new Error("parent turn is still running");
      let threadId: string;
      let seedHistory = !parent && !!parentId;
      if (parent) {
        const latest = getDB().prepare("SELECT node_id FROM as_turns WHERE thread_id=? AND daemon_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(parent.thread_id, parent.daemon_id) as {node_id:string} | null;
        if (!args.fork && latest?.node_id !== parent.node_id) {
          // A normal question from an earlier node starts a new conversation
          // seeded only from that node's ancestry, never from the live tip.
          threadId = (await setup.request("thread/start", { ...options, clientThreadId: `trellis-${node.id}-${randomUUID()}` })).thread.id;
          seedHistory = true;
        } else if (args.retry || args.fork) {
          // 7913839 only forks the live thread tip. Never silently include later
          // turns when the user selected an earlier node (or retries a past turn).
          if (latest?.node_id !== parent.node_id) throw new Error("当前 Agent 服务仅支持从线程最新节点分叉，暂不支持从早期节点分叉；原会话未改变。");
          if (!setup.initializeResult?.capabilities.fork) throw new Error("daemon does not support fork");
          const snapshot = await setup.request("thread/attach", {threadId:parent.thread_id,sinceSeq:0});
          const last = snapshot.items.slice().sort((a,b)=>b.seq-a.seq)[0];
          if (snapshot.thread.status.type === "running" || snapshot.queue.length || (last && last.turnId !== parent.turn_id)) {
            if (!args.retry) throw new Error("线程已在其他客户端继续运行，请刷新后从线程最新节点分叉；原会话未改变。");
            threadId = (await setup.request("thread/start", { ...options, clientThreadId: `trellis-${node.id}-${randomUUID()}` })).thread.id;
            seedHistory = true;
          } else threadId = (await setup.request("thread/fork", { threadId: parent.thread_id, clientThreadId: `trellis-fork-${node.id}-${randomUUID()}` })).thread.id;
        } else {
          threadId = parent.thread_id;
          const snapshot = await setup.request("thread/attach", {threadId,sinceSeq:0});
          const last = snapshot.items.slice().sort((a,b)=>b.seq-a.seq)[0];
          if ((last && last.turnId !== parent.turn_id) || snapshot.queue.length || snapshot.thread.status.type === "running") {
            threadId = (await setup.request("thread/start", { ...options, clientThreadId: `trellis-${node.id}-${randomUUID()}` })).thread.id;
            seedHistory = true;
          } else if (["closed", "systemError", "interrupted"].includes(snapshot.thread.status.type)) await setup.request("thread/resume", {threadId});
        }
      } else threadId = (await setup.request("thread/start", { ...options, clientThreadId: `trellis-${node.id}-${randomUUID()}` })).thread.id;
      const recoveredHistory = seedHistory ? buildHistoryForNode(node.id,{maxDepth:20}).map(m=>`${m.role}: ${m.content}`).join("\n\n") : "";
      const params: StartTurnParams = { threadId, clientTurnId: `trellis-${node.id}-${randomUUID()}`, input: [{ type: "text", text: recoveredHistory ? `${recoveredHistory}\n\nuser: ${args.prompt}` : args.prompt }, ...args.attachments.map(a => ({ type: "image" as const, ...a }))] };
      const run = new ProjectRun(node.id, threadId, params, args.retry);
      if (!args.retry) {
        bindAsThread(session.id, threadId);
        bindAsTurn(node.id, threadId, params.clientTurnId!);
        getDB().prepare("UPDATE as_turns SET request_json=? WHERE node_id=?").run(JSON.stringify(params), node.id);
      }
      runs.set(node.id, run);
      try { await run.start(); } catch (error) {
        run.close();
        if (!args.retry && !run.turnId) removeAsTurn(node.id);
        throw error;
      }
      return run;
    } finally { setup.close(); }
  })();
  starts.set(session.id, job);
  try { return await job; } finally { starts.delete(session.id); }
}
export class DaemonUnavailable extends Error {}
export function hasActiveProjectRun(nodeId: string) { const run = runs.get(nodeId); return !!run && !run.terminal; }
export function projectTarget(nodeId: string) {
  const active = runs.get(nodeId);
  return active && !active.terminal
    ? { thread_id: active.threadId, turn_id: active.turnId ?? null, daemon_id: daemonIdentity() }
    : getAsTurn(nodeId);
}
export async function getProjectRun(nodeId: string) {
  if (!isShadowEnabled()) return null;
  const existing = runs.get(nodeId); if (existing) { await existing.start(); return existing; }
  const binding = getAsTurn(nodeId);
  if (!binding || getNode(nodeId)?.status !== "streaming") return null;
  if (binding.daemon_id !== daemonIdentity()) throw new Error("session daemon mapping changed");
  const row = getDB().prepare("SELECT request_json FROM as_turns WHERE node_id=?").get(nodeId) as {request_json:string};
  const run = new ProjectRun(nodeId, binding.thread_id, JSON.parse(row.request_json));
  runs.set(nodeId, run);
  try { await run.start(); return run; } catch (e) { run.close(); throw e; }
}
export function isThreadNode(nodeId: string) {
  const node = getNode(nodeId);
  return !!node && resolveSessionBinding(node.sessionId).type === "thread" && !!projectTarget(nodeId);
}
export async function withNodeThread<T>(nodeId: string, action: (client: AgentClient, threadId: string) => Promise<T>) {
  if (!isShadowEnabled()) throw new DaemonUnavailable("Agent 服务已关闭");
  const binding = projectTarget(nodeId);
  if (!binding || binding.daemon_id !== daemonIdentity()) throw new Error("node has no binding to this daemon");
  const client = createProjectClient();
  try {
    await client.connect();
    await client.request("thread/attach", { threadId: binding.thread_id, sinceSeq: 0 });
    return await action(client, binding.thread_id);
  } finally { client.close(); }
}
export async function respondProject(nodeId: string, body: { toolUseId: string; behavior: "allow" | "deny"; updatedInput?: unknown; alwaysAllowTool?: unknown }) {
  return withNodeThread(nodeId, (client, threadId) => withProjectLease(client, threadId, async () => {
    // Re-read under lease: another client may have won between attach and acquire.
    await client.request("thread/attach", { threadId, sinceSeq: 0 });
    const request = client.pendingRequests.get(body.toolUseId);
    if (!request || request.params.turnId !== projectTarget(nodeId)?.turn_id) throw new Error("already resolved");
    const completion = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => done(new Error("approval acknowledgement timed out")), 5000);
      const offResolved = client.onNotification("serverRequest/resolved", p => {
        if (p.requestId === body.toolUseId) done(p.decidedBy.clientId === client.clientId ? undefined : new Error(`已由 ${p.decidedBy.label} 处理`));
      });
      const offError = client.onError((error, id) => { if (id === request.id) done(error); });
      function done(error?: Error) { clearTimeout(timer); offResolved(); offError(); if (error) reject(error); else resolve(); }
    });
    const allow = body.behavior === "allow";
    switch (request.method) {
      case "item/commandExecution/requestApproval": case "item/fileChange/requestApproval":
        request.respond({ decision: allow ? body.alwaysAllowTool === true ? "acceptForSession" : "accept" : "reject" }); break;
      case "item/permissions/requestApproval":
        request.respond({ permissions: allow ? request.params.permissions : {}, scope: body.alwaysAllowTool === true ? "session" : "turn" }); break;
      case "item/tool/requestUserInput": {
        const input = body.updatedInput as {answers?: Record<string,unknown>} | undefined;
        const answers: Record<string, {answers:string[]}> = {};
        if (allow) for (const question of request.params.questions) {
          const answer = input?.answers?.[question.id] ?? input?.answers?.[question.question];
          if (typeof answer === "string") answers[question.id] = {answers:[answer]};
          else if (Array.isArray(answer) && answer.every(a => typeof a === "string")) answers[question.id] = {answers:answer};
        }
        request.respond({ answers }); break;
      }
    }
    await completion;
    return { ok: true };
  }));
}
export async function interruptProject(nodeId: string) {
  const active = runs.get(nodeId);
  if (active && !active.terminal) return active.client.request("turn/interrupt", { threadId: active.threadId, turnId: active.turnId });
  return withNodeThread(nodeId, (client, threadId) => client.request("turn/interrupt", { threadId, turnId: getAsTurn(nodeId)?.turn_id ?? undefined }));
}
export async function permissionProject(nodeId: string, permission: NonNullable<StartThreadParams["permission"]>) {
  if (["full", "bypassPermissions"].includes(permission)) throw new Error("bypass 只能在创建线程时选择");
  return withNodeThread(nodeId, (client, threadId) => setProjectPermission(client, threadId, permission));
}
export function projectSSE(req: Request, run: ProjectRun, created?: Record<string, unknown>) {
  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  return new Response(new ReadableStream({
    start(controller) {
      let closed = false;
      const close = () => { if (!closed) { closed = true; controller.close(); } };
      const send = (event: unknown) => { if (!closed) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); };
      if (created) send(created);
      unsubscribe = run.subscribe({ onEvent: send, onClose: close });
      const abort = () => { unsubscribe(); close(); };
      if (req.signal.aborted) abort(); else req.signal.addEventListener("abort", abort, {once:true});
    }, cancel() { unsubscribe(); },
  }), { headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no" } });
}
