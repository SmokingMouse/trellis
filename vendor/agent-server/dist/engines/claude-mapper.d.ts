import { type AgentEvent } from "@smokingmouse/agent";
import { ProtocolError, type PendingServerRequest, type ServerRequestResult } from "../protocol/index.js";
import type { EngineEvent } from "./session.js";
export declare function jsonValue(value: unknown): any;
export declare function record(value: unknown): Record<string, any>;
export declare function fileChanges(input: Record<string, any>, name?: string): Array<{
    path: string;
    kind: "add" | "update" | "delete";
    diff?: string;
}>;
/** AgentEvent is a stream; this mapper gives each item a stable identity. */
export declare class ClaudeEventMapper {
    private readonly cwd;
    private items;
    private textItem?;
    private reasoningItem?;
    private turnId;
    constructor(cwd?: string);
    beginTurn(turnId: string): void;
    private start;
    private complete;
    private finishText;
    finish(status: "completed" | "interrupted" | "failed", error?: ProtocolError): EngineEvent[];
    map(event: AgentEvent): EngineEvent[];
}
export interface ToolPermissionRequest {
    requestId: string;
    toolUseId: string;
    toolName: string;
    input: unknown;
}
export declare function mapPermissionRequest(req: ToolPermissionRequest, threadId: string, turnId: string, cwd: string, now?: number): PendingServerRequest;
export declare function mapPermissionDecision(req: ToolPermissionRequest, decision: ServerRequestResult): {
    behavior: "allow" | "deny";
    updatedInput?: unknown;
    message?: string;
};
//# sourceMappingURL=claude-mapper.d.ts.map