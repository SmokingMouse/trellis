import { ErrorCode, FrameSchema, MethodSchemas, NotificationMethodSchema, NotificationSchemas, PendingServerRequestSchema, ProtocolError, ServerRequestSchemas, } from "../protocol/index.js";
import { openWire } from "./wire.js";
/** AS v1 client. Snapshots are upserts by item.id; delta notifications are live only. */
export class AgentClient {
    endpoint;
    options;
    wire;
    connecting;
    generation = 0;
    sequence = 0;
    stopped = false;
    everConnected = false;
    retries = 0;
    reconnectTimer;
    calls = new Map();
    cursors = new Map();
    pending = new Map();
    frameListeners = new Set();
    notifications = new Set();
    requests = new Set();
    snapshots = new Set();
    states = new Set();
    errors = new Set();
    currentState = "disconnected";
    initialized;
    constructor(endpoint, options = {}) {
        this.endpoint = endpoint;
        this.options = options;
    }
    get state() { return this.currentState; }
    get clientId() { return this.initialized?.clientId; }
    get initializeResult() { return this.initialized && structuredClone(this.initialized); }
    get pendingRequests() { return new Map(this.pending); }
    static async connectUnix(options) {
        const client = new AgentClient({ transport: "unix", path: options.path }, options);
        try {
            await client.connect();
            return client;
        }
        catch (error) {
            client.close();
            throw error;
        }
    }
    static async connectWebSocket(options) {
        const client = new AgentClient({ transport: "ws", url: options.url }, options);
        try {
            await client.connect();
            return client;
        }
        catch (error) {
            client.close();
            throw error;
        }
    }
    onFrame(listener) { return this.listen(this.frameListeners, listener); }
    onStateChange(listener) { return this.listen(this.states, listener); }
    onSnapshot(listener) { return this.listen(this.snapshots, listener); }
    onError(listener) { this.errors.add(listener); return () => this.errors.delete(listener); }
    onNotification(method, listener) {
        return this.listen(this.notifications, frame => { if (frame.method === method)
            listener(frame.params); });
    }
    onServerRequest(method, listener) {
        return this.listen(this.requests, request => { if (request.method === method)
            listener(request); });
    }
    listen(listeners, listener) { listeners.add(listener); return () => listeners.delete(listener); }
    emit(listeners, value) {
        for (const listener of [...listeners]) {
            try {
                listener(value);
            }
            catch (error) {
                this.error(error);
            }
        }
    }
    error(error, id) { for (const listener of [...this.errors]) {
        try {
            listener(error, id);
        }
        catch { /* Consumer isolation. */ }
    } }
    setState(state) { if (this.currentState !== state) {
        this.currentState = state;
        this.emit(this.states, state);
    } }
    connect() {
        if (this.stopped)
            return Promise.reject(new Error("client closed"));
        if (this.currentState === "connected")
            return Promise.resolve();
        if (this.connecting)
            return this.connecting;
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = undefined;
        this.connecting = this.open().finally(() => { this.connecting = undefined; if (!this.wire)
            this.scheduleReconnect(); });
        return this.connecting;
    }
    async open() {
        const generation = ++this.generation;
        this.setState(this.everConnected ? "reconnecting" : "connecting");
        try {
            const wire = await openWire(this.endpoint, text => { if (generation === this.generation)
                this.receive(text); }, error => this.lost(generation, error), this.options.connectTimeoutMs ?? 5000);
            if (this.stopped || generation !== this.generation) {
                wire.close();
                throw new Error("connection cancelled");
            }
            this.wire = wire;
            this.initialized = await this.call("initialize", {
                protocolVersion: this.options.protocolVersion ?? "as/1", token: this.options.token,
                client: this.options.client ?? { name: "agent-client", version: "0.1.0", kind: "library", label: "agent-client" },
                capabilities: this.options.capabilities,
            });
            this.send({ jsonrpc: "2.0", method: "initialized", params: {} });
            for (const threadId of [...this.cursors.keys()]) {
                try {
                    await this.call("thread/attach", { threadId, sinceSeq: this.sinceSeq(threadId) });
                }
                catch (error) {
                    if (error instanceof ProtocolError && error.code === ErrorCode.thread_not_found) {
                        this.cursors.delete(threadId);
                        this.error(error);
                    }
                    else
                        throw error;
                }
            }
            if (generation !== this.generation || this.stopped)
                throw new Error("connection cancelled");
            this.everConnected = true;
            this.retries = 0;
            this.setState("connected");
        }
        catch (error) {
            if (error instanceof ProtocolError && (error.code === ErrorCode.unauthorized || error.code === ErrorCode.unsupported_protocol_version))
                this.close();
            this.lost(generation, error);
            throw error;
        }
    }
    lost(generation, error) {
        if (generation !== this.generation)
            return;
        ++this.generation;
        const wire = this.wire;
        this.wire = undefined;
        wire?.close();
        this.pending.clear();
        for (const call of this.calls.values()) {
            clearTimeout(call.timer);
            call.reject(error);
        }
        this.calls.clear();
        this.setState(this.stopped ? "closed" : "disconnected");
        this.scheduleReconnect();
    }
    scheduleReconnect() {
        if (this.stopped || !this.everConnected || this.options.reconnect === false || this.connecting || this.reconnectTimer)
            return;
        const options = this.options.reconnect || {};
        const delay = Math.min(options.maxDelayMs ?? 5000, (options.minDelayMs ?? 100) * 2 ** Math.min(this.retries++, 16));
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; void this.connect().catch(error => this.error(error)); }, delay);
    }
    close() { this.stopped = true; clearTimeout(this.reconnectTimer); this.lost(this.generation, new Error("client closed")); }
    async request(method, params) {
        await this.connect();
        return this.call(method, params);
    }
    call(method, params) {
        const id = `cli_${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.calls.delete(id); reject(new Error(`${method} timed out; delivery is unknown`)); }, this.options.requestTimeoutMs ?? 30_000);
            this.calls.set(id, { method, params: structuredClone(params), resolve: result => resolve(result), reject, timer });
            try {
                this.send({ jsonrpc: "2.0", id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.calls.delete(id);
                reject(error);
            }
        });
    }
    send(frame) {
        if (!this.wire)
            throw new Error("client disconnected");
        try {
            this.wire.send(JSON.stringify(frame));
        }
        catch (error) {
            this.lost(this.generation, error);
            throw error;
        }
    }
    receive(text) {
        try {
            const frame = FrameSchema.parse(JSON.parse(text));
            this.emit(this.frameListeners, structuredClone(frame));
            if (!("method" in frame)) {
                const call = frame.id === null ? undefined : this.calls.get(frame.id);
                if (call) {
                    this.calls.delete(frame.id);
                    clearTimeout(call.timer);
                    if ("error" in frame)
                        call.reject(new ProtocolError(frame.error.code, frame.error.message, frame.error.data));
                    else {
                        try {
                            const result = MethodSchemas[call.method].result.parse(frame.result);
                            this.trackResult(call.method, call.params, result);
                            call.resolve(result);
                        }
                        catch (error) {
                            call.reject(error);
                        }
                    }
                }
                else if ("error" in frame)
                    this.error(new ProtocolError(frame.error.code, frame.error.message, frame.error.data), frame.id);
                return;
            }
            if ("id" in frame) {
                const request = PendingServerRequestSchema.parse(frame);
                if (!this.options.capabilities?.serverRequests?.includes(request.method))
                    throw new Error(`undeclared server request: ${request.method}`);
                this.rememberRequest(request, frame.id);
                return;
            }
            const known = NotificationMethodSchema.safeParse(frame.method);
            // AS v1 can add notifications without a version bump; onFrame still exposes them.
            if (!known.success)
                return;
            const method = known.data;
            const parsed = NotificationSchemas[method].safeParse(frame.params);
            // A malformed notification is local to this frame, not a broken connection.
            if (!parsed.success) {
                this.error(parsed.error);
                return;
            }
            const params = parsed.data;
            const notification = { jsonrpc: "2.0", method, params };
            if (notification.method === "thread/started")
                this.cursor(notification.params.threadId);
            if (notification.method === "item/started" || notification.method === "item/completed")
                this.trackItem(notification.params.threadId, notification.params.item);
            if (notification.method === "serverRequest/resolved" || notification.method === "serverRequest/expired")
                this.pending.delete(notification.params.requestId);
            this.emit(this.notifications, notification);
        }
        catch (error) {
            this.error(error);
            this.lost(this.generation, error);
        }
    }
    rememberRequest(request, id) {
        const generation = this.generation;
        const handle = { ...request, id, respond: (result) => {
                if (generation !== this.generation)
                    throw new Error("server request belongs to a disconnected connection");
                const validated = ServerRequestSchemas[request.method].result.parse(result);
                this.send({ jsonrpc: "2.0", id, result: validated });
            } };
        const previous = this.pending.get(request.params.requestId);
        this.pending.set(request.params.requestId, handle);
        if (previous?.id !== id)
            this.emit(this.requests, handle);
    }
    cursor(threadId) {
        let cursor = this.cursors.get(threadId);
        if (!cursor) {
            cursor = { highest: 0 };
            this.cursors.set(threadId, cursor);
        }
        return cursor;
    }
    trackItem(threadId, item) {
        const cursor = this.cursor(threadId);
        cursor.highest = Math.max(cursor.highest, item.seq, item.completedSeq ?? 0);
    }
    /** Server completion cursors reconcile items finished while disconnected. */
    sinceSeq(threadId) {
        return this.cursors.get(threadId)?.highest ?? 0;
    }
    trackResult(method, params, result) {
        if (method === "thread/detach") {
            const { threadId } = params;
            this.cursors.delete(threadId);
            for (const [id, request] of this.pending)
                if (request.params.threadId === threadId)
                    this.pending.delete(id);
        }
        else if (method === "thread/attach") {
            const snapshot = result, threadId = snapshot.thread.id;
            const cursor = this.cursor(threadId);
            cursor.highest = Math.max(cursor.highest, snapshot.nextSeq - 1);
            for (const item of snapshot.items)
                this.trackItem(threadId, item);
            const pendingIds = new Set(snapshot.pendingRequests.map(request => request.params.requestId));
            for (const [id, request] of this.pending)
                if (request.params.threadId === threadId && !pendingIds.has(id))
                    this.pending.delete(id);
            // The attach response has logical IDs; the preceding reverse frames supply connection-local IDs.
            for (const request of snapshot.pendingRequests) {
                const handle = this.pending.get(request.params.requestId);
                if (handle)
                    this.rememberRequest(request, handle.id);
            }
            this.emit(this.snapshots, structuredClone(snapshot));
        }
        else if (method === "thread/start" || method === "thread/resume" || method === "thread/fork")
            this.cursor(result.thread.id);
    }
}
export const connectUnix = AgentClient.connectUnix;
export const connectWebSocket = AgentClient.connectWebSocket;
//# sourceMappingURL=client.js.map