import { accessSync, constants as fsConstants, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
// Default allowlist for the readonly-auto-allow gate: pure inspection commands only.
// `env` is deliberately absent: it is a program launcher (see HARD_BANNED_HEADS) and can never be
// auto-allowed no matter what a caller configures.
export const DEFAULT_READONLY_COMMANDS = [
    "ls", "cat", "head", "tail", "wc", "find", "grep", "rg", "pwd", "echo", "stat", "file", "which", "git",
];
// argv[0] must resolve, via a real PATH lookup, to a file inside one of these directories. This
// closes the PATH-hijack case: an attacker who can prepend a directory to PATH (e.g. via a prior
// tool call, a repo-local .envrc, etc.) cannot get a bare `ls` to resolve to a planted binary,
// because the resolved directory would not be in this list.
export const DEFAULT_SYSTEM_BIN_DIRS = [
    "/bin", "/sbin", "/usr/bin", "/usr/sbin", "/usr/local/bin", "/usr/local/sbin", "/opt/homebrew/bin", "/opt/homebrew/sbin",
];
// Names that are never auto-allowed as argv[0], regardless of what `allow` (even a caller-supplied
// custom set) contains. Every one of these launches or delegates to another program under
// attacker-controlled input, which is exactly the escape hatch this gate exists to close: `env -S`
// (P0-B), `xargs`, `sh -c`, `eval`, etc. are all the same class of risk as the readonly command
// itself being a decoy for a wrapped write.
const HARD_BANNED_HEADS = new Set([
    "env", "command", "exec", "xargs", "source", ".", "eval",
    "sudo", "doas", "time", "nice", "nohup", "sh", "bash", "zsh", "script", "expect",
]);
const GIT_READONLY_SUBCOMMANDS = new Set(["status", "log", "diff", "show", "rev-parse", "branch"]);
// git-diff-options(1) --output=<file> writes to disk instead of stdout, and it is inherited by log/diff/show.
const GIT_OUTPUT_SUBCOMMANDS = new Set(["log", "diff", "show"]);
function isGitWriteToFile(arg) { return arg === "--output" || arg.startsWith("--output="); }
// `git branch` is only readonly when it is a pure listing invocation: no positional args (branch
// names) and only flags that list/inspect. Anything else (create/delete/rename/move/set-upstream) mutates refs.
const BRANCH_READONLY_FLAGS = new Set(["-a", "-l", "-r", "--list", "--show-current", "-v"]);
const textValue = value => value.length > 0 && !value.startsWith("-");
const countValue = value => /^\d+$/.test(value);
const choice = (...values) => value => values.includes(value);
function optionValues(...groups) {
    return new Map(groups.flatMap(([names, check]) => names.split(" ").map(name => [name, check])));
}
const RG_READONLY_OPTIONS = {
    flags: new Set([
        "-i", "--ignore-case", "-s", "--case-sensitive", "-S", "--smart-case", "-F", "--fixed-strings",
        "-w", "--word-regexp", "-x", "--line-regexp", "-v", "--invert-match", "-n", "--line-number",
        "-N", "--no-line-number", "-H", "--with-filename", "-I", "--no-filename", "-l", "--files-with-matches",
        "--files-without-match", "-c", "--count", "--count-matches", "-o", "--only-matching", "-q", "--quiet",
        "-a", "--text", "-U", "--multiline", "--multiline-dotall", "-P", "--pcre2", "--hidden", "--no-ignore",
        "--no-ignore-vcs", "--files", "--type-list", "--heading", "--no-heading", "--column", "--json",
        "-0", "--null", "--null-data", "--no-config", "--stats", "--help", "-h", "--version", "-V",
    ]),
    values: optionValues(["-e --regexp -f --file -g --glob --iglob -t --type -T --type-not", textValue], ["-A --after-context -B --before-context -C --context -m --max-count --max-depth -j --threads", countValue], ["--color", choice("never", "auto", "always", "ansi")]),
};
const GREP_READONLY_OPTIONS = {
    flags: new Set([
        "-E", "--extended-regexp", "-F", "--fixed-strings", "-G", "--basic-regexp", "-P", "--perl-regexp",
        "-i", "--ignore-case", "-w", "--word-regexp", "-x", "--line-regexp", "-v", "--invert-match",
        "-n", "--line-number", "-H", "--with-filename", "-h", "--no-filename", "-l", "--files-with-matches",
        "-L", "--files-without-match", "-c", "--count", "-o", "--only-matching", "-q", "--quiet", "--silent",
        "-s", "--no-messages", "-r", "--recursive", "-R", "--dereference-recursive", "-a", "--text",
        "-I", "-b", "--byte-offset", "-Z", "--null", "-z", "--null-data", "--help", "-V", "--version",
    ]),
    values: optionValues(["-e --regexp -f --file --include --exclude --exclude-dir", textValue], ["-A --after-context -B --before-context -C --context -m --max-count", countValue], ["--color --colour", choice("never", "auto", "always")], ["--binary-files", choice("binary", "text", "without-match")], ["-d --directories", choice("read", "recurse", "skip")], ["-D --devices", choice("read", "skip")]),
};
const FILE_READONLY_OPTIONS = {
    flags: new Set([
        "-b", "--brief", "-i", "--mime", "--mime-type", "--mime-encoding", "--extension", "--apple",
        "-h", "--no-dereference", "-L", "--dereference", "-k", "--keep-going", "-N", "--no-pad",
        "-n", "--no-buffer", "-r", "--raw", "-s", "--special-files", "-E", "--error", "-0", "--print0",
        "--help", "-v", "--version",
    ]),
    values: optionValues(["-F --separator -f --files-from", textValue]),
};
const FIND_PREFIX_FLAGS = new Set(["-H", "-L", "-P"]);
const FIND_READONLY_OPTIONS = {
    flags: new Set([
        "-print", "-print0", "-ls", "-prune", "-quit", "-depth", "-xdev", "-mount", "-noleaf",
        "-empty", "-readable", "-writable", "-executable", "-true", "-false",
        "!", "(", ")", "-a", "-and", "-o", "-or", "-not",
    ]),
    values: optionValues(["-name -iname -path -ipath -wholename -iwholename -lname -ilname -regex -iregex -user -group -newer", textValue], ["-maxdepth -mindepth", countValue], ["-type -xtype", choice("b", "c", "d", "p", "f", "l", "s")], ["-mtime -atime -ctime -mmin -amin -cmin -uid -gid -inum -links", value => /^[+-]?\d+$/.test(value)], ["-size", value => /^[+-]?\d+[bcwkMG]?$/.test(value)]),
};
function readonlyOptionArgs(args, options, find = false, inputFile) {
    let expression = false;
    let paths = false;
    for (let i = 0; i < args.length; i++) {
        const arg = args[i];
        if (find && !paths && !expression && FIND_PREFIX_FLAGS.has(arg))
            continue;
        if (options.flags.has(arg)) {
            expression = true;
            continue;
        }
        if (!find && /^-[A-Za-z0-9]{2,}$/.test(arg) && [...arg.slice(1)].every(letter => options.flags.has(`-${letter}`)))
            continue;
        // Only long search/file options support =value; find primaries require a separate token.
        const equals = !find && arg.startsWith("--") ? arg.indexOf("=") : -1;
        const name = equals < 0 ? arg : arg.slice(0, equals);
        const check = options.values.get(name);
        if (check) {
            const value = equals < 0 ? args[++i] : arg.slice(equals + 1);
            if (value === undefined || !check(value))
                return false;
            if (!find && ["-f", "--file", "--files-from"].includes(name) && !inputFile?.(value))
                return false;
            expression = true;
            continue;
        }
        if (!textValue(arg) || (find && (expression || ["!", "(", ")", ","].includes(arg))))
            return false;
        paths = true;
    }
    return true;
}
/**
 * Fail-closed shell tokenizer for the readonly-auto-allow gate. See out/result.md for the BNF and
 * the rationale for hand-writing this instead of pulling in a general bash parser.
 *
 * Design: parsing FAILS (returns null, which the caller treats as "deny") the instant the input
 * contains anything outside a deliberately small allowed shape, rather than trying to faithfully
 * parse full shell grammar. `$` and a backtick are rejected unconditionally, everywhere in the
 * string, including inside single quotes -- real shells treat single quotes as inert, but this
 * gate does not rely on that distinction being bug-free, so it denies regardless of quoting.
 * Unquoted `<`, `>`, `(`, `)` are rejected as operators (redirection, heredoc, subshell, process
 * substitution all start with one of these); the same characters *inside* a quote are ordinary
 * literal text, matching real shell semantics, and are accepted.
 */
function parseScript(command) {
    // Command substitution ($( ), `...`), parameter expansion (${...}), and arithmetic expansion
    // ($(( ))) all start with one of these two characters; ban them unconditionally, in any quoting
    // context, rather than trying to prove a specific occurrence is inert.
    if (/[`$]/.test(command))
        return null;
    const commands = [];
    let words = [];
    let word = "";
    let hasWord = false;
    let quote = null;
    const pushWord = () => { if (hasWord) {
        words.push(word);
        word = "";
        hasWord = false;
    } };
    const pushCommand = () => {
        pushWord();
        if (words.length)
            commands.push({ words });
        words = [];
    };
    for (let i = 0; i < command.length; i++) {
        const ch = command[i];
        if (quote === "'") {
            if (ch === "'") {
                quote = null;
                continue;
            }
            word += ch;
            hasWord = true;
            continue;
        }
        if (quote === '"') {
            if (ch === '"') {
                quote = null;
                continue;
            }
            if (ch === "\\") {
                const nxt = command[i + 1];
                // POSIX: inside double quotes, backslash is only special before ", \, or a line
                // continuation ($ and ` are already banned above, so those escape forms cannot occur).
                if (nxt === '"' || nxt === "\\") {
                    word += nxt;
                    hasWord = true;
                    i++;
                    continue;
                }
                if (nxt === "\n") {
                    i++;
                    continue;
                }
                word += ch;
                hasWord = true;
                continue;
            }
            word += ch;
            hasWord = true;
            continue;
        }
        if (ch === "'" || ch === '"') {
            quote = ch;
            hasWord = true;
            continue;
        }
        if (ch === "\\") {
            if (i + 1 >= command.length)
                return null; // dangling escape
            // A shell removes backslash-newline before tokenization. Retaining the newline would
            // disguise an option as a positional path, e.g. find . <continuation>-delete.
            if (command[i + 1] === "\n") {
                i++;
                continue;
            }
            word += command[i + 1];
            hasWord = true;
            i++;
            continue;
        }
        // Redirection, heredoc (a doubled '<'), subshell grouping, and process substitution (`<(`/`>(`)
        // all start with an unquoted '<', '>', '(' or ')' -- reject the operator outright.
        if (ch === "<" || ch === ">" || ch === "(" || ch === ")")
            return null;
        if (ch === "\n" || ch === "\r") {
            pushCommand();
            continue;
        }
        // Only space/tab split words, matching bash/zsh's default IFS. JS's \s also matches NBSP,
        // U+2028 and other Unicode space separators that real shells treat as ordinary word
        // characters; using it here would parse a name real shells never split into two tokens.
        if (ch === " " || ch === "\t") {
            pushWord();
            continue;
        }
        if (ch === "&") {
            if (command[i + 1] === "&") {
                pushCommand();
                i++;
                continue;
            }
            return null; // bare `&` (background) is not an allowed connector
        }
        if (ch === "|") {
            if (command[i + 1] === "|") {
                pushCommand();
                i++;
                continue;
            }
            if (command[i + 1] === "&")
                return null; // `|&` is not an allowed connector
            pushCommand();
            continue;
        }
        if (ch === ";") {
            pushCommand();
            continue;
        }
        // Parser-wide invariant: no unquoted expansion characters in ANY argv, including argv[0].
        // Reject characters, not recognized patterns, independently of shell options or matches.
        // ^/# cover zsh EXTENDED_GLOB too; quoted/escaped patterns remain literal.
        if ("*?[]{}~^#".includes(ch))
            return null;
        word += ch;
        hasWord = true;
    }
    if (quote)
        return null; // unterminated quote
    pushCommand();
    return { commands };
}
function realpathOrSelf(dir) {
    try {
        return realpathSync(dir);
    }
    catch {
        return dir;
    }
}
function pathSearchDirs(options) {
    if (options.pathDirs)
        return options.pathDirs;
    return (process.env.PATH ?? "").split(":").filter(Boolean);
}
/**
 * Resolves `name` via a real PATH lookup (first matching directory wins, same as a shell) and
 * returns that directory (realpath-normalized), or null if no directory has an executable file by
 * that name. Deliberately attributes the result to the PATH entry the name was found under rather
 * than following the target through to its final destination: package managers commonly place a
 * stable symlink in a system bin dir (e.g. Homebrew's /opt/homebrew/bin/git -> .../Cellar/git/
 * 2.x/bin/git) and fully resolving through that would put the deep, version-specific Cellar path
 * outside `systemDirs` and deny every such command. The directory an attacker could actually
 * plant a same-named binary in -- by prepending it to PATH -- is exactly this first-match
 * directory, so checking it (rather than the symlink target) still closes the PATH-hijack case.
 */
