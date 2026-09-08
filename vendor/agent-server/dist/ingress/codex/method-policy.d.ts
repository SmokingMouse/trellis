/** Reviewed against the entire codex-cli 0.153.4 experimental ClientRequest schema.
 * No prefix matches: a new upstream method remains denied until explicitly reviewed.
 */
export type MethodPolicy = "handshake" | "control-read" | "as-governed" | "owner-read" | "deny";
export declare const NATIVE_METHOD_POLICY: Readonly<Record<string, MethodPolicy>>;
export declare function methodPolicy(method: string): MethodPolicy;
/** Additional readonly denials; ordinary read-only sandboxed turns remain usable.
 * D bucket methods above are denied for every permission, including full.
 */
export declare const READONLY_OVERRIDE_DENY: Readonly<{
    "thread/resume": string[];
    "thread/settings/update": string[];
    "turn/start": string[];
}>;
