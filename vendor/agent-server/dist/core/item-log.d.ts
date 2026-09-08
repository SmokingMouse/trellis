import { Database } from "bun:sqlite";
import { type AttachResult, type Item, type MethodParams, type PendingServerRequest, type QueuedTurn, type ServerNotification, type Thread, type Turn } from "../protocol/index.js";
import type { DeltaKind, EngineItem } from "../engines/session.js";
export declare function canonical(value: unknown): string;
export interface ApprovalRow {
    id: string;
    thread_id: string;
    status: string;
    params_json: string;
    decided_by: string | null;
    decision_json: string | null;
}
export type NotificationListener = (notification: ServerNotification) => void;
export declare class ItemLog {
    readonly db: Database;
    private partial;
    private listeners;
    private serverListeners;
    private broadcasts;
    private broadcasting;
    constructor(path?: string);
    private allocateSeq;
    transaction<T>(work: () => T): T;
    thread(threadId: string): Thread;
    allThreads(): Thread[];
    findEngine(engineId: string, backend?: string): Thread | undefined;
    options<T = MethodParams<"thread/start">>(id: string): T;
    saveOptions(id: string, options: unknown): void;
    saveForkPoint(threadId: string, itemId: string, nativeId: string): void;
    forkPoint(threadId: string, itemId: string): string | undefined;
    /** Snapshot payloads and cursors; inherited turns get fresh globally unique IDs. */
    copyPrefix(sourceId: string, targetId: string, items: Item[], copyForkPoints?: boolean): void;
    deduplicate<T extends Thread | Turn>(table: "threads" | "turns", key: string | undefined, request: unknown): T | undefined;
    insertThread(thread: Thread, request: unknown, options?: unknown): void;
    saveThread(thread: Thread): void;
    insertTurn(turn: Turn, request: unknown, preview: string): void;
    turn(id: string, threadId?: string): Turn;
    turnInput(id: string): MethodParams<"turn/start">;
    turns(threadId: string): Turn[];
    saveTurn(turn: Turn): void;
    dequeue(turnId: string): void;
    queue(threadId: string): QueuedTurn[];
    private key;
    private decodeItem;
    private readItems;
    private logRows;
    item(threadId: string, itemId: string): Item;
    startItem(threadId: string, turnId: string, draft: EngineItem, now?: number): Item;
    delta(threadId: string, itemId: string, kind: DeltaKind, text: string): void;
    updateItem(threadId: string, draft: EngineItem, completed?: boolean, now?: number): Item;
    finishOpenItems(threadId: string, turnId: string, failed: boolean): void;
    listItems(params: MethodParams<"thread/items/list">): {
        items: Item[];
        nextCursor: string | null;
    };
    pendingRequests(threadId: string): PendingServerRequest[];
    snapshot(threadId: string, sinceSeq?: number): AttachResult;
    subscribe(threadId: string, listener: NotificationListener): () => void;
    subscribeServer(listener: NotificationListener): () => void;
    attach(threadId: string, listener: NotificationListener, sinceSeq?: number): {
        snapshot: AttachResult;
        detach: () => void;
    };
    publish(notification: ServerNotification): void;
    approval(id: string): ApprovalRow | null;
    close(): void;
}
