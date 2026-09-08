import { ErrorCode, ProtocolError } from "../../protocol/index.js";
import { NativeRpcError } from "./native-error.js";
export function pageLimit(value, fallback = 25, maximum = 100) {
    if (value == null)
        return fallback;
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffffffff)
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid pagination limit");
    return Math.min(maximum, Math.max(1, value));
}
/** Opaque ingress cursors never expose an AS seq cursor. Inclusive reverse
 * anchors match 0.153.4, including a terminal page and an empty page. */
export function nativePage(rows, p, scope, defaultDirection = "desc") {
    const direction = p.sortDirection ?? defaultDirection, limit = pageLimit(p.limit);
    if (direction !== "asc" && direction !== "desc")
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid sortDirection");
    const compare = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
    const sign = direction === "asc" ? 1 : -1;
    rows.sort((a, b) => sign * compare(a.key, b.key));
    if (p.cursor != null) {
        let c;
        try {
            if (typeof p.cursor !== "string")
                throw new Error();
            c = JSON.parse(Buffer.from(p.cursor, "base64url").toString());
            if (c.scope !== scope || !Array.isArray(c.key) || c.key.length !== 2 || !Number.isFinite(c.key[0]) || typeof c.key[1] !== "string" || typeof c.inclusive !== "boolean")
                throw new Error();
        }
        catch {
            throw new NativeRpcError(-32600, `invalid cursor: ${p.cursor}`);
        }
        rows = rows.filter(r => c.inclusive ? sign * compare(r.key, c.key) >= 0 : sign * compare(r.key, c.key) > 0);
    }
    const cursor = (key, inclusive) => Buffer.from(JSON.stringify({ scope, key, inclusive })).toString("base64url");
    const page = rows.slice(0, limit);
    return { data: page.map(r => r.value), nextCursor: rows.length > limit ? cursor(page.at(-1).key, false) : null,
        backwardsCursor: page.length ? cursor(page[0].key, true) : null };
}
export function turnItemsView(turn, view) {
    if (!["full", "summary", "notLoaded"].includes(view))
        throw new ProtocolError(ErrorCode.invalid_params, "as-ingress: invalid itemsView");
    if (view === "full")
        return turn;
    const user = turn.items.find((i) => i.type === "userMessage");
    const agent = turn.items.findLast((i) => i.type === "agentMessage");
    return { ...turn, itemsView: view, items: view === "notLoaded" ? [] : [user, agent].filter((i, n, items) => i && items.findIndex(x => x?.id === i.id) === n) };
}
