import { z } from "zod";
import { RpcErrorSchema } from "./errors.js";
export const IdSchema = z.string().min(1);
export const TimestampSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const JsonObjectSchema = z.record(z.string(), z.json());
export const AbsolutePathSchema = z.string().regex(/^(?:\/|[A-Za-z]:[\\/])/, "absolute local path required");
export const BackendSchema = z.enum(["claude", "codex", "external"]);
export const PermissionSchema = z.enum(["readonly", "auto-edit", "full", "default"]);
export const UserInputSchema = z.discriminatedUnion("type", [
    z.object({ type: z.literal("text"), text: z.string() }),
    z.object({ type: z.literal("image"), path: AbsolutePathSchema, mime: z.string().min(1) }),
    z.object({ type: z.literal("file"), path: AbsolutePathSchema, mime: z.string().optional(), name: z.string().optional() }),
]);
// Keep this schema structurally checked against the existing agent Cost contract.
export const UsageSchema = z.object({
    usd: z.number().nonnegative().nullable(), inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(), cachedTokens: z.number().int().nonnegative(),
    cacheCreation: z.number().int().nonnegative(), estimated: z.boolean(),
    contextTokens: z.number().int().nonnegative().nullable(),
});
export const ThreadStatusTypeSchema = z.enum(["spawning", "idle", "running", "interrupted", "systemError", "closed"]);
export const ThreadStatusSchema = z.object({ type: ThreadStatusTypeSchema, error: RpcErrorSchema.optional() });
export const ThreadSchema = z.object({
    id: IdSchema, backend: BackendSchema, engineThreadId: IdSchema.nullable(), status: ThreadStatusSchema,
    cwd: AbsolutePathSchema, model: z.string().optional(), title: z.string().optional(), meta: JsonObjectSchema.optional(),
    createdAtMs: TimestampSchema, closedAtMs: TimestampSchema.optional(), clientThreadId: IdSchema.optional(),
});
export const TurnSchema = z.object({
    id: IdSchema, threadId: IdSchema, ordinal: z.number().int().positive(),
    status: z.enum(["queued", "inProgress", "completed", "interrupted", "failed", "cancelled"]),
    clientTurnId: IdSchema.optional(), enqueuedAtMs: TimestampSchema,
    startedAtMs: TimestampSchema.optional(), completedAtMs: TimestampSchema.optional(),
    durationMs: z.number().nonnegative().optional(), usage: UsageSchema.optional(), error: RpcErrorSchema.optional(),
});
export const QueuedTurnSchema = z.object({
    turnId: IdSchema, clientTurnId: IdSchema.optional(), position: z.number().int().nonnegative(),
    enqueuedAtMs: TimestampSchema, preview: z.string(),
});
export const ClientIdentitySchema = z.object({ clientId: IdSchema, label: z.string() });
export const LeaseSchema = z.object({ threadId: IdSchema, holder: ClientIdentitySchema, expiresAtMs: TimestampSchema });
export const FileChangesSchema = z.array(z.object({ path: z.string(), kind: z.enum(["add", "update", "delete"]), diff: z.string().optional() }));
export const PlanStepSchema = z.object({ step: z.string(), status: z.enum(["pending", "inProgress", "completed"]) });
export const PlanSchema = z.object({ text: z.string().optional(), steps: z.array(PlanStepSchema).optional() });
const common = {
    id: IdSchema, status: z.enum(["inProgress", "completed", "failed", "rejected"]).optional(),
    seq: z.number().int().positive(), completedSeq: z.number().int().positive().optional(), turnId: IdSchema, startedAtMs: TimestampSchema, completedAtMs: TimestampSchema.optional(),
};
export const ItemPayloadSchemas = {
    userMessage: z.object({ content: z.array(UserInputSchema), clientTurnId: IdSchema.optional() }),
    agentMessage: z.object({ text: z.string(), phase: z.string().optional() }),
    reasoning: z.object({ summary: z.string().optional(), text: z.string().optional() }),
    commandExecution: z.object({ command: z.string(), cwd: z.string(), exitCode: z.number().int().nullable().optional(), aggregatedOutput: z.string().optional(), durationMs: z.number().nonnegative().optional() }),
    fileChange: z.object({ changes: FileChangesSchema, status: z.enum(["inProgress", "completed", "failed", "rejected"]) }),
    toolCall: z.object({ name: z.string(), namespace: z.string().optional(), input: z.json(), output: z.json().optional(), isError: z.boolean().optional() }),
    mcpToolCall: z.object({ server: z.string(), tool: z.string(), arguments: z.json(), result: z.json().optional(), error: z.json().optional() }),
    subAgent: z.object({ kind: z.enum(["agent", "bash", "workflow"]), parentItemId: IdSchema, phase: z.string(), progress: z.json().optional(), report: z.json().optional() }),
    webSearch: z.object({ query: z.string(), results: z.json().optional() }),
    imageOutput: z.object({ paths: z.array(z.string()) }),
    plan: PlanSchema,
    contextCompaction: z.object({}),
    error: z.object({ message: z.string(), code: z.union([z.number(), z.string()]).optional(), retryable: z.boolean() }),
};
export const ItemTypeSchema = z.enum(Object.keys(ItemPayloadSchemas));
// Explicit variants preserve the type/payload relationship in z.infer.
function item(type) { return z.object({ ...common, type: z.literal(type), payload: ItemPayloadSchemas[type] }); }
export const ItemSchema = z.discriminatedUnion("type", [
    item("userMessage"), item("agentMessage"), item("reasoning"), item("commandExecution"), item("fileChange"),
    item("toolCall"), item("mcpToolCall"), item("subAgent"), item("webSearch"), item("imageOutput"), item("plan"), item("contextCompaction"), item("error"),
]);
//# sourceMappingURL=models.js.map