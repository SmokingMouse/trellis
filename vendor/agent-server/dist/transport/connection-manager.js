import { ErrorCode, ProtocolError } from "../protocol/index.js";
export class ManagedConnection {
    client;
    peer;
    ingress = Promise.resolve();
    disposed = false;
    clientId;
    constructor(client, peer, remove) {
        this.client = client;
        this.peer = peer;
        this.clientId = client.clientId;
        client.onFrame(frame => {
            try {
                peer.send(JSON.stringify(frame));
            }
            catch {
                this.close();
            }
        });
        client.onClose(() => { remove(); this.disposed = true; peer.end(); });
    }
    receive(text) {
        // Parse errors use the same ingress queue as requests, never overtaking a response.
        this.ingress = this.ingress.then(async () => {
            if (this.disposed)
                return;
            let frame;
            try {
                frame = JSON.parse(text);
            }
            catch {
                this.peer.send(JSON.stringify({ jsonrpc: "2.0", id: null, error: new ProtocolError(ErrorCode.parse, "invalid JSON").toJSON() }));
                return;
            }
            await this.client.send(frame);
        }).catch(() => this.close());
    }
    close() { if (!this.disposed)
        this.client.close(); }
}
/** One wire connection is exactly one server client. Business routing stays in AgentServer. */
export class ConnectionManager {
    server;
    clients = new Map();
    constructor(server) {
        this.server = server;
    }
    get size() { return this.clients.size; }
    accept(peer) {
        const client = this.server.connectInProcess();
        const connection = new ManagedConnection(client, peer, () => this.clients.delete(client.clientId));
        this.clients.set(client.clientId, connection);
        return connection;
    }
    disconnect(clientId) { this.clients.get(clientId)?.close(); }
    close() { for (const connection of [...this.clients.values()])
        connection.close(); }
}
//# sourceMappingURL=connection-manager.js.map