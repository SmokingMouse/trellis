import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { ensureParent } from "./paths.js";
export function isAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 1)
        return false;
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === "EPERM";
    }
}
function processStart(pid) {
    try {
        return execFileSync("ps", ["-p", String(pid), "-o", "lstart="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: { ...process.env, LC_ALL: "C", TZ: "UTC" } }).trim();
    }
    catch {
        return "";
    }
}
export function readPid(path) {
    let raw;
    try {
        if (!lstatSync(path).isFile())
            throw new Error("pid path must be a regular file");
        raw = readFileSync(path, "utf8");
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    try {
        const value = JSON.parse(raw);
        if (Number.isSafeInteger(value) && value > 1)
            return { raw, pid: value };
        if (value && Number.isSafeInteger(value.pid) && value.pid > 1 && typeof value.processStart === "string" && value.processStart && typeof value.socketPath === "string" && Number.isFinite(value.graceMs) && value.graceMs >= 0)
            return { raw, pid: value.pid, record: value };
    }
    catch { /* An empty or corrupt pid file is handled conservatively by the owner check. */ }
    return { raw };
}
export function ownsProcess(record) { return isAlive(record.pid) && processStart(record.pid) === record.processStart; }
export function removePid(path, raw) {
    const current = readPid(path);
    if (current?.raw === raw)
        unlinkSync(path);
}
export function claimPid(path, socketPath, graceMs) {
    ensureParent(path);
    const existing = readPid(path);
    if (existing) {
        if (existing.record && ownsProcess(existing.record))
            throw new Error(`agent-server already running (pid ${existing.pid})`);
        if (!existing.record && existing.pid && isAlive(existing.pid))
            throw new Error(`pid ${existing.pid} is live but has no verifiable agent-server identity`);
        if (!existing.pid && Date.now() - lstatSync(path).mtimeMs < 30_000)
            throw new Error("pid file is incomplete; another daemon may be starting");
        removePid(path, existing.raw);
    }
    const record = { pid: process.pid, processStart: processStart(process.pid), socketPath, graceMs };
    if (!record.processStart)
        throw new Error("cannot determine process start time for pid ownership");
    const raw = JSON.stringify(record) + "\n";
    writeFileSync(path, raw, { flag: "wx", mode: 0o600 });
    return () => removePid(path, raw);
}
/** A stale inode may be removed only after a direct local connection is refused. */
export async function removeStaleSocket(path) {
    let stat;
    try {
        stat = lstatSync(path);
    }
    catch (error) {
        if (error.code === "ENOENT")
            return;
        throw error;
    }
    if (!stat.isSocket())
        throw new Error(`refusing to replace non-socket path: ${path}`);
    try {
        const socket = await Bun.connect({ unix: path, socket: { data() { }, connectError() { } } });
        socket.end();
        throw new Error(`socket is already accepting connections: ${path}`);
    }
    catch (error) {
        const code = error.code;
        if (code !== "ECONNREFUSED" && code !== "ENOENT")
            throw error;
    }
    try {
        const current = lstatSync(path);
        if (current.isSocket() && current.ino === stat.ino && current.dev === stat.dev)
            unlinkSync(path);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
}
