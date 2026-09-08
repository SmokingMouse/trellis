export interface PidRecord {
    pid: number;
    processStart: string;
    socketPath: string;
    graceMs: number;
}
export declare function isAlive(pid: number): boolean;
export declare function readPid(path: string): {
    raw: string;
    record?: PidRecord;
    pid?: number;
} | undefined;
export declare function ownsProcess(record: PidRecord): boolean;
export declare function removePid(path: string, raw: string): void;
export declare function claimPid(path: string, socketPath: string, graceMs: number): () => void;
/** A stale inode may be removed only after a direct local connection is refused. */
export declare function removeStaleSocket(path: string): Promise<void>;
