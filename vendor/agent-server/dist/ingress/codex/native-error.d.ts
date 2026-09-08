/** Keep native read/history errors native instead of wrapping them as an
 * unavailable AS engine (which suggests a dead process for a bad cursor). */
export declare class NativeRpcError extends Error {
    readonly code: number;
    readonly data?: unknown | undefined;
    constructor(code: number, message: string, data?: unknown | undefined);
}
export declare function nativeResult<T>(result: Promise<T>): Promise<T>;
