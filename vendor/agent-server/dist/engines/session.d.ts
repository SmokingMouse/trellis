import type { Backend, Item, PendingServerRequest, RpcError, ServerRequestResult, StartThreadParams, StartTurnParams, ThreadStatus, Usage, UserInput } from "../protocol/index.js";
export interface EngineItem {
    id: string;
    type: Item["type"];
    payload: Item["payload"];
    status?: Item["status"];
}
export type DeltaKind = "text" | "reasoning" | "summary" | "stdout" | "stderr";
export type EngineEvent = {
    type: "metadata";
    engineThreadId: string;
} | {
    type: "status";
    status: ThreadStatus;
} | {
    type: "usage";
    usage: Usage;
} | {
    type: "error";
    turnId?: string;
    error: RpcError;
    willRetry: boolean;
} | {
    type: "plan";
    turnId: string;
    plan: Extract<Item, {
        type: "plan";
    }>["payload"];
} | {
    type: "diff";
    turnId: string;
    diff: string;
} | {
    type: "itemStarted";
    turnId: string;
    item: EngineItem;
} | {
    type: "itemDelta";
    turnId: string;
    itemId: string;
    kind: DeltaKind;
    text: string;
} | {
    type: "itemUpdated";
    turnId: string;
    item: EngineItem;
} | {
    type: "itemCompleted";
    turnId: string;
    item: EngineItem;
} | {
    type: "turnCompleted";
    turnId: string;
    status: "completed" | "interrupted" | "failed";
    usage?: Usage;
    error?: RpcError;
} | {
    type: "approval";
    request: PendingServerRequest;
    respond: (result: ServerRequestResult) => void | Promise<void>;
} | {
    type: "approvalExpired";
    turnId: string;
    requestId: string;
    reason: string;
} | {
    type: "exit";
    error?: RpcError;
};
export interface SessionOptions extends StartThreadParams {
    threadId: string;
    engineThreadId?: string;
    forkSession?: boolean;
}
export interface EngineSession {
    readonly backend: Backend;
    readonly engineThreadId: string | null;
    /** Native item/usage notifications already cover these core-generated records. */
    readonly emitsUserMessages?: boolean;
    readonly emitsTokenUsage?: boolean;
    readonly events: AsyncIterable<EngineEvent>;
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    validateTurn?(options: StartTurnParams): void;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    steer(turnId: string, input: UserInput[], options?: Pick<StartTurnParams, "clientTurnId">): Promise<void>;
    interrupt(turnId: string): Promise<void>;
    close(reason: string): Promise<void>;
}
export type EngineFactory = (backend: Backend) => EngineSession;
/** Single-consumer stream, shared by engines and transport-neutral connections. */
export declare class AsyncQueue<T> implements AsyncIterableIterator<T> {
    private values;
    private waiters;
    private ended;
    push(value: T): void;
    end(): void;
    next(): Promise<IteratorResult<T>>;
    [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}
