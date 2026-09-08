import { realpathSync } from "node:fs";
import { isAbsolute, relative } from "node:path";
import { CodexEngine } from "../../engines/codex.js";
import { ErrorCode, ProtocolError, UserInputSchema } from "../../protocol/index.js";
import { CONTROL_METHODS } from "./control-process.js";
import { claudeItems, claudeSettings, claudeThread, claudeTurn } from "./claude-projection.js";
import { methodPolicy } from "./method-policy.js";
import { nativePage, pageLimit, turnItemsView } from "./pagination.js";
import { NativeRpcError, nativeResult } from "./native-error.js";
export { NativeRpcError } from "./native-error.js";
export const isClaudeModel = (model) => /^(claude-|sonnet(?:$|-)|opus(?:$|-)|haiku(?:$|-)|fable(?:$|-))/i.test(model);
const claudeModels = ["sonnet", "opus"].map(model => ({ id: model, model, displayName: `Claude · ${model}`, description: `Claude ${model} via Agent Server; readonly auto-allow requires a trusted PATH executable (rg without ripgrep always requires approval)`, hidden: false,
    isDefault: false, supportedReasoningEfforts: [], defaultReasoningEffort: "medium", inputModalities: ["text", "image"] }));
export function nativeThreadId(thread) {
    if (thread.backend === "claude")
        return thread.id.slice(3);
    if (thread.backend !== "codex" || !thread.engineThreadId)
        throw new ProtocolError(ErrorCode.backend_unsupported, "as-ingress: unsupported thread backend");
    return thread.engineThreadId;
}
export function resolveThread(server, id) {
    if (typeof id !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: native thread UUID required");
    const thread = server.log.findEngine(id, "codex") ?? findClaudeThread(server, `th_${id}`);
    if (!thread)
        throw new ProtocolError(ErrorCode.thread_not_found, "as-ingress: unknown thread");
    return thread;
}
export function findClaudeThread(server, asId) {
    try {
        const thread = server.log.thread(asId);
        return thread.backend === "claude" ? thread : undefined;
    }
    catch (error) {
        if (error instanceof ProtocolError && error.code === ErrorCode.thread_not_found)
            return undefined;
        throw error;
    }
}
function effectiveSandbox(options) {
    return options.sandbox ?? (options.permission === "readonly" ? "read-only" : options.permission === "full" ? "danger-full-access" : options.permission ? "workspace-write" : undefined);
}
export function nativeOptions(p, current = {}) {
    if (p.serviceTier != null && p.serviceTier !== "default")
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: serviceTier must be default");
    if (p.serviceTierForTurn != null && p.serviceTierForTurn !== "default")
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: serviceTierForTurn must be default");
    if (p.approvalsReviewer != null && p.approvalsReviewer !== "user")
        throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: approvalsReviewer must be user");
    const sandbox = p.sandbox ?? (p.sandboxPolicy ? { readOnly: "read-only", workspaceWrite: "workspace-write", dangerFullAccess: "danger-full-access" }[p.sandboxPolicy.type] : undefined);
    if (p.sandboxPolicy != null && (!sandbox || Object.keys(p.sandboxPolicy).some(k => !["type", "networkAccess", "writableRoots", "excludeTmpdirEnvVar", "excludeSlashTmp"].includes(k))))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported sandboxPolicy");
    if (sandbox != null && !["read-only", "workspace-write", "danger-full-access"].includes(sandbox))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported sandbox");
    if (p.approvalPolicy != null && !["never", "untrusted", "on-request"].includes(p.approvalPolicy))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unsupported approvalPolicy");
    let permission;
    if (p.approvalPolicy === "never") {
        const mode = sandbox ?? effectiveSandbox(current);
        if (mode === "read-only")
            permission = "readonly";
        else if (mode === "danger-full-access")
            permission = "full";
        else
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: never requires read-only or danger-full-access sandbox");
    }
    else if (p.approvalPolicy === "untrusted")
        permission = "default";
    else if (p.approvalPolicy === "on-request")
        permission = "auto-edit";
    // A sandbox override cannot silently bypass the lease required for full access.
    if (sandbox === "danger-full-access" && permission !== "full")
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: full access requires explicit never approval policy");
    return {
        ...(p.model != null ? { model: p.model } : {}), ...(p.cwd != null ? { cwd: p.cwd } : {}),
        ...(p.effort != null ? { effort: p.effort } : {}), ...(sandbox ? { sandbox } : {}), ...(permission ? { permission } : {}),
    };
}
/** The durable engine UUID index plus ThreadManager.live are the routing table. */
export class CodexRouter {
    server;
    client;
    control;
    signal;
    claudeThreads;
    notify;
    attached = new Set();
    constructor(server, client, control, signal, claudeThreads = false, notify) {
        this.server = server;
        this.client = client;
        this.control = control;
        this.signal = signal;
        this.claudeThreads = claudeThreads;
        this.notify = notify;
    }
    async reattach(threadId) {
        const thread = this.server.threads.get(threadId);
        if (thread.backend === "claude" && !this.claudeThreads)
            return;
        await this.allowedPath(thread.cwd);
        await this.client.request("thread/attach", { threadId });
        this.attached.add(threadId);
    }
    engine(thread) {
        const engine = this.server.threads.session(thread.id);
        if (!(engine instanceof CodexEngine))
            throw new ProtocolError(ErrorCode.backend_unsupported, "as-ingress: native Codex engine required");
        return engine;
    }
    async allowedPath(path) {
        const config = await this.client.request("server/config/read", {});
        let actual;
        try {
            actual = realpathSync(path);
        }
        catch {
            throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: inaccessible path");
        }
        if (actual === "/" || !config.allowed_roots.some(root => { const child = relative(root, actual); return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child)); }))
            throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: path outside allowed_roots");
    }
    async paths(p) {
        for (const key of ["cwd", "path", "marketplacePath"])
            if (p[key] != null) {
                if (typeof p[key] !== "string")
                    throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: invalid ${key}`);
                await this.allowedPath(p[key]);
            }
        for (const key of ["cwds", "runtimeWorkspaceRoots"])
            if (p[key] != null) {
                if (!Array.isArray(p[key]) || p[key].some((v) => typeof v !== "string"))
                    throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: invalid ${key}`);
                for (const path of p[key])
                    await this.allowedPath(path);
            }
        for (const path of p.sandboxPolicy?.writableRoots ?? [])
            await this.allowedPath(path);
    }
    rejectExtras(p) {
        for (const key of ["permissions", "permissionProfile", "modelProvider", "developerInstructions", "environments", "selectedCapabilityRoots", "outputSchema", "fjContext", "toolOutput", "additionalContext"])
            if (p[key] != null)
                throw new ProtocolError(ErrorCode.unsupported_capability, `as-ingress: ${key} is unavailable in slice 1`);
        if (p.collaborationMode != null) {
            if (p.collaborationMode.mode !== "default")
                throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: only default collaboration mode is supported");
            const settings = p.collaborationMode.settings;
            if (settings?.model != null && p.model != null && settings.model !== p.model)
                throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: conflicting collaboration model");
            if (settings?.reasoning_effort != null && p.effort != null && settings.reasoning_effort !== p.effort)
                throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: conflicting collaboration effort");
            p.model ??= settings?.model;
            p.effort ??= settings?.reasoning_effort;
        }
        if (p.config != null && (typeof p.config !== "object" || Array.isArray(p.config) || Object.keys(p.config).some(k => !["web_search", "personality"].includes(k))))
            throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: native config overrides are not supported");
        if (p.ephemeral === true)
            throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: ephemeral threads are unsupported");
    }
    async guardThread(thread, options) {
        const saved = this.server.log.options(thread.id);
        await this.allowedPath(options.cwd ?? thread.cwd);
        if (thread.permission === "readonly" && ((options.permission && options.permission !== "readonly") || (options.sandbox && options.sandbox !== "read-only")))
            throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: readonly thread cannot be elevated");
        if (options.model != null) {
            // The TUI repeats its startup model on picker resumes and turns. An
            // existing thread's backend is immutable; discard only that override.
            if (isClaudeModel(options.model) !== (thread.backend === "claude")) {
                delete options.model;
                this.notify?.({ method: "warning", params: { threadId: nativeThreadId(thread), message: `该线程为 ${thread.backend}，已沿用 ${thread.model}` } });
            }
            else
                this.server.threads.model(options.model, thread.backend, thread.id);
        }
        if (thread.backend === "codex" && saved.fjContext && options.model != null && options.model !== "gpt-6-astra")
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: fj Codex requires gpt-6-astra");
    }
    threadView(thread) {
        if (thread.backend === "claude")
            return { ...claudeThread(thread), ...this.threadActivity(thread) };
        const engine = this.server.threads.live.get(thread.id);
        const native = engine instanceof CodexEngine ? engine.nativeThreadStart().thread : thread.meta?.nativeThreadData;
        return { forkedFromId: null, parentThreadId: null,
            preview: thread.title ?? "", ephemeral: false, modelProvider: "unknown", createdAt: Math.floor(thread.createdAtMs / 1000),
            updatedAt: Math.floor(thread.createdAtMs / 1000), cwd: thread.cwd, cliVersion: "", source: "cli", gitInfo: null,
            name: thread.title ?? null, historyMode: "paginated", ...(native ?? {}),
            id: nativeThreadId(thread), sessionId: nativeThreadId(thread),
            ...this.threadActivity(thread), turns: [],
            ...(thread.forkedFrom ? { forkedFromId: nativeThreadId(this.server.threads.get(thread.forkedFrom.threadId)) } : {}),
            ...(thread.title !== undefined ? { name: thread.title } : {}),
            status: { type: thread.status.type === "running" ? "active" : thread.status.type === "systemError" ? "systemError" : "idle", ...(thread.status.type === "running" ? { activeFlags: [] } : {}) }, };
    }
    threadActivity(thread) {
        const turns = this.server.log.turns(thread.id);
        const last = turns.at(-1);
        const updated = Math.max(thread.createdAtMs, thread.closedAtMs ?? 0, last?.completedAtMs ?? last?.startedAtMs ?? last?.enqueuedAtMs ?? 0);
        return { updatedAt: Math.floor(updated / 1000), recencyAt: Math.floor(updated / 1000) };
    }
    claudeResponse(thread, includeTurns = false) {
        thread = this.server.threads.get(thread.id);
        const items = includeTurns ? this.server.log.snapshot(thread.id).items : [];
        return { ...claudeSettings(thread), thread: { ...claudeThread(thread, includeTurns ? this.server.log.turns(thread.id).map(t => claudeTurn(t, items, nativeThreadId(thread))) : []), ...this.threadActivity(thread) } };
    }
    claudeOnly(thread, method) {
        if (thread.backend !== "claude")
            throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method} on Codex threads`);
    }
    input(p) {
        if (!Array.isArray(p.input))
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: input array required");
        return p.input.map((part) => UserInputSchema.parse(part.type === "localImage" ? { type: "image", path: part.path, mime: "application/octet-stream" } : part));
    }
    claudeOptions(options, thread) {
        // Native sandbox is a UI permission selector; Claude enforces AS permission
        // rather than accepting a Codex sandbox override.
        const { sandbox, ...rest } = options;
        if (sandbox === "read-only")
            rest.permission = "readonly";
        if (thread && rest.effort !== undefined && rest.effort !== this.server.log.options(thread.id).effort)
            throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude 线程 effort 只在新建时生效");
        return rest;
    }
    async claudeHistory(thread, method, p) {
        const scope = `${nativeThreadId(thread)}:${method}:${p.turnId ?? ""}`;
        const snapshot = [];
        let asCursor;
        do {
            const page = await this.client.request("thread/items/list", { threadId: thread.id, direction: "asc", limit: 10000, ...(asCursor ? { cursor: asCursor } : {}) });
            snapshot.push(...page.items);
            asCursor = page.nextCursor ?? undefined;
        } while (asCursor);
        let rows;
        if (method === "thread/turns/list") {
            rows = this.server.log.turns(thread.id).map(t => ({ ordinal: t.ordinal, value: turnItemsView(claudeTurn(t, snapshot, nativeThreadId(thread)), p.itemsView ?? "summary") }));
        }
        else {
            // Keep AS seq cursors private. Each page is an immutable ordered slice of
            // the AS snapshot, including secondary image/subagent presentation items.
            rows = snapshot.filter(i => p.turnId == null || i.turnId === p.turnId).flatMap(i => claudeItems(i, nativeThreadId(thread)).map((item, n) => ({ ordinal: i.seq * 4 + n, value: { turnId: i.turnId, item } })));
        }
        return nativePage(rows.map(r => ({ key: [r.ordinal, ""], value: r.value })), p, scope, method === "thread/items/list" ? "asc" : "desc");
    }
    async claudeResume(thread, p) {
        const turns = await this.claudeHistory(thread, "thread/turns/list", { limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        const items = await this.claudeHistory(thread, "thread/items/list", { limit: 1, sortDirection: "desc" });
        return { ...this.claudeResponse(thread, p.excludeTurns !== true),
            initialTurnsPage: p.initialTurnsPage == null ? null : await this.claudeHistory(thread, "thread/turns/list", p.initialTurnsPage),
            turnsBackwardsCursor: turns.backwardsCursor, itemsBackwardsCursor: items.backwardsCursor };
    }
    async codexRead(thread, includeTurns) {
        const result = await nativeResult(this.engine(thread).nativeThreadRead(includeTurns));
        if (includeTurns && Array.isArray(thread.meta?.nativeInheritedTurns))
            result.thread.turns = [...structuredClone(thread.meta.nativeInheritedTurns), ...result.thread.turns];
        if (thread.forkedFrom)
            result.thread.forkedFromId = nativeThreadId(this.server.threads.get(thread.forkedFrom.threadId));
        return result;
    }
    async codexHistory(thread, method, p) {
        if (!Array.isArray(thread.meta?.nativeInheritedTurns))
            return nativeResult(this.engine(thread).nativeThreadHistory(method, p));
        // AS forks at an item inside a turn use a bounded seed, not a native turn
        // checkpoint. Retain original native presentation items for that prefix.
        const { thread: native } = await this.codexRead(thread, true);
        const values = method === "thread/turns/list" ? native.turns.map((t) => turnItemsView(t, p.itemsView ?? "summary"))
            : native.turns.filter((t) => p.turnId == null || t.id === p.turnId).flatMap((t) => t.items.map((item) => ({ turnId: t.id, item })));
        return nativePage(values.map((value, i) => ({ key: [i, ""], value })), p, `${nativeThreadId(thread)}:${method}:${p.turnId ?? ""}`, method === "thread/items/list" ? "asc" : "desc");
    }
    async request(method, p = {}) {
        if (methodPolicy(method) === "deny")
            throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method}`);
        if (p.approvalsReviewer != null && p.approvalsReviewer !== "user")
            throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: approvalsReviewer must be user");
        if (!this.claudeThreads && typeof p.threadId === "string" && !this.server.log.findEngine(p.threadId, "codex") && findClaudeThread(this.server, `th_${p.threadId}`))
            throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude threads are disabled by codex_ingress.claude_threads");
        if (CONTROL_METHODS.has(method)) {
            await this.paths(p);
            if (method === "account/read" && p.refreshToken === true)
                throw new ProtocolError(ErrorCode.unauthorized, "as-ingress: token refresh is unsupported");
            const result = await this.control.request(method, p);
            if (method === "model/list")
                return { ...result, data: [...result.data, ...(this.claudeThreads && result.nextCursor == null ? claudeModels : [])].filter((model) => {
                        if (!this.claudeThreads && isClaudeModel(model.model))
                            return false;
                        try {
                            this.server.threads.model(model.model, isClaudeModel(model.model) ? "claude" : "codex", `ingress_${this.client.clientId}`);
                            return true;
                        }
                        catch {
                            return false;
                        }
                    }).map((model) => ({ ...model, serviceTiers: [], additionalSpeedTiers: [], defaultServiceTier: null })) };
            return result;
        }
        switch (method) {
            case "thread/start": {
                this.rejectExtras(p);
                const options = nativeOptions(p);
                await this.paths(p);
                if (!options.cwd && p.runtimeWorkspaceRoots?.length)
                    options.cwd = p.runtimeWorkspaceRoots[0];
                const model = this.server.threads.model(options.model, "codex", `ingress_${this.client.clientId}`), backend = isClaudeModel(model) ? "claude" : "codex";
                if (backend === "claude" && !this.claudeThreads)
                    throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: Claude threads are disabled by codex_ingress.claude_threads");
                const selected = backend === "claude" ? this.claudeOptions(options) : options;
                const { thread } = await this.client.request("thread/start", { ...selected, model, backend, ...(backend === "codex" ? { serviceTier: "default" } : {}), permission: selected.permission ?? "default", ...(p.baseInstructions != null ? { systemPrompt: p.baseInstructions } : {}) });
                this.attached.add(thread.id);
                if (backend === "claude")
                    return this.claudeResponse(thread);
                const result = this.engine(thread).nativeThreadStart();
                // The ID mapping stays in the existing durable engine index. This shadow
                // contains presentation fields for listing after the owning process exits.
                thread.meta = { ...thread.meta, nativeThreadData: result.thread };
                this.server.log.saveThread(thread);
                return result;
            }
            case "thread/resume": {
                this.rejectExtras(p);
                const thread = resolveThread(this.server, p.threadId);
                const saved = this.server.log.options(thread.id);
                const options = nativeOptions(p, { ...saved, permission: thread.permission });
                await this.paths(p);
                if (thread.backend === "claude")
                    this.claudeOptions(options, thread);
                await this.guardThread(thread, options);
                // AS attach to a live thread intentionally keeps its saved settings.
                if (this.server.threads.live.has(thread.id)) {
                    const effective = { ...saved, model: thread.model, cwd: thread.cwd, permission: thread.permission, sandbox: effectiveSandbox({ ...saved, permission: thread.permission }) };
                    for (const key of ["model", "cwd", "sandbox", "permission", "effort"])
                        if (options[key] != null && options[key] !== effective[key])
                            throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: live resume cannot override ${key}`);
                }
                // Repeating the saved permission is an attachment, not an escalation.
                const selected = thread.backend === "claude" ? this.claudeOptions(options) : { ...options };
                if (selected.permission === thread.permission)
                    delete selected.permission;
                if (this.server.threads.live.has(thread.id))
                    await this.client.request("thread/attach", { threadId: thread.id });
                else
                    await this.client.request("thread/resume", { ...selected, threadId: thread.id, backend: thread.backend });
                this.attached.add(thread.id);
                if (thread.backend === "claude")
                    return this.claudeResume(thread, p);
                const engine = this.engine(thread), response = engine.nativeThreadStart();
                const result = { ...response, ...await this.codexRead(thread, p.excludeTurns !== true), initialTurnsPage: null, turnsBackwardsCursor: null, itemsBackwardsCursor: null };
                if (result.thread.historyMode === "paginated") {
                    // Same one-entry descending probes as upstream
                    // paginated_resume_backwards_cursors; never translate opaque cursors.
                    const turns = await this.codexHistory(thread, "thread/turns/list", { limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
                    const items = await this.codexHistory(thread, "thread/items/list", { limit: 1, sortDirection: "desc" });
                    result.turnsBackwardsCursor = turns.backwardsCursor;
                    result.itemsBackwardsCursor = items.backwardsCursor;
                }
                if (p.initialTurnsPage != null)
                    result.initialTurnsPage = await this.codexHistory(thread, "thread/turns/list", p.initialTurnsPage);
                const title = this.server.threads.get(thread.id).title;
                if (title !== undefined)
                    result.thread.name = title;
                return result;
            }
            case "turn/start": {
                this.rejectExtras(p);
                const thread = resolveThread(this.server, p.threadId);
                const saved = this.server.log.options(thread.id);
                const options = nativeOptions(p, { ...saved, permission: thread.permission });
                await this.paths(p);
                await this.guardThread(thread, options);
                const input = this.input(p);
                for (const part of input)
                    if (part.type === "image" || part.type === "file")
                        await this.allowedPath(part.path);
                const engine = thread.backend === "codex" ? this.engine(thread) : undefined;
                const selected = thread.backend === "claude" ? this.claudeOptions(options, thread) : { ...options, sandbox: options.sandbox ?? saved.sandbox };
                // Omit an unchanged permission so AS applies its ordinary input rule.
                // Actual overrides still pass through AS escalation checks.
                if (selected.permission === thread.permission)
                    delete selected.permission;
                const { turn } = await this.client.request("turn/start", { ...selected, threadId: thread.id, input, ...(p.clientUserMessageId ? { clientTurnId: p.clientUserMessageId } : {}) });
                if (!engine)
                    return { turn: claudeTurn(turn, this.server.log.snapshot(thread.id).items, nativeThreadId(thread)) };
                try {
                    return await engine.waitNativeTurn(turn.id, this.signal);
                }
                catch (error) {
                    // A queued AS turn has no native ID yet. Do not report a timeout and
                    // leave that undisclosed turn to execute later behind a long approval.
                    if (!this.signal?.aborted && this.server.log.turn(turn.id).status === "queued")
                        await this.client.request("turn/cancel", { threadId: thread.id, turnId: turn.id });
                    throw error;
                }
            }
            case "turn/interrupt": {
                const thread = resolveThread(this.server, p.threadId), turnId = this.server.threads.queue(thread.id).runningTurnId;
                if (p.turnId === undefined)
                    throw new NativeRpcError(-32600, "Invalid request: missing field `turnId`");
                if (typeof p.turnId !== "string")
                    throw new ProtocolError(ErrorCode.invalid_params, "turnId must be a string");
                // Upstream turn_interrupt_inner: empty ID is startup cancellation; a
                // named terminal/absent turn is InvalidRequest, not AS turn_not_active.
                if (!turnId) {
                    if (p.turnId === "")
                        return {};
                    throw new NativeRpcError(-32600, "no active turn to interrupt");
                }
                const engine = thread.backend === "codex" ? this.engine(thread) : undefined;
                const nativeId = engine ? engine.nativeTurnId(turnId) ?? (p.turnId !== "" ? (await engine.waitNativeTurn(turnId, this.signal)).turn.id : undefined) : turnId;
                if (p.turnId !== "" && nativeId !== p.turnId)
                    throw new NativeRpcError(-32600, `expected active turn id ${p.turnId} but found ${nativeId}`);
                try {
                    await this.client.request("turn/interrupt", { threadId: thread.id, turnId });
                }
                catch (error) {
                    if (error instanceof ProtocolError && error.code === ErrorCode.turn_not_active) {
                        if (p.turnId === "")
                            return {};
                        throw new NativeRpcError(-32600, "no active turn to interrupt");
                    }
                    if (error instanceof ProtocolError && typeof error.data.raw === "string") {
                        let native;
                        try {
                            native = JSON.parse(error.data.raw);
                        }
                        catch { /* Non-native AS failure. */ }
                        if (native && typeof native.code === "number" && typeof native.message === "string")
                            throw new NativeRpcError(native.code, native.message);
                    }
                    throw error;
                }
                return {};
            }
            case "thread/name/set": {
                const thread = resolveThread(this.server, p.threadId);
                if (typeof p.name !== "string" || !p.name.trim())
                    throw new NativeRpcError(-32600, "thread name must not be empty");
                return this.client.request("thread/name/set", { threadId: thread.id, name: p.name });
            }
            case "thread/read": {
                const thread = resolveThread(this.server, p.threadId);
                await this.allowedPath(thread.cwd);
                await this.client.request("thread/read", { threadId: thread.id });
                if (thread.backend === "claude")
                    return { thread: this.claudeResponse(thread, p.includeTurns === true).thread };
                const result = await this.codexRead(thread, p.includeTurns === true);
                const title = this.server.threads.get(thread.id).title;
                if (title !== undefined)
                    result.thread.name = title;
                return result;
            }
            case "thread/items/list":
            case "thread/turns/list": {
                const thread = resolveThread(this.server, p.threadId);
                await this.allowedPath(thread.cwd);
                await this.client.request("thread/read", { threadId: thread.id });
                if (thread.backend === "claude")
                    return this.claudeHistory(thread, method, p);
                return this.codexHistory(thread, method, p);
            }
            case "thread/list": {
                const cwds = p.cwd == null ? [] : Array.isArray(p.cwd) ? p.cwd : [p.cwd];
                await this.paths({ ...p, cwd: undefined, cwds });
                if (p.originators?.length || p.projectId !== undefined || p.sectionId != null || p.sortKey === "section_position")
                    throw new ProtocolError(ErrorCode.unsupported_capability, "as-ingress: originator/project/section filtering is unavailable");
                if (p.parentThreadId && p.ancestorThreadId)
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: parentThreadId and ancestorThreadId are mutually exclusive");
                const threads = [];
                let cursor;
                do {
                    const result = await this.client.request("thread/list", { limit: 10000, ...(cursor ? { cursor } : {}) });
                    threads.push(...result.threads);
                    cursor = result.nextCursor ?? undefined;
                } while (cursor);
                let data = threads.filter(t => (this.claudeThreads && t.backend === "claude" || t.backend === "codex" && t.engineThreadId) && (t.status.type === "closed") === (p.archived ?? false) && (!cwds.length || cwds.includes(t.cwd))).map(t => this.threadView(t));
                if (p.modelProviders?.length)
                    data = data.filter(t => p.modelProviders.includes(t.modelProvider));
                const sourceKinds = p.sourceKinds?.length ? p.sourceKinds : p.parentThreadId || p.ancestorThreadId ? null : ["cli", "vscode"];
                if (sourceKinds)
                    data = data.filter(t => {
                        if (typeof t.source === "string")
                            return sourceKinds.includes(t.source);
                        const kind = t.source?.subAgent;
                        return sourceKinds.includes("subAgent") || sourceKinds.includes(kind === "review" ? "subAgentReview" : kind === "compact" ? "subAgentCompact" : kind?.thread_spawn ? "subAgentThreadSpawn" : "subAgentOther");
                    });
                if (p.searchTerm)
                    data = data.filter(t => String(t.name ?? t.preview).toLowerCase().includes(String(p.searchTerm).toLowerCase()));
                if (p.parentThreadId)
                    data = data.filter(t => t.parentThreadId === p.parentThreadId);
                if (p.ancestorThreadId) {
                    const parents = new Map(threads.filter(t => t.backend === "claude" || t.engineThreadId).map(t => { const view = this.threadView(t); return [view.id, view.parentThreadId]; }));
                    data = data.filter(t => {
                        const seen = new Set([t.id]);
                        let parent = t.parentThreadId;
                        while (parent && !seen.has(parent)) {
                            if (parent === p.ancestorThreadId)
                                return true;
                            seen.add(parent);
                            parent = parents.get(parent);
                        }
                        return false;
                    });
                }
                if (p.sortKey != null && !["created_at", "updated_at", "recency_at"].includes(p.sortKey))
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid sortKey");
                const key = p.sortKey === "updated_at" ? "updatedAt" : p.sortKey === "recency_at" ? "recencyAt" : "createdAt";
                const scope = JSON.stringify(["thread/list", key, [...cwds].sort(), p.archived ?? false, p.modelProviders ?? [], p.sourceKinds ?? [], p.searchTerm ?? null, p.parentThreadId ?? null, p.ancestorThreadId ?? null]);
                return nativePage(data.map(t => ({ key: [t[key] ?? t.updatedAt, t.id], value: t })), p, scope);
            }
            case "thread/loaded/list": {
                const health = await this.client.request("server/health", {});
                let data = health.engines.filter(e => this.claudeThreads && e.backend === "claude" || e.backend === "codex" && e.engineThreadId).map(e => e.backend === "claude" ? e.threadId.slice(3) : e.engineThreadId).sort();
                if (!data.length)
                    return { data, nextCursor: null };
                if (p.cursor != null) {
                    if (typeof p.cursor !== "string" || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(p.cursor))
                        throw new NativeRpcError(-32600, `invalid cursor: ${p.cursor}`);
                    data = data.filter(id => id > p.cursor.toLowerCase());
                }
                const limit = pageLimit(p.limit, data.length, 0xffffffff), page = data.slice(0, limit);
                return { data: page, nextCursor: data.length > limit ? page.at(-1) : null };
            }
            case "turn/steer": {
                const thread = resolveThread(this.server, p.threadId);
                this.claudeOnly(thread, method);
                await this.guardThread(thread, {});
                const input = this.input(p);
                for (const part of input)
                    if (part.type === "image" || part.type === "file")
                        await this.allowedPath(part.path);
                await this.client.request("turn/steer", { threadId: thread.id, expectedTurnId: p.expectedTurnId, input });
                return { turnId: p.expectedTurnId };
            }
            case "thread/settings/update": {
                const thread = resolveThread(this.server, p.threadId);
                this.claudeOnly(thread, method);
                this.rejectExtras(p);
                for (const key of Object.keys(p))
                    if (p[key] != null && !["threadId", "model", "approvalPolicy", "sandbox", "sandboxPolicy", "effort", "serviceTier", "approvalsReviewer", "collaborationMode"].includes(key))
                        throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported Claude setting ${key}`);
                const options = nativeOptions(p, { permission: thread.permission });
                await this.paths(p);
                await this.guardThread(thread, options);
                const selected = this.claudeOptions(options, thread);
                if (selected.model !== undefined) {
                    const result = await this.client.request("thread/engineControl", { threadId: thread.id, subtype: "set_model", params: { model: selected.model } });
                    if (result.response?.subtype === "error")
                        throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: Claude rejected model update: ${result.response.error}`);
                }
                if (selected.permission !== undefined && selected.permission !== thread.permission) {
                    const elevate = selected.permission === "full";
                    if (elevate)
                        await this.client.request("thread/lease/acquire", { threadId: thread.id, ttlMs: 10_000 });
                    try {
                        await this.client.request("thread/permission/set", { threadId: thread.id, permission: selected.permission });
                    }
                    finally {
                        // A disconnect clears our lease; an expired lease may already have
                        // a new owner. Never release that owner's lease or mask the error.
                        if (elevate && this.server.leases.read(thread.id)?.holder.clientId === this.client.clientId)
                            await this.client.request("thread/lease/release", { threadId: thread.id });
                    }
                }
                return {};
            }
            case "thread/compact/start": {
                const thread = resolveThread(this.server, p.threadId);
                this.claudeOnly(thread, method);
                await this.guardThread(thread, {});
                await this.client.request("thread/compact", { threadId: thread.id });
                return {};
            }
            case "thread/fork": {
                const thread = resolveThread(this.server, p.threadId);
                this.rejectExtras(p);
                await this.paths(p);
                const saved = this.server.log.options(thread.id), options = nativeOptions(p, { ...saved, permission: thread.permission });
                await this.guardThread(thread, options);
                const effective = { ...saved, model: thread.model, cwd: thread.cwd, permission: thread.permission, sandbox: effectiveSandbox({ ...saved, permission: thread.permission }) };
                for (const key of ["model", "cwd", "permission", "sandbox", "effort"])
                    if (options[key] != null && options[key] !== effective[key])
                        throw new ProtocolError(ErrorCode.invalid_params, `as-ingress: fork inherits saved ${key}`);
                for (const key of ["beforeTurnId", "baseInstructions"])
                    if (p[key] != null)
                        throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported fork option ${key}`);
                if (p.fromItemId != null && p.lastTurnId != null)
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: fork boundaries are mutually exclusive");
                let fromItemId = p.fromItemId;
                if (p.lastTurnId != null) {
                    const items = this.server.log.snapshot(thread.id).items;
                    fromItemId = items.findLast(i => thread.backend === "claude" ? i.turnId === p.lastTurnId : this.server.log.forkPoint(thread.id, i.id) === p.lastTurnId)?.id;
                    if (!fromItemId)
                        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: unknown fork turn boundary");
                }
                const result = await this.client.request("thread/fork", { threadId: thread.id, ...(fromItemId != null ? { fromItemId } : {}) });
                this.attached.add(result.thread.id);
                if (thread.backend === "claude")
                    return this.claudeResponse(result.thread, p.excludeTurns !== true);
                if (this.server.log.options(result.thread.id).seedHistory !== undefined) {
                    const prefix = new Set(this.server.log.snapshot(result.thread.id).items.map(i => i.id));
                    const original = await this.codexRead(thread, true);
                    const inherited = original.thread.turns.map((t) => ({ ...t, status: "completed", items: t.items.filter((i) => prefix.has(i.id)) })).filter((t) => t.items.length);
                    result.thread.meta = { ...result.thread.meta, nativeInheritedTurns: inherited };
                    this.server.log.saveThread(result.thread);
                }
                const response = this.engine(result.thread).nativeThreadStart();
                response.thread = (await this.codexRead(result.thread, p.excludeTurns !== true)).thread;
                result.thread.meta = { ...result.thread.meta, nativeThreadData: { ...response.thread, turns: [] } };
                this.server.log.saveThread(result.thread);
                return response;
            }
            case "thread/archive": {
                const thread = resolveThread(this.server, p.threadId);
                this.claudeOnly(thread, method);
                await this.guardThread(thread, {});
                return this.client.request("thread/close", { threadId: thread.id });
            }
            case "thread/unsubscribe": {
                const thread = resolveThread(this.server, p.threadId);
                await this.client.request("thread/detach", { threadId: thread.id });
                this.attached.delete(thread.id);
                return { status: "unsubscribed" };
            }
            default: throw new ProtocolError(ErrorCode.method_not_found, `as-ingress: unsupported method ${method}`);
        }
    }
}
