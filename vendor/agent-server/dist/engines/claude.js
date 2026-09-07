import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { EventType, resolveClaudeModel } from "@smokingmouse/agent";
import { ClaudeEffortSchema, ErrorCode, PermissionSchema, ProtocolError } from "../protocol/index.js";
import { AsyncQueue } from "./session.js";
import { ClaudeEventMapper, jsonValue, mapPermissionDecision, mapPermissionRequest, record } from "./claude-mapper.js";
// Local Claude Code 2.1.258 bin/claude.exe: print.ts d.request.subtype dispatch.
// Default deny: auth, initialization, settings, remote plumbing and lifecycle controls
// either need a native UI or would desynchronize the daemon's ownership/allowed_roots.
export const CLAUDE_CONTROL_ALLOWLIST = new Set([
    "set_model", "set_permission_mode", "set_max_thinking_tokens", "list_models",
    "file_suggestions", "read_file", "get_workspace_diff", "get_plan",
    "get_context_usage", "get_session_cost", "get_usage", "get_settings", "get_binary_version",
    "mcp_status", "mcp_reconnect", "mcp_toggle", "interrupt",
    "rewind_conversation", "rewind_files", "seed_read_state", "background_tasks", "stop_task",
    "reload_plugins", "reload_skills", "side_question",
]);
export function claudePermission(permission = "default") {
    return permission === "full" ? "bypassPermissions" : permission === "auto-edit" ? "acceptEdits" : permission === "readonly" ? "default" : permission;
}
export function buildClaudeLaunch(options) {
    validateClaudeEffort(options.effort);
    if (options.sandbox !== undefined)
        throw new ProtocolError(ErrorCode.unsupported_capability, "Claude sandbox override is not supported");
    const resolved = resolveClaudeModel(options.model);
    const args = ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--permission-prompt-tool", "stdio", "--settings", JSON.stringify({ permissions: { ask: ["*"] } })];
    if (resolved.model)
        args.push("--model", resolved.model);
    if (options.effort !== undefined)
        args.push("--effort", options.effort);
    if (options.autocompact !== undefined)
        args.push("--autocompact", String(options.autocompact));
    args.push("--include-hook-events", "--forward-subagent-text");
    if (options.engineThreadId)
        args.push("--resume", options.engineThreadId);
    if (options.forkSession && options.engineThreadId)
        args.push("--fork-session");
    if (options.systemPrompt)
        args.push("--system-prompt", options.systemPrompt);
    if (options.tools && options.tools !== "all")
        args.push("--tools", options.tools.join(","));
    const permission = options.permission ?? "default";
    if (permission === "full" || permission === "bypassPermissions")
        args.push("--dangerously-skip-permissions");
    args.push("--permission-mode", claudePermission(permission));
    // 2.1.258 PLe checks isBypassPermissionsModeAvailable on a live switch.
    // This flag permits switching later; it does not select bypass at launch.
    if (permission === "full" || permission === "bypassPermissions")
        args.push("--allow-dangerously-skip-permissions");
    if (permission === "readonly")
        args.push("--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit");
    const env = { ...process.env };
    delete env.CLAUDECODE;
    // The shared resolver owns endpoint routing; ambient proxy settings cannot override it.
    for (const key of ["ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL", "ANTHROPIC_DEFAULT_HAIKU_MODEL"])
        delete env[key];
    return { args, env: { ...env, ...resolved.env } };
}
export function validateClaudeEffort(effort) {
    if (effort !== undefined && !ClaudeEffortSchema.safeParse(effort).success)
        throw new ProtocolError(ErrorCode.invalid_params, "Claude effort must be low, medium, high, xhigh or max");
}
export function claudeUserMessage(input) {
    const content = input.map(part => {
        if (part.type === "bash")
            throw new ProtocolError(ErrorCode.invalid_params, "bash must be a standalone turn input");
        if (part.type === "text")
            return part;
        if (part.type === "image")
            return { type: "image", source: { type: "base64", media_type: part.mime, data: readFileSync(part.path).toString("base64") } };
        // File references are local paths, as required by AS v1; CLI file tools read them.
        return { type: "text", text: `Attached file${part.name ? ` (${part.name})` : ""}: ${part.path}` };
    });
    return { type: "user", message: { role: "user", content } };
}
export class ClaudeEngine {
    config;
    backend = "claude";
    events = new AsyncQueue();
    engineThreadId = null;
    process;
    options;
    mapper = new ClaudeEventMapper();
    active = null;
    interrupting = false;
    closed = false;
    dead = false;
    stderr = "";
    buffer = "";
    context = null;
    controls = new Map();
    taskParents = new Map();
    sessionGrants = new Set();
    nativeRequests = new Map();
    sawTextDelta = false;
    sawThinkingDelta = false;
    partials = new Map();
    bash;
    constructor(config = {}) {
        this.config = config;
    }
    async spawn(options) {
        this.options = options;
        this.mapper = new ClaudeEventMapper(options.cwd);
        const launch = buildClaudeLaunch(options);
        this.process = (this.config.spawnProcess ?? ((command, args, opts) => spawn(command, args, { ...opts, stdio: "pipe" })))(this.config.executable ?? "claude", launch.args, { cwd: options.cwd, env: launch.env });
        this.process.stdout.setEncoding("utf8");
        this.process.stderr.setEncoding("utf8");
        this.process.stderr.on("data", (chunk) => { this.stderr = (this.stderr + chunk).slice(-4000); });
        this.process.stdout.on("data", (chunk) => {
            this.buffer += chunk;
            let newline;
            while ((newline = this.buffer.indexOf("\n")) >= 0) {
                const line = this.buffer.slice(0, newline).trim();
                this.buffer = this.buffer.slice(newline + 1);
                if (!line || this.dead)
                    continue;
                try {
                    this.receive(JSON.parse(line));
                }
                catch (error) {
                    this.fail(new ProtocolError(ErrorCode.engine_protocol_error, String(error), { raw: line.slice(0, 2000) }));
                }
            }
        });
        this.process.on("error", error => this.fail(new ProtocolError(ErrorCode.engine_unavailable, error.message, { stderr: this.stderr })));
        this.process.stdin.on("error", error => this.fail(new ProtocolError(ErrorCode.engine_unavailable, error.message, { stderr: this.stderr })));
        this.process.on("close", code => {
            if (!this.closed)
                this.fail(new ProtocolError(ErrorCode.engine_unavailable, `Claude exited (${code})`, { stderr: this.stderr, retryable: true }));
            else
                this.events.end();
        });
        try {
            await this.control({ subtype: "initialize", hooks: {} });
        }
        catch (error) {
            this.fail(error instanceof ProtocolError ? error : new ProtocolError(ErrorCode.engine_unavailable, String(error), { stderr: this.stderr }));
            throw error;
        }
    }
    async attach() { this.assertAlive(); }
    async engineControl(subtype, params) {
        this.assertAlive();
        if (!CLAUDE_CONTROL_ALLOWLIST.has(subtype))
            throw new ProtocolError(ErrorCode.unsupported_capability, `Claude control is not allowed: ${subtype}`);
        if ("subtype" in params)
            throw new ProtocolError(ErrorCode.invalid_params, "params must not override subtype");
        if (subtype === "set_permission_mode") {
            if (typeof params.mode !== "string" || !["default", "acceptEdits", "plan", "bypassPermissions", "dontAsk"].includes(params.mode))
                throw new ProtocolError(ErrorCode.invalid_params, "unsupported permission mode");
            if (params.ultraplan !== undefined && typeof params.ultraplan !== "boolean")
                throw new ProtocolError(ErrorCode.invalid_params, "ultraplan must be boolean");
        }
        const interrupting = this.interrupting;
        if (subtype === "interrupt" && this.active)
            this.interrupting = true;
        try {
            const frame = await this.control({ ...params, subtype }, true);
            if (record(frame.response).subtype === "success") {
                if (subtype === "set_permission_mode") {
                    const mode = PermissionSchema.safeParse(record(record(frame.response).response).mode ?? params.mode);
                    if (mode.success)
                        this.permissionChanged(mode.data);
                }
                if (subtype === "set_model" && this.options && (params.model == null || typeof params.model === "string")) {
                    // 2.1.258 Tf/Im: omitted or null model is the native "default" reset.
                    this.options.model = params.model ?? "default";
                    this.events.push({ type: "modelChanged", model: this.options.model });
                }
            }
            if (record(frame.response).subtype !== "success" && subtype === "interrupt")
                this.interrupting = interrupting;
            return frame;
        }
        catch (error) {
            if (subtype === "interrupt")
                this.interrupting = interrupting;
            throw error;
        }
    }
    permissionChanged(permission) {
        if (this.options)
            this.options.permission = permission;
        this.sessionGrants.clear();
        this.events.push({ type: "permissionChanged", permission });
    }
    async setPermission(permission) {
        if (permission === "readonly") {
            if (this.options?.permission === "readonly")
                return;
            throw new ProtocolError(ErrorCode.unsupported_capability, "readonly is a launch-time tool restriction; use a native permission mode for hot switching");
        }
        const response = await this.engineControl("set_permission_mode", { mode: claudePermission(permission) });
        if (record(response.response).subtype !== "success")
            throw new ProtocolError(ErrorCode.unsupported_capability, String(record(response.response).error ?? "Claude rejected permission mode"), { raw: response });
    }
    assertAlive() { if (!this.process || this.dead || this.closed)
        throw new ProtocolError(ErrorCode.engine_unavailable, "Claude session is not alive"); }
    validateTurn(options) {
        validateClaudeEffort(options.effort);
        if (options.permission === "readonly" && this.options?.permission !== "readonly")
            throw new ProtocolError(ErrorCode.unsupported_capability, "readonly requires a new session; native permission modes support hot switching");
        if (options.input.some(p => p.type === "bash") && (options.input.length !== 1 || options.input[0].type !== "bash"))
            throw new ProtocolError(ErrorCode.invalid_params, "bash must be a standalone turn input");
        if ((options.cwd !== undefined && options.cwd !== this.options?.cwd) || options.sandbox !== undefined)
            throw new ProtocolError(ErrorCode.unsupported_capability, "Changing cwd or sandbox on a live Claude session is not supported");
        if (options.effort !== undefined && options.effort !== this.options?.effort)
            throw new ProtocolError(ErrorCode.unsupported_capability, "Use thread/effort/set with maxThinkingTokens for live Claude thinking budget; effort labels are launch-only");
        if (options.model && options.model !== this.options?.model && resolveClaudeModel(options.model).env)
            throw new ProtocolError(ErrorCode.unsupported_capability, "Changing endpoint requires a new Claude session");
    }
    async sendTurn(turnId, input, options) {
        this.assertAlive();
        this.validateTurn(options);
        if (this.active)
            throw new ProtocolError(ErrorCode.turn_not_active, "Claude already has an active turn");
        const bash = input.length === 1 && input[0].type === "bash" ? input[0] : undefined;
        // Local 2.1.258 print.ts: if(d.type==="bash_command") invokes
        // runHeadlessBashCommand({command:d.command,cwd:d.cwd,...}), then emits user
        // isReplay frames containing bash-input followed by bash-stdout/stderr/exit-code.
        // It does NOT emit result. uuid is a native UUID (not an AS turn id).
        const message = bash ? { type: "bash_command", command: bash.command, cwd: this.options?.cwd ?? process.cwd(), uuid: crypto.randomUUID() } : claudeUserMessage(input);
        if (options.permission && claudePermission(options.permission) !== claudePermission(this.options?.permission))
            await this.setPermission(options.permission);
        const model = options.model ?? this.options?.model;
        if (model)
            await this.control({ subtype: "set_model", model: resolveClaudeModel(model).model });
        this.active = turnId;
        this.interrupting = false;
        this.context = null;
        this.sawTextDelta = false;
        this.sawThinkingDelta = false;
        this.mapper.beginTurn(turnId);
        this.partials.clear();
        this.taskParents.clear();
        this.bash = undefined;
        if (bash) {
            this.bash = { itemId: `bash_${crypto.randomUUID()}` };
            this.emit({ type: EventType.ToolCall, data: { id: this.bash.itemId, name: "Bash", input: { command: bash.command } }, backend: "claude", sessionId: this.engineThreadId });
        }
        this.write(message);
    }
    async steer(turnId, input) {
        this.assertAlive();
        if (this.active !== turnId || this.interrupting)
            throw new ProtocolError(ErrorCode.turn_not_active, "turn changed before steer");
        if (this.bash || input.some(p => p.type === "bash"))
            throw new ProtocolError(ErrorCode.invalid_params, "bash is only supported as a standalone turn/start");
        this.write(claudeUserMessage(input));
    }
    async interrupt(turnId) {
        this.assertAlive();
        if (this.active !== turnId)
            throw new ProtocolError(ErrorCode.turn_not_active, "turn is not active");
        this.interrupting = true;
        // Wait for the native result before the queue starts another turn.
        try {
            await this.control({ subtype: "interrupt" });
        }
        catch (error) {
            this.fail(new ProtocolError(ErrorCode.engine_unavailable, String(error)));
            throw error;
        }
    }
    async close(_reason) {
        if (this.closed)
            return;
        this.closed = true;
        this.rejectControls(new Error("Claude session closed"));
        const child = this.process;
        if (child && child.exitCode === null && child.signalCode === null) {
            await new Promise(resolve => {
                const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 1000);
                child.once("close", () => { clearTimeout(timeout); resolve(); });
                child.stdin.end();
                child.kill("SIGTERM");
            });
        }
        this.events.end();
    }
    write(message) { this.assertAlive(); this.process.stdin.write(JSON.stringify(message) + "\n"); }
    control(request, raw = false) {
        const request_id = `as_control_${crypto.randomUUID()}`;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => { this.controls.delete(request_id); reject(new ProtocolError(ErrorCode.engine_unavailable, `Claude ${request.subtype} timed out`, { stderr: this.stderr })); }, this.config.handshakeTimeoutMs ?? 15000);
            this.controls.set(request_id, { resolve, reject, timer, raw });
            try {
                this.write({ type: "control_request", request_id, request });
            }
            catch (error) {
                clearTimeout(timer);
                this.controls.delete(request_id);
                reject(error);
            }
        });
    }
    rejectControls(error) { for (const p of this.controls.values()) {
        clearTimeout(p.timer);
        p.reject(error);
    } this.controls.clear(); }
    fail(error) {
        if (this.dead || this.closed)
            return;
        this.dead = true;
        this.rejectControls(error);
        this.events.push({ type: "exit", error: error.toJSON() });
        this.events.end();
        this.process?.kill("SIGKILL");
    }
    emit(event) { for (const mapped of this.mapper.map(event))
        this.events.push(mapped); }
    /** Native frame parsing is separated from process creation for offline fixtures. */
    receive(raw) {
        const obj = record(raw), t = obj.type;
        const emit = (type, data) => this.emit({ type, data, backend: "claude", sessionId: this.engineThreadId });
        if (t === "control_response") {
            const response = record(obj.response), pending = this.controls.get(String(response.request_id));
            if (pending) {
                clearTimeout(pending.timer);
                this.controls.delete(String(response.request_id));
                if (pending.raw || response.subtype === "success")
                    pending.resolve(jsonValue(obj));
                else
                    pending.reject(new ProtocolError(ErrorCode.engine_unavailable, String(response.error ?? "Claude control failed"), { stderr: this.stderr }));
            }
            return;
        }
        if (t === "control_request") {
            const subtype = record(obj.request).subtype;
            if (subtype === "prompt_suggestion")
                return;
            if (subtype !== "can_use_tool" || !this.active || !this.options) {
                const message = `Unsupported Claude control request: ${String(subtype)}`;
                // Local @anthropic-ai/claude-code 2.1.258 bin/claude.exe (rg -a):
                // bJe: behavior enum [completed,cancelled]; gAn: action enum [accept,decline,cancel].
                // can_use_tool deny schema requires behavior:"deny", message:string.
                // hae/ul: control_response.response = {subtype:"error",request_id,error:string}
                // for unknown requests. Use dialog cancellation: parked dialogs ignore error replies.
                const response = subtype === "can_use_tool" ? { behavior: "deny", message }
                    : subtype === "request_user_dialog" ? { behavior: "cancelled" }
                        : subtype === "elicitation" ? { action: "cancel" } : undefined;
                if (typeof obj.request_id === "string") {
                    this.write({ type: "control_response", response: response === undefined
                            ? { subtype: "error", request_id: obj.request_id, error: message }
                            : { subtype: "success", request_id: obj.request_id, response } });
                }
                this.events.push({ type: "error", error: new ProtocolError(ErrorCode.engine_protocol_error, message).toJSON(), willRetry: false });
                return;
            }
            const req = { requestId: String(obj.request_id), toolUseId: String(obj.request.tool_use_id), toolName: String(obj.request.tool_name), input: obj.request.input };
            emit(EventType.ToolCall, { id: req.toolUseId, name: req.toolName, input: req.input });
            const grantKey = JSON.stringify([req.toolName, req.input]);
            let cancelled = false;
            const respond = (decision) => {
                this.nativeRequests.delete(req.requestId);
                if (this.dead || this.closed || cancelled)
                    return;
                if ("decision" in decision && decision.decision === "acceptForSession")
                    this.sessionGrants.add(grantKey);
                this.write({ type: "control_response", response: { subtype: "success", request_id: req.requestId, response: mapPermissionDecision(req, decision) } });
                if ("decision" in decision && decision.decision === "abort" && this.active)
                    void this.interrupt(this.active).catch(error => this.fail(new ProtocolError(ErrorCode.engine_unavailable, String(error))));
            };
            if (this.sessionGrants.has(grantKey))
                respond({ decision: "accept" });
            else {
                const requestId = `ar_${crypto.randomUUID()}`;
                this.nativeRequests.set(req.requestId, { requestId, turnId: this.active, cancel: () => { cancelled = true; } });
                this.events.push({ type: "approval", request: mapPermissionRequest({ ...req, requestId }, this.options.threadId, this.active, this.options.cwd ?? process.cwd()), respond });
            }
            return;
        }
        if (t === "control_cancel_request") {
            const pending = this.nativeRequests.get(String(obj.request_id));
            if (pending) {
                pending.cancel();
                this.nativeRequests.delete(String(obj.request_id));
                this.events.push({ type: "approvalExpired", turnId: pending.turnId, requestId: pending.requestId, reason: "engine_cancelled" });
            }
            return;
        }
        if (typeof obj.session_id === "string" && obj.session_id !== this.engineThreadId) {
            this.engineThreadId = obj.session_id;
            this.events.push({ type: "metadata", engineThreadId: this.engineThreadId });
        }
        if (t === "system") {
            this.events.push({ type: "engineEvent", ...(this.active ? { turnId: this.active } : {}), backend: this.backend, subtype: String(obj.subtype ?? "system"), payload: jsonValue(obj) });
            if (obj.subtype === "init")
                return;
            const phase = { task_started: "started", task_progress: "progress", task_updated: "updated", task_notification: "completed" };
            if (phase[obj.subtype]) {
                if (obj.tool_use_id)
                    this.taskParents.set(obj.task_id, obj.tool_use_id);
                const parent = obj.tool_use_id ?? this.taskParents.get(obj.task_id);
                if (parent)
                    emit(EventType.Task, { ...jsonValue(obj), taskType: obj.task_type, taskId: obj.task_id, toolUseId: parent, phase: phase[obj.subtype], summary: obj.summary });
            }
            else if (obj.subtype === "compact_boundary" && this.active) {
                const item = { id: `it_${crypto.randomUUID()}`, type: "contextCompaction", payload: {} };
                this.events.push({ type: "itemStarted", turnId: this.active, item: { ...item, status: "inProgress" } });
                this.events.push({ type: "itemCompleted", turnId: this.active, item: { ...item, status: "completed" } });
            }
            return;
        }
        if (t === "stream_event") {
            const delta = obj.event?.delta;
            if (obj.parent_tool_use_id) {
                const parent = String(obj.parent_tool_use_id), seen = this.partials.get(parent) ?? { text: false, thinking: false };
                if (delta?.type === "text_delta") {
                    seen.text = true;
                    emit(EventType.TextChunk, { text: delta.text, parentToolUseId: parent });
                }
                if (delta?.type === "thinking_delta") {
                    seen.thinking = true;
                    emit(EventType.Thinking, { text: delta.thinking, parentToolUseId: parent });
                }
                this.partials.set(parent, seen);
                return;
            }
            if (delta?.type === "text_delta") {
                this.sawTextDelta = true;
                emit(EventType.TextChunk, { text: delta.text });
            }
            if (delta?.type === "thinking_delta") {
                this.sawThinkingDelta = true;
                emit(EventType.Thinking, { text: delta.thinking });
            }
            return;
        }
        if (t === "assistant") {
            if (obj.parent_tool_use_id) {
                // 2.1.258 --forward-subagent-text emits assistant/user envelopes with this parent.
                const parent = String(obj.parent_tool_use_id), seen = this.partials.get(parent);
                for (const block of obj.message?.content ?? []) {
                    if (block.type === "text" && !seen?.text && block.text)
                        emit(EventType.TextChunk, { text: block.text, parentToolUseId: parent });
                    if (block.type === "thinking" && !seen?.thinking && block.thinking)
                        emit(EventType.Thinking, { text: block.thinking, parentToolUseId: parent });
                    if (block.type === "tool_use")
                        emit(EventType.ToolCall, { id: block.id, name: block.name, input: block.input, parentToolUseId: parent });
                }
                this.partials.delete(parent);
                return;
            }
            const u = obj.message?.usage;
            if (u)
                this.context = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
            for (const block of obj.message?.content ?? []) {
                if (block.type === "tool_use")
                    emit(EventType.ToolCall, { id: block.id, name: block.name, input: block.input, parentToolUseId: obj.parent_tool_use_id });
                // Some compatible endpoints omit partials or return an empty result string.
                if (block.type === "text" && !this.sawTextDelta && block.text)
                    emit(EventType.TextChunk, { text: block.text });
                if (block.type === "thinking" && !this.sawThinkingDelta && block.thinking)
                    emit(EventType.Thinking, { text: block.thinking });
            }
            this.sawTextDelta = false;
            this.sawThinkingDelta = false;
            return;
        }
        if (t === "user") {
            if (this.bash && this.active && !obj.parent_tool_use_id && obj.isReplay === true && typeof obj.message?.content === "string") {
                const content = obj.message.content;
                const field = (tag) => content.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`))?.[1];
                const decode = (text) => text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#(?:39|x27);/g, "'").replace(/&amp;/g, "&");
                const code = field("bash-exit-code"), stderr = field("bash-stderr");
                if (code !== undefined || stderr?.startsWith("Command failed:")) {
                    const exitCode = code !== undefined && /^-?\d+$/.test(code) ? Number(code) : 1;
                    emit(EventType.ToolCallDone, { id: this.bash.itemId, output: decode(field("bash-stdout") ?? ""), stderr: decode(stderr ?? ""), exitCode, isError: exitCode !== 0 });
                    this.bash = undefined;
                    this.active = null;
                    for (const event of this.mapper.finish(this.interrupting ? "interrupted" : "completed"))
                        this.events.push(event);
                }
                return;
            }
            if (typeof obj.message?.content === "string")
                return; // Native replay text, not tool_result blocks.
            if (!this.active) {
                if ((obj.message?.content ?? []).some((block) => block.type === "tool_result")) {
                    this.events.push({ type: "error", error: new ProtocolError(ErrorCode.engine_protocol_error, "tool result without active turn").toJSON(), willRetry: false });
                }
                return;
            }
            for (const block of obj.message?.content ?? [])
                if (block.type === "tool_result") {
                    const output = obj.tool_use_result?.stdout || (typeof block.content === "string" ? block.content : (block.content ?? []).map((b) => b.text ?? "").join("\n"));
                    emit(EventType.ToolCallDone, { id: block.tool_use_id, output, stderr: obj.tool_use_result?.stderr, exitCode: obj.tool_use_result?.exitCode ?? obj.tool_use_result?.exit_code, isError: Boolean(block.is_error) });
                }
            return;
        }
        if (t === "result") {
            if (!this.active)
                throw new ProtocolError(ErrorCode.engine_protocol_error, "Result without active turn");
            this.active = null;
            if (this.interrupting) {
                for (const event of this.mapper.finish("interrupted"))
                    this.events.push(event);
                return;
            }
            if (obj.is_error) {
                emit(EventType.Error, { message: obj.result || obj.subtype || this.stderr || "Claude turn failed" });
                return;
            }
            const u = obj.usage ?? {};
            const cost = { usd: obj.total_cost_usd ?? null, inputTokens: u.input_tokens ?? 0, outputTokens: u.output_tokens ?? 0, cachedTokens: u.cache_read_input_tokens ?? 0, cacheCreation: u.cache_creation_input_tokens ?? 0, estimated: false, contextTokens: this.context ?? (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) };
            emit(EventType.Result, { text: obj.result, cost });
            return;
        }
        if (t === "error") {
            this.fail(new ProtocolError(ErrorCode.engine_unavailable, String(obj.message ?? obj.error ?? "Claude error")));
            return;
        }
        // 2.1.258 Ase schema emits prompt_suggestion as a top-level informational frame.
        if (t === "rate_limit_event") {
            this.events.push({ type: "engineEvent", ...(this.active ? { turnId: this.active } : {}), backend: this.backend, subtype: t, payload: jsonValue(obj) });
            return;
        }
        if (["keep_alive", "tool_progress", "tool_use_summary", "auth_status", "prompt_suggestion"].includes(t))
            return;
        if (typeof t === "string") {
            this.events.push({ type: "engineEvent", ...(this.active ? { turnId: this.active } : {}), backend: this.backend, subtype: t, payload: jsonValue(obj) });
            return;
        }
        this.events.push({ type: "error", error: new ProtocolError(ErrorCode.engine_protocol_error, "Claude frame has no string type", { raw: jsonValue(raw) }).toJSON(), willRetry: false });
    }
}
