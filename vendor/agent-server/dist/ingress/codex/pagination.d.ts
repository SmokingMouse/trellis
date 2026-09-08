import type { NativeObject } from "./control-process.js";
export declare function pageLimit(value: unknown, fallback?: number, maximum?: number): number;
/** Opaque ingress cursors never expose an AS seq cursor. Inclusive reverse
 * anchors match 0.153.4, including a terminal page and an empty page. */
export declare function nativePage<T>(rows: Array<{
    key: [number, string];
    value: T;
}>, p: NativeObject, scope: string, defaultDirection?: string): NativeObject;
export declare function turnItemsView(turn: NativeObject, view: string): NativeObject;
