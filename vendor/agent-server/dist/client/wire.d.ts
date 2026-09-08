export interface ClientWire {
    send(text: string): void;
    close(): void;
}
export type ClientEndpoint = {
    transport: "unix";
    path: string;
} | {
    transport: "ws";
    url: string;
};
export declare function openWire(endpoint: ClientEndpoint, onMessage: (text: string) => void, onClose: (error: Error) => void, timeoutMs: number): Promise<ClientWire>;
