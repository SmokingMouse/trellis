import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { NDJSONDecoder, UnixWriter } from "./ndjson.js";
export function listenUnix(manager, options) {
    const { path } = options;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try {
        lstatSync(path);
        throw new Error(`socket path already exists: ${path}`);
    }
    catch (error) {
        if (error.code !== "ENOENT")
            throw error;
    }
    const sockets = new Set();
    const disconnect = (socket) => {
        sockets.delete(socket);
        socket.data?.writer.dispose();
        socket.data?.connection.close();
        socket.end();
    };
    // Existing paths are never unlinked here. Only daemon ownership checks may remove stale sockets.
    const listener = Bun.listen({
        unix: path,
        socket: {
            open(socket) {
                const writer = new UnixWriter(socket);
                try {
                    const connection = manager.accept({ send: text => writer.send(text), end() { try {
                            writer.end();
                        }
                        catch {
                            socket.terminate();
                        } } });
                    socket.data = { writer, connection, decoder: new NDJSONDecoder(line => connection.receive(line)) };
                    sockets.add(socket);
                }
                catch {
                    writer.dispose();
                    socket.end();
                }
            },
            data(socket, data) { try {
                socket.data.decoder.push(data);
            }
            catch {
                disconnect(socket);
            } },
            drain(socket) { try {
                socket.data.writer.drain();
            }
            catch {
                disconnect(socket);
            } },
            close: disconnect, end: disconnect, error: disconnect,
        },
    });
    chmodSync(path, 0o600);
    const identity = lstatSync(path);
    let closed = false;
    return { path, close() {
            if (closed)
                return;
            closed = true;
            for (const socket of sockets)
                disconnect(socket);
            listener.stop(true);
            try {
                const current = lstatSync(path);
                if (current.isSocket() && current.ino === identity.ino && current.dev === identity.dev)
                    unlinkSync(path);
            }
            catch (error) {
                if (error.code !== "ENOENT")
                    throw error;
            }
        } };
}
