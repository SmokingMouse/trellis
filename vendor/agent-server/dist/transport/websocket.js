import { MAX_MESSAGE_BYTES } from "./ndjson.js";
export function listenWebSocket(manager, options = {}) {
    const hostname = options.hostname ?? "127.0.0.1";
    if (hostname !== "127.0.0.1" && hostname !== "::1")
        throw new Error("agent-server WebSocket must bind to loopback");
    const allowedOrigins = new Set(options.allowedOrigins ?? []);
    for (const origin of allowedOrigins) {
        const url = new URL(origin);
        if (!["http:", "https:"].includes(url.protocol) || url.origin !== origin)
            throw new Error("WebSocket allowedOrigins requires exact HTTP(S) origins");
    }
    const sockets = new Set();
    const server = Bun.serve({
        hostname, port: options.port ?? 0,
        fetch(request, server) {
            const origin = request.headers.get("origin");
            if (origin !== null && !allowedOrigins.has(origin))
                return new Response("Origin forbidden", { status: 403 });
            if (server.upgrade(request, { data: {} }))
                return;
            return new Response("WebSocket upgrade required", { status: 426 });
        },
        websocket: {
            maxPayloadLength: MAX_MESSAGE_BYTES,
            backpressureLimit: 32 * 1024 * 1024,
            closeOnBackpressureLimit: true,
            idleTimeout: 0,
            open(socket) {
                sockets.add(socket);
                try {
                    socket.data.connection = manager.accept({
                        send(text) { if (socket.send(text) === 0)
                            throw new Error("WebSocket closed or message dropped"); },
                        end() { socket.close(1000, "connection closed"); },
                    });
                }
                catch {
                    socket.close(1011, "server unavailable");
                }
            },
            message(socket, message) {
                if (typeof message !== "string") {
                    socket.close(1003, "AS requires text messages");
                    socket.data.connection?.close();
                    return;
                }
                socket.data.connection?.receive(message);
            },
            close(socket) { sockets.delete(socket); socket.data.connection?.close(); },
        },
    });
    return { port: server.port, url: `ws://${hostname === "::1" ? "[::1]" : hostname}:${server.port}`, close() {
            for (const socket of sockets) {
                socket.data.connection?.close();
                socket.terminate();
            }
            sockets.clear();
            // Bun 1.3.14 can leave stop's promise pending after a WS close/reconnect cycle.
            // terminate + stop synchronously release our sockets/listener; do not await that promise.
            void server.stop(true);
            server.unref();
        } };
}
