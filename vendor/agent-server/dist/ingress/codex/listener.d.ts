import type { AgentServer } from "../../server/server.js";
import { type ControlClient, type NativeObject } from "./control-process.js";
export declare const MAX_NATIVE_FRAME_BYTES: number;
/** Separate namespace: never displace the official app-server daemon socket. */
export declare function defaultCodexUnixPath(env?: NodeJS.ProcessEnv): string;
export interface CodexListener {
    readonly url: string;
    readonly port: number;
    close(): Promise<void>;
}
export declare function listenCodex(server: AgentServer, options: {
    token: string;
    port?: number;
    hostname?: string;
    unixPath?: string;
    control?: ControlClient;
    audit?: (message: string) => void;
    claudeThreads?: boolean;
    trace?: (direction: "TUI>AS" | "AS>TUI", frame: NativeObject, connection?: string) => void;
}): CodexListener;
