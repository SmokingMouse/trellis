import { ErrorCode, ProtocolError, rpcError } from "../protocol/index.js";
import { TurnQueue } from "./turn-queue.js";
const transitions = {
    spawning: ["idle", "systemError", "closed"], idle: ["running", "closed", "systemError"],
    running: ["idle", "interrupted", "systemError", "closed"], interrupted: ["idle", "systemError", "closed"],
    systemError: ["spawning", "closed"], closed: ["spawning"],
};
export class ThreadManager {
    log;
    factory;
    live = new Map();
    engineThreads = new Map();
    opening = new Map();
    closing = new Map();
    queues = new Map();
    idleSince = new Map();
    consumers = new Map();
    timer;
    approvals;
    maxQueuedTurns;
    idleTimeoutMs;
    now;
    constructor(log, factory, options = {}) {
        this.log = log;
        this.factory = factory;
        this.maxQueuedTurns = options.maxQueuedTurns ?? 8;
        this.idleTimeoutMs = options.idleTimeoutMs ?? 30 * 60_000;
        this.now = options.now ?? Date.now;
        // The database outlives engines. No process survives this owner restarting.
        for (const thread of log.allThreads())
            if (!["closed", "systemError"].includes(thread.status.type)) {
                const error = new ProtocolError(ErrorCode.engine_unavailable, "server restarted; resume required", { threadId: thread.id, retryable: true }).toJSON();
                thread.status = { type: "systemError", error };
                log.saveThread(thread);
                for (const turn of log.turns(thread.id))
                    if (turn.status === "inProgress") {
                        turn.status = "failed";
                        turn.error = error;
                        turn.completedAtMs = this.now();
                        log.saveTurn(turn);
                        log.finishOpenItems(thread.id, turn.id, true);
                    }
            }
        this.timer = setInterval(() => { void this.sweepIdle(); }, Math.max(10, Math.min(this.idleTimeoutMs || 60_000, 60_000)));
        this.timer.unref();
    }
    get(threadId) { return this.log.thread(threadId); }
    async setPermission(params) {
        const thread = this.get(params.threadId);
        if (thread.backend !== "claude")
            throw new ProtocolError(ErrorCode.backend_unsupported, "live permission mode requires Claude");
        const engine = this.session(thread.id);
        if (!engine.setPermission)
            throw new ProtocolError(ErrorCode.backend_unsupported, "live permission mode unavailable");
        await engine.setPermission(params.permission);
        return { thread: this.get(thread.id) };
    }
    engineControl(params) {
        const thread = this.get(params.threadId);
        if (thread.backend !== "claude")
            throw new ProtocolError(ErrorCode.backend_unsupported, `${thread.backend} does not support Claude engine controls`);
        const engine = this.session(thread.id);
        if (!engine.engineControl)
            throw new ProtocolError(ErrorCode.backend_unsupported, "engine controls unavailable");
        return engine.engineControl(params.subtype, params.params);
    }
    session(threadId) {
        const session = this.live.get(threadId);
        if (!session)
            throw new ProtocolError(ErrorCode.engine_unavailable, "no live engine", { threadId, retryable: true });
        return session;
    }
    queue(threadId) {
        this.get(threadId);
        let queue = this.queues.get(threadId);
        if (!queue) {
            queue = new TurnQueue(threadId, this.log, () => this.session(threadId), status => this.setStatus(threadId, status), this.maxQueuedTurns, error => this.engineDied(threadId, error));
            this.queues.set(threadId, queue);
        }
        return queue;
    }
    setStatus(threadId, status) {
        const thread = this.get(threadId);
        if (thread.status.type !== status.type && !transitions[thread.status.type].includes(status.type))
            throw new ProtocolError(ErrorCode.internal, `invalid thread transition ${thread.status.type} -> ${status.type}`, { threadId });
        thread.status = status;
        this.log.saveThread(thread);
        if (status.type === "idle")
            this.idleSince.set(threadId, this.now());
        else
            this.idleSince.delete(threadId);
        this.log.publish({ jsonrpc: "2.0", method: "thread/status/changed", params: { threadId, status } });
    }
    async start(params, onCreated, internal) {
        const request = internal?.request ?? params;
        const existing = this.log.deduplicate("threads", params.clientThreadId, request);
        if (existing) {
            onCreated?.(existing);
            await this.opening.get(existing.id);
            return { thread: this.get(existing.id), deduplicated: true };
        }
        const thread = { id: `th_${crypto.randomUUID()}`, backend: params.backend, engineThreadId: internal?.fork ? null : internal?.resume ?? null, cwd: params.cwd ?? process.cwd(), status: { type: "spawning" }, createdAtMs: this.now(), ...(params.model ? { model: params.model } : {}), ...(params.meta ? { meta: params.meta } : {}), ...(params.clientThreadId ? { clientThreadId: params.clientThreadId } : {}) };
        if (internal?.forkedFrom)
            thread.forkedFrom = internal.forkedFrom;
        const options = { ...params, cwd: thread.cwd, ...(internal?.seedHistory ? { seedHistory: internal.seedHistory } : {}), ...(internal?.fork ? { engineThreadId: internal.resume, forkSession: true, forkPoint: internal.forkPoint } : {}) };
        thread.permission = params.permission ?? "default";
        this.log.transaction(() => {
            this.log.insertThread(thread, request, options);
            if (internal?.prefix && internal.forkedFrom)
                this.log.copyPrefix(internal.forkedFrom.threadId, thread.id, internal.prefix);
        });
        onCreated?.(thread);
        this.log.publish({ jsonrpc: "2.0", method: "thread/started", params: { threadId: thread.id, thread } });
        await this.open(thread, { ...options, threadId: thread.id, engineThreadId: internal?.resume, forkSession: internal?.fork, forkPoint: internal?.forkPoint });
        return { thread: this.get(thread.id) };
    }
    open(thread, options) {
        const pending = this.opening.get(thread.id);
        if (pending)
            return pending;
        const job = Promise.resolve().then(async () => {
            let session;
            try {
                session = this.factory(thread.backend);
                this.live.set(thread.id, session);
                const owned = session;
                const consumer = (async () => {
                    try {
                        for await (const event of owned.events) {
                            if (this.live.get(thread.id) !== owned)
                                break;
                            this.handle(thread.id, event);
                        }
                        if (this.live.get(thread.id) === owned)
                            this.engineDied(thread.id, new ProtocolError(ErrorCode.engine_unavailable, "engine event stream ended", { retryable: true }).toJSON());
                    }
                    catch (error) {
                        if (this.live.get(thread.id) === owned)
                            this.engineDied(thread.id, rpcError(error));
                    }
                })();
                this.consumers.set(thread.id, consumer);
                await session.spawn(options);
                if (this.live.get(thread.id) !== session)
                    throw new ProtocolError(ErrorCode.engine_unavailable, "engine died while spawning");
                if (session.engineThreadId)
                    this.metadata(thread.id, session.engineThreadId);
                this.setStatus(thread.id, { type: "idle" });
                this.queue(thread.id).resume();
            }
            catch (error) {
                this.engineDied(thread.id, rpcError(error));
                if (session)
                    await session.close("spawn_failed").catch(() => { });
                throw error instanceof ProtocolError ? error : new ProtocolError(ErrorCode.engine_unavailable, String(error), { threadId: thread.id, retryable: true });
            }
        }).finally(() => { this.opening.delete(thread.id); });
        this.opening.set(thread.id, job);
        return job;
    }
    async resume(params, onAttach) {
        let thread = params.threadId ? this.get(params.threadId) : params.engineThreadId ? this.log.findEngine(params.engineThreadId, params.backend) : undefined;
        if (!thread) {
            if (!params.engineThreadId)
                throw new ProtocolError(ErrorCode.thread_not_found, "thread not found");
            if (!params.cwd)
                throw new ProtocolError(ErrorCode.invalid_params, "cwd is required when importing an unknown engineThreadId");
            const { threadId: _, engineThreadId, ...overrides } = params;
            const result = await this.start({ ...overrides, backend: params.backend ?? "claude" }, onAttach, { resume: engineThreadId });
            return { ...result, attached: false };
        }
        if ((params.engineThreadId && thread.engineThreadId !== params.engineThreadId) || (params.backend && thread.backend !== params.backend))
            throw new ProtocolError(ErrorCode.invalid_params, "thread identity does not match");
        onAttach?.(thread);
        await this.closing.get(thread.id);
        const pending = this.opening.get(thread.id);
        if (pending || this.live.has(thread.id)) {
            if (pending)
                await pending;
            await this.session(thread.id).attach();
            return { thread: this.get(thread.id), attached: true };
        }
        thread = this.get(thread.id);
        const { threadId: _, engineThreadId: __, ...overrides } = params;
        const options = { ...this.log.options(thread.id), ...overrides, backend: thread.backend };
        this.log.saveOptions(thread.id, options);
        thread.cwd = options.cwd ?? thread.cwd;
        thread.model = options.model;
        thread.permission = options.permission ?? "default";
        delete thread.closedAtMs;
        this.log.saveThread(thread);
        // Claude replay frames are only durably flushed by a subsequent turn. Before
        // that, recreate the seeded process instead of resuming an incomplete file.
        const reseed = thread.backend === "claude" && options.seedHistory !== undefined;
        if (reseed && thread.engineThreadId) {
            thread.engineThreadId = null;
            this.log.saveThread(thread);
        }
        this.setStatus(thread.id, { type: "spawning" });
        await this.open(thread, { ...options, threadId: thread.id, ...(reseed ? { engineThreadId: undefined, forkSession: false } : thread.engineThreadId ? { engineThreadId: thread.engineThreadId, forkSession: false, forkPoint: undefined, seedHistory: undefined } : {}) });
        return { thread: this.get(thread.id), attached: false };
    }
    async fork(params, onCreated) {
        const source = this.get(params.threadId);
        if (source.backend !== "claude" && source.backend !== "codex")
            throw new ProtocolError(ErrorCode.unsupported_capability, "fork requires Claude or Codex", { threadId: source.id });
        const all = this.log.snapshot(source.id).items;
        const index = params.fromItemId === undefined ? all.length - 1 : all.findIndex(item => item.id === params.fromItemId);
        if (params.fromItemId !== undefined && index < 0)
            throw new ProtocolError(ErrorCode.invalid_params, "fromItemId does not belong to the source thread", { threadId: source.id, itemId: params.fromItemId });
        const prefix = all.slice(0, index + 1), itemId = prefix.at(-1)?.id ?? null;
        const forkPoint = itemId ? this.log.forkPoint(source.id, itemId) : undefined;
        // Unmapped and live boundaries must never silently inherit a later native suffix.
        const unflushedSeed = source.backend === "claude" && this.log.options(source.id).seedHistory !== undefined;
        const native = !unflushedSeed && !!source.engineThreadId && !!forkPoint;
        const { clientThreadId: _, ...options } = this.log.options(source.id);
        const { seedHistory: __, engineThreadId: ___, forkSession: ____, forkPoint: _____, ...clean } = options;
        return this.start({ ...clean, clientThreadId: params.clientThreadId }, onCreated, { ...(native ? { resume: source.engineThreadId, fork: true, forkPoint } : { seedHistory: prefix }), prefix, forkedFrom: { threadId: source.id, itemId }, request: params });
    }
    metadata(threadId, engineThreadId) {
        const owner = this.engineThreads.get(engineThreadId);
        if (owner && owner !== threadId)
            throw new ProtocolError(ErrorCode.engine_protocol_error, "engine session already owned by another live thread", { threadId });
        const thread = this.get(threadId);
        if (thread.engineThreadId && thread.engineThreadId !== engineThreadId && this.engineThreads.get(thread.engineThreadId) === threadId)
            this.engineThreads.delete(thread.engineThreadId);
        this.engineThreads.set(engineThreadId, threadId);
        if (thread.engineThreadId === engineThreadId)
            return;
        thread.engineThreadId = engineThreadId;
        this.log.saveThread(thread);
        this.log.publish({ jsonrpc: "2.0", method: "thread/metadata/updated", params: { threadId, engineThreadId } });
    }
    handle(threadId, event) {
        if (event.type === "modelChanged") {
            const thread = this.get(threadId);
            thread.model = event.model;
            this.log.transaction(() => { this.log.saveThread(thread); this.log.saveOptions(threadId, { ...this.log.options(threadId), model: event.model }); });
            this.log.publish({ jsonrpc: "2.0", method: "thread/metadata/updated", params: { threadId, model: event.model } });
            return;
        }
        if (event.type === "permissionChanged") {
            const thread = this.get(threadId);
            thread.permission = event.permission;
            this.log.saveThread(thread);
            this.log.saveOptions(threadId, { ...this.log.options(threadId), permission: event.permission });
            this.log.publish({ jsonrpc: "2.0", method: "thread/permission/changed", params: { threadId, permission: event.permission } });
            return;
        }
        if (event.type === "engineEvent") {
            const { type: _, ...params } = event;
            this.log.publish({ jsonrpc: "2.0", method: "thread/engineEvent", params: { threadId, ...params } });
            return;
        }
        if (event.type === "metadata") {
            this.metadata(threadId, event.engineThreadId);
            return;
        }
        if (event.type === "exit") {
            this.engineDied(threadId, event.error ?? new ProtocolError(ErrorCode.engine_unavailable, "engine exited", { retryable: true }).toJSON());
            return;
        }
        if (event.type === "error") {
            this.log.publish({ jsonrpc: "2.0", method: "error", params: { threadId, ...(event.turnId ? { turnId: event.turnId } : {}), error: event.error, willRetry: event.willRetry } });
            return;
        }
        if (event.type === "usage") {
            this.log.publish({ jsonrpc: "2.0", method: "thread/tokenUsage/updated", params: { threadId, usage: event.usage } });
            return;
        }
        if (event.type === "status") {
            if (event.status.type === "systemError") {
                this.engineDied(threadId, event.status.error ?? new ProtocolError(ErrorCode.engine_unavailable, "engine thread entered systemError", { retryable: true }).toJSON());
                return;
            }
            // The queue owns running/idle transitions. Native idle can trail completion
            // after the next queued turn has already started, and must not release it.
            if (this.get(threadId).status.type === "spawning" || this.queue(threadId).runningTurnId)
                return;
            if (event.status.type === "idle" && this.get(threadId).status.type !== "idle")
                this.setStatus(threadId, event.status);
            return;
        }
        const turnId = event.type === "approval" ? event.request.params.turnId : event.turnId;
        if (this.queue(threadId).runningTurnId !== turnId)
            return; // stale output from an interrupted/closed generation
        switch (event.type) {
            case "itemStarted":
                this.log.startItem(threadId, turnId, event.item);
                break;
            case "itemDelta":
                this.log.delta(threadId, event.itemId, event.kind, event.text);
                break;
            case "itemUpdated":
                this.log.updateItem(threadId, event.item);
                break;
            case "itemCompleted":
                this.log.updateItem(threadId, event.item, true);
                break;
            case "turnCompleted": {
                this.approvals?.expireThread(threadId, "turn_completed", turnId);
                const { seedHistory: _, engineThreadId: __, forkSession: ___, forkPoint: ____, ...options } = this.log.options(threadId);
                this.log.saveOptions(threadId, options);
                this.queue(threadId).complete(turnId, event.status, event.usage, event.error);
                const last = this.log.snapshot(threadId).items.filter(item => item.turnId === turnId).at(-1);
                if (last && event.status === "completed" && event.forkPoint)
                    this.log.saveForkPoint(threadId, last.id, event.forkPoint);
                break;
            }
            case "approval":
                if (!this.approvals)
                    throw new ProtocolError(ErrorCode.internal, "ApprovalBroker is not configured");
                this.approvals.create(event.request, event.respond);
                break;
            case "approvalExpired":
                this.approvals?.expire(event.requestId, event.reason);
                break;
            case "plan":
                this.log.publish({ jsonrpc: "2.0", method: "turn/plan/updated", params: { threadId, turnId, plan: event.plan } });
                break;
            case "diff":
                this.log.publish({ jsonrpc: "2.0", method: "turn/diff/updated", params: { threadId, turnId, diffStat: { diff: event.diff } } });
                break;
        }
    }
    engineDied(threadId, error) {
        const session = this.live.get(threadId);
        this.live.delete(threadId);
        for (const [id, owner] of this.engineThreads)
            if (owner === threadId)
                this.engineThreads.delete(id);
        if (this.get(threadId).status.type === "closed")
            return;
        this.queue(threadId).freeze(error);
        this.approvals?.expireThread(threadId, "engine_gone");
        this.log.publish({ jsonrpc: "2.0", method: "error", params: { threadId, error, willRetry: false } });
        if (session)
            void session.close("engine_gone").catch(() => { });
    }
    async close(threadId, reason = "client_request") {
        this.get(threadId);
        const closing = this.closing.get(threadId);
        if (closing)
            return closing;
        const job = (async () => {
            await this.opening.get(threadId)?.catch(() => { });
            this.queue(threadId).pause();
            this.approvals?.expireThread(threadId, "thread_closed");
            const session = this.live.get(threadId);
            this.live.delete(threadId);
            for (const [id, owner] of this.engineThreads)
                if (owner === threadId)
                    this.engineThreads.delete(id);
            await session?.close(reason);
            await this.consumers.get(threadId);
            this.consumers.delete(threadId);
            const thread = this.get(threadId);
            thread.closedAtMs = this.now();
            this.log.saveThread(thread);
            this.setStatus(threadId, { type: "closed" });
            this.log.publish({ jsonrpc: "2.0", method: "thread/closed", params: { threadId, reason } });
        })().finally(() => this.closing.delete(threadId));
        this.closing.set(threadId, job);
        return job;
    }
    async sweepIdle() { if (this.idleTimeoutMs <= 0)
        return; for (const [id, since] of this.idleSince)
        if (this.now() - since >= this.idleTimeoutMs)
            await this.close(id, "idle_timeout"); }
    async shutdown() { clearInterval(this.timer); for (const id of new Set([...this.live.keys(), ...this.opening.keys()]))
        await this.close(id, "server_shutdown"); }
}
