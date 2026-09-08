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
    /** Auto-allow readonly Bash commands under default/plan/acceptEdits without an approval round trip. Default true. */
    readonlyAutoAllow?: boolean;
    /** Overrides the default readonly command allowlist entirely (not merged). */
    readonlyCommands?: readonly string[];
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
    private lastAssistantUuid?;
    private seeding?;
    private readonly readonlyAutoAllow;
    private readonly readonlyCommandSet;
    constructor(config?: ClaudeEngineOptions);
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    engineControl(subtype: string, params: JsonObject): Promise<JsonObject>;
    private permissionChanged;
    setPermission(permission: NonNullable<SessionOptions["permission"]>): Promise<void>;
    private assertAlive;
    validateTurn(options: StartTurnParams): void;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    /**
     * Returns a denial message if the standalone bash turn must not reach the engine, else undefined.
     * A standalone bash turn (`turn/start` with `input:[{type:"bash"}]`) never round-trips native
     * can_use_tool for ANY permission mode (see the comment at the call site in sendTurn), so this is
     * the only gate this command will ever see. readonly_auto_allow only decides whether an
     * allowlisted read-only command may skip the broker -- it must never decide whether the gate
     * exists at all (P0-1): turning it off makes every standalone bash turn require approval, it does
     * not remove the gate. bypassPermissions/dontAsk keep native mode's already-decided outcome but
     * still leave an audit trail (P0-2), matching the can_use_tool fallback in receive().
     */
    private gateStandaloneBash;
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
