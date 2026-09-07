import type { AgentServer, InProcessClient } from "../server/index.js";
export interface WirePeer {
    /** Enqueue one message, preserving order and handling transport backpressure. */
    send(text: string): void;
    end(): void;
}
export declare class ManagedConnection {
    private readonly client;
    private readonly peer;
    private ingress;
    private disposed;
    readonly clientId: string;
    constructor(client: InProcessClient, peer: WirePeer, remove: () => void);
    receive(text: string): void;
    close(): void;
}
/** One wire connection is exactly one server client. Business routing stays in AgentServer. */
export declare class ConnectionManager {
    readonly server: AgentServer;
    private readonly clients;
    constructor(server: AgentServer);
    get size(): number;
    accept(peer: WirePeer): ManagedConnection;
    disconnect(clientId: string): void;
    close(): void;
}
//# sourceMappingURL=connection-manager.d.ts.map