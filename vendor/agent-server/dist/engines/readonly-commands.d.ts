export declare const DEFAULT_READONLY_COMMANDS: readonly string[];
export declare const DEFAULT_SYSTEM_BIN_DIRS: readonly string[];
/**
 * A name in `allow` only actually skips approval if it also resolves to a real, executable file
 * inside `systemDirs` on *this* machine -- e.g. `rg` when ripgrep is not installed and the shell
 * only knows it as an injected function is never resolvable, so it always falls through to deny/
 * approval instead of auto-allow (fail-closed, but a silent coverage gap). Call this once at
 * startup to audit the configured allowlist and log which entries are currently dead weight,
 * rather than discovering it only from an unexplained stream of approval requests.
 */
export declare function unresolvableReadonlyCommands(allow?: ReadonlySet<string>, options?: ReadonlyClassificationOptions): string[];
export interface ReadonlyClassificationOptions {
    /** Trusted server roots for -f/--file/--files-from inputs. Missing scope fails closed. */
    allowedRoots?: readonly string[];
    /** Execution cwd used to resolve relative input paths. */
    cwd?: string;
    /** Directories a resolved executable must live in. Defaults to DEFAULT_SYSTEM_BIN_DIRS. */
    systemDirs?: readonly string[];
    /** Overrides the directories searched to resolve argv[0]. Defaults to process.env.PATH. Exists
     *  primarily so tests do not depend on the host's installed binary layout. */
    pathDirs?: readonly string[];
}
export interface ReadonlyClassification {
    readonly: boolean;
    matchedRules: string[];
}
/**
 * Classifies a Bash command as readonly-auto-allowable. The command must parse under the strict
 * grammar in parseScript (see out/result.md for the BNF); every resulting simple command must
 * invoke a bare (path-free) name that is (a) never in HARD_BANNED_HEADS, (b) present in `allow`,
 * (c) resolvable via a real PATH lookup to a file inside `options.systemDirs`, and (d) pass that
 * command's own argument validator. Any failure at any stage denies the *entire* command -- this
 * function has no partial-allow mode.
 */
export declare function classifyReadonlyCommand(command: string, allow?: ReadonlySet<string>, options?: ReadonlyClassificationOptions): ReadonlyClassification;
