import { ErrorCode, PendingServerRequestSchema, ProtocolError, ServerRequestSchemas } from "../protocol/index.js";
import { LeaseManager } from "./lease-manager.js";
function defaultDecision(request) {
    return request.method === "item/tool/requestUserInput" ? { answers: {} } : request.method === "item/permissions/requestApproval" ? { permissions: {}, scope: "turn" } : { decision: "reject" };
}
export class ApprovalBroker {
    log;
    clients;
    leases;
    options;
    waiting = new Map();
    orphanTimeoutMs;
    now;
    constructor(log, clients, leases = new LeaseManager(), options = {}) {
        this.log = log;
        this.clients = clients;
        this.leases = leases;
        this.options = options;
        this.orphanTimeoutMs = options.orphanTimeoutMs ?? 30 * 60_000;
        this.now = options.now ?? Date.now;
        // Pending callbacks belonged to the previous process and cannot be resurrected.
        log.db.query("UPDATE approvals SET status='expired',decided_at=?,decision_json=? WHERE status='pending'").run(this.now(), JSON.stringify({ reason: "engine_gone" }));
    }
    audience(request) { return [...this.clients()].filter(c => c.attached.has(request.params.threadId) && c.serverRequests.has(request.method)); }
    create(raw, respond) {
        const request = PendingServerRequestSchema.parse(raw), p = request.params;
        if (this.log.approval(p.requestId)) {
            this.log.publish({ jsonrpc: "2.0", method: "error", params: { threadId: p.threadId, turnId: p.turnId, error: new ProtocolError(ErrorCode.engine_protocol_error, "engine reused requestId", { threadId: p.threadId }).toJSON(), willRetry: false } });
            // Preserve the original card and settle only the duplicate engine callback.
            this.deliver({ request, respond, since: this.now(), orphan: false }, defaultDecision(request));
            return;
        }
        this.log.turn(p.turnId, p.threadId);
        this.log.item(p.threadId, p.itemId);
        this.log.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,created_at) VALUES(?,?,?,?,?,?,'pending',?)").run(p.requestId, p.threadId, p.turnId, p.itemId, request.method, JSON.stringify(request), this.now());
        const audience = this.audience(request);
        const pending = { request, respond, since: this.now(), orphan: !audience.length };
        this.waiting.set(p.requestId, pending);
        this.schedule(pending);
        for (const client of audience)
            client.sendRequest(structuredClone(request));
    }
    clientAttached(client, threadId) {
        for (const pending of this.waiting.values())
            if (pending.request.params.threadId === threadId && client.serverRequests.has(pending.request.method))
                client.sendRequest(structuredClone(pending.request));
        this.audienceChanged();
    }
    audienceChanged() {
        for (const pending of this.waiting.values()) {
            const orphan = !this.audience(pending.request).length;
            if (orphan !== pending.orphan) {
                pending.orphan = orphan;
                pending.since = this.now();
                this.schedule(pending);
            }
        }
    }
    timeout(pending) { return pending.orphan ? this.orphanTimeoutMs : pending.request.method === "item/tool/requestUserInput" && pending.request.params.isBlocking ? Infinity : this.options.timeoutMs ?? 120_000; }
    schedule(pending) {
        if (pending.timer)
            clearTimeout(pending.timer);
        const timeout = this.timeout(pending);
        if (Number.isFinite(timeout)) {
            pending.timer = setTimeout(() => this.sweep(), Math.max(1, Math.min(2 ** 31 - 1, pending.since + timeout - this.now())));
            pending.timer.unref();
        }
    }
    sweep() {
        for (const pending of [...this.waiting.values()]) {
            if (this.now() - pending.since >= this.timeout(pending))
                this.expire(pending.request.params.requestId, pending.orphan ? "orphan_timeout" : "timeout");
            else
                this.schedule(pending);
        }
    }
    answer(requestId, clientId, raw) {
        const row = this.log.approval(requestId);
        if (!row)
            throw new ProtocolError(ErrorCode.invalid_params, "unknown server request");
        if (row.status !== "pending")
            throw new ProtocolError(ErrorCode.already_resolved, "server request already resolved", { threadId: row.thread_id });
        const pending = this.waiting.get(requestId);
        const client = this.audience(pending.request).find(c => c.clientId === clientId);
        if (!client)
            throw new ProtocolError(ErrorCode.unauthorized, "client must be attached and capable", { threadId: row.thread_id });
        this.leases.assertInput(row.thread_id, clientId);
        const result = ServerRequestSchemas[pending.request.method].result.parse(raw);
        if (pending.request.method === "item/tool/requestUserInput" && "answers" in result) {
            const questions = new Set(pending.request.params.questions.map(q => q.id));
            if (Object.keys(result.answers).some(id => !questions.has(id)))
                throw new ProtocolError(ErrorCode.invalid_params, "unknown questionId");
        }
        const decidedBy = { clientId, label: client.label };
        const changed = this.log.db.query("UPDATE approvals SET status='decided',decided_by=?,decision_json=?,decided_at=? WHERE id=? AND status='pending'").run(JSON.stringify(decidedBy), JSON.stringify(result), this.now(), requestId);
        if (!changed.changes)
            throw new ProtocolError(ErrorCode.already_resolved, "server request already resolved");
        this.remove(pending);
        this.log.publish({ jsonrpc: "2.0", method: "serverRequest/resolved", params: { threadId: row.thread_id, requestId, decidedBy, outcome: "decision" in result ? result.decision : result } });
        this.deliver(pending, result);
    }
    remove(pending) { if (pending.timer)
        clearTimeout(pending.timer); this.waiting.delete(pending.request.params.requestId); }
    deliver(pending, result) {
        try {
            void Promise.resolve(pending.respond(result)).catch(error => this.options.onDeliveryError?.(pending.request.params.threadId, error));
        }
        catch (error) {
            this.options.onDeliveryError?.(pending.request.params.threadId, error);
        }
    }
    expire(requestId, reason) {
        const pending = this.waiting.get(requestId);
        if (!pending)
            return;
        const result = defaultDecision(pending.request);
        this.log.db.query("UPDATE approvals SET status='expired',decision_json=?,decided_at=? WHERE id=? AND status='pending'").run(JSON.stringify({ reason, result }), this.now(), requestId);
        this.remove(pending);
        this.log.publish({ jsonrpc: "2.0", method: "serverRequest/expired", params: { threadId: pending.request.params.threadId, requestId, reason } });
        this.deliver(pending, result);
    }
    expireThread(threadId, reason, turnId) { for (const pending of [...this.waiting.values()])
        if (pending.request.params.threadId === threadId && (!turnId || pending.request.params.turnId === turnId))
            this.expire(pending.request.params.requestId, reason); }
    close() { for (const id of [...this.waiting.keys()])
        this.expire(id, "server_closed"); }
}
