import { type StartThreadParams, type Thread } from "../../protocol/index.js";
import type { AgentServer, InProcessClient } from "../../server/server.js";
import { type ControlClient, type NativeObject } from "./control-process.js";
export { NativeRpcError } from "./native-error.js";
export declare const isClaudeModel: (model: string) => boolean;
export declare function nativeThreadId(thread: Thread): string;
export declare function resolveThread(server: AgentServer, id: unknown): Thread;
export declare function findClaudeThread(server: AgentServer, asId: string): Thread | undefined;
export declare function nativeOptions(p: NativeObject, current?: Partial<StartThreadParams>): Partial<StartThreadParams>;
/** The durable engine UUID index plus ThreadManager.live are the routing table. */
export declare class CodexRouter {
    readonly server: AgentServer;
    readonly client: InProcessClient;
    readonly control: ControlClient;
    private readonly signal?;
    readonly claudeThreads: boolean;
    private readonly notify?;
    readonly attached: Set<string>;
    constructor(server: AgentServer, client: InProcessClient, control: ControlClient, signal?: AbortSignal | undefined, claudeThreads?: boolean, notify?: ((frame: NativeObject) => void) | undefined);
    reattach(threadId: string): Promise<void>;
    private engine;
    allowedPath(path: string): Promise<void>;
    private paths;
    private rejectExtras;
    private guardThread;
    private threadView;
    private threadActivity;
    private claudeResponse;
    private claudeOnly;
    private input;
    private claudeOptions;
    private claudeHistory;
    private claudeResume;
    private codexRead;
    private codexHistory;
    request(method: string, p?: NativeObject): Promise<NativeObject>;
}
