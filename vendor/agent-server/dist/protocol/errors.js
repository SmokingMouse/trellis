import { z } from "zod";
export const ErrorCode = {
    parse: -32700, invalid_request: -32600, method_not_found: -32601,
    invalid_params: -32602, internal: -32603,
    thread_not_found: -32001, not_initialized: -32002, unsupported_protocol_version: -32003,
    engine_unavailable: -32004, unauthorized: -32005, thread_busy: -32006,
    thread_closed: -32007, unsupported_capability: -32008, cursor_expired: -32009,
    turn_not_found: -32010, turn_not_active: -32011, lease_held: -32012,
    duplicate_client_id: -32013, already_resolved: -32014, engine_protocol_error: -32015,
};
export const ErrorCodeSchema = z.union(Object.values(ErrorCode).map(code => z.literal(code)));
export const ErrorDataSchema = z.object({
    threadId: z.string().optional(), turnId: z.string().optional(), itemId: z.string().optional(),
    retryable: z.boolean(), detail: z.json().optional(), stderr: z.string().optional(),
    raw: z.json().optional(), holder: z.object({ clientId: z.string(), label: z.string() }).optional(),
});
export const RpcErrorSchema = z.object({ code: ErrorCodeSchema, message: z.string(), data: ErrorDataSchema.optional() });
export class ProtocolError extends Error {
    code;
    data;
    constructor(code, message, data = {}) {
        super(message);
        this.code = code;
        this.name = "ProtocolError";
        this.data = { retryable: false, ...data };
    }
    toJSON() { return { code: this.code, message: this.message, data: this.data }; }
}
export function rpcError(error) {
    if (error instanceof ProtocolError)
        return error.toJSON();
    if (error instanceof z.ZodError)
        return new ProtocolError(ErrorCode.invalid_params, "invalid params", { detail: JSON.parse(JSON.stringify(error.issues)) }).toJSON();
    return new ProtocolError(ErrorCode.internal, error instanceof Error ? error.message : String(error)).toJSON();
}
//# sourceMappingURL=errors.js.map