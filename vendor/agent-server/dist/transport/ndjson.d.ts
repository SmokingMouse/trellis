/** Shared framing for both ends of a unix socket. Decode only complete UTF-8 lines. */
export declare const MAX_MESSAGE_BYTES: number;
export declare class NDJSONDecoder {
    private readonly onLine;
    private readonly maxBytes;
    private chunks;
    private length;
    constructor(onLine: (line: string) => void, maxBytes?: number);
    push(data: Buffer): void;
}
/** Bun.write is unbuffered: retain the unaccepted suffix until drain, in wire order. */
export declare class UnixWriter {
    private readonly socket;
    private readonly maxBytes;
    private queue;
    private bytes;
    private ending;
    private closed;
    constructor(socket: Pick<Bun.Socket, "write" | "end">, maxBytes?: number);
    send(text: string): void;
    drain(): void;
    end(): void;
    dispose(): void;
}
//# sourceMappingURL=ndjson.d.ts.map