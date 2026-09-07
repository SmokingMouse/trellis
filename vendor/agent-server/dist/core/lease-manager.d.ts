import { type ClientIdentity, type Lease } from "../protocol/index.js";
export declare class LeaseManager {
    private readonly now;
    private leases;
    constructor(now?: () => number);
    read(threadId: string): Lease | undefined;
    assertInput(threadId: string, clientId: string): void;
    acquire(threadId: string, holder: ClientIdentity, ttlMs?: number): Lease;
    release(threadId: string, clientId: string): void;
    disconnect(clientId: string): void;
    clear(threadId: string): void;
}
//# sourceMappingURL=lease-manager.d.ts.map