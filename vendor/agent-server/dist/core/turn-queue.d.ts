import { type MethodParams, type MethodResult, type RpcError, type ThreadStatus, type Usage } from "../protocol/index.js";
import type { EngineSession } from "../engines/session.js";
import { ItemLog } from "./item-log.js";
export declare class TurnQueue {
    readonly threadId: string;
    private readonly log;
    private readonly engine;
    private readonly status;
    readonly maxQueuedTurns: number;
    private readonly onEngineFailure?;
    private readonly interruptTimeoutMs;
    private active;
    private frozen;
    private dispatch;
    private interruptTimer?;
    constructor(threadId: string, log: ItemLog, engine: () => EngineSession, status: (status: ThreadStatus) => void, maxQueuedTurns?: number, onEngineFailure?: ((error: RpcError) => void) | undefined, interruptTimeoutMs?: number);
    get runningTurnId(): string | null;
    get isFrozen(): boolean;
    read(): {
        turnId: string;
        position: number;
        enqueuedAtMs: number;
        preview: string;
        clientTurnId?: string | undefined;
    }[];
    private changed;
    enqueue(params: MethodParams<"turn/start">): MethodResult<"turn/start">;
    private pump;
    private assertActive;
    steer(params: MethodParams<"turn/steer">): Promise<void>;
    interrupt(expected?: string): Promise<string | null>;
    cancel(turnId: string): void;
    complete(turnId: string, status: "completed" | "interrupted" | "failed", usage?: Usage, error?: RpcError): void;
    freeze(error: RpcError): void;
    pause(): void;
    resume(): void;
}
