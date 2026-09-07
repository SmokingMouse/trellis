import type { Backend, PendingServerRequest, ServerRequestResult, StartTurnParams, UserInput } from "../protocol/index.js";
import { AsyncQueue, type EngineEvent, type EngineSession, type SessionOptions } from "./session.js";
export type MockStep = EngineEvent | {
    waitMs: number;
} | {
    approval: PendingServerRequest;
    onDecision?: (decision: ServerRequestResult) => void;
};
export type MockScript = (turnId: string, input: UserInput[], engine: MockEngine) => Iterable<MockStep> | AsyncIterable<MockStep>;
export declare class MockEngine implements EngineSession {
    readonly script?: MockScript | undefined;
    readonly backend: Backend;
    readonly events: AsyncQueue<EngineEvent>;
    engineThreadId: string | null;
    spawnCount: number;
    attachCount: number;
    options?: SessionOptions;
    sent: Array<{
        turnId: string;
        input: UserInput[];
        options: StartTurnParams;
    }>;
    steered: Array<{
        turnId: string;
        input: UserInput[];
    }>;
    interrupted: string[];
    closed: boolean;
    private active;
    private generation;
    constructor(script?: MockScript | undefined, backend?: Backend);
    spawn(options: SessionOptions): Promise<void>;
    attach(): Promise<void>;
    sendTurn(turnId: string, input: UserInput[], options: StartTurnParams): Promise<void>;
    private play;
    emit(event: EngineEvent): void;
    steer(turnId: string, input: UserInput[]): Promise<void>;
    interrupt(turnId: string): Promise<void>;
    close(_reason: string): Promise<void>;
}
//# sourceMappingURL=mock.d.ts.map