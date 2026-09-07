import { spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import { AgentClient } from "../client/index.js";
import { ensureParent, loadToken } from "./paths.js";
import { isAlive, ownsProcess, readPid, removePid } from "./process.js";
function runningPid(paths) {
    const pid = readPid(paths.pidPath);
    if (!pid)
        throw new Error(`agent-server is not running (no pid file: ${paths.pidPath})`);
    if (!pid.record || !ownsProcess(pid.record) || pid.record.socketPath !== paths.socketPath)
        throw new Error(`agent-server is not running (stale or unverified pid file: ${paths.pidPath})`);
    return pid.record;
}
export async function daemonStatus(paths) {
    runningPid(paths);
    const client = await AgentClient.connectUnix({ path: paths.socketPath, token: loadToken(paths.tokenPath), reconnect: false, connectTimeoutMs: 1000, requestTimeoutMs: 1000 });
    try {
        return await client.request("server/health", {});
    }
    finally {
        client.close();
    }
}
export async function daemonStart(paths, cliPath, args = []) {
    const current = readPid(paths.pidPath);
    if (current?.record && ownsProcess(current.record))
        return daemonStatus(paths);
    if (current?.pid && !current.record && isAlive(current.pid))
        throw new Error("refusing to replace an unverified live pid");
    ensureParent(paths.logPath);
    const fd = openSync(paths.logPath, "a", 0o600);
    // The child owns the atomic pid claim. A losing concurrent start cannot unlink its winner.
    const child = spawn(process.execPath, [cliPath, "run", ...args], {
        detached: true, stdio: ["ignore", fd, fd], env: { ...process.env, AGENT_SERVER_SOCKET_PATH: paths.socketPath, AGENT_SERVER_DAEMON_CHILD: "1" },
    });
    closeSync(fd);
    child.unref();
    let exited = false, spawnError;
    child.on("exit", () => { exited = true; });
    child.on("error", error => { exited = true; spawnError = error; });
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
        if (exited)
            throw spawnError ?? new Error(`agent-server failed to start; see ${paths.logPath}`);
        try {
            return await daemonStatus(paths);
        }
        catch { /* The child is still claiming its pid and opening the socket. */ }
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    // This is our just-spawned child, not a pid read from a potentially stale file.
    child.kill("SIGTERM");
    throw new Error(`agent-server start timed out; see ${paths.logPath}`);
}
export async function daemonStop(paths) {
    const stale = readPid(paths.pidPath);
    if (stale && (!stale.pid || !isAlive(stale.pid) || (stale.record && !ownsProcess(stale.record)))) {
        removePid(paths.pidPath, stale.raw);
        throw new Error("agent-server is not running (removed stale pid file)");
    }
    const record = runningPid(paths);
    await daemonStatus(paths);
    if (!ownsProcess(record))
        throw new Error("agent-server process changed before stop");
    process.kill(record.pid, "SIGTERM");
    const deadline = Date.now() + record.graceMs + 5000;
    while (Date.now() < deadline) {
        if (!readPid(paths.pidPath) && !ownsProcess(record))
            return;
        await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error(`agent-server did not stop within grace period; see ${paths.logPath}`);
}
//# sourceMappingURL=control.js.map