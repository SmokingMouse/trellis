import { type Thread } from "../protocol/index.js";
export declare const DEFAULT_DENIED_MODELS: string[];
export interface ModelPolicyOptions {
    defaultModel?: string;
    deniedModels?: string[];
}
/** Resolve only the daemon's explicit default; never defer to engine/environment defaults. */
export declare function executionModel(value: unknown, backend: Thread["backend"], options: ModelPolicyOptions, threadId: string): string;
