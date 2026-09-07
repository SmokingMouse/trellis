import { z } from "zod";
import { ClientIdentitySchema, FileChangesSchema, IdSchema, ItemSchema, JsonObjectSchema, PlanSchema, QueuedTurnSchema, ThreadSchema, ThreadStatusSchema, TimestampSchema, TurnSchema, UsageSchema } from "./models.js";
import { RpcErrorSchema } from "./errors.js";
import { BackendSchema } from "./models.js";
import { PermissionSchema } from "./models.js";
import { PendingRequestStateSchema } from "./requests.js";
const item = { threadId: IdSchema, turnId: IdSchema, itemId: IdSchema };
const delta = z.object({ ...item, delta: z.string() });
export const NotificationSchemas = {
    "thread/pendingRequests": PendingRequestStateSchema,
    "thread/permission/changed": z.strictObject({ threadId: IdSchema, permission: PermissionSchema }),
    "thread/engineEvent": z.strictObject({ threadId: IdSchema, turnId: IdSchema.optional(), backend: BackendSchema, subtype: z.string(), payload: JsonObjectSchema }),
    initialized: z.object({}),
    "thread/started": z.object({ threadId: IdSchema, thread: ThreadSchema }),
    "thread/status/changed": z.object({ threadId: IdSchema, status: ThreadStatusSchema }),
    "thread/queue/changed": z.object({ threadId: IdSchema, queue: z.array(QueuedTurnSchema) }),
    "thread/closed": z.object({ threadId: IdSchema, reason: z.string() }),
    "thread/tokenUsage/updated": z.object({ threadId: IdSchema, usage: UsageSchema }),
    "thread/metadata/updated": z.object({ threadId: IdSchema, engineThreadId: IdSchema.nullable().optional(), model: z.string().optional(), title: z.string().optional(), meta: JsonObjectSchema.optional() }),
    "turn/started": z.object({ threadId: IdSchema, turnId: IdSchema, turn: TurnSchema }),
    "turn/completed": z.object({ threadId: IdSchema, turnId: IdSchema, turn: TurnSchema }),
    "turn/plan/updated": z.object({ threadId: IdSchema, turnId: IdSchema, plan: PlanSchema }),
    "turn/diff/updated": z.object({ threadId: IdSchema, turnId: IdSchema, diffStat: JsonObjectSchema }),
    "item/started": z.object({ ...item, item: ItemSchema, seq: z.number().int().positive(), startedAtMs: TimestampSchema }),
    "item/completed": z.object({ ...item, item: ItemSchema, seq: z.number().int().positive(), completedAtMs: TimestampSchema }),
    "item/agentMessage/delta": delta,
    "item/reasoning/textDelta": delta,
    "item/reasoning/summaryTextDelta": delta,
    "item/commandExecution/outputDelta": z.object({ ...item, chunk: z.string(), stream: z.enum(["stdout", "stderr"]) }),
    "item/fileChange/patchUpdated": z.object({ ...item, changes: FileChangesSchema }),
    "item/subAgent/progress": z.object({ ...item, phase: z.string(), progress: z.json().optional() }),
    "serverRequest/resolved": z.object({ threadId: IdSchema, requestId: IdSchema, decidedBy: ClientIdentitySchema, outcome: z.json() }),
    "serverRequest/expired": z.object({ threadId: IdSchema, requestId: IdSchema, reason: z.string() }),
    error: z.object({ threadId: IdSchema.optional(), turnId: IdSchema.optional(), error: RpcErrorSchema, willRetry: z.boolean() }),
    "server/shuttingDown": z.object({ reason: z.string(), graceMs: z.number().nonnegative() }),
};
export const NotificationMethodSchema = z.enum(Object.keys(NotificationSchemas));
