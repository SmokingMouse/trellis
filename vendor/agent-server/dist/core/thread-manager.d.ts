import { type Item, type MethodParams, type MethodResult, type RpcError, type StartThreadParams, type Thread, type ThreadStatus } from "../protocol/index.js";
import type { EngineFactory, EngineSession } from "../engines/session.js";
import { ItemLog } from "./item-log.js";
import { TurnQueue } from "./turn-queue.js";
import type { ApprovalBroker } from "./approval-broker.js";
export interface ThreadManagerOptions {
    maxQueuedTurns?: number;
    idleTimeoutMs?: number;
    now?: () => number;
}
export declare class ThreadManager {
    readonly log: ItemLog;
    private readonly factory;
    readonly live: Map<string, EngineSession>;
    readonly engineThreads: Map<string, string>;
    private opening;
    private closing;
    private queues;
    private idleSince;
    private consumers;
    private timer;
    approvals?: ApprovalBroker;
    readonly maxQueuedTurns: number;
    readonly idleTimeoutMs: number;
    private now;
    constructor(log: ItemLog, factory: EngineFactory, options?: ThreadManagerOptions);
    get(threadId: string): Thread;
    setPermission(params: MethodParams<"thread/permission/set">): Promise<MethodResult<"thread/permission/set">>;
    engineControl(params: MethodParams<"thread/engineControl">): Promise<MethodResult<"thread/engineControl">>;
    session(threadId: string): EngineSession;
    queue(threadId: string): TurnQueue;
    setStatus(threadId: string, status: ThreadStatus): void;
    start(params: StartThreadParams, onCreated?: (thread: Thread) => void, internal?: {
        resume?: string;
        fork?: boolean;
        request?: unknown;
        prefix?: Item[];
        forkedFrom?: Thread["forkedFrom"];
        forkPoint?: string;
        seedHistory?: Item[];
    }): Promise<MethodResult<"thread/start">>;
    private open;
    resume(params: MethodParams<"thread/resume">, onAttach?: (thread: Thread) => void): Promise<MethodResult<"thread/resume">>;
    fork(params: MethodParams<"thread/fork">, onCreated?: (thread: Thread) => void): Promise<MethodResult<"thread/fork">>;
    private metadata;
    private handle;
    engineDied(threadId: string, error: RpcError): void;
    close(threadId: string, reason?: string): Promise<void>;
    sweepIdle(): Promise<void>;
    shutdown(): Promise<void>;
}
