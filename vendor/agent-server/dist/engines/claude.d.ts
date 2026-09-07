import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type JsonObject, type StartTurnParams, type UserInput } from "../protocol/index.js";
import { AsyncQueue, type EngineEvent, type EngineSession, type SessionOptions } from "./session.js";
export declare const CLAUDE_CONTROL_ALLOWLIST: Set<string>;
export declare function claudePermission(permission?: SessionOptions["permission"]): string;
export declare function buildClaudeLaunch(options: SessionOptions): {
    args: string[];
    env: NodeJS.ProcessEnv;
};
export declare function validateClaudeEffort(effort?: string): void;
export declare function claudeUserMessage(input: UserInput[]): Record<string, unknown>;
export interface ClaudeEngineOptions {
    executable?: string;
    handshakeTimeoutMs?: number;
    spawnProcess?: (command: string, args: string[], options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
    }) => ChildProcessWithoutNullStreams;
}
export declare class ClaudeEngine implements EngineSession {
    private readonly config;
    readonly backend: "claude";
    readonly events: AsyncQueue<EngineEvent>;
    engineThreadId: string | null;
    private process?;
    private options?;
    private mapper;
    private active;
    private interrupting;
    private closed;
    private dead;
    private stderr;
    private buffer;
    private context;
    private controls;
    private taskParents;
    private sessionGrants;
    private nativeRequests;
    private sawTextDelta;
    private sawThinkingDelta;
    private partials;
    private bash?;
    constructor(config?: ClaudeEngineOptions);
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    engineControl(subtype: string, params: JsonObject): Promise<JsonObject>;
    private permissionChanged;
    setPermission(permission: NonNullable<SessionOptions["permission"]>): Promise<void>;
    private assertAlive;
    validateTurn(options: StartTurnParams): void;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    steer(turnId: string, input: UserInput[]): Promise<void>;
    interrupt(turnId: string): Promise<void>;
    close(_reason: string): Promise<void>;
    private write;
    private control;
    private rejectControls;
    private fail;
    private emit;
    /** Native frame parsing is separated from process creation for offline fixtures. */
    receive(raw: unknown): void;
}
