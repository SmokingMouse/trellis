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
    codexTrace?: (direction: "TUI>AS" | "AS>TUI", frame: Record<string, any>, connection?: string) => void;
}
export declare function readConfig(path: string): ServerOptions & {
    ws_allowed_origins?: string[];
    codex_ingress?: {
        enabled: boolean;
        port: number;
        claude_threads: boolean;
        unix_path?: string;
    };
};
export interface RunningDaemon {
    readonly server: AgentServer;
    readonly manager: ConnectionManager;
    readonly paths: DaemonPaths;
    readonly webSocketUrl?: string;
    readonly closed: Promise<void>;
    readonly codexIngressUrl?: string;
    readonly codexIngressUnixUrl?: string;
    shutdown(reason?: string): Promise<void>;
}
export declare function runDaemon(options?: DaemonOptions): Promise<RunningDaemon>;
