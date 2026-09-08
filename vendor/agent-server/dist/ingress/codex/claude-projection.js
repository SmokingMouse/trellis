import { ErrorCode, ProtocolError } from "../../protocol/index.js";
const text = (value) => typeof value === "string" ? value : JSON.stringify(value) ?? "";
const error = (message) => ({ message, codexErrorInfo: null, additionalDetails: null });
const status = (item) => item.status === "rejected" ? "failed" : item.status ?? "inProgress";
export const nativeChanges = (changes) => changes.map(c => ({ path: c.path, kind: { type: c.kind }, diff: c.diff ?? "" }));
const agentStatus = (phase) => ["pendingInit", "running", "interrupted", "completed", "errored", "shutdown", "notFound"].includes(phase) ? phase : "running";
/** One-way presentation only. No native -> AS item inverse exists. */
export function claudeItems(item, threadId) {
    const p = item.payload, base = { id: item.id, type: item.type };
    const dynamic = (tool, namespace, input, output) => ({ ...base, type: "dynamicToolCall", tool, namespace, arguments: input,
        status: status(item), contentItems: output === undefined ? null : [{ type: "inputText", text: text(output) }], success: item.status === "inProgress" ? null : status(item) === "completed", durationMs: null });
    switch (item.type) {
        case "userMessage": return [{ ...base, content: p.content.map((c) => c.type === "image" ? { type: "localImage", path: c.path } : { type: "text", text: c.type === "bash" ? `!${c.command}` : c.type === "file" ? `Attached file: ${c.path}` : c.text, text_elements: [] }) }];
        case "agentMessage": return [{ ...base, text: p.text, phase: ["commentary", "final_answer"].includes(p.phase) ? p.phase : null }];
        case "reasoning": return [{ ...base, summary: p.summary === undefined ? [] : [p.summary], content: p.text === undefined ? [] : [p.text] }];
        case "commandExecution": return [{ ...base, ...p, status: item.status === "rejected" ? "declined" : item.status ?? "inProgress", commandActions: [], processId: null, aggregatedOutput: p.aggregatedOutput ?? null, exitCode: p.exitCode ?? null, durationMs: p.durationMs ?? null }];
        case "fileChange": return [{ ...base, status: p.status === "rejected" ? "declined" : p.status, changes: nativeChanges(p.changes) }];
        case "toolCall": return [{ ...dynamic(p.name, p.namespace ?? null, p.input, p.output), success: p.isError ? false : item.status === "inProgress" ? null : status(item) === "completed" }];
        case "mcpToolCall": return [{ ...base, server: p.server, tool: p.tool, arguments: p.arguments, status: status(item),
                result: p.result === undefined ? null : Array.isArray(p.result?.content) ? p.result : { content: [{ type: "text", text: text(p.result) }], structuredContent: p.result },
                error: p.error === undefined ? null : { message: text(p.error) }, durationMs: null }];
        case "subAgent": {
            if (p.kind !== "agent")
                return [dynamic(`subagent_${p.kind}`, "as", { parentItemId: p.parentItemId }, p)];
            return [{ ...base, type: "collabAgentToolCall", tool: "spawnAgent", status: status(item), senderThreadId: threadId, receiverThreadIds: [p.parentItemId],
                    agentsStates: { [p.parentItemId]: { status: agentStatus(p.phase), message: text(p.report ?? p.progress ?? p.text ?? "") } }, prompt: p.text ?? null, model: null, reasoningEffort: null },
                { id: `${item.id}:activity`, type: "subAgentActivity", agentThreadId: p.parentItemId, agentPath: p.parentItemId,
                    kind: p.phase === "completed" ? "completed" : p.phase === "interrupted" ? "interrupted" : p.phase === "started" ? "started" : "interacted" }];
        }
        case "webSearch": return [{ ...base, query: p.query, action: null, results: p.results === undefined ? null : Array.isArray(p.results) ? p.results : [p.results] }];
        case "imageOutput": return [{ ...base, type: "imageGeneration", status: status(item), result: "", savedPath: p.paths[0] ?? null, revisedPrompt: null },
            ...(p.paths.length > 1 ? [{ id: `${item.id}:paths`, type: "agentMessage", text: p.paths.slice(1).join("\n"), phase: null }] : [])];
        case "plan": return [{ ...base, text: p.text ?? "" }];
        case "contextCompaction": return [base];
        case "error": return [];
        // Native has no unknown union member. An explicitly named card retains the
        // original type and payload instead of dropping future AS items.
        default: return [dynamic("unknown", "as", { type: item.type, payload: p }, p)];
    }
}
export function claudeTurn(turn, items, threadId) {
    return { id: turn.id, status: turn.status === "queued" ? "inProgress" : turn.status === "cancelled" ? "interrupted" : turn.status,
        items: items.filter(i => i.turnId === turn.id).flatMap(i => claudeItems(i, threadId)), itemsView: "full",
        error: turn.error ? error(turn.error.message) : null, startedAt: turn.startedAtMs === undefined ? null : Math.floor(turn.startedAtMs / 1000),
        completedAt: turn.completedAtMs === undefined ? null : Math.floor(turn.completedAtMs / 1000), durationMs: turn.durationMs ?? null };
}
export function claudeStatus(type) {
    return type === "running" || type === "spawning" ? { type: "active", activeFlags: [] } : { type: type === "systemError" ? "systemError" : "idle" };
}
export function claudeThread(thread, turns = []) {
    const id = thread.id.slice(3);
    return { id, sessionId: id, model: thread.model ?? null, modelProvider: "claude", cwd: thread.cwd, name: thread.title ?? null, preview: thread.title ?? "",
        createdAt: Math.floor(thread.createdAtMs / 1000), updatedAt: Math.floor((thread.closedAtMs ?? thread.createdAtMs) / 1000),
        cliVersion: "", source: "cli", status: claudeStatus(thread.status.type), turns, historyMode: "paginated", ephemeral: false,
        projectId: null, path: null, parentThreadId: null, forkedFromId: thread.forkedFrom?.threadId.slice(3) ?? null, gitInfo: null };
}
export function claudeSettings(thread) {
    const readonly = thread.permission === "readonly", full = ["full", "bypassPermissions", "dontAsk"].includes(thread.permission ?? "");
    return { model: thread.model, modelProvider: "claude", cwd: thread.cwd, reasoningEffort: null, serviceTier: null, approvalsReviewer: "user",
        approvalPolicy: readonly || full ? "never" : ["auto-edit", "acceptEdits"].includes(thread.permission ?? "") ? "on-request" : "untrusted",
        sandbox: { type: readonly ? "readOnly" : full ? "dangerFullAccess" : "workspaceWrite" } };
}
export function claudeSettingsUpdated(thread) {
    const { sandbox, reasoningEffort, ...settings } = claudeSettings(thread);
    return { method: "thread/settings/updated", params: { threadId: thread.id.slice(3), threadSettings: { ...settings, sandboxPolicy: sandbox,
                activePermissionProfile: null, effort: reasoningEffort, summary: null, personality: null, multiAgentMode: "explicitRequestOnly",
                collaborationMode: { mode: "default", settings: { model: thread.model, reasoning_effort: reasoningEffort, developer_instructions: null } } } } };
}
export function claudeToolPermission(method, p) {
    return method === "item/permissions/requestApproval" && typeof p.permissions?.toolName === "string";
}
export function claudeAnswer(method, p, result) {
    if (claudeToolPermission(method, p)) {
        const answers = result?.answers?.permission?.answers;
        if (!Array.isArray(answers) || answers.length !== 1 || !["allow", "deny"].includes(answers[0]))
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: permission answer must be allow or deny");
        return { permissions: answers[0] === "allow" ? p.permissions : {}, scope: "turn" };
    }
    if (method !== "item/tool/requestUserInput")
        return result;
    const decoded = structuredClone(result);
    for (const q of p.questions) {
        if (!q.multiSelect)
            continue;
        const answer = decoded?.answers?.[q.id];
        if (!Array.isArray(answer?.answers) || answer.answers.some((s) => typeof s !== "string"))
            throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: multiSelect answers must be strings");
        answer.answers = [...new Set(answer.answers.flatMap((s) => s.split(/[,，]/)).map((s) => {
                const value = s.trim();
                if (!/^\d+$/.test(value))
                    return value;
                const option = q.options?.[Number(value) - 1];
                if (!option)
                    throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: multiSelect option number out of range");
                return option.label;
            }).filter(Boolean))];
    }
    return decoded;
}
export function claudeApproval(method, p, thread) {
    if (claudeToolPermission(method, p))
        return {
            threadId: thread.id.slice(3), turnId: p.turnId, itemId: p.itemId, isBlocking: true,
            questions: [{ id: "permission", header: `权限请求：${p.permissions.toolName}`, question: JSON.stringify(p.permissions.input, null, 2)?.slice(0, 4000) ?? "无输入",
                    isOther: false, isSecret: false, options: [{ label: "allow", description: "允许本次工具调用" }, { label: "deny", description: "拒绝本次工具调用" }] }],
        };
    if (method === "item/permissions/requestApproval" && Object.keys(p.permissions).some(k => !["network", "fileSystem"].includes(k)))
        throw new ProtocolError(ErrorCode.method_not_found, "as-ingress: unsupported Claude permission shape");
    const { data: _data, requestId: _requestId, ...params } = p;
    params.threadId = thread.id.slice(3);
    if (method === "item/fileChange/requestApproval")
        params.changes = nativeChanges(p.changes);
    if (method === "item/tool/requestUserInput")
        params.questions = p.questions.map((q) => ({ id: q.id, header: q.header ?? "Question", isOther: true, isSecret: false,
            question: q.multiSelect ? `${q.question}\n${(q.options ?? []).map((o, i) => `${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")}\n可多选，逗号分隔（填写编号或选项文字）` : q.question,
            options: q.multiSelect ? null : q.options?.map((o) => ({ ...o, description: o.description ?? "" })) ?? null }));
    return params;
}
/** AS last-usage becomes native last; totals are reconstructed from durable turns. */
export function claudeUsage(usage) {
    return { totalTokens: usage.inputTokens + usage.outputTokens + usage.cachedTokens + usage.cacheCreation,
        inputTokens: usage.inputTokens + usage.cachedTokens + usage.cacheCreation, cachedInputTokens: usage.cachedTokens, cacheWriteInputTokens: usage.cacheCreation, outputTokens: usage.outputTokens, reasoningOutputTokens: 0 };
}
export function claudeNotification(method, p, thread, turns, items) {
    const threadId = thread.id.slice(3), ids = { threadId, ...(p.turnId ? { turnId: p.turnId } : {}), ...(p.itemId ? { itemId: p.itemId } : {}) };
    const notify = (method, params) => ({ method, params });
    switch (method) {
        case "thread/started": return [notify(method, { thread: claudeThread(thread) })];
        case "thread/status/changed": return [notify(method, { threadId, status: claudeStatus(p.status.type) })];
        case "thread/closed": return [notify(method, { threadId })];
        case "thread/metadata/updated": return p.model === undefined ? [] : [claudeSettingsUpdated(thread)];
        case "thread/permission/changed": return [claudeSettingsUpdated(thread)];
        case "turn/started":
        case "turn/completed": return [notify(method, { threadId, turn: claudeTurn(p.turn, items, threadId) })];
        case "item/started":
        case "item/completed": {
            const item = p.item;
            if (item.type === "error")
                return method === "item/completed" ? [notify("error", { ...ids, error: error(item.payload.message), willRetry: item.payload.retryable })] : [];
            const lifecycle = method === "item/started" ? { startedAtMs: p.startedAtMs ?? item.startedAtMs } : { completedAtMs: p.completedAtMs ?? item.completedAtMs ?? item.startedAtMs };
            const frames = claudeItems(item, threadId).map(item => notify(method, { ...ids, item, ...lifecycle }));
            if (item.type === "plan" && item.payload.steps)
                frames.push(notify("turn/plan/updated", { threadId, turnId: p.turnId, explanation: item.payload.text ?? null, plan: item.payload.steps }));
            if (item.type === "contextCompaction" && method === "item/completed")
                frames.push(notify("thread/compacted", { threadId, turnId: p.turnId }));
            return frames;
        }
        case "item/agentMessage/delta": return [notify(method, { ...ids, delta: p.delta })];
        case "item/reasoning/textDelta": return [notify(method, { ...ids, delta: p.delta, contentIndex: 0 })];
        case "item/reasoning/summaryTextDelta": return [notify(method, { ...ids, delta: p.delta, summaryIndex: 0 })];
        case "item/commandExecution/outputDelta": return [notify(method, { ...ids, delta: p.chunk })];
        case "item/fileChange/patchUpdated": return [notify(method, { ...ids, changes: nativeChanges(p.changes) })];
        case "item/subAgent/progress": {
            const item = items.find(i => i.id === p.itemId);
            return item ? claudeItems(item, threadId).map(projected => notify("item/started", { ...ids, item: projected, startedAtMs: item.startedAtMs })) : [];
        }
        case "turn/plan/updated": return [notify(method, { ...ids, explanation: p.plan.text ?? null, plan: p.plan.steps ?? [] })];
        case "thread/tokenUsage/updated": {
            const last = claudeUsage(p.usage), total = Object.fromEntries(Object.keys(last).map(k => [k, 0]));
            for (const t of turns)
                if (t.usage) {
                    const u = claudeUsage(t.usage);
                    for (const k of Object.keys(total))
                        total[k] += u[k];
                }
            return [notify(method, { threadId, turnId: turns.at(-1)?.id ?? "", tokenUsage: { last, total, modelContextWindow: null } })];
        }
        default: return [];
    }
}
