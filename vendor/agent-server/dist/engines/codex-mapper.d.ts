import { ProtocolError, type Item, type PendingServerRequest, type ServerRequestMethod, type ServerRequestResult, type UserInput } from "../protocol/index.js";
import type { EngineEvent, EngineItem } from "./session.js";
export declare function codexRecord(value: unknown): Record<string, any>;
export declare function codexProtocolError(message: string, raw: unknown): ProtocolError;
export declare function codexString(value: unknown, field: string): string;
export declare function codexUserInput(input: UserInput[]): Record<string, unknown>[];
export declare function codexFileChanges(raw: unknown): Extract<Item, {
    type: "fileChange";
}>["payload"]["changes"];
export declare function mapCodexItem(raw: unknown, completed?: boolean, parentItemId?: string): EngineItem;
export declare class CodexEventMapper {
    private items;
    private unknownItems;
    private parents;
    private parts;
    private inputs;
    private turnId;
    private totalUsage?;
    private turnUsage?;
    constructor(resumed?: boolean);
    beginTurn(turnId: string): void;
    registerInput(input: UserInput[], clientTurnId?: string): void;
    getItem(id: string): EngineItem | undefined;
    private put;
    ensureRequestItem(method: ServerRequestMethod, raw: unknown): EngineEvent[];
    map(method: string, raw: unknown): EngineEvent[];
}
export declare function mapCodexRequest(method: ServerRequestMethod, raw: unknown, threadId: string, turnId: string, requestId: string, item?: EngineItem): PendingServerRequest;
export declare function mapCodexDecision(method: ServerRequestMethod, raw: ServerRequestResult): Record<string, unknown>;
//# sourceMappingURL=codex-mapper.d.ts.map