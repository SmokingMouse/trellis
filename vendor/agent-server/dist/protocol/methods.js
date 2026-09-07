import { z } from "zod";
import { AbsolutePathSchema, BackendSchema, IdSchema, ItemSchema, JsonObjectSchema, LeaseSchema, PermissionSchema, QueuedTurnSchema, ThreadSchema, ThreadStatusTypeSchema, TurnSchema, UserInputSchema } from "./models.js";
import { PendingServerRequestSchema, ServerRequestMethodSchema } from "./requests.js";
const empty = z.object({});
const threadId = z.object({ threadId: IdSchema });
const limit = z.number().int().positive().max(10000).optional();
export const EngineCapabilitiesSchema = z.strictObject({ engineEvents: z.boolean().optional(), engineControl: z.boolean().optional(), permissionSet: z.boolean().optional(), effortSet: z.boolean().optional(), subAgentText: z.boolean().optional(), bashInput: z.boolean().optional(), compact: z.boolean().optional() });
export const ThreadOptionsSchema = z.strictObject({
    cwd: AbsolutePathSchema.optional(), model: z.string().optional(), effort: z.string().min(1).optional(), permission: PermissionSchema.optional(),
    sandbox: z.string().optional(), systemPrompt: z.string().optional(), tools: z.union([z.literal("all"), z.array(z.string())]).optional(),
    meta: JsonObjectSchema.optional(),
    autocompact: z.union([z.literal("auto"), z.number().int().min(100000).max(1000000)]).optional(),
});
export const StartThreadParamsSchema = ThreadOptionsSchema.extend({ backend: BackendSchema, clientThreadId: IdSchema.optional() });
export const StartTurnParamsSchema = z.object({
    threadId: IdSchema, input: z.array(UserInputSchema).min(1), clientTurnId: IdSchema.optional(), model: z.string().optional(),
    effort: z.string().optional(), cwd: AbsolutePathSchema.optional(), permission: PermissionSchema.optional(), sandbox: z.string().optional(),
});
export const AttachResultSchema = z.object({ thread: ThreadSchema, items: z.array(ItemSchema), nextSeq: z.number().int().positive(), queue: z.array(QueuedTurnSchema), pendingRequests: z.array(PendingServerRequestSchema) });
const threadResult = z.object({ thread: ThreadSchema, deduplicated: z.literal(true).optional() });
const resumeOptions = ThreadOptionsSchema.extend({ threadId: IdSchema.optional(), engineThreadId: IdSchema.optional(), backend: BackendSchema.optional() });
export const ResumeThreadParamsSchema = z.union([
    resumeOptions.extend({ threadId: IdSchema }), resumeOptions.extend({ engineThreadId: IdSchema }),
]);
export const MethodSchemas = {
    initialize: {
        params: z.object({ protocolVersion: z.string(), token: z.string().optional(), client: z.object({ name: z.string(), version: z.string(), kind: z.string(), label: z.string() }), capabilities: z.object({ pendingRequests: z.boolean().optional(), engineEvents: z.boolean().optional(), bashInput: z.boolean().optional(), serverRequests: z.array(ServerRequestMethodSchema).optional(), notifications: z.object({ optOut: z.array(z.string()) }).optional() }).optional() }),
        result: z.object({ protocolVersion: z.literal("as/1"), server: z.object({ name: z.string(), version: z.string() }), clientId: IdSchema, capabilities: z.object({ pendingRequests: z.boolean().optional(), midThreadFork: z.boolean().optional(), backends: z.array(BackendSchema), steer: z.boolean(), fork: z.boolean(), leases: z.boolean(), externalProviders: z.boolean(), maxQueuedTurns: z.number().int().nonnegative(), engine: EngineCapabilitiesSchema.optional() }) }),
    },
    "thread/start": { params: StartThreadParamsSchema, result: threadResult },
    "thread/engineControl": { params: z.strictObject({ threadId: IdSchema, subtype: z.string().min(1), params: JsonObjectSchema }), result: JsonObjectSchema },
    "thread/permission/set": { params: z.strictObject({ threadId: IdSchema, permission: PermissionSchema }), result: threadResult },
    "thread/effort/set": { params: z.strictObject({ threadId: IdSchema, maxThinkingTokens: z.number().int().nonnegative().nullable(), thinkingDisplay: z.enum(["summarized", "omitted"]).nullable().optional() }), result: JsonObjectSchema },
    "thread/compact": { params: z.strictObject({ threadId: IdSchema, instructions: z.string().optional(), clientTurnId: IdSchema.optional() }), result: z.object({ turn: TurnSchema, deduplicated: z.literal(true).optional() }) },
    "thread/resume": { params: ResumeThreadParamsSchema, result: threadResult.extend({ attached: z.boolean() }) },
    "thread/attach": { params: threadId.extend({ sinceSeq: z.number().int().nonnegative().optional() }).strict(), result: AttachResultSchema },
    "thread/detach": { params: threadId, result: empty },
    "thread/items/list": { params: threadId.extend({ cursor: z.string().optional(), limit, turnId: IdSchema.optional(), direction: z.enum(["asc", "desc"]).optional() }), result: z.object({ items: z.array(ItemSchema), nextCursor: z.string().nullable() }) },
    "thread/list": { params: z.object({ status: ThreadStatusTypeSchema.optional(), backend: BackendSchema.optional(), cwd: AbsolutePathSchema.optional(), limit, cursor: z.string().optional() }), result: z.object({ threads: z.array(ThreadSchema), nextCursor: z.string().nullable() }) },
    "thread/read": { params: threadId, result: z.object({ thread: ThreadSchema }) },
    "thread/fork": { params: threadId.extend({ fromItemId: IdSchema.optional(), clientThreadId: IdSchema.optional() }), result: threadResult },
    "thread/close": { params: threadId.extend({ reason: z.string().optional() }), result: empty },
    "thread/interrupt": { params: threadId, result: z.object({ interruptedTurnId: IdSchema.nullable() }) },
    "thread/lease/acquire": { params: threadId.extend({ ttlMs: z.number().int().positive().optional() }), result: z.object({ lease: LeaseSchema }) },
    "thread/lease/release": { params: threadId, result: empty },
    "turn/start": { params: StartTurnParamsSchema, result: z.object({ turn: TurnSchema, deduplicated: z.literal(true).optional() }) },
    "turn/steer": { params: threadId.extend({ expectedTurnId: IdSchema, input: z.array(UserInputSchema).min(1), clientTurnId: IdSchema.optional() }), result: empty },
    "turn/interrupt": { params: threadId.extend({ turnId: IdSchema.optional() }), result: empty },
    "turn/cancel": { params: threadId.extend({ turnId: IdSchema }), result: empty },
    "thread/queue/read": { params: threadId, result: z.object({ queue: z.array(QueuedTurnSchema) }) },
    "server/health": { params: empty, result: z.object({ uptimeMs: z.number().nonnegative(), threads: z.object({ running: z.number().int(), idle: z.number().int(), closed: z.number().int() }), engines: z.array(z.object({ threadId: IdSchema, backend: BackendSchema, engineThreadId: IdSchema.nullable() })) }) },
    "server/config/read": { params: empty, result: z.object({ allowed_roots: z.array(z.string()), maxQueuedTurns: z.number().int(), orphanTimeoutMs: z.number(), idleTimeoutMs: z.number() }) },
};
export const MethodSchema = z.enum(Object.keys(MethodSchemas));
