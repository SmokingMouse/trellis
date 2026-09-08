import { type ChildProcessWithoutNullStreams } from "node:child_process";
import { type StartTurnParams, type UserInput } from "../protocol/index.js";
import { AsyncQueue, type EngineEvent, type EngineSession, type SessionOptions } from "./session.js";
type NativeId = string | number;
type NativeFrame = Record<string, any>;
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
    readonly nativeToolCalls: Map<NativeId, {
        frame: NativeFrame;
        owner?: string;
    }>;
    claimNativeToolCall(id: NativeId, owner: string): boolean;
    respondNativeToolCall(id: NativeId, owner: string, response: NativeFrame): void;
    releaseNativeToolCalls(owner: string): void;
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
    private threadResponse?;
    private nativeTurns;
    private nativeHistoryFresh;
    private turnReaders;
    constructor(config?: CodexEngineOptions);
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    validateTurn(options: StartTurnParams): void;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    steer(turnId: string, input: UserInput[], options?: Pick<StartTurnParams, "clientTurnId">): Promise<void>;
    interrupt(turnId: string): Promise<void>;
    close(_reason: string): Promise<void>;
    /** Read-only native views for ingress; mutations still enter through as/1. */
    nativeThreadStart(): NativeFrame;
    nativeThreadRead(includeTurns?: boolean): Promise<NativeFrame>;
    nativeThreadHistory(method: "thread/turns/list" | "thread/items/list", params: NativeFrame): Promise<NativeFrame>;
    private emptyNativeHistoryError;
    nativeTurnId(turnId: string): string | undefined;
    waitNativeTurn(turnId: string, signal?: AbortSignal): Promise<NativeFrame>;
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
export {};
