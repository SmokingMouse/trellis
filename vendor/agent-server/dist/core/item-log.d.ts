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
    /**
     * Persists a readonly-auto-allow decision into the same `approvals` table as broker-mediated
     * approvals (status='auto_allowed', decided immediately), so "which rule let this Bash command
     * skip approval" survives process restarts and is queryable the same way regular approvals are,
     * not just visible on the live engineEvent broadcast.
     */
    recordReadonlyAutoAllow(entry: {
        id: string;
        threadId: string;
        turnId: string;
        itemId: string;
        command: string;
        matchedRules: string[];
        now?: number;
    }): void;
    readonlyAutoAllows(threadId: string): ApprovalRow[];
    /** Same rationale as recordReadonlyAutoAllow, for the readonly-thread write-tool direct-deny path. */
    recordReadonlyDenied(entry: {
        id: string;
        threadId: string;
        turnId: string;
        itemId: string;
        toolName: string;
        now?: number;
    }): void;
    readonlyDenials(threadId: string): ApprovalRow[];
    /**
     * Same rationale as recordReadonlyAutoAllow: "this thread's write tools were disabled" must
     * survive past the one-shot spawn-time engineEvent broadcast. Unlike the sibling records this
     * fires before any turn exists, so turn_id is NULL (see the nullable-turn_id migration above)
     * and item_id is a synthetic constant rather than a real tool-use id.
     */
    recordReadonlyToolsDisabled(entry: {
        id: string;
        threadId: string;
        toolNames: string[];
        reason: string;
        now?: number;
    }): void;
    readonlyToolsDisabled(threadId: string): ApprovalRow[];
    /** Same persistence pattern as recordReadonlyAutoAllow, for the bypassPermissions/dontAsk and can_use_tool auto-response paths. */
    recordPermissionAutoResponse(entry: {
        id: string;
        threadId: string;
        turnId: string;
        itemId: string;
        toolName: string;
        permission: string;
        behavior: string;
        now?: number;
    }): void;
    permissionAutoResponses(threadId: string): ApprovalRow[];
    close(): void;
}
