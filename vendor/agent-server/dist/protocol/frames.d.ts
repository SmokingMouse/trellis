import { z } from "zod";
export declare const RpcIdSchema: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
export declare const RequestSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    method: z.ZodString;
    params: z.ZodJSONSchema;
}, z.core.$strict>;
export declare const ResponseSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    result: z.ZodJSONSchema;
}, z.core.$strict>;
export declare const ErrorResponseSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    error: z.ZodObject<{
        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodObject<{
            threadId: z.ZodOptional<z.ZodString>;
            turnId: z.ZodOptional<z.ZodString>;
            itemId: z.ZodOptional<z.ZodString>;
            retryable: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodJSONSchema>;
            stderr: z.ZodOptional<z.ZodString>;
            raw: z.ZodOptional<z.ZodJSONSchema>;
            holder: z.ZodOptional<z.ZodObject<{
                clientId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strict>;
export declare const NotificationSchema: z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    method: z.ZodString;
    params: z.ZodJSONSchema;
}, z.core.$strict>;
export declare const FrameSchema: z.ZodUnion<readonly [z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    method: z.ZodString;
    params: z.ZodJSONSchema;
}, z.core.$strict>, z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>;
    result: z.ZodJSONSchema;
}, z.core.$strict>, z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    id: z.ZodNullable<z.ZodUnion<readonly [z.ZodNumber, z.ZodString]>>;
    error: z.ZodObject<{
        code: z.ZodUnion<z.ZodLiteral<-32700 | -32600 | -32601 | -32602 | -32603 | -32001 | -32002 | -32003 | -32004 | -32005 | -32006 | -32007 | -32008 | -32009 | -32010 | -32011 | -32012 | -32013 | -32014 | -32015>[]>;
        message: z.ZodString;
        data: z.ZodOptional<z.ZodObject<{
            threadId: z.ZodOptional<z.ZodString>;
            turnId: z.ZodOptional<z.ZodString>;
            itemId: z.ZodOptional<z.ZodString>;
            retryable: z.ZodBoolean;
            detail: z.ZodOptional<z.ZodJSONSchema>;
            stderr: z.ZodOptional<z.ZodString>;
            raw: z.ZodOptional<z.ZodJSONSchema>;
            holder: z.ZodOptional<z.ZodObject<{
                clientId: z.ZodString;
                label: z.ZodString;
            }, z.core.$strip>>;
        }, z.core.$strip>>;
    }, z.core.$strip>;
}, z.core.$strict>, z.ZodObject<{
    jsonrpc: z.ZodLiteral<"2.0">;
    method: z.ZodString;
    params: z.ZodJSONSchema;
}, z.core.$strict>]>;
export type RpcId = z.infer<typeof RpcIdSchema>;
export type Request = z.infer<typeof RequestSchema>;
export type Response = z.infer<typeof ResponseSchema>;
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;
export type Notification = z.infer<typeof NotificationSchema>;
export type Frame = z.infer<typeof FrameSchema>;
