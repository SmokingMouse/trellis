export type NativeObject = Record<string, any>;
export interface ControlClient {
    initialize(): Promise<NativeObject>;
    request(method: string, params?: NativeObject): Promise<NativeObject>;
    close(): Promise<void>;
}
export declare const CONTROL_METHODS: Set<string>;
/** Ingress-owned process: no thread is ever started here. */
export declare class ControlProcess implements ControlClient {
    private readonly options;
    private child?;
    private starting?;
    private dead;
    private sequence;
    private buffer;
    private pending;
    constructor(options?: {
        executable?: string;
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        timeoutMs?: number;
    });
    initialize(): Promise<NativeObject>;
    request(method: string, params?: NativeObject): Promise<NativeObject>;
    private call;
    private fail;
    close(): Promise<void>;
}
