import { AgentServer, type ServerOptions } from "../server/index.js";
import { ConnectionManager } from "../transport/index.js";
import { type DaemonPaths } from "./paths.js";
export interface DaemonOptions {
    paths?: DaemonPaths;
    graceMs?: number;
    wsPort?: number;
    wsAllowedOrigins?: string[];
    serverOptions?: ServerOptions;
    logger?: (message: string) => void;
}
export interface RunningDaemon {
    readonly server: AgentServer;
    readonly manager: ConnectionManager;
    readonly paths: DaemonPaths;
    readonly webSocketUrl?: string;
    readonly closed: Promise<void>;
    shutdown(reason?: string): Promise<void>;
}
export declare function runDaemon(options?: DaemonOptions): Promise<RunningDaemon>;
