import { z } from "zod";
import { RpcErrorSchema } from "./errors.js";
export const RpcIdSchema = z.union([z.number().int(), z.string()]);
export const RequestSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, method: z.string(), params: z.json() });
export const ResponseSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: RpcIdSchema, result: z.json() });
export const ErrorResponseSchema = z.strictObject({ jsonrpc: z.literal("2.0"), id: RpcIdSchema.nullable(), error: RpcErrorSchema });
export const NotificationSchema = z.strictObject({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.json() });
export const FrameSchema = z.union([RequestSchema, ResponseSchema, ErrorResponseSchema, NotificationSchema]);
