import type { Item } from "../protocol/index.js";
/** No tool replay: non-conversation items remain quoted records, including partial output. */
export declare function historyMessages(items: Item[]): Array<{
    role: "user" | "assistant";
    text: string;
}>;
export declare function codexHistoryInstructions(items: Item[]): string;
