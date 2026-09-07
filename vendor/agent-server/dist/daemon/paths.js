import { chmodSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
export function resolveDaemonPaths(env = process.env) {
    const home = env.HOME || homedir();
    const xdg = (name) => env[name] && isAbsolute(env[name]) ? env[name] : undefined;
    const runtime = xdg("XDG_RUNTIME_DIR"), state = xdg("XDG_STATE_HOME");
    const socketSource = env.AGENT_SERVER_SOCKET_PATH ? "AGENT_SERVER_SOCKET_PATH" : runtime ? "XDG_RUNTIME_DIR" : state ? "XDG_STATE_HOME" : "HOME";
    const socketPath = resolve(env.AGENT_SERVER_SOCKET_PATH || join(runtime || state || join(home, ".sm-toolkit"), ...(runtime || state ? ["sm-toolkit"] : []), "agent-server.sock"));
    const data = state ? join(state, "sm-toolkit", "agent-server") : join(home, ".agent-server");
    return { socketPath, socketSource, pidPath: socketPath + ".pid", tokenPath: join(data, "token"), logPath: join(data, "agent-server.log"), databasePath: join(data, "agent-server.db"), configPath: join(data, "config.toml"), endpointPath: socketPath + ".endpoint.json" };
}
export function ensureParent(path) { mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); }
export function loadToken(path, create = false) {
    if (create) {
        ensureParent(path);
        try {
            writeFileSync(path, randomBytes(32).toString("hex") + "\n", { flag: "wx", mode: 0o600 });
        }
        catch (error) {
            if (error.code !== "EEXIST")
                throw error;
        }
    }
    if (!lstatSync(path).isFile())
        throw new Error("token path must be a regular file");
    const token = readFileSync(path, "utf8").trim();
    if (!token)
        throw new Error("token file is empty");
    chmodSync(path, 0o600);
    return token;
}
//# sourceMappingURL=paths.js.map