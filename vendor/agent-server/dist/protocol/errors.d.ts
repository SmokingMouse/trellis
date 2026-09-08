import { z } from "zod";
export declare const ErrorCode: {
    readonly parse: -32700;
    readonly invalid_request: -32600;
    readonly method_not_found: -32601;
    readonly invalid_params: -32602;
    readonly internal: -32603;
    readonly thread_not_found: -32001;
    readonly not_initialized: -32002;
    readonly unsupported_protocol_version: -32003;
    readonly engine_unavailable: -32004;
    readonly unauthorized: -32005;
    readonly thread_busy: -32006;
    readonly thread_closed: -32007;
    readonly unsupported_capability: -32008;
    readonly cursor_expired: -32009;
    readonly turn_not_found: -32010;
    readonly turn_not_active: -32011;
    readonly lease_held: -32012;
    readonly duplicate_client_id: -32013;
    readonly already_resolved: -32014;
    readonly engine_protocol_error: -32015;
    readonly backend_unsupported: -32016;
};
export declare const ErrorCodeSchema: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015 | -32016>[]>;
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;
export declare const ErrorDataSchema: z.ZodObject<{
    threadId: z.ZodOptional<z.ZodString>;
    turnId: z.ZodOptional<z.ZodString>;
    itemId: z.ZodOptional<z.ZodString>;
    retryable: z.ZodBoolean;
    detail: z.ZodOptional<z.ZodJSONSchema>;
    stderr: z.ZodOptional<z.ZodString>;
    reason: z.ZodOptional<z.ZodString>;
    raw: z.ZodOptional<z.ZodJSONSchema>;
    holder: z.ZodOptional<z.ZodObject<{
        clientId: z.ZodString;
        label: z.ZodString;
    }, z.core.$strip>>;
}, z.core.$strip>;
export declare const RpcErrorSchema: z.ZodObject<{
    code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015 | -32016>[]>;
    message: z.ZodString;
    data: z.ZodOptional<z.ZodObject<{
        threadId: z.ZodOptional<z.ZodString>;
        turnId: z.ZodOptional<z.ZodString>;
        itemId: z.ZodOptional<z.ZodString>;
        retryable: z.ZodBoolean;
        detail: z.ZodOptional<z.ZodJSONSchema>;
        stderr: z.ZodOptional<z.ZodString>;
        reason: z.ZodOptional<z.ZodString>;
        raw: z.ZodOptional<z.ZodJSONSchema>;
        holder: z.ZodOptional<z.ZodObject<{
            clientId: z.ZodString;
            label: z.ZodString;
        }, z.core.$strip>>;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type ErrorData = z.infer<typeof ErrorDataSchema>;
export type RpcError = z.infer<typeof RpcErrorSchema>;
export declare class ProtocolError extends Error {
    readonly code: ErrorCode;
    readonly data: ErrorData;
    constructor(code: ErrorCode, message: string, data?: Partial<ErrorData>);
    toJSON(): RpcError;
}
export declare function rpcError(error: unknown): RpcError;
