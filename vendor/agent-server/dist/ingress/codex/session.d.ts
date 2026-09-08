import { type ServerRequestMethod } from "../../protocol/index.js";
import type { AgentServer, InProcessClient } from "../../server/server.js";
import type { ControlClient, NativeObject } from "./control-process.js";
import { CodexRouter } from "./router.js";
export declare function nativeDecision(method: ServerRequestMethod, result: NativeObject): unknown;
/** Each WebSocket owns exactly one authenticated AS connection. */
export declare class CodexSession {
    private readonly control;
    private readonly options;
    readonly client: InProcessClient;
    readonly router: CodexRouter;
    private state;
    private abort;
    private reverse;
    private logical;
    private localTools;
    private optOut;
    private unsubscribe;
    private unclose;
    private restoring;
    constructor(server: AgentServer, control: ControlClient, options: {
        token: string;
        send: (frame: NativeObject) => void;
        end?: () => void;
        audit?: (message: string) => void;
        claudeThreads?: boolean;
    });
    private send;
    receive(raw: unknown): Promise<void>;
    private fromAS;
    parseError(): void;
    private forwardTool;
    private restore;
    close(): void;
}
