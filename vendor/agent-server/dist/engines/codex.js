import { spawn } from "node:child_process";
import { ErrorCode, ProtocolError, ServerRequestMethodSchema } from "../protocol/index.js";
import { AsyncQueue } from "./session.js";
import { CodexEventMapper, codexProtocolError, codexRecord, codexString, codexUserInput, mapCodexDecision, mapCodexRequest } from "./codex-mapper.js";
import { CODEX_SCHEMA_VERSION } from "./codex-version.js";
function sandboxMode(options) {
    const value = options.sandbox ?? (options.permission === "readonly" ? "read-only" : options.permission === "full" ? "danger-full-access" : options.permission ? "workspace-write" : undefined);
    if (value !== undefined && !["read-only", "workspace-write", "danger-full-access"].includes(value))
        throw new ProtocolError(ErrorCode.unsupported_capability, `Unsupported Codex sandbox: ${value}`);
    if (options.permission === "readonly" && value !== "read-only")
        throw new ProtocolError(ErrorCode.invalid_params, "readonly permission requires read-only sandbox");
    return value;
}
function approvalPolicy(permission) {
    if (permission && !["readonly", "full", "auto-edit", "default"].includes(permission))
        throw new ProtocolError(ErrorCode.backend_unsupported, "native Claude permission modes require Claude; use legacy permission aliases for Codex");
    if (permission === undefined)
        return undefined;
    return permission === "readonly" || permission === "full" ? "never" : permission === "auto-edit" ? "on-request" : "untrusted";
}
function checkEffort(effort) {
    if (effort !== undefined && !effort.trim())
        throw new ProtocolError(ErrorCode.invalid_params, "Codex effort must not be empty");
}
export function buildCodexThreadParams(options) {
    if (options.autocompact !== undefined)
        throw new ProtocolError(ErrorCode.backend_unsupported, "autocompact requires Claude");
    if (options.forkSession)
        throw new ProtocolError(ErrorCode.unsupported_capability, "Codex fork is not implemented");
    if (options.tools !== undefined && options.tools !== "all")
        throw new ProtocolError(ErrorCode.unsupported_capability, "Codex app-server does not support an AS tool allowlist");
    checkEffort(options.effort);
    const sandbox = sandboxMode(options), approval = approvalPolicy(options.permission);
    return {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.model !== undefined ? { model: options.model } : {}),
        ...(sandbox ? { sandbox } : {}), ...(approval ? { approvalPolicy: approval } : {}),
        approvalsReviewer: "user", serviceTier: "default",
        ...(options.systemPrompt !== undefined ? { baseInstructions: options.systemPrompt } : {}),
        ...(options.effort !== undefined ? { config: { model_reasoning_effort: options.effort } } : {}),
        ...(options.engineThreadId ? { threadId: options.engineThreadId, excludeTurns: true } : {}),
    };
}
function turnOverrides(options) {
    checkEffort(options.effort);
    const mode = sandboxMode(options), approval = approvalPolicy(options.permission);
    const sandboxPolicy = mode === "read-only" ? { type: "readOnly" } : mode === "workspace-write" ? { type: "workspaceWrite" } : mode === "danger-full-access" ? { type: "dangerFullAccess" } : undefined;
    return {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}), ...(options.model !== undefined ? { model: options.model } : {}),
        ...(options.effort !== undefined ? { effort: options.effort } : {}), ...(approval ? { approvalPolicy: approval } : {}),
        ...(sandboxPolicy ? { sandboxPolicy } : {}), serviceTier: "default", approvalsReviewer: "user",
        ...(options.clientTurnId ? { clientUserMessageId: options.clientTurnId } : {}),
    };
}
/** One app-server process per AS thread; only v2 thread/turn methods use it. */
export class CodexEngine {
    config;
    backend = "codex";
    emitsUserMessages = true;
    emitsTokenUsage = true;
    events = new AsyncQueue();
    engineThreadId = null;
    process;
    options;
    mapper = new CodexEventMapper();
    active;
    pending = new Map();
    approvals = new Map();
    sequence = 0;
    buffer = "";
    stderr = "";
    dead = false;
    closed = false;
    ready = false;
    constructor(config = {}) {
        this.config = config;
    }
    async spawn(options) {
        if (this.process || this.closed || this.dead)
            throw new ProtocolError(ErrorCode.engine_unavailable, "Codex session has already been spawned or closed");
        const params = buildCodexThreadParams(options);
        this.options = options;
        this.mapper = new CodexEventMapper(Boolean(options.engineThreadId));
        try {
            this.process = (this.config.spawnProcess ?? ((command, args, opts) => spawn(command, args, { ...opts, stdio: "pipe" })))(this.config.executable ?? "codex", ["app-server", "--listen", "stdio://"], { cwd: options.cwd, env: { ...process.env } });
            const child = this.process;
            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
            child.stdout.on("data", (chunk) => {
                this.buffer += chunk;
                let index;
                while (!this.dead && !this.closed && (index = this.buffer.indexOf("\n")) >= 0) {
                    const line = this.buffer.slice(0, index).trim();
                    this.buffer = this.buffer.slice(index + 1);
                    if (!line)
                        continue;
                    try {
                        this.receive(JSON.parse(line));
                    }
                    catch (error) {
                        this.fail(error instanceof ProtocolError ? error : codexProtocolError(String(error), line));
                    }
                }
            });
            child.on("error", error => this.fail(this.unavailable(error.message)));
            child.stdin.on("error", error => this.fail(this.unavailable(error.message)));
            child.on("close", (code, signal) => { if (!this.closed)
                this.fail(this.unavailable(`Codex app-server exited (${code ?? signal})`));
            else
                this.events.end(); });
            const initialized = await this.request("initialize", { clientInfo: { name: "sm_agent_server", title: "SM Agent Server", version: "0.1.0" }, capabilities: { experimentalApi: true } });
            this.write({ method: "initialized", params: {} });
            await this.request(options.engineThreadId ? "thread/resume" : "thread/start", params, result => {
                const thread = codexRecord(result.thread);
                const id = codexString(thread.id, "thread id");
                if (options.engineThreadId && id !== options.engineThreadId)
                    throw codexProtocolError("Codex resumed a different thread", result);
                // app-server echoes clientInfo.name in userAgent; the thread is authoritative.
                const version = (typeof thread.cliVersion === "string" ? thread.cliVersion.trim() : "")
                    || String(initialized.userAgent ?? "").match(/^[^\s/]+\/(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)(?=\s|$)/)?.[1];
                if (version !== CODEX_SCHEMA_VERSION)
                    this.events.push({ type: "error", error: codexProtocolError(`Codex version ${version ?? "unknown"} differs from pinned schema ${CODEX_SCHEMA_VERSION}`, { initialized, thread }).toJSON(), willRetry: false });
                this.engineThreadId = id;
                this.events.push({ type: "metadata", engineThreadId: id });
            });
            this.assertAlive();
            this.ready = true;
        }
        catch (error) {
            const failure = error instanceof ProtocolError ? error : this.unavailable(String(error));
            this.fail(failure);
            throw failure;
        }
    }
    async attach() { this.assertReady(); }
    validateTurn(options) { turnOverrides(options); codexUserInput(options.input); }
    async sendTurn(turnId, input, options) {
        this.assertReady();
        this.validateTurn(options);
        if (this.active)
            throw new ProtocolError(ErrorCode.turn_not_active, "Codex already has an active turn");
        const turn = { id: turnId, interrupting: false, buffered: [] };
        this.active = turn;
        this.mapper.beginTurn(turnId);
        this.mapper.registerInput(input, options.clientTurnId);
        try {
            await this.request("turn/start", { threadId: this.engineThreadId, input: codexUserInput(input), ...turnOverrides(options) }, result => this.bindTurn(turn, codexString(codexRecord(result.turn).id, "turn id")));
        }
        catch (error) {
            this.fail(error instanceof ProtocolError ? error : this.unavailable(String(error)));
            throw error;
        }
    }
    async steer(turnId, input, options) {
        const turn = this.assertTurn(turnId);
        this.mapper.registerInput(input, options?.clientTurnId);
        await this.request("turn/steer", { threadId: this.engineThreadId, expectedTurnId: turn.nativeId, input: codexUserInput(input), ...(options?.clientTurnId ? { clientUserMessageId: options.clientTurnId } : {}) });
    }
    async interrupt(turnId) {
        const turn = this.assertTurn(turnId);
        turn.interrupting = true;
        try {
            await this.request("turn/interrupt", { threadId: this.engineThreadId, turnId: turn.nativeId });
        }
        catch (error) {
            turn.interrupting = false;
            throw error;
        }
        // The acknowledgement is not completion. Keep active until turn/completed.
    }
    async close(_reason) {
        if (this.closed)
            return;
        this.closed = true;
        this.ready = false;
        this.rejectPending(this.unavailable("Codex session closed"));
        this.approvals.clear();
        const child = this.process;
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => {
                const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
                child.once("close", () => { clearTimeout(timer); resolve(); });
                child.stdin.end();
                child.kill("SIGTERM");
            });
        }
        this.events.end();
    }
    unavailable(message) { return new ProtocolError(ErrorCode.engine_unavailable, message, { stderr: this.stderr, retryable: true }); }
    assertAlive() { if (!this.process || this.dead || this.closed)
        throw this.unavailable("Codex session is not alive"); }
    assertReady() { this.assertAlive(); if (!this.ready)
        throw this.unavailable("Codex handshake is not complete"); }
    assertTurn(turnId) {
        this.assertReady();
        if (this.active?.id !== turnId || !this.active.nativeId || this.active.interrupting)
            throw new ProtocolError(ErrorCode.turn_not_active, "Codex turn changed or is interrupting");
        return this.active;
    }
    write(frame) {
        this.assertAlive();
        // app-server stdio omits the JSON-RPC version marker (unlike the AS transport).
        this.process.stdin.write(JSON.stringify(frame) + "\n");
    }
    request(method, params, onResult) {
        const id = `as_${++this.sequence}`;
        return new Promise((resolve, reject) => {
            const timeout = this.ready ? this.config.requestTimeoutMs ?? 30_000 : this.config.handshakeTimeoutMs ?? 15_000;
            const timer = setTimeout(() => this.fail(this.unavailable(`Codex ${method} timed out`)), timeout);
            this.pending.set(id, { method, resolve, reject, timer, onResult });
            try {
                this.write({ id, method, params });
            }
            catch (error) {
                clearTimeout(timer);
                this.pending.delete(id);
                reject(error);
            }
        });
    }
    rejectPending(error) { for (const call of this.pending.values()) {
        clearTimeout(call.timer);
        call.reject(error);
    } this.pending.clear(); }
    fail(error) {
        if (this.dead || this.closed)
            return;
        this.dead = true;
        this.ready = false;
        this.approvals.clear();
        this.rejectPending(error);
        this.events.push({ type: "exit", error: error.toJSON() });
        this.events.end();
        this.process?.kill("SIGKILL");
    }
    bindTurn(turn, nativeId) {
        if (turn.nativeId && turn.nativeId !== nativeId)
            throw codexProtocolError("Codex changed the active turn id", nativeId);
        turn.nativeId = nativeId;
        if (this.active === turn)
            for (const frame of turn.buffered.splice(0))
                this.receive(frame);
    }
    /** Public for wire fixtures; production frames arrive only through stdout. */
    receive(raw) {
        if (this.dead || this.closed)
            return;
        const frame = codexRecord(raw), hasId = typeof frame.id === "string" || typeof frame.id === "number";
        if (!frame.method && hasId) {
            const call = this.pending.get(frame.id);
            if (!call)
                throw codexProtocolError("Unexpected Codex response id", raw);
            clearTimeout(call.timer);
            this.pending.delete(frame.id);
            if (frame.error) {
                const native = codexRecord(frame.error);
                call.reject(new ProtocolError(native.code === -32602 ? ErrorCode.invalid_params : call.method === "turn/steer" ? ErrorCode.turn_not_active : ErrorCode.engine_unavailable, String(native.message ?? "Codex request failed"), { raw: JSON.stringify(native).slice(0, 2000), stderr: this.stderr }));
            }
            else if ("result" in frame) {
                try {
                    const result = codexRecord(frame.result);
                    call.onResult?.(result);
                    call.resolve(result);
                }
                catch (error) {
                    call.reject(error instanceof Error ? error : new Error(String(error)));
                    throw error;
                }
            }
            else {
                const error = codexProtocolError("Codex response has no result or error", raw);
                call.reject(error);
                throw error;
            }
            return;
        }
        if (typeof frame.method !== "string")
            throw codexProtocolError("Invalid Codex JSON-RPC frame", raw);
        const method = frame.method, params = codexRecord(frame.params);
        if (hasId && !ServerRequestMethodSchema.safeParse(method).success) {
            this.rejectRequest(frame, codexProtocolError(`Unknown Codex server request: ${method}`, raw));
            return;
        }
        if (params.threadId && this.engineThreadId && params.threadId !== this.engineThreadId) {
            if (hasId)
                this.rejectRequest(frame, codexProtocolError("Codex request belongs to another thread", raw));
            return;
        }
        const nativeTurnId = params.turnId ?? (method === "turn/completed" || method === "turn/started" ? codexRecord(params.turn).id : undefined);
        const emitRaw = () => {
            if (!hasId)
                this.events.push({ type: "engineEvent", ...(this.active && (!nativeTurnId || nativeTurnId === this.active.nativeId) ? { turnId: this.active.id } : {}), backend: this.backend, subtype: method, payload: structuredClone(frame) });
        };
        if (method === "serverRequest/resolved") {
            emitRaw();
            const pending = this.approvals.get(params.requestId);
            if (pending) {
                this.approvals.delete(params.requestId);
                this.events.push({ type: "approvalExpired", ...pending, reason: "engine_resolved" });
            }
            return;
        }
        if (method === "turn/started") {
            emitRaw();
            // The correlated turn/start response owns the ID. Buffer early items until
            // it arrives; a delayed turn/started must not bind a later queued turn.
            return;
        }
        if (nativeTurnId && !this.active?.nativeId && this.active) {
            this.active.buffered.push(frame);
            return;
        }
        emitRaw();
        if (nativeTurnId && nativeTurnId !== this.active?.nativeId) {
            if (hasId)
                this.rejectRequest(frame, codexProtocolError("Codex request belongs to an inactive turn", raw));
            // Usage can also be sent while resuming an idle thread.
            else if (method === "thread/tokenUsage/updated" && !this.active)
                for (const event of this.mapper.map(method, params))
                    this.events.push(event);
            return;
        }
        if (hasId) {
            try {
                this.serverRequest(frame);
            }
            catch (error) {
                this.rejectRequest(frame, error instanceof ProtocolError ? error : codexProtocolError(String(error), raw));
            }
            return;
        }
        const events = this.mapper.map(method, params);
        if (method === "turn/completed") {
            this.active = undefined;
            for (const event of events)
                if (event.type === "turnCompleted")
                    for (const [id, request] of this.approvals)
                        if (request.turnId === event.turnId)
                            this.approvals.delete(id);
        }
        for (const event of events)
            this.events.push(event);
    }
    rejectRequest(frame, error) {
        this.write({ id: frame.id, error: error.toJSON() });
        this.events.push({ type: "error", turnId: this.active?.id, error: error.toJSON(), willRetry: false });
    }
    serverRequest(frame) {
        if (!this.active || !this.options)
            throw codexProtocolError("Codex server request without an active turn", frame);
        if (this.approvals.has(frame.id))
            throw codexProtocolError("Duplicate Codex server request id", frame);
        const method = ServerRequestMethodSchema.parse(frame.method), params = codexRecord(frame.params);
        for (const event of this.mapper.ensureRequestItem(method, params))
            this.events.push(event);
        const requestId = `ar_${crypto.randomUUID()}`, turnId = this.active.id;
        const request = mapCodexRequest(method, params, this.options.threadId, turnId, requestId, this.mapper.getItem(params.itemId));
        this.approvals.set(frame.id, { requestId, turnId });
        this.events.push({ type: "approval", request, respond: result => {
                if (this.dead || this.closed || this.approvals.get(frame.id)?.requestId !== requestId)
                    return;
                const native = mapCodexDecision(method, result);
                this.write({ id: frame.id, result: native });
                this.approvals.delete(frame.id);
            } });
    }
}
