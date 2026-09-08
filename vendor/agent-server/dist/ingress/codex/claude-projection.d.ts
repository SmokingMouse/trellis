import { type Item, type Thread, type Turn, type Usage, type ServerRequestMethod } from "../../protocol/index.js";
import type { NativeObject } from "./control-process.js";
export declare const nativeChanges: (changes: NativeObject[]) => {
    path: any;
    kind: {
        type: any;
    };
    diff: any;
}[];
/** One-way presentation only. No native -> AS item inverse exists. */
export declare function claudeItems(item: Item | NativeObject, threadId: string): NativeObject[];
export declare function claudeTurn(turn: Turn, items: Item[], threadId: string): NativeObject;
export declare function claudeStatus(type: string): NativeObject;
export declare function claudeThread(thread: Thread, turns?: NativeObject[]): NativeObject;
export declare function claudeSettings(thread: Thread): NativeObject;
export declare function claudeSettingsUpdated(thread: Thread): NativeObject;
export declare function claudeToolPermission(method: ServerRequestMethod, p: NativeObject): boolean;
export declare function claudeAnswer(method: ServerRequestMethod, p: NativeObject, result: NativeObject): NativeObject;
export declare function claudeApproval(method: ServerRequestMethod, p: NativeObject, thread: Thread): NativeObject;
/** AS last-usage becomes native last; totals are reconstructed from durable turns. */
export declare function claudeUsage(usage: Usage): NativeObject;
export declare function claudeNotification(method: string, p: NativeObject, thread: Thread, turns: Turn[], items: Item[]): NativeObject[];
