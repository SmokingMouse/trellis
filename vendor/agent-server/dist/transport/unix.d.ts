import { ConnectionManager } from "./connection-manager.js";
export interface UnixTransport {
    readonly path: string;
    close(): void;
}
export declare function listenUnix(manager: ConnectionManager, options: {
    path: string;
}): UnixTransport;
//# sourceMappingURL=unix.d.ts.map