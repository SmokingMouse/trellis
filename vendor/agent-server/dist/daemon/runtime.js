import { appendFileSync, chmodSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AgentServer } from "../server/index.js";
import { ConnectionManager, listenUnix, listenWebSocket } from "../transport/index.js";
import { ensureParent, loadToken, resolveDaemonPaths } from "./paths.js";
import { claimPid, removeStaleSocket } from "./process.js";
import { defaultCodexUnixPath, listenCodex } from "../ingress/codex/listener.js";
const ConfigSchema = z.object({
    codex_ingress: z.object({ enabled: z.boolean().default(false), port: z.number().int().min(0).max(65535).default(0), claude_threads: z.boolean().default(false), unix_path: z.string().min(1).optional() }).optional(),
    denied_models: z.array(z.string().trim().min(1)).optional(),
    default_model: z.string().trim().min(1).refine(model => model.toLowerCase() !== "default", "default_model must name an explicit model").optional(),
    ws_allowed_origins: z.array(z.string()).optional(),
    allowed_roots: z.array(z.string()).optional(), maxQueuedTurns: z.number().int().nonnegative().optional(),
    orphanTimeoutMs: z.number().int().nonnegative().optional(), idleTimeoutMs: z.number().int().nonnegative().optional(),
    readonly_auto_allow: z.boolean().optional(), readonly_commands: z.array(z.string()).optional(),
});
export function readConfig(path) {
    if (!existsSync(path))
        return {};
    const { allowed_roots, readonly_auto_allow, readonly_commands, default_model, denied_models, ...options } = ConfigSchema.parse(Bun.TOML.parse(readFileSync(path, "utf8")));
    return {
        ...options,
        ...(default_model !== undefined ? { defaultModel: default_model } : {}),
        ...(denied_models !== undefined ? { deniedModels: denied_models } : {}),
        ...(allowed_roots ? { allowedRoots: allowed_roots } : {}),
        ...(readonly_auto_allow !== undefined ? { readonlyAutoAllow: readonly_auto_allow } : {}),
        ...(readonly_commands ? { readonlyCommands: readonly_commands } : {}),
    };
}
export async function runDaemon(options = {}) {
    const paths = options.paths ?? resolveDaemonPaths(), graceMs = options.graceMs ?? 1000;
    if (!Number.isSafeInteger(graceMs) || graceMs < 0 || graceMs > 300_000)
        throw new Error("graceMs must be an integer from 0 to 300000");
    const releasePid = claimPid(paths.pidPath, paths.socketPath, graceMs);
    let server, unix, ws;
    let codexIngress, codexUnix;
    const logger = options.logger ?? ((message) => console.log(message));
    const log = (message) => {
        const line = `${new Date().toISOString()} ${message}`;
        appendFileSync(paths.logPath, line + "\n", { mode: 0o600 });
        logger(line);
    };
    try {
        await removeStaleSocket(paths.socketPath);
        const token = loadToken(paths.tokenPath, true);
        ensureParent(paths.logPath);
        appendFileSync(paths.logPath, "", { mode: 0o600 });
        chmodSync(paths.logPath, 0o600);
        const { ws_allowed_origins, codex_ingress, ...serverConfig } = readConfig(paths.configPath);
        server = new AgentServer({ databasePath: paths.databasePath, ...serverConfig, ...options.serverOptions, token });
        const manager = new ConnectionManager(server);
        unix = listenUnix(manager, { path: paths.socketPath });
        if (options.wsPort !== undefined)
            ws = listenWebSocket(manager, { port: options.wsPort, allowedOrigins: options.wsAllowedOrigins ?? ws_allowed_origins });
        if (codex_ingress?.enabled)
            codexIngress = listenCodex(server, { port: codex_ingress.port, claudeThreads: codex_ingress.claude_threads, token, audit: log });
        if (codex_ingress?.enabled && codex_ingress.unix_path) {
            const unixPath = codex_ingress.unix_path === "default" ? defaultCodexUnixPath() : codex_ingress.unix_path;
            await removeStaleSocket(unixPath);
            codexUnix = listenCodex(server, { unixPath, claudeThreads: codex_ingress.claude_threads, token, audit: log, trace: options.codexTrace });
        }
        const endpoint = JSON.stringify({ pid: process.pid, socketPath: paths.socketPath, ...(ws ? { webSocketUrl: ws.url } : {}), ...(codexIngress ? { codexIngressUrl: codexIngress.url } : {}), ...(codexUnix ? { codexIngressUnixUrl: codexUnix.url } : {}) }) + "\n";
        writeFileSync(paths.endpointPath, endpoint, { mode: 0o600 });
        chmodSync(paths.endpointPath, 0o600);
        log(`agent-server ready pid=${process.pid} socket=${paths.socketPath} source=${paths.socketSource}${ws ? ` ws=${ws.url}` : ""} tokenFile=${paths.tokenPath} logFile=${paths.logPath}`);
        let resolveClosed;
        const closed = new Promise(resolve => { resolveClosed = resolve; });
        let shuttingDown;
        return { server, manager, paths, webSocketUrl: ws?.url, codexIngressUrl: codexIngress?.url, codexIngressUnixUrl: codexUnix?.url, closed, shutdown(reason = "server_shutdown") {
                if (shuttingDown)
                    return shuttingDown;
                shuttingDown = (async () => {
                    log(`agent-server shutting down reason=${reason} graceMs=${graceMs}`);
                    try {
                        await server.close(reason, graceMs);
                    }
                    finally {
                        unix.close();
                        ws?.close();
                        await codexIngress?.close();
                        await codexUnix?.close();
                        if (existsSync(paths.endpointPath) && readFileSync(paths.endpointPath, "utf8") === endpoint)
                            unlinkSync(paths.endpointPath);
                        releasePid();
                        log("agent-server stopped");
                    }
                })().finally(resolveClosed);
                return shuttingDown;
            } };
    }
    catch (error) {
        unix?.close();
        ws?.close();
        await codexIngress?.close();
        await codexUnix?.close();
        await server?.close();
        releasePid();
        throw error;
    }
}
