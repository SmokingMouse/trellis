import { ConnectionManager } from "./connection-manager.js";
export interface WebSocketTransport {
    readonly url: string;
    readonly port: number;
    close(): void;
}
export declare function listenWebSocket(manager: ConnectionManager, options?: {
    port?: number;
    hostname?: string;
    allowedOrigins?: string[];
}): WebSocketTransport;