function resolveExecutableDir(name, dirs) {
    for (const dir of dirs) {
        const candidate = join(dir, name);
        try {
            const info = statSync(candidate); // follows symlinks to confirm a real file exists
            if (!info.isFile())
                continue;
            accessSync(candidate, fsConstants.X_OK);
            return realpathOrSelf(dir);
        }
        catch {
            continue;
        }
    }
    return null;
}
/**
 * A name in `allow` only actually skips approval if it also resolves to a real, executable file
 * inside `systemDirs` on *this* machine -- e.g. `rg` when ripgrep is not installed and the shell
 * only knows it as an injected function is never resolvable, so it always falls through to deny/
 * approval instead of auto-allow (fail-closed, but a silent coverage gap). Call this once at
 * startup to audit the configured allowlist and log which entries are currently dead weight,
 * rather than discovering it only from an unexplained stream of approval requests.
 */
export function unresolvableReadonlyCommands(allow = new Set(DEFAULT_READONLY_COMMANDS), options = {}) {
    const systemDirs = (options.systemDirs ?? DEFAULT_SYSTEM_BIN_DIRS).map(realpathOrSelf);
    const searchDirs = pathSearchDirs(options);
    return [...allow].filter(name => {
        const dir = resolveExecutableDir(name, searchDirs);
        return !dir || !systemDirs.includes(dir);
    });
}
function inputWithinRoots(value, options) {
    try {
        // Bun/Node realpath can normalize .. before following symlinks. Walk components so
        // link/../secret means the real target's parent, as it does when the tool opens it.
        let path = isAbsolute(value) ? "/" : realpathSync(options.cwd ?? process.cwd());
        for (const part of value.split("/")) {
            if (!part || part === ".")
                continue;
            path = part === ".." ? dirname(path) : realpathSync(join(path, part));
        }
        return (options.allowedRoots ?? []).some(root => {
            const child = relative(realpathSync(resolve(root)), path);
            return child === "" || (child !== ".." && !child.startsWith("../") && !isAbsolute(child));
        });
    }
    catch {
        return false;
    } // missing, unreadable or unresolvable input requires approval
}
/**
 * Classifies a Bash command as readonly-auto-allowable. The command must parse under the strict
 * grammar in parseScript (see out/result.md for the BNF); every resulting simple command must
 * invoke a bare (path-free) name that is (a) never in HARD_BANNED_HEADS, (b) present in `allow`,
 * (c) resolvable via a real PATH lookup to a file inside `options.systemDirs`, and (d) pass that
 * command's own argument validator. Any failure at any stage denies the *entire* command -- this
 * function has no partial-allow mode.
 */
