import { z } from "zod";
import { ClientIdentitySchema, IdSchema, TimestampSchema, FileChangesSchema, JsonObjectSchema } from "./models.js";
export const PendingRequestStateSchema = z.object({
    threadId: IdSchema, turnId: IdSchema, requestId: IdSchema, itemId: IdSchema,
    kind: z.enum(["commandExecution", "fileChange", "permissions", "userInput"]),
    status: z.enum(["pending", "resolved", "expired"]), decidedBy: ClientIdentitySchema.nullable(),
    createdAtMs: TimestampSchema, updatedAtMs: TimestampSchema, reason: z.string().optional(),
});
export const ApprovalDecisionSchema = z.enum(["accept", "acceptForSession", "reject", "abort"]);
// Permissions remain backend-specific JSON objects in AS v1.
export const GrantedPermissionsSchema = JsonObjectSchema;
export const QuestionSchema = z.object({
    id: IdSchema, question: z.string(), header: z.string().optional(), multiSelect: z.boolean().optional(),
    options: z.array(z.object({ label: z.string(), description: z.string().optional() })).optional(),
});
export const AnswerSchema = z.object({ answers: z.array(z.string()) });
const base = { requestId: IdSchema, threadId: IdSchema, turnId: IdSchema, itemId: IdSchema, data: z.object({ raw: z.json() }).optional() };
const approval = { ...base, reason: z.string().optional(), startedAtMs: TimestampSchema };
const decision = z.object({ decision: ApprovalDecisionSchema });
export const ServerRequestSchemas = {
    "item/commandExecution/requestApproval": {
        params: z.object({ ...approval, command: z.string(), cwd: z.string() }), result: decision,
    },
    "item/fileChange/requestApproval": {
        params: z.object({ ...approval, changes: FileChangesSchema, grantRoot: z.string().optional() }), result: decision,
    },
    "item/permissions/requestApproval": {
        params: z.object({ ...approval, cwd: z.string(), permissions: JsonObjectSchema }),
        result: z.object({ permissions: GrantedPermissionsSchema, scope: z.enum(["turn", "thread", "session"]) }),
    },
    "item/tool/requestUserInput": {
        params: z.object({ ...base, questions: z.array(QuestionSchema), isBlocking: z.boolean() }),
        result: z.object({ answers: z.record(z.string(), AnswerSchema) }),
    },
};
export const ServerRequestMethodSchema = z.enum(Object.keys(ServerRequestSchemas));
export const PendingServerRequestSchema = z.discriminatedUnion("method", [
    z.object({ method: z.literal("item/commandExecution/requestApproval"), params: ServerRequestSchemas["item/commandExecution/requestApproval"].params }),
    z.object({ method: z.literal("item/fileChange/requestApproval"), params: ServerRequestSchemas["item/fileChange/requestApproval"].params }),
    z.object({ method: z.literal("item/permissions/requestApproval"), params: ServerRequestSchemas["item/permissions/requestApproval"].params }),
    z.object({ method: z.literal("item/tool/requestUserInput"), params: ServerRequestSchemas["item/tool/requestUserInput"].params }),
]).and(z.object({ state: PendingRequestStateSchema.optional() }));
export function pendingRequestState(request, createdAtMs) {
    const { threadId, turnId, requestId, itemId } = request.params;
    const kinds = { "item/commandExecution/requestApproval": "commandExecution", "item/fileChange/requestApproval": "fileChange", "item/permissions/requestApproval": "permissions", "item/tool/requestUserInput": "userInput" };
    return { threadId, turnId, requestId, itemId, kind: kinds[request.method], status: "pending", decidedBy: null, createdAtMs, updatedAtMs: createdAtMs };
}
