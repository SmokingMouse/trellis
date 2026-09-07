import { type AttachResult, type Frame, type Method, type MethodParams, type MethodResult, type NotificationMethod, type NotificationParams, type RpcId, type ServerRequestMethod, type ServerRequestParams, type ServerRequestResult } from "../protocol/index.js";
import { type ClientEndpoint } from "./wire.js";
export type ClientState = "disconnected" | "connecting" | "reconnecting" | "connected" | "closed";
export interface ClientOptions {
    token?: string;
    protocolVersion?: string;
    client?: MethodParams<"initialize">["client"];
    capabilities?: MethodParams<"initialize">["capabilities"];
    reconnect?: false | {
        minDelayMs?: number;
        maxDelayMs?: number;
    };
    requestTimeoutMs?: number;
    connectTimeoutMs?: number;
}
export type ServerRequestHandle<M extends ServerRequestMethod = ServerRequestMethod> = {
    [K in M]: {
        id: RpcId;
        method: K;
        params: ServerRequestParams<K>;
        /** Sends a JSON-RPC response. Rejections arrive through onError; success through resolved. */
        respond(result: ServerRequestResult<K>): void;
    };
}[M];
type Listener<T> = (value: T) => void;
/** AS v1 client. Snapshots are upserts by item.id; delta notifications are live only. */
export declare class AgentClient {
    readonly endpoint: ClientEndpoint;
    readonly options: ClientOptions;
    private wire?;
    private connecting?;
    private generation;
    private sequence;
    private stopped;
    private everConnected;
    private retries;
    private reconnectTimer?;
    private calls;
    private cursors;
    private pending;
    private frameListeners;
    private notifications;
    private requests;
    private snapshots;
    private states;
    private errors;
    private currentState;
    private initialized?;
    constructor(endpoint: ClientEndpoint, options?: ClientOptions);
    get state(): ClientState;
    get clientId(): string | undefined;
    get initializeResult(): MethodResult<"initialize"> | undefined;
    get pendingRequests(): ReadonlyMap<string, ServerRequestHandle>;
    static connectUnix(options: ClientOptions & {
        path: string;
    }): Promise<AgentClient>;
    static connectWebSocket(options: ClientOptions & {
        url: string;
    }): Promise<AgentClient>;
    onFrame(listener: Listener<Frame>): () => void;
    onStateChange(listener: Listener<ClientState>): () => void;
    onSnapshot(listener: Listener<AttachResult>): () => void;
    onError(listener: (error: Error, id?: RpcId | null) => void): () => void;
    onNotification<M extends NotificationMethod>(method: M, listener: Listener<NotificationParams<M>>): () => void;
    onServerRequest<M extends ServerRequestMethod>(method: M, listener: Listener<ServerRequestHandle<M>>): () => void;
    private listen;
    private emit;
    private error;
    private setState;
    connect(): Promise<void>;
    private open;
    private lost;
    private scheduleReconnect;
    close(): void;
    request<M extends Method>(method: M, params: MethodParams<M>): Promise<MethodResult<M>>;
    private call;
    private send;
    private receive;
    private rememberRequest;
    private cursor;
    private trackItem;
    /** Server completion cursors reconcile items finished while disconnected. */
    sinceSeq(threadId: string): number;
    private trackResult;
}
export declare const connectUnix: typeof AgentClient.connectUnix;
export declare const connectWebSocket: typeof AgentClient.connectWebSocket;
export {};
//# sourceMappingURL=client.d.ts.map