import { ProtocolError } from "../../protocol/index.js";
/** Keep native read/history errors native instead of wrapping them as an
 * unavailable AS engine (which suggests a dead process for a bad cursor). */
export class NativeRpcError extends Error {
    code;
    data;
    constructor(code, message, data) {
        super(message);
        this.code = code;
        this.data = data;
    }
}
export async function nativeResult(result) {
    try {
        return await result;
    }
    catch (error) {
        if (error instanceof ProtocolError && typeof error.data.raw === "string") {
            let native;
            try {
                native = JSON.parse(error.data.raw);
            }
            catch { /* AS-only error. */ }
            if (typeof native?.code === "number" && typeof native?.message === "string")
                throw new NativeRpcError(native.code, native.message, native.data);
        }
        throw error;
    }
}
