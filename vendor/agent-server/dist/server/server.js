import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { timingSafeEqual } from "node:crypto";
import { ApprovalBroker, ItemLog, LeaseManager, ThreadManager } from "../core/index.js";
import { AsyncQueue, ClaudeEngine, CodexEngine } from "../engines/index.js";
import { ErrorCode, FrameSchema, MethodSchema, MethodSchemas, ProtocolError, rpcError } from "../protocol/index.js";
class Connection {
    server;
    clientId = `c_${crypto.randomUUID()}`;
    stream;
    get frames() {
        if (!this.stream) {
            this.stream = new AsyncQueue();
            if (this.closed)
                this.stream.end();
        }
        return this.stream;
    }
    serverRequests = new Set();
    attached = new Set();
    subscriptions = new Map();
    reverse = new Map();
    delivered = new Set();
    optOut = new Set();
    label = "in-process";
    initialized = false;
    initializing = false;
    closed = false;
    sequence = 0;
    reverseSequence = 0;
    listeners = new Set();
    closeListeners = new Set();
    calls = new Map();
    ingress = Promise.resolve();
    constructor(server) {
        this.server = server;
    }
    send(frame) {
        if (this.closed)
            return Promise.reject(new Error("connection closed"));
        // Clone at the transport boundary; callers cannot mutate an enqueued frame.
        let copy;
        try {
            copy = structuredClone(frame);
        }
        catch {
            copy = null;
        }
        const job = this.ingress.then(() => this.server.receive(this, copy));
        this.ingress = job.catch(() => { });
        return job;
    }
    emit(raw) {
        if (this.closed)
            return;
        const frame = FrameSchema.parse(JSON.parse(JSON.stringify(raw)));
        if ("id" in frame && ("result" in frame || "error" in frame)) {
            const call = frame.id === null ? undefined : this.calls.get(frame.id);
            if (call) {
                this.calls.delete(frame.id);
                if ("error" in frame)
                    call.reject(new ProtocolError(frame.error.code, frame.error.message, frame.error.data));
                else
                    call.resolve(frame.result);
            }
        }
        this.stream?.push(structuredClone(frame));
        for (const listener of [...this.listeners]) {
            try {
                listener(structuredClone(frame));
            }
            catch { /* Transport consumer isolation. */ }
        }
    }
    onFrame(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
    onClose(listener) {
        if (this.closed)
            listener();
        else
            this.closeListeners.add(listener);
        return () => this.closeListeners.delete(listener);
    }
    request(method, params) {
        const id = ++this.sequence;
        return new Promise((resolve, reject) => {
            this.calls.set(id, { resolve, reject });
            void this.send(JSON.parse(JSON.stringify({ jsonrpc: "2.0", id, method, params }))).catch(error => { this.calls.delete(id); reject(error); });
        });
    }
    notifyInitialized() { return this.send({ jsonrpc: "2.0", method: "initialized", params: {} }); }
    respond(id, result) { return this.send({ jsonrpc: "2.0", id, result }); }
    sendRequest(request) {
        // Each connection has its own wire ID; requestId is the durable logical ID.
        if (this.delivered.has(request.params.requestId))
            return;
        this.delivered.add(request.params.requestId);
        const id = `srv_${this.clientId}_${++this.reverseSequence}`;
        this.reverse.set(id, request.params.requestId);
        this.emit({ jsonrpc: "2.0", id, method: request.method, params: request.params });
    }
    notification(frame) { if (!this.optOut.has(frame.method))
        this.emit(frame); }
    close() {
        if (this.closed)
            return;
        this.closed = true;
        for (const detach of this.subscriptions.values())
            detach();
        this.subscriptions.clear();
        this.attached.clear();
        this.reverse.clear();
        this.server.disconnect(this);
        for (const call of this.calls.values())
            call.reject(new Error("connection closed"));
        this.calls.clear();
        this.stream?.end();
        this.listeners.clear();
        this.delivered.clear();
        for (const listener of this.closeListeners) {
            try {
                listener();
            }
            catch { /* Transport isolation. */ }
        }
        this.closeListeners.clear();
    }
}
export class AgentServer {
    options;
    log;
    threads;
    approvals;
    leases = new LeaseManager();
    connections = new Set();
    startedAt = Date.now();
    closed = false;
    closing;
    allowedRoots;
    backends;
    constructor(options = {}) {
        this.options = options;
        this.allowedRoots = (options.allowedRoots ?? [homedir()]).map(root => realpathSync(resolve(root)));
        this.backends = options.backends ?? ["claude", "codex"];
        this.log = new ItemLog(options.databasePath ?? join(homedir(), ".agent-server", "agent-server.db"));
        this.log.subscribeServer(notification => {
            for (const connection of this.connections)
                if (connection.initialized && !connection.optOut.has(notification.method))
                    connection.emit(notification);
        });
        this.threads = new ThreadManager(this.log, options.engineFactory ?? (backend => {
            if (backend === "codex")
                return new CodexEngine();
            if (backend !== "claude")
                throw new ProtocolError(ErrorCode.unsupported_capability, `backend ${backend} is not installed`);
            return new ClaudeEngine();
        }), options);
        this.approvals = new ApprovalBroker(this.log, () => this.connections, this.leases, { orphanTimeoutMs: options.orphanTimeoutMs, timeoutMs: options.approvalTimeoutMs, onDeliveryError: (threadId, error) => this.threads.engineDied(threadId, rpcError(error)) });
        this.threads.approvals = this.approvals;
    }
    connectInProcess() {
        if (this.closed)
            throw new Error("server closed");
        const connection = new Connection(this);
        this.connections.add(connection);
        return connection;
    }
    disconnect(connection) { this.connections.delete(connection); this.leases.disconnect(connection.clientId); this.approvals.audienceChanged(); }
    cwd(path) {
        let cwd;
        try {
            cwd = realpathSync(path ?? process.cwd());
        }
        catch {
            throw new ProtocolError(ErrorCode.unauthorized, "cwd is not accessible");
        }
        if (cwd === "/" || !this.allowedRoots.some(root => { const child = relative(root, cwd); return child === "" || (!child.startsWith(".." + "/") && child !== ".." && !isAbsolute(child)); }))
            throw new ProtocolError(ErrorCode.unauthorized, "cwd is outside allowed_roots");
        return cwd;
    }
    attach(connection, threadId) {
        if (connection.closed || connection.attached.has(threadId))
            return;
        this.threads.get(threadId);
        const detach = this.log.subscribe(threadId, frame => connection.notification(frame));
        connection.attached.add(threadId);
        connection.subscriptions.set(threadId, detach);
        this.approvals.clientAttached(connection, threadId);
    }
    async receive(connection, raw) {
        if (connection.closed)
            return;
        if (this.closed) {
            const id = raw && typeof raw === "object" && "id" in raw && (typeof raw.id === "string" || typeof raw.id === "number") ? raw.id : null;
            connection.emit({ jsonrpc: "2.0", id, error: new ProtocolError(ErrorCode.engine_unavailable, "server is shutting down").toJSON() });
            return;
        }
        const parsed = FrameSchema.safeParse(raw);
        if (!parsed.success) {
            const id = raw && typeof raw === "object" && "id" in raw && (typeof raw.id === "string" || (typeof raw.id === "number" && Number.isSafeInteger(raw.id))) ? raw.id : null;
            connection.emit({ jsonrpc: "2.0", id, error: new ProtocolError(ErrorCode.invalid_request, "invalid JSON-RPC frame").toJSON() });
            return;
        }
        const frame = parsed.data;
        try {
            if (!("method" in frame)) {
                if (!connection.initialized)
                    throw new ProtocolError(ErrorCode.not_initialized, "initialize first");
                const requestId = frame.id === null ? undefined : connection.reverse.get(frame.id);
                if (!requestId)
                    throw new ProtocolError(ErrorCode.invalid_request, "unknown reverse request id");
                if ("error" in frame)
                    throw new ProtocolError(ErrorCode.invalid_params, "server request requires a decision result");
                this.approvals.answer(requestId, connection.clientId, frame.result);
                return;
            }
            if (!("id" in frame)) {
                if (frame.method !== "initialized" || !connection.initializing || connection.initialized)
                    throw new ProtocolError(ErrorCode.not_initialized, "initialize handshake required");
                connection.initialized = true;
                return;
            }
            if (frame.method !== "initialize" && !connection.initialized)
                throw new ProtocolError(ErrorCode.not_initialized, "initialize and initialized required");
            const method = MethodSchema.safeParse(frame.method);
            if (!method.success)
                throw new ProtocolError(ErrorCode.method_not_found, `unknown method ${frame.method}`);
            const params = MethodSchemas[method.data].params.parse(frame.params);
            // A synchronous snapshot and its response share one event-loop turn. Awaiting
            // an already-resolved promise here lets newer deltas overtake that snapshot.
            const dispatched = this.dispatch(connection, method.data, params);
            const result = dispatched instanceof Promise ? await dispatched : dispatched;
            const validated = MethodSchemas[method.data].result.parse(result);
            connection.emit({ jsonrpc: "2.0", id: frame.id, result: validated });
        }
        catch (error) {
            const rpc = rpcError(error);
            connection.emit({ jsonrpc: "2.0", id: "id" in frame ? frame.id : null, error: rpc });
            if (rpc.code === ErrorCode.unsupported_protocol_version || ("method" in frame && frame.method === "initialize" && rpc.code === ErrorCode.unauthorized))
                connection.close();
        }
    }
    dispatch(connection, method, raw) {
        // Narrow at each method using the schema's inferred params type.
        const params = (_method) => raw;
        switch (method) {
            case "initialize": {
                const p = params(method);
                if (connection.initializing)
                    throw new ProtocolError(ErrorCode.invalid_request, "already initialized");
                if (p.protocolVersion !== "as/1")
                    throw new ProtocolError(ErrorCode.unsupported_protocol_version, "only as/1 is supported");
                if (this.options.token !== undefined) {
                    const expected = Buffer.from(this.options.token), provided = Buffer.from(p.token ?? "");
                    if (expected.length !== provided.length || !timingSafeEqual(expected, provided))
                        throw new ProtocolError(ErrorCode.unauthorized, "invalid token");
                }
                connection.initializing = true;
                connection.label = p.client.label;
                for (const capability of p.capabilities?.serverRequests ?? [])
                    connection.serverRequests.add(capability);
                for (const notification of p.capabilities?.notifications?.optOut ?? [])
                    connection.optOut.add(notification);
                return { protocolVersion: "as/1", server: { name: "agent-server", version: "0.1.0" }, clientId: connection.clientId, capabilities: { backends: this.backends, steer: true, fork: this.backends.includes("claude"), leases: true, externalProviders: false, maxQueuedTurns: this.threads.maxQueuedTurns } };
            }
            case "thread/start": {
                const p = params(method);
                if (!this.backends.includes(p.backend))
                    throw new ProtocolError(ErrorCode.unsupported_capability, "backend is not available");
                return this.threads.start({ ...p, cwd: this.cwd(p.cwd) }, thread => this.attach(connection, thread.id));
            }
            case "thread/resume": {
                const p = params(method);
                if (p.cwd)
                    this.cwd(p.cwd);
                if (p.backend && !this.backends.includes(p.backend))
                    throw new ProtocolError(ErrorCode.unsupported_capability, "backend is not available");
                const existing = p.threadId ? this.threads.get(p.threadId) : p.engineThreadId ? this.log.findEngine(p.engineThreadId, p.backend) : undefined;
                if (!existing && !p.cwd)
                    throw new ProtocolError(ErrorCode.invalid_params, "cwd is required when importing an unknown engineThreadId");
                if (existing)
                    this.cwd(p.cwd ?? existing.cwd);
                return this.threads.resume(existing ? p : { ...p, cwd: this.cwd(p.cwd) }, thread => this.attach(connection, thread.id));
            }
            case "thread/attach": {
                const p = params(method);
                this.attach(connection, p.threadId);
                return this.log.snapshot(p.threadId, p.sinceSeq);
            }
            case "thread/detach": {
                const p = params(method);
                this.threads.get(p.threadId);
                connection.subscriptions.get(p.threadId)?.();
                connection.subscriptions.delete(p.threadId);
                connection.attached.delete(p.threadId);
                for (const request of this.log.pendingRequests(p.threadId))
                    connection.delivered.delete(request.params.requestId);
                this.approvals.audienceChanged();
                return {};
            }
            case "thread/read": return { thread: this.threads.get(params(method).threadId) };
            case "thread/items/list": return this.log.listItems(params(method));
            case "thread/list": {
                const p = params(method), limit = p.limit ?? 100;
                let threads = this.log.allThreads().filter(t => (!p.status || t.status.type === p.status) && (!p.backend || t.backend === p.backend) && (!p.cwd || t.cwd === p.cwd));
                if (p.cursor) {
                    const index = threads.findIndex(t => t.id === p.cursor);
                    if (index < 0)
                        throw new ProtocolError(ErrorCode.invalid_params, "invalid thread cursor");
                    threads = threads.slice(index + 1);
                }
                const more = threads.length > limit;
                threads = threads.slice(0, limit);
                return { threads, nextCursor: more ? threads.at(-1).id : null };
            }
            case "thread/fork": {
                const p = params(method);
                this.cwd(this.threads.get(p.threadId).cwd);
                return this.threads.fork(p, thread => this.attach(connection, thread.id));
            }
            case "thread/close": {
                const p = params(method);
                return this.threads.close(p.threadId, p.reason).then(() => { this.leases.clear(p.threadId); return {}; });
            }
            case "thread/interrupt": return this.threads.queue(params(method).threadId).interrupt().then(interruptedTurnId => ({ interruptedTurnId }));
            case "turn/start": {
                const p = params(method);
                this.leases.assertInput(p.threadId, connection.clientId);
                if (p.cwd)
                    this.cwd(p.cwd);
                return this.threads.queue(p.threadId).enqueue(p);
            }
            case "turn/steer": {
                const p = params(method);
                this.leases.assertInput(p.threadId, connection.clientId);
                return this.threads.queue(p.threadId).steer(p).then(() => ({}));
            }
            case "turn/interrupt": {
                const p = params(method);
                return this.threads.queue(p.threadId).interrupt(p.turnId).then(() => ({}));
            }
            case "turn/cancel": {
                const p = params(method);
                this.threads.queue(p.threadId).cancel(p.turnId);
                return {};
            }
            case "thread/queue/read": return { queue: this.threads.queue(params(method).threadId).read() };
            case "thread/lease/acquire": {
                const p = params(method);
                this.threads.get(p.threadId);
                return { lease: this.leases.acquire(p.threadId, { clientId: connection.clientId, label: connection.label }, p.ttlMs) };
            }
            case "thread/lease/release": {
                const p = params(method);
                this.threads.get(p.threadId);
                this.leases.release(p.threadId, connection.clientId);
                return {};
            }
            case "server/health": {
                const threads = this.log.allThreads();
                return { uptimeMs: Date.now() - this.startedAt, threads: Object.fromEntries(["running", "idle", "closed"].map(status => [status, threads.filter(t => t.status.type === status).length])), engines: [...this.threads.live].map(([threadId, engine]) => ({ threadId, backend: engine.backend, engineThreadId: engine.engineThreadId })) };
            }
            case "server/config/read": return { allowed_roots: this.allowedRoots, maxQueuedTurns: this.threads.maxQueuedTurns, orphanTimeoutMs: this.approvals.orphanTimeoutMs, idleTimeoutMs: this.threads.idleTimeoutMs };
        }
    }
    close(reason = "server_shutdown", graceMs = 0) {
        if (this.closing)
            return this.closing;
        if (!Number.isFinite(graceMs) || graceMs < 0)
            return Promise.reject(new Error("graceMs must be nonnegative"));
        this.closed = true;
        for (const connection of this.connections)
            if (connection.initialized)
                connection.emit({ jsonrpc: "2.0", method: "server/shuttingDown", params: { reason, graceMs } });
        this.closing = (async () => {
            if (graceMs)
                await new Promise(resolve => setTimeout(resolve, graceMs));
            try {
                await this.threads.shutdown();
            }
            finally {
                this.approvals.close();
                for (const connection of [...this.connections])
                    connection.close();
                this.log.close();
            }
        })();
        return this.closing;
    }
}
export { AgentServer as Server };
export function connectInProcess(server) { return server.connectInProcess(); }
