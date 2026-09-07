import { ErrorCode, ProtocolError } from "../protocol/index.js";
export class LeaseManager {
    now;
    leases = new Map();
    constructor(now = Date.now) {
        this.now = now;
    }
    read(threadId) {
        const lease = this.leases.get(threadId);
        if (lease && lease.expiresAtMs <= this.now()) {
            this.leases.delete(threadId);
            return;
        }
        return lease ? structuredClone(lease) : undefined;
    }
    assertInput(threadId, clientId) {
        const lease = this.read(threadId);
        if (lease && lease.holder.clientId !== clientId)
            throw new ProtocolError(ErrorCode.lease_held, "input lease held", { threadId, holder: lease.holder });
    }
    assertHeld(threadId, clientId) {
        this.assertInput(threadId, clientId);
        if (!this.read(threadId))
            throw new ProtocolError(ErrorCode.unauthorized, "an active thread lease is required for permission escalation", { threadId });
    }
    acquire(threadId, holder, ttlMs = 5 * 60_000) {
        this.assertInput(threadId, holder.clientId);
        const lease = { threadId, holder: structuredClone(holder), expiresAtMs: this.now() + ttlMs };
        this.leases.set(threadId, lease);
        return structuredClone(lease);
    }
    release(threadId, clientId) { this.assertInput(threadId, clientId); this.leases.delete(threadId); }
    disconnect(clientId) { for (const [id, lease] of this.leases)
        if (lease.holder.clientId === clientId)
            this.leases.delete(id); }
    clear(threadId) { this.leases.delete(threadId); }
}