export function classifyReadonlyCommand(command, allow = new Set(DEFAULT_READONLY_COMMANDS), options = {}) {
    const deny = { readonly: false, matchedRules: [] };
    const trimmed = command.trim();
    if (!trimmed)
        return deny;
    const parsed = parseScript(trimmed);
    if (!parsed)
        return deny;
    // Normalize through realpath so a symlinked system dir (e.g. macOS's /tmp -> /private/tmp, used
    // by tests, or a distro symlinking /bin -> /usr/bin) still matches the realpath'd resolution
    // result below instead of failing closed on a spurious string mismatch.
    const systemDirs = (options.systemDirs ?? DEFAULT_SYSTEM_BIN_DIRS).map(realpathOrSelf);
    const searchDirs = pathSearchDirs(options);
    // A long `;`-chain repeats the same head many times; resolving argv[0] does real statSync
    // calls per PATH entry, so memoize per command name within this one classification call.
    const resolvedDirCache = new Map();
    const resolveCached = (name) => {
        let cached = resolvedDirCache.get(name);
        if (cached === undefined) {
            cached = resolveExecutableDir(name, searchDirs);
            resolvedDirCache.set(name, cached);
        }
        return cached;
    };
    const rules = [];
    for (const { words: tokens } of parsed.commands) {
        if (!tokens.length)
            continue;
        const [head, ...args] = tokens;
        // A path (relative or absolute) can resolve to an attacker-planted same-named binary
        // (e.g. ./ls, /tmp/evil/ls); only a bare command name looked up on PATH is trusted.
        if (head.includes("/"))
            return deny;
        const name = head;
        if (HARD_BANNED_HEADS.has(name))
            return deny;
        if (!allow.has(name))
            return deny;
        const resolvedDir = resolveCached(name);
        if (!resolvedDir || !systemDirs.includes(resolvedDir))
            return deny;
        if (name === "git") {
            // No global flags at all: this alone closes --exec-path, --config-env, --git-dir,
            // --work-tree, -C, -c, etc. -- none of them can appear before the subcommand token.
            const sub = args[0];
            if (!sub || sub.startsWith("-") || !GIT_READONLY_SUBCOMMANDS.has(sub))
                return deny;
            const subArgs = args.slice(1);
            if (GIT_OUTPUT_SUBCOMMANDS.has(sub) && subArgs.some(isGitWriteToFile))
                return deny;
            if (sub === "branch" && subArgs.some(a => !BRANCH_READONLY_FLAGS.has(a)))
                return deny;
            rules.push(`git ${sub}`);
            continue;
        }
        if (name === "find") {
            if (!readonlyOptionArgs(args, FIND_READONLY_OPTIONS, true))
                return deny;
            rules.push("find");
            continue;
        }
        if (name === "grep" || name === "rg") {
            if (!readonlyOptionArgs(args, name === "rg" ? RG_READONLY_OPTIONS : GREP_READONLY_OPTIONS, false, value => inputWithinRoots(value, options)))
                return deny;
            rules.push(name);
            continue;
        }
        if (name === "file") {
            if (!readonlyOptionArgs(args, FILE_READONLY_OPTIONS, false, value => inputWithinRoots(value, options)))
                return deny;
            rules.push("file");
            continue;
        }
        // ls/cat/head/tail/wc/pwd/echo/stat/which: no flags of theirs write or execute anything, and
        // the grammar above already rejects every form of redirection, so no further arg validation
        // is needed -- see out/result.md for the explicit scope call on this.
        rules.push(name);
    }
    return rules.length ? { readonly: true, matchedRules: rules } : deny;
}
