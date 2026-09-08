import { timingSafeEqual } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { ControlProcess } from "./control-process.js";
import { CodexSession } from "./session.js";
export const MAX_NATIVE_FRAME_BYTES = 128 * 1024 * 1024;
/** Separate namespace: never displace the official app-server daemon socket. */
export function defaultCodexUnixPath(env = process.env) {
    return join(resolve(env.CODEX_HOME || join(env.HOME || homedir(), ".codex")), "agent-server", "ingress.sock");
}
export function listenCodex(server, options) {
    const hostname = options.hostname ?? "127.0.0.1";
    if (hostname !== "127.0.0.1" && hostname !== "::1")
        throw new Error("codex-ingress must bind to loopback");
    if (!options.token)
        throw new Error("codex-ingress requires a bearer token");
    const unix = options.unixPath;
    if (unix) {
        if (!isAbsolute(unix))
            throw new Error("codex-ingress unix path must be absolute");
        if (Buffer.byteLength(unix) > (process.platform === "darwin" ? 103 : 107))
            throw new Error("codex-ingress unix path exceeds platform limit");
        const parent = dirname(unix);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid()) || (stat.mode & 0o077))
            throw new Error("codex-ingress unix parent must be an owned 0700 directory");
        if (existsSync(unix))
            throw new Error("codex-ingress unix socket already exists");
    }
    const token = Buffer.from(`Bearer ${options.token}`), control = options.control ?? new ControlProcess();
    const sockets = new Set();
    const listener = Bun.serve({ ...(unix ? { unix } : { hostname, port: options.port ?? 0 }),
        fetch(request, listener) {
            const peer = listener.requestIP(request)?.address;
            if (!unix && peer !== "127.0.0.1" && peer !== "::1" && peer !== "::ffff:127.0.0.1")
                return new Response("Loopback required", { status: 403 });
            if (request.headers.has("origin"))
                return new Response("Browser origins forbidden", { status: 403 });
            const provided = Buffer.from(request.headers.get("authorization") ?? "");
            if (!unix && (provided.length !== token.length || !timingSafeEqual(provided, token)))
                return new Response("Invalid bearer token", { status: 401 });
            if (listener.upgrade(request, { data: {} }))
                return;
            return new Response("WebSocket upgrade required", { status: 426 });
        },
        websocket: { maxPayloadLength: MAX_NATIVE_FRAME_BYTES, backpressureLimit: MAX_NATIVE_FRAME_BYTES * 2, closeOnBackpressureLimit: true, idleTimeout: 0,
            open(socket) {
                sockets.add(socket);
                try {
                    socket.data.session = new CodexSession(server, control, { token: options.token, audit: options.audit, claudeThreads: options.claudeThreads,
                        send(frame) { options.trace?.("AS>TUI", frame, socket.data.session?.client.clientId); if (socket.send(JSON.stringify(frame)) === 0)
                            throw new Error("native socket closed"); },
                        end() { socket.close(1000, "connection closed"); },
                    });
                }
                catch {
                    socket.close(1011, "server unavailable");
                }
            },
            message(socket, message) {
                if (typeof message !== "string") {
                    socket.close(1003, "native JSON text required");
                    socket.data.session?.close();
                    return;
                }
                try {
                    const frame = JSON.parse(message);
                    options.trace?.("TUI>AS", frame, socket.data.session?.client.clientId);
                    void socket.data.session?.receive(frame);
                }
                catch {
                    socket.data.session?.parseError();
                }
            },
            close(socket) { sockets.delete(socket); socket.data.session?.close(); },
        },
    });
    if (unix)
        chmodSync(unix, 0o600);
    let closing;
    return { url: unix ? `unix://${unix}` : `ws://${hostname === "::1" ? "[::1]" : hostname}:${listener.port}`, port: listener.port ?? 0, close() {
            if (closing)
                return closing;
            for (const socket of sockets) {
                socket.data.session?.close();
                socket.terminate();
            }
            sockets.clear();
            void listener.stop(true);
            listener.unref();
            return closing = control.close();
        } };
}
