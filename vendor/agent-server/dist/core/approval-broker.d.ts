import { type ClientIdentity, type PendingServerRequest, type ServerRequestMethod, type ServerRequestResult } from "../protocol/index.js";
import { ItemLog } from "./item-log.js";
import { LeaseManager } from "./lease-manager.js";
export interface ApprovalClient extends ClientIdentity {
    serverRequests: ReadonlySet<ServerRequestMethod>;
    attached: ReadonlySet<string>;
    sendRequest: (request: PendingServerRequest) => void;
}
export interface ApprovalBrokerOptions {
    orphanTimeoutMs?: number;
    timeoutMs?: number;
    now?: () => number;
    onDeliveryError?: (threadId: string, error: unknown) => void;
}
interface Waiting {
    request: PendingServerRequest;
    respond: (result: ServerRequestResult) => void | Promise<void>;
    since: number;
    orphan: boolean;
    timer?: ReturnType<typeof setTimeout>;
}
export declare class ApprovalBroker {
    private readonly log;
    private readonly clients;
    private readonly leases;
    private readonly options;
    private waiting;
    readonly orphanTimeoutMs: number;
    private now;
    constructor(log: ItemLog, clients: () => Iterable<ApprovalClient>, leases?: LeaseManager, options?: ApprovalBrokerOptions);
    private audience;
    create(raw: PendingServerRequest, respond: Waiting["respond"]): void;
    clientAttached(client: ApprovalClient, threadId: string): void;
    audienceChanged(): void;
    private timeout;
    private schedule;
    sweep(): void;
    answer(requestId: string, clientId: string, raw: unknown): void;
    private remove;
    private deliver;
    expire(requestId: string, reason: string): void;
    expireThread(threadId: string, reason: string, turnId?: string): void;
    close(): void;
}
export {};
