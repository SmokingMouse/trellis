import { CODEX_SCHEMA_VERSION } from "../../engines/codex-version.js";
import { CodexEngine } from "../../engines/codex.js";
import { ErrorCode, ProtocolError, rpcError, ServerRequestMethodSchema, ServerRequestSchemas } from "../../protocol/index.js";
import { CodexRouter, NativeRpcError, nativeThreadId, findClaudeThread } from "./router.js";
import { claudeApproval, claudeNotification, claudeToolPermission, claudeAnswer } from "./claude-projection.js";
export function nativeDecision(method, result) {
    if (!result || typeof result !== "object" || Array.isArray(result))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: decision object required");
    if (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval") {
        const decisions = { accept: "accept", acceptForSession: "acceptForSession", decline: "reject", cancel: "abort" };
        if (typeof result.decision !== "string" || !Object.hasOwn(decisions, result.decision))
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported approval decision");
        return ServerRequestSchemas[method].result.parse({ decision: decisions[result.decision] });
    }
    if (method === "item/permissions/requestApproval") {
        if (result.scope !== "turn" && result.scope !== "session")
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported permission scope");
        return ServerRequestSchemas[method].result.parse({ permissions: result.permissions, scope: result.scope === "session" ? "thread" : "turn" });
    }
    return ServerRequestSchemas[method].result.parse(result);
}
// A bearer identifies the authorized local audience, not one TUI process. Only
// detached subscriptions transfer; live connections keep their own ownership.
const detached = new WeakMap();
/** Each WebSocket owns exactly one authenticated AS connection. */
export class CodexSession {
    control;
    options;
    client;
    router;
    state = "new";
    abort = new AbortController();
    reverse = new Map();
    logical = new Map();
    localTools = new Map();
    optOut = new Set();
    unsubscribe;
    unclose;
    restoring = Promise.resolve();
    constructor(server, control, options) {
        this.control = control;
        this.options = options;
        this.client = server.connectInProcess();
        this.router = new CodexRouter(server, this.client, control, this.abort.signal, options.claudeThreads ?? false, frame => this.send(frame));
        this.unsubscribe = this.client.onFrame(frame => this.fromAS(frame));
        this.unclose = this.client.onClose(() => { this.close(); options.end?.(); });
    }
    send(frame) {
        if (this.state === "closed")
            return;
        if (frame.method && frame.id == null && this.optOut.has(frame.method) && frame.method !== "serverRequest/resolved")
            return;
        try {
            this.options.send(frame);
        }
        catch {
            this.close();
            this.options.end?.();
        }
    }
    async receive(raw) {
        if (this.state === "closed")
            return;
        const f = raw;
        const id = f && (typeof f.id === "string" || (typeof f.id === "number" && Number.isSafeInteger(f.id))) ? f.id : null;
        try {
            if (!f || typeof f !== "object" || Array.isArray(f) || ("id" in f && id === null) || (f.jsonrpc != null && f.jsonrpc !== "2.0"))
                throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: invalid native frame");
            if (!f.method) {
                if (this.state !== "ready")
                    throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: initialize and initialized required");
                const tool = id === null ? undefined : this.localTools.get(id);
                if (tool) {
                    if (("result" in f) === ("error" in f))
                        throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: native tool result or error required");
                    tool.engine.respondNativeToolCall(tool.nativeId, this.client.clientId, "error" in f ? { error: f.error } : { result: f.result });
                    this.localTools.delete(id);
                    return;
                }
                const pending = id === null ? undefined : this.reverse.get(id);
                if (!pending || !("result" in f) || "error" in f)
                    throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: unknown approval or missing decision");
                const result = pending.claudeParams ? claudeAnswer(pending.method, pending.claudeParams, f.result) : f.result;
                await this.client.respond(id, nativeDecision(pending.method, result));
                return;
            }
            if (typeof f.method !== "string" || "result" in f || "error" in f)
                throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: invalid request");
            const p = f.params ?? {};
            if (typeof p !== "object" || Array.isArray(p))
                throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: params must be an object");
            if (f.method === "initialized" && id === null) {
                if (this.state !== "initialized")
                    throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: invalid initialized notification");
                // AS send serializes its own frames. Mark ready before awaiting so a
                // native startup burst can queue immediately behind initialized.
                this.state = "ready";
                this.restoring = this.client.notifyInitialized().then(() => this.restore());
                await this.restoring;
                return;
            }
            if (id === null)
                throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: request ID required");
            if (f.method === "initialize") {
                if (this.state !== "new")
                    throw new ProtocolError(ErrorCode.invalid_request, "as-ingress: already initialized");
                if (typeof p.clientInfo?.name !== "string" || typeof p.clientInfo?.version !== "string")
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: clientInfo required");
                if (p.capabilities?.requestAttestation === true)
                    throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: attestation unavailable");
                const optOut = p.capabilities?.optOutNotificationMethods;
                if (optOut != null && (!Array.isArray(optOut) || optOut.some((v) => typeof v !== "string")))
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid notification opt-outs");
                this.optOut = new Set(optOut ?? []);
                this.state = "initializing";
                const result = await this.control.initialize();
                await this.client.request("initialize", { protocolVersion: "as/1", token: this.options.token,
                    client: { name: "codex-tui", version: p.clientInfo.version, kind: "tui", label: `codex-tui:${this.client.clientId}` },
                    capabilities: { pendingRequests: true, engineEvents: true, bashInput: false, serverRequests: ServerRequestMethodSchema.options },
                });
                const version = String(result.userAgent ?? "").match(/^[^\s/]+\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1];
                if (version !== CODEX_SCHEMA_VERSION) {
                    const message = `Codex version ${version ?? "unknown"} differs from pinned schema ${CODEX_SCHEMA_VERSION}`;
                    this.options.audit?.(message);
                    this.send({ method: "warning", params: { message } });
                }
                if (this.client.closed)
                    return;
                this.state = "initialized";
                this.send({ id, result });
                return;
            }
            if (this.state !== "ready")
                throw new ProtocolError(ErrorCode.not_initialized, "as-ingress: initialize and initialized required");
            await this.restoring;
            const result = await this.router.request(f.method, p);
            this.send({ id, result });
            if (f.method === "thread/resume" && result.thread?.id) {
                const thread = this.router.server.log.findEngine(result.thread.id, "codex");
                const engine = thread && this.router.server.threads.live.get(thread.id);
                if (engine instanceof CodexEngine)
                    for (const call of engine.nativeToolCalls.values())
                        this.forwardTool(engine, call.frame);
            }
        }
        catch (error) {
            const rpc = rpcError(error);
            if (!this.client.closed && typeof f?.method === "string") {
                // Durable audit omits arbitrary params, paths, tokens and tool contents.
                this.router.server.log.db.query("INSERT INTO ingress_audit(created_at,client_id,method,thread_id,code,reason) VALUES (?,?,?,?,?,?)")
                    .run(Date.now(), this.client.clientId, f.method.slice(0, 256), typeof f.params?.threadId === "string" ? f.params.threadId.slice(0, 128) : null, error instanceof NativeRpcError ? error.code : rpc.code, "native_request_rejected");
            }
            if (error instanceof NativeRpcError) {
                this.send({ id, error: { code: error.code, message: error.message, ...(error.data !== undefined ? { data: error.data } : {}) } });
                return;
            }
            this.send({ id, error: { ...rpc, message: `${rpc.message.startsWith("as-ingress: ") ? "" : "as-ingress: "}${rpc.message}${rpc.data?.holder ? ` (holder: ${rpc.data.holder.label})` : ""}` } });
            if (this.state === "initializing") {
                this.close();
                this.options.end?.();
            }
        }
    }
    fromAS(frame) {
        if (!("method" in frame)) {
            if (frame.id !== null && this.reverse.has(frame.id) && "error" in frame)
                this.send({ id: frame.id, error: frame.error });
            return;
        }
        const p = frame.params;
        if (!this.router.claudeThreads && p.threadId) {
            if (p.backend === "claude" || findClaudeThread(this.router.server, p.threadId))
                return;
        }
        if ("id" in frame) {
            const method = ServerRequestMethodSchema.safeParse(frame.method);
            if (!method.success)
                return;
            const thread = this.router.server.threads.get(p.threadId);
            let raw;
            try {
                raw = thread.backend === "claude" ? claudeApproval(method.data, p, thread) : p.data?.raw;
            }
            catch (error) {
                const rpc = rpcError(error);
                this.send({ method: "error", params: { threadId: nativeThreadId(thread), turnId: p.turnId, error: { message: rpc.message, codexErrorInfo: null, additionalDetails: `JSON-RPC ${rpc.code}; requestId=${p.requestId}` }, willRetry: false } });
                // This connection cannot display the request. Do not decide/expire it
                // on behalf of other attached clients; the AS broker remains authority.
                return;
            }
            if (!raw || typeof raw !== "object")
                return;
            this.reverse.set(frame.id, { method: method.data, requestId: p.requestId, ...(thread.backend === "claude" ? { claudeParams: structuredClone(p) } : {}) });
            this.logical.set(p.requestId, frame.id);
            const params = structuredClone(raw);
            if (method.data === "item/commandExecution/requestApproval" || method.data === "item/fileChange/requestApproval") {
                const supported = ["accept", "acceptForSession", "decline", "cancel"];
                params.availableDecisions = Array.isArray(raw.availableDecisions) ? raw.availableDecisions.filter((d) => typeof d === "string" && supported.includes(d)) : supported;
            }
            this.send({ id: frame.id, method: thread.backend === "claude" && claudeToolPermission(method.data, p) ? "item/tool/requestUserInput" : method.data, params });
            return;
        }
        if (frame.method === "thread/engineEvent" && p.backend === "codex" && typeof p.payload?.method === "string") {
            if (p.payload.method === "item/tool/call" && p.payload.id != null) {
                const engine = this.router.server.threads.live.get(p.threadId);
                if (engine instanceof CodexEngine)
                    this.forwardTool(engine, p.payload);
                return;
            }
            // Broker owns card closure; engine request IDs are process-local and collide.
            if (p.payload.method !== "serverRequest/resolved")
                this.send(p.payload);
        }
        else if (frame.method === "serverRequest/resolved" || frame.method === "serverRequest/expired") {
            const id = this.logical.get(p.requestId);
            if (id === undefined)
                return;
            const thread = this.router.server.threads.get(p.threadId);
            this.send({ method: "serverRequest/resolved", params: { threadId: nativeThreadId(thread), requestId: id, ...(p.decidedBy ? { decidedBy: p.decidedBy } : {}), ...(p.reason ? { reason: p.reason } : {}) } });
            this.logical.delete(p.requestId);
            this.reverse.delete(id);
        }
        else if (frame.method === "thread/metadata/updated" && typeof p.title === "string") {
            const thread = this.router.server.threads.get(p.threadId);
            this.send({ method: "thread/name/updated", params: { threadId: nativeThreadId(thread), threadName: p.title } });
        }
        else if (frame.method === "error") {
            // CodexEventMapper also projects each native error into AS. Its raw error
            // object identifies that projection; the original frame was sent above.
            if (p.error.code === ErrorCode.engine_unavailable && p.error.data?.raw?.message === p.error.message)
                return;
            const thread = p.threadId ? this.router.server.threads.get(p.threadId) : undefined;
            this.send({ method: "error", params: { ...(thread ? { threadId: nativeThreadId(thread) } : {}), ...(p.turnId ? { turnId: p.turnId } : {}), error: { message: p.error.message, codexErrorInfo: null, additionalDetails: null }, willRetry: p.willRetry } });
        }
        else if (p.threadId && frame.method !== "thread/engineEvent") {
            const thread = this.router.server.threads.get(p.threadId);
            if (thread.backend === "claude") {
                const needsItems = ["turn/started", "turn/completed", "item/subAgent/progress"].includes(frame.method);
                const frames = claudeNotification(frame.method, p, thread, frame.method === "thread/tokenUsage/updated" ? this.router.server.log.turns(thread.id) : [], needsItems ? this.router.server.log.snapshot(thread.id).items : []);
                for (const native of frames)
                    this.send(native);
            }
        }
    }
    parseError() { this.send({ id: null, error: { code: ErrorCode.parse, message: "as-ingress: invalid JSON" } }); }
    forwardTool(engine, frame) {
        if (this.state !== "ready" || !engine.claimNativeToolCall(frame.id, this.client.clientId))
            return;
        const id = `tui_tool_${crypto.randomUUID()}`;
        this.localTools.set(id, { engine, nativeId: frame.id });
        this.send({ ...frame, id });
    }
    async restore() {
        const records = detached.get(this.router.server), previous = records?.get(this.options.token);
        if (!previous)
            return;
        records.delete(this.options.token);
        // Close old connection-scoped cards even if another client decided while
        // offline. AS attach below is the sole producer of new pending requests.
        for (const [id, requestId] of previous.pending) {
            const row = this.router.server.log.approval(requestId);
            if (!row)
                continue;
            const thread = this.router.server.threads.get(row.thread_id);
            if (thread.backend === "claude" && !this.router.claudeThreads)
                continue;
            this.send({ method: "serverRequest/resolved", params: { threadId: nativeThreadId(thread), requestId: id,
                    ...(row.decided_by ? { decidedBy: JSON.parse(row.decided_by) } : {}), reason: row.status === "pending" ? "reconnected" : row.status } });
        }
        for (const threadId of previous.threads) {
            if (this.client.closed)
                break;
            try {
                await this.router.reattach(threadId);
                const engine = this.router.server.threads.live.get(threadId);
                if (engine instanceof CodexEngine)
                    for (const call of engine.nativeToolCalls.values())
                        this.forwardTool(engine, call.frame);
            }
            catch (error) {
                const message = `as-ingress: reconnect attach failed: ${String(error)}`;
                this.options.audit?.(message);
                this.send({ method: "warning", params: { message } });
            }
        }
    }
    close() {
        if (this.state === "closed")
            return;
        if (this.router.attached.size) {
            let records = detached.get(this.router.server);
            if (!records) {
                records = new Map();
                detached.set(this.router.server, records);
            }
            const record = records.get(this.options.token) ?? { threads: new Set(), pending: new Map() };
            for (const threadId of this.router.attached)
                record.threads.add(threadId);
            for (const [id, request] of this.reverse)
                record.pending.set(id, request.requestId);
            records.set(this.options.token, record);
        }
        this.state = "closed";
        this.abort.abort();
        this.unsubscribe?.();
        this.unclose?.();
        this.client.close();
        this.reverse.clear();
        this.logical.clear();
        for (const engine of new Set([...this.localTools.values()].map(call => call.engine)))
            engine.releaseNativeToolCalls(this.client.clientId);
        this.localTools.clear();
    }
}
