import { NDJSONDecoder, UnixWriter } from "../transport/ndjson.js";
export async function openWire(endpoint, onMessage, onClose, timeoutMs) {
    if (endpoint.transport === "ws")
        return new Promise((resolve, reject) => {
            const socket = new WebSocket(endpoint.url);
            let opened = false, ended = false;
            const finish = (error) => {
                if (ended)
                    return;
                ended = true;
                clearTimeout(timer);
                if (!opened)
                    reject(error);
                else
                    onClose(error);
            };
            const timer = setTimeout(() => { finish(new Error("WebSocket connect timed out")); socket.close(); }, timeoutMs);
            socket.onopen = () => {
                if (ended) {
                    socket.close();
                    return;
                }
                opened = true;
                clearTimeout(timer);
                resolve({ send(text) { if (socket.readyState !== WebSocket.OPEN)
                        throw new Error("WebSocket closed"); socket.send(text); }, close() { finish(new Error("connection closed")); socket.close(); } });
            };
            socket.onmessage = event => {
                if (typeof event.data !== "string") {
                    finish(new Error("AS requires text messages"));
                    socket.close();
                    return;
                }
                onMessage(event.data);
            };
            socket.onerror = () => { finish(new Error("WebSocket connection failed")); socket.close(); };
            socket.onclose = () => finish(new Error("WebSocket disconnected"));
        });
    return new Promise((resolve, reject) => {
        let writer, socket, opened = false, ended = false;
        const finish = (error = new Error("unix socket disconnected")) => {
            if (ended)
                return;
            ended = true;
            clearTimeout(timer);
            writer?.dispose();
            if (!opened)
                reject(error);
            else
                onClose(error);
            socket?.end();
        };
        const decoder = new NDJSONDecoder(onMessage);
        const timer = setTimeout(() => finish(new Error("unix socket connect timed out")), timeoutMs);
        void Bun.connect({
            unix: endpoint.path,
            socket: {
                open(s) {
                    socket = s;
                    if (ended) {
                        s.end();
                        return;
                    }
                    writer = new UnixWriter(s);
                    opened = true;
                    clearTimeout(timer);
                    resolve({ send: text => writer.send(text), close: () => finish(new Error("connection closed")) });
                },
                data(_s, data) { try {
                    decoder.push(data);
                }
                catch (error) {
                    finish(error);
                } },
                drain() { try {
                    writer?.drain();
                }
                catch (error) {
                    finish(error);
                } },
                end: () => finish(), close: () => finish(), error: (_s, error) => finish(error), connectError: (_s, error) => finish(error),
            },
        }).catch(finish);
    });
}
//# sourceMappingURL=wire.js.map