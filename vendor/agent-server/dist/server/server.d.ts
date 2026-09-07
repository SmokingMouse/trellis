import { ApprovalBroker, ItemLog, LeaseManager, ThreadManager, type ApprovalClient } from "../core/index.js";
import { type EngineFactory } from "../engines/index.js";
import { type Frame, type Method, type MethodParams, type MethodResult, type PendingServerRequest, type RpcId, type ServerNotification } from "../protocol/index.js";
export interface ServerOptions {
    databasePath?: string;
    token?: string;
    allowedRoots?: string[];
    engineFactory?: EngineFactory;
    backends?: Array<"claude" | "codex" | "external">;
    maxQueuedTurns?: number;
    orphanTimeoutMs?: number;
    approvalTimeoutMs?: number;
    idleTimeoutMs?: number;
}
export interface InProcessClient {
    readonly clientId: string;
    readonly frames: AsyncIterable<Frame>;
    readonly closed: boolean;
    /** Transport adapters feed decoded JSON frames here, and consume frames/onFrame. */
    send(frame: unknown): Promise<void>;
    onFrame(listener: (frame: Frame) => void): () => void;
    onClose(listener: () => void): () => void;
    request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
    notifyInitialized(): Promise<void>;
    respond(id: RpcId, result: unknown): Promise<void>;
    close(): void;
}
declare class Connection implements InProcessClient, ApprovalClient {
    private readonly server;
    readonly clientId: string;
    private stream?;
    get frames(): AsyncIterable<Frame>;
    readonly serverRequests: Set<"item/commandExecution/requestApproval" | "item/fileChange/requestApproval" | "item/permissions/requestApproval" | "item/tool/requestUserInput">;
    readonly attached: Set<string>;
    readonly subscriptions: Map<string, () => void>;
    readonly reverse: Map<string | number, string>;
    readonly delivered: Set<string>;
    readonly optOut: Set<string>;
    label: string;
    initialized: boolean;
    initializing: boolean;
    closed: boolean;
    private sequence;
    private reverseSequence;
    private listeners;
    private closeListeners;
    private calls;
    private ingress;
    constructor(server: AgentServer);
    send(frame: unknown): Promise<void>;
    emit(raw: unknown): void;
    onFrame(listener: (frame: Frame) => void): () => void;
    onClose(listener: () => void): () => void;
    request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
    notifyInitialized(): Promise<void>;
    respond(id: RpcId, result: unknown): Promise<void>;
    sendRequest(request: PendingServerRequest): void;
    notification(frame: ServerNotification): void;
    close(): void;
}
export declare class AgentServer {
    private readonly options;
    readonly log: ItemLog;
    readonly threads: ThreadManager;
    readonly approvals: ApprovalBroker;
    readonly leases: LeaseManager;
    private connections;
    private startedAt;
    private closed;
    private closing?;
    private readonly allowedRoots;
    private readonly backends;
    constructor(options?: ServerOptions);
    connectInProcess(): InProcessClient;
    disconnect(connection: Connection): void;
    private cwd;
    private attach;
    receive(connection: Connection, raw: unknown): Promise<void>;
    private dispatch;
    close(reason?: string, graceMs?: number): Promise<void>;
}
export { AgentServer as Server };
export declare function connectInProcess(server: AgentServer): InProcessClient;
