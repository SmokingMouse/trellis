import { EventType } from "@smokingmouse/agent";
import { ErrorCode, ProtocolError, UsageSchema } from "../protocol/index.js";
export function jsonValue(value) { return value === undefined ? null : JSON.parse(JSON.stringify(value)); }
export function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
export function fileChanges(input, name = "Edit") {
    if (Array.isArray(input.changes))
        return input.changes;
    const path = String(input.file_path ?? input.path ?? "");
    const edits = Array.isArray(input.edits) ? input.edits : [input];
    return edits.map((edit) => ({ path: String(edit.file_path ?? path), kind: name === "Write" ? "add" : "update", diff: String(edit.diff ?? (name === "Write" ? edit.content ?? "" : `-${edit.old_string ?? ""}\n+${edit.new_string ?? ""}`)) }));
}
/** AgentEvent is a stream; this mapper gives each item a stable identity. */
export class ClaudeEventMapper {
    cwd;
    items = new Map();
    textItem;
    reasoningItem;
    turnId = "";
    constructor(cwd = process.cwd()) {
        this.cwd = cwd;
    }
    beginTurn(turnId) { this.turnId = turnId; this.items.clear(); this.textItem = undefined; this.reasoningItem = undefined; }
    start(item, out) { this.items.set(item.id, item); out.push({ type: "itemStarted", turnId: this.turnId, item: structuredClone(item) }); }
    complete(item, out, failed = false) {
        if (item.status !== "inProgress")
            return;
        item.status = failed ? "failed" : "completed";
        if (item.type === "fileChange")
            Object.assign(item.payload, { status: item.status });
        out.push({ type: "itemCompleted", turnId: this.turnId, item: structuredClone(item) });
    }
    finishText(out) {
        if (this.textItem)
            this.complete(this.textItem, out);
        if (this.reasoningItem)
            this.complete(this.reasoningItem, out);
        this.textItem = undefined;
        this.reasoningItem = undefined;
    }
    finish(status, error) {
        const out = [];
        for (const item of this.items.values())
            this.complete(item, out, status !== "completed");
        out.push({ type: "turnCompleted", turnId: this.turnId, status, ...(error ? { error: error.toJSON() } : {}) });
        this.textItem = undefined;
        this.reasoningItem = undefined;
        return out;
    }
    map(event) {
        const out = [];
        const d = event.data;
        const create = (type, payload, id = `it_${crypto.randomUUID()}`) => ({ id, type, payload, status: "inProgress" });
        switch (event.type) {
            case EventType.SessionStart:
                if (event.sessionId)
                    out.push({ type: "metadata", engineThreadId: event.sessionId });
                break;
            case EventType.TextChunk:
            case EventType.Thinking: {
                const thinking = event.type === EventType.Thinking;
                if (thinking && this.textItem)
                    this.finishText(out);
                if (!thinking && this.reasoningItem) {
                    this.complete(this.reasoningItem, out);
                    this.reasoningItem = undefined;
                }
                let item = thinking ? this.reasoningItem : this.textItem;
                if (!item) {
                    item = create(thinking ? "reasoning" : "agentMessage", { text: "" });
                    this.start(item, out);
                    if (thinking)
                        this.reasoningItem = item;
                    else
                        this.textItem = item;
                }
                const text = String(d.text ?? "");
                Object.assign(item.payload, { text: String(record(item.payload).text ?? "") + text });
                out.push({ type: "itemDelta", turnId: this.turnId, itemId: item.id, kind: thinking ? "reasoning" : "text", text });
                break;
            }
            case EventType.ToolCall: {
                this.finishText(out);
                const id = String(d.id ?? `it_${crypto.randomUUID()}`);
                if (this.items.has(id))
                    break; // permission can precede the assistant envelope
                const name = String(d.name ?? "unknown"), input = record(d.input);
                let item;
                if (name === "Bash")
                    item = create("commandExecution", { command: String(input.command ?? ""), cwd: this.cwd, aggregatedOutput: "" }, id);
                else if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name))
                    item = create("fileChange", { changes: fileChanges(input, name), status: "inProgress" }, id);
                else if (name.startsWith("mcp__")) {
                    const [, server, ...tool] = name.split("__");
                    item = create("mcpToolCall", { server: server ?? "", tool: tool.join("__"), arguments: jsonValue(d.input) }, id);
                }
                else if (name === "WebSearch")
                    item = create("webSearch", { query: String(input.query ?? "") }, id);
                else if (name === "ExitPlanMode")
                    item = create("plan", { text: String(input.plan ?? "") }, id);
                else
                    item = create("toolCall", { name, input: jsonValue(d.input) }, id);
                this.start(item, out);
                break;
            }
            case EventType.ToolCallDone: {
                const item = this.items.get(String(d.id));
                if (!item) {
                    out.push({ type: "error", ...(this.turnId ? { turnId: this.turnId } : {}), error: new ProtocolError(ErrorCode.engine_protocol_error, "tool result without tool call", { raw: jsonValue(d) }).toJSON(), willRetry: false });
                    break;
                }
                const failed = Boolean(d.isError);
                if (item.type === "commandExecution")
                    Object.assign(item.payload, { aggregatedOutput: String(d.output ?? "") + (d.stderr ? `\n${d.stderr}` : ""), ...(typeof d.exitCode === "number" ? { exitCode: d.exitCode } : {}) });
                else if (item.type === "toolCall")
                    Object.assign(item.payload, { output: jsonValue(d.output), isError: failed });
                else if (item.type === "mcpToolCall")
                    Object.assign(item.payload, failed ? { error: jsonValue(d.output) } : { result: jsonValue(d.output) });
                else if (item.type === "webSearch")
                    Object.assign(item.payload, { results: jsonValue(d.output) });
                this.complete(item, out, failed);
                break;
            }
            case EventType.Task: {
                const id = String(d.taskId ?? `task_${d.toolUseId}`);
                let item = this.items.get(id);
                if (!item) {
                    item = create("subAgent", { kind: d.taskType === "local_bash" ? "bash" : d.taskType === "local_workflow" ? "workflow" : "agent", parentItemId: String(d.toolUseId), phase: String(d.phase ?? "started") }, id);
                    this.start(item, out);
                }
                Object.assign(item.payload, { phase: String(d.phase ?? "progress"), progress: jsonValue(d), ...(d.summary !== undefined ? { report: jsonValue(d.summary) } : {}) });
                out.push({ type: "itemUpdated", turnId: this.turnId, item: structuredClone(item) });
                if (d.phase === "completed")
                    this.complete(item, out, d.status === "failed");
                break;
            }
            case EventType.FileChange: {
                const item = create("fileChange", { changes: fileChanges(record(d)), status: "inProgress" });
                this.start(item, out);
                this.complete(item, out);
                break;
            }
            case EventType.ImageOutput: {
                const item = create("imageOutput", { paths: Array.isArray(d.paths) ? d.paths.map(String) : [] });
                this.start(item, out);
                this.complete(item, out);
                break;
            }
            case EventType.Error: {
                const item = create("error", { message: String(d.message ?? "claude error"), retryable: false });
                this.start(item, out);
                this.complete(item, out);
                out.push(...this.finish("failed", new ProtocolError(ErrorCode.engine_unavailable, String(d.message ?? "claude error"))));
                break;
            }
            case EventType.Result: {
                if (!this.textItem && d.text && ![...this.items.values()].some(i => i.type === "agentMessage")) {
                    const item = create("agentMessage", { text: String(d.text) });
                    this.start(item, out);
                }
                out.push(...this.finish("completed"));
                const last = out.at(-1);
                if (last.type === "turnCompleted" && d.cost)
                    last.usage = UsageSchema.parse(d.cost);
                break;
            }
        }
        return out;
    }
}
export function mapPermissionRequest(req, threadId, turnId, cwd, now = Date.now()) {
    const base = { requestId: req.requestId, threadId, turnId, itemId: req.toolUseId }, input = record(req.input);
    if (req.toolName === "AskUserQuestion")
        return { method: "item/tool/requestUserInput", params: { ...base, isBlocking: true, questions: (Array.isArray(input.questions) ? input.questions : []).map((q, i) => ({ id: String(q.id ?? `q_${i}`), question: String(q.question ?? ""), ...(q.header ? { header: String(q.header) } : {}), ...(typeof q.multiSelect === "boolean" ? { multiSelect: q.multiSelect } : {}), ...(Array.isArray(q.options) ? { options: q.options.map((o) => ({ label: String(o.label ?? ""), description: String(o.description ?? "") })) } : {}) })) } };
    const approval = { ...base, startedAtMs: now };
    if (req.toolName === "Bash")
        return { method: "item/commandExecution/requestApproval", params: { ...approval, command: String(input.command ?? ""), cwd } };
    if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(req.toolName))
        return { method: "item/fileChange/requestApproval", params: { ...approval, changes: fileChanges(input, req.toolName) } };
    return { method: "item/permissions/requestApproval", params: { ...approval, cwd, permissions: { toolName: req.toolName, input: jsonValue(req.input) } } };
}
export function mapPermissionDecision(req, decision) {
    if ("decision" in decision)
        return decision.decision === "accept" || decision.decision === "acceptForSession" ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: decision.decision === "abort" ? "Aborted by client" : "Rejected by client" };
    if ("answers" in decision) {
        const questions = record(req.input).questions ?? [];
        const answers = Object.fromEntries(Object.entries(decision.answers).map(([id, answer]) => {
            const i = /^q_(\d+)$/.exec(id)?.[1];
            const q = questions.find((q) => q.id === id) ?? (i !== undefined ? questions[Number(i)] : undefined);
            return [q?.question ?? id, answer.answers.join(", ")];
        }));
        return { behavior: "allow", updatedInput: { ...record(req.input), answers } };
    }
    return Object.keys(decision.permissions).length ? { behavior: "allow", updatedInput: req.input } : { behavior: "deny", message: "No permissions granted" };
}
//# sourceMappingURL=claude-mapper.js.map