import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type StartTurnParams, type UserInput } from "../protocol/index.js";
import { AsyncQueue, type EngineEvent, type EngineSession, type SessionOptions } from "./session.js";
export declare function buildCodexThreadParams(options: SessionOptions): Record<string, unknown>;
export interface CodexEngineOptions {
    executable?: string;
    handshakeTimeoutMs?: number;
    requestTimeoutMs?: number;
    spawnProcess?: (command: string, args: string[], options: {
        cwd?: string;
        env: NodeJS.ProcessEnv;
    }) => ChildProcessWithoutNullStreams;
}
/** One app-server process per AS thread; only v2 thread/turn methods use it. */
export declare class CodexEngine implements EngineSession {
    private readonly config;
    readonly backend: "codex";
    readonly emitsUserMessages = true;
    readonly emitsTokenUsage = true;
    readonly events: AsyncQueue<EngineEvent>;
    engineThreadId: string | null;
    private process?;
    private options?;
    private mapper;
    private active?;
    private pending;
    private approvals;
    private sequence;
    private buffer;
    private stderr;
    private dead;
    private closed;
    private ready;
    constructor(config?: CodexEngineOptions);
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    validateTurn(options: StartTurnParams): void;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    steer(turnId: string, input: UserInput[], options?: Pick<StartTurnParams, "clientTurnId">): Promise<void>;
    interrupt(turnId: string): Promise<void>;
    close(_reason: string): Promise<void>;
    private unavailable;
    private assertAlive;
    private assertReady;
    private assertTurn;
    private write;
    private request;
    private rejectPending;
    private fail;
    private bindTurn;
    /** Public for wire fixtures; production frames arrive only through stdout. */
    receive(raw: unknown): void;
    private rejectRequest;
    private serverRequest;
}
//# sourceMappingURL=codex.d.ts.map