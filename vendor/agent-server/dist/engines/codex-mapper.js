import { extname } from "node:path";
import { ErrorCode, ItemPayloadSchemas, PendingServerRequestSchema, ProtocolError, ServerRequestSchemas, UsageSchema } from "../protocol/index.js";
// The native boundary is versioned by docs/agent-server/codex-schema-version.txt.
// Validate translated payloads before they reach the persistent AS item log.
export function codexRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}
export function codexProtocolError(message, raw) {
    return new ProtocolError(ErrorCode.engine_protocol_error, message, { raw: JSON.stringify(raw)?.slice(0, 2000) ?? null });
}
export function codexString(value, field) {
    if (typeof value !== "string" || !value.length)
        throw codexProtocolError(`Missing Codex ${field}`, value);
    return value;
}
function json(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
function list(value) {
    if (!Array.isArray(value))
        throw codexProtocolError("Expected a Codex array", value);
    return value;
}
function status(value, completed) {
    if (value === undefined || value === null)
        return completed ? "completed" : "inProgress";
    if (value === "interrupted")
        return "failed";
    if (value === "declined")
        return "rejected";
    if (["inProgress", "completed", "failed"].includes(String(value)))
        return value;
    throw codexProtocolError("Unknown Codex item status", value);
}
export function codexUserInput(input) {
    return input.map(part => {
        if (part.type === "text")
            return { type: "text", text: part.text, text_elements: [] };
        if (part.type === "image")
            return { type: "localImage", path: part.path };
        // v2 has no generic file input. Keep the local path available to file tools.
        return { type: "text", text: `Attached file${part.name ? ` (${part.name})` : ""}: ${part.path}`, text_elements: [] };
    });
}
function inputKey(input) {
    return JSON.stringify(input.map(p => p.type === "text" ? { type: p.type, text: p.text } : p.type === "localImage" ? { type: p.type, path: p.path } : p));
}
function userContent(raw) {
    return list(raw).map(part => {
        if (part.type === "text")
            return { type: "text", text: part.text };
        if (part.type === "localImage") {
            const mime = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" }[extname(part.path).toLowerCase()] ?? "application/octet-stream";
            return { type: "image", path: part.path, mime };
        }
        if (part.type === "mention" || part.type === "skill")
            return { type: "file", path: part.path, name: part.name };
        throw codexProtocolError("Codex user input cannot be represented as a local AS attachment", part);
    });
}
export function codexFileChanges(raw) {
    return list(raw).flatMap(change => {
        const kind = codexRecord(change.kind);
        if (!["add", "update", "delete"].includes(kind.type))
            throw codexProtocolError("Unknown Codex patch kind", change);
        // AS has no rename kind: represent the source removal and destination addition.
        if (kind.type === "update" && typeof kind.move_path === "string")
            return [{ path: change.path, kind: "delete", diff: change.diff }, { path: kind.move_path, kind: "add", diff: change.diff }];
        return [{ path: change.path, kind: kind.type, diff: change.diff }];
    });
}
export function mapCodexItem(raw, completed = false, parentItemId) {
    const d = codexRecord(raw);
    let type, payload;
    switch (d.type) {
        case "userMessage":
            type = "userMessage";
            payload = { content: userContent(d.content) };
            break;
        case "agentMessage":
            type = "agentMessage";
            payload = { text: d.text, ...(d.phase != null ? { phase: d.phase } : {}) };
            break;
        case "reasoning":
            type = "reasoning";
            payload = { summary: list(d.summary ?? []).join("\n\n"), text: list(d.content ?? []).join("\n\n") };
            break;
        case "commandExecution":
            type = "commandExecution";
            payload = { command: d.command, cwd: d.cwd, ...(d.aggregatedOutput != null ? { aggregatedOutput: d.aggregatedOutput } : {}), ...(d.exitCode !== undefined ? { exitCode: d.exitCode } : {}), ...(d.durationMs != null ? { durationMs: d.durationMs } : {}) };
            break;
        case "fileChange":
            type = "fileChange";
            payload = { changes: codexFileChanges(d.changes), status: status(d.status, completed) };
            break;
        case "functionCallOutput":
            type = "toolCall";
            payload = { name: d.name, ...(d.namespace != null ? { namespace: d.namespace } : {}), input: null, output: json(d.output) };
            break;
        case "dynamicToolCall":
            type = "toolCall";
            payload = { name: d.tool, ...(d.namespace != null ? { namespace: d.namespace } : {}), input: json(d.arguments), ...(d.contentItems != null ? { output: json(d.contentItems) } : {}), ...(d.success != null ? { isError: !d.success } : {}) };
            break;
        case "mcpToolCall":
            type = "mcpToolCall";
            payload = { server: d.server, tool: d.tool, arguments: json(d.arguments), ...(d.result != null ? { result: json(d.result) } : {}), ...(d.error != null ? { error: json(d.error) } : {}) };
            break;
        case "collabAgentToolCall":
            type = "subAgent";
            payload = { kind: "agent", parentItemId: d.id, phase: d.status, progress: json(d), ...(completed ? { report: json(d.agentsStates) } : {}) };
            break;
        case "subAgentActivity":
            // Activity has no parent field. Link to its collab spawn when present;
            // otherwise the native activity item itself is the available anchor.
            type = "subAgent";
            payload = { kind: "agent", parentItemId: parentItemId ?? d.id, phase: d.kind, progress: json(d), ...(d.kind === "completed" ? { report: json(d) } : {}) };
            break;
        case "webSearch":
            type = "webSearch";
            payload = { query: d.query, ...(d.results != null ? { results: json(d.results) } : {}) };
            break;
        case "imageGeneration":
            type = "imageOutput";
            payload = { paths: d.savedPath ? [d.savedPath] : [] };
            break;
        case "plan":
            type = "plan";
            payload = { text: d.text };
            break;
        case "contextCompaction":
            type = "contextCompaction";
            payload = {};
            break;
        default: throw codexProtocolError(`Unknown Codex item type: ${String(d.type)}`, raw);
    }
    const parsed = ItemPayloadSchemas[type].safeParse(payload);
    if (!parsed.success)
        throw codexProtocolError(`Invalid Codex ${String(d.type)} item`, raw);
    return { id: codexString(d.id, "item id"), type, status: status(d.status, completed), payload: parsed.data };
}
function usage(raw, context) {
    const d = codexRecord(raw);
    const parsed = UsageSchema.safeParse({ usd: null, inputTokens: d.inputTokens, outputTokens: d.outputTokens, cachedTokens: d.cachedInputTokens, cacheCreation: d.cacheWriteInputTokens ?? 0, estimated: false, contextTokens: context });
    if (!parsed.success)
        throw codexProtocolError("Invalid Codex token usage", raw);
    return parsed.data;
}
const zeroUsage = () => ({ usd: null, inputTokens: 0, outputTokens: 0, cachedTokens: 0, cacheCreation: 0, estimated: false, contextTokens: null });
export class CodexEventMapper {
    items = new Map();
    unknownItems = new Set();
    parents = new Map();
    parts = new Map();
    inputs = [];
    turnId = "";
    totalUsage;
    turnUsage;
    constructor(resumed = false) { if (!resumed)
        this.totalUsage = zeroUsage(); }
    beginTurn(turnId) { this.turnId = turnId; this.items.clear(); this.unknownItems.clear(); this.parts.clear(); this.inputs = []; this.turnUsage = undefined; }
    registerInput(input, clientTurnId) { this.inputs.push({ key: inputKey(codexUserInput(input)), content: structuredClone(input), clientTurnId }); }
    getItem(id) { return this.items.get(id); }
    put(item, completed) {
        const old = this.items.get(item.id), out = [];
        if (old && old.type !== item.type)
            throw codexProtocolError("Codex item type changed", item);
        if (!old)
            out.push({ type: "itemStarted", turnId: this.turnId, item: structuredClone(completed ? { ...item, status: "inProgress" } : item) });
        if (completed)
            out.push({ type: "itemCompleted", turnId: this.turnId, item: structuredClone(item) });
        else if (old)
            out.push({ type: "itemUpdated", turnId: this.turnId, item: structuredClone(item) });
        this.items.set(item.id, item);
        return out;
    }
    ensureRequestItem(method, raw) {
        const p = codexRecord(raw), id = codexString(p.itemId, "approval itemId");
        if (this.items.has(id))
            return [];
        if (method === "item/fileChange/requestApproval")
            throw codexProtocolError("File approval arrived without its fileChange item", raw);
        if (method === "item/commandExecution/requestApproval")
            return this.put(mapCodexItem({ type: "commandExecution", id, command: p.command, cwd: p.cwd, status: "inProgress" }), false);
        return this.put({ id, type: "toolCall", status: "inProgress", payload: { name: method === "item/tool/requestUserInput" ? "request_user_input" : "request_permissions", input: json(p) } }, false);
    }
    map(method, raw) {
        const p = codexRecord(raw);
        if (p.itemId && this.unknownItems.has(p.itemId))
            return [{ type: "error", ...(this.turnId ? { turnId: this.turnId } : {}), error: codexProtocolError(`Notification for unsupported Codex item: ${method}`, raw).toJSON(), willRetry: false }];
        if (method === "thread/status/changed") {
            const native = codexRecord(p.status).type;
            if (native === "notLoaded")
                return []; // Loading is owned by spawn/resume.
            if (!["active", "idle", "systemError"].includes(native))
                throw codexProtocolError("Unknown Codex thread status", raw);
            return [{ type: "status", status: { type: native === "active" ? "running" : native } }];
        }
        if (method === "thread/tokenUsage/updated") {
            const u = codexRecord(p.tokenUsage), last = usage(u.last, codexRecord(u.last).totalTokens), total = usage(u.total, last.contextTokens);
            const increment = this.totalUsage ? { ...total, inputTokens: Math.max(0, total.inputTokens - this.totalUsage.inputTokens), outputTokens: Math.max(0, total.outputTokens - this.totalUsage.outputTokens), cachedTokens: Math.max(0, total.cachedTokens - this.totalUsage.cachedTokens), cacheCreation: Math.max(0, total.cacheCreation - this.totalUsage.cacheCreation) } : last;
            if (this.turnId) {
                const previous = this.turnUsage ?? zeroUsage();
                this.turnUsage = { ...last, inputTokens: previous.inputTokens + increment.inputTokens, outputTokens: previous.outputTokens + increment.outputTokens, cachedTokens: previous.cachedTokens + increment.cachedTokens, cacheCreation: previous.cacheCreation + increment.cacheCreation };
            }
            this.totalUsage = total;
            return [{ type: "usage", usage: total }];
        }
        if (method === "item/started" || method === "item/completed") {
            const native = codexRecord(p.item), completed = method === "item/completed";
            let item;
            try {
                item = mapCodexItem(native, completed, this.parents.get(native.agentThreadId));
            }
            catch (error) {
                if (!(error instanceof ProtocolError) || !error.message.startsWith("Unknown Codex item type:"))
                    throw error;
                // An additive native variant is observable but must not kill this thread.
                const fallback = { id: codexString(native.id, "item id"), type: "error", status: "failed", payload: { message: error.message, code: error.code, retryable: false } };
                this.unknownItems.add(fallback.id);
                return [...this.put(fallback, true), { type: "error", ...(this.turnId ? { turnId: this.turnId } : {}), error: error.toJSON(), willRetry: false }];
            }
            if (native.type === "collabAgentToolCall")
                for (const threadId of list(native.receiverThreadIds))
                    this.parents.set(threadId, item.id);
            if (item.type === "userMessage") {
                const old = this.items.get(item.id);
                const index = this.inputs.findIndex(input => input.key === inputKey(native.content));
                const matched = index >= 0 ? this.inputs.splice(index, 1)[0] : undefined;
                if (matched)
                    item.payload = { content: matched.content, ...(matched.clientTurnId ? { clientTurnId: matched.clientTurnId } : {}) };
                else if (old)
                    item.payload = old.payload;
            }
            return this.put(item, completed);
        }
        if (method === "item/fileChange/patchUpdated") {
            const old = this.items.get(p.itemId);
            if (old?.type !== "fileChange")
                throw codexProtocolError("Patch update without a fileChange item", raw);
            return this.put({ ...old, payload: { changes: codexFileChanges(p.changes), status: old.status ?? "inProgress" } }, false);
        }
        const deltaKinds = { "item/agentMessage/delta": "text", "item/reasoning/textDelta": "reasoning", "item/reasoning/summaryTextDelta": "summary", "item/commandExecution/outputDelta": "stdout" };
        if (method === "item/reasoning/summaryPartAdded") {
            if (this.items.get(p.itemId)?.type !== "reasoning")
                throw codexProtocolError("Reasoning part without an item", raw);
            return []; // AS flattens parts; the next text delta inserts the separator.
        }
        const kind = deltaKinds[method];
        if (kind) {
            const item = this.items.get(p.itemId), expected = kind === "text" ? "agentMessage" : kind === "stdout" ? "commandExecution" : "reasoning";
            if (!item || item.type !== expected || item.status !== "inProgress" || typeof p.delta !== "string")
                throw codexProtocolError("Invalid Codex item delta", raw);
            let text = p.delta;
            if (kind === "summary" || kind === "reasoning") {
                const indices = this.parts.get(item.id) ?? { summary: 0, reasoning: 0 }, index = kind === "summary" ? p.summaryIndex : p.contentIndex;
                if (!Number.isInteger(index) || index < indices[kind])
                    throw codexProtocolError("Out-of-order Codex reasoning part", raw);
                if (index > indices[kind])
                    text = "\n\n".repeat(index - indices[kind]) + text;
                indices[kind] = index;
                this.parts.set(item.id, indices);
            }
            const field = kind === "stdout" ? "aggregatedOutput" : kind === "summary" ? "summary" : "text";
            Object.assign(item.payload, { [field]: String(codexRecord(item.payload)[field] ?? "") + text });
            return [{ type: "itemDelta", turnId: this.turnId, itemId: item.id, kind, text }];
        }
        if (method === "turn/plan/updated")
            return [{ type: "plan", turnId: this.turnId, plan: ItemPayloadSchemas.plan.parse({ ...(p.explanation != null ? { text: p.explanation } : {}), steps: p.plan }) }];
        if (method === "turn/diff/updated")
            return [{ type: "diff", turnId: this.turnId, diff: p.diff }];
        if (method === "error") {
            const error = new ProtocolError(ErrorCode.engine_unavailable, codexString(codexRecord(p.error).message, "error message"), { raw: json(p.error), retryable: p.willRetry === true }).toJSON();
            const item = { id: `it_${crypto.randomUUID()}`, type: "error", status: "completed", payload: { message: error.message, code: error.code, retryable: p.willRetry === true } };
            return [...(this.turnId ? this.put(item, true) : []), { type: "error", ...(this.turnId ? { turnId: this.turnId } : {}), error, willRetry: p.willRetry === true }];
        }
        if (method === "turn/completed") {
            const turn = codexRecord(p.turn);
            if (!["completed", "interrupted", "failed"].includes(turn.status))
                throw codexProtocolError("Invalid completed Codex turn", raw);
            const result = { type: "turnCompleted", turnId: this.turnId, status: turn.status, ...(this.turnUsage ? { usage: this.turnUsage } : {}), ...(turn.error ? { error: new ProtocolError(ErrorCode.engine_unavailable, codexString(turn.error.message, "turn error"), { raw: json(turn.error) }).toJSON() } : {}) };
            this.turnId = "";
            return [result];
        }
        // Account, marketplace, and other notifications outside AS v1 are not items.
        return [];
    }
}
export function mapCodexRequest(method, raw, threadId, turnId, requestId, item) {
    const p = codexRecord(raw), payload = codexRecord(item?.payload);
    const base = { requestId, threadId, turnId, itemId: p.itemId, data: { raw: json(p) } };
    const approval = { ...base, startedAtMs: p.startedAtMs, ...(p.reason != null ? { reason: p.reason } : {}) };
    let params;
    switch (method) {
        case "item/commandExecution/requestApproval":
            params = { ...approval, command: p.command ?? payload.command, cwd: p.cwd ?? payload.cwd };
            break;
        case "item/fileChange/requestApproval":
            params = { ...approval, changes: payload.changes, ...(p.grantRoot != null ? { grantRoot: p.grantRoot } : {}) };
            break;
        case "item/permissions/requestApproval":
            params = { ...approval, cwd: p.cwd, permissions: p.permissions };
            break;
        case "item/tool/requestUserInput":
            params = { ...base, isBlocking: p.isBlocking, questions: list(p.questions).map(q => ({ id: q.id, question: q.question, header: q.header, ...(q.options != null ? { options: q.options } : {}) })) };
            break;
    }
    const parsed = PendingServerRequestSchema.safeParse({ method, params });
    if (!parsed.success)
        throw codexProtocolError(`Invalid Codex server request: ${method}`, raw);
    return parsed.data;
}
export function mapCodexDecision(method, raw) {
    const result = ServerRequestSchemas[method].result.parse(raw);
    if ("decision" in result)
        return { decision: { accept: "accept", acceptForSession: "acceptForSession", reject: "decline", abort: "cancel" }[result.decision] };
    if ("permissions" in result)
        return { permissions: result.permissions, scope: result.scope === "thread" ? "session" : result.scope };
    return result;
}
