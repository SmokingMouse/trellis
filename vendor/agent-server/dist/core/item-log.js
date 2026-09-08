import { Database } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { ErrorCode, ItemSchema, NotificationMethodSchema, NotificationSchema, NotificationSchemas, ProtocolError } from "../protocol/index.js";
export function canonical(value) {
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    if (value && typeof value === "object")
        return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
    return JSON.stringify(value);
}
export class ItemLog {
    db;
    partial = new Map();
    listeners = new Map();
    serverListeners = new Set();
    broadcasts = [];
    broadcasting = false;
    constructor(path = ":memory:") {
        if (path !== ":memory:") {
            mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
            // Secure the database before SQLite creates WAL/SHM with its file mode.
            closeSync(openSync(path, "a", 0o600));
            for (const file of [path, `${path}-wal`, `${path}-shm`])
                if (existsSync(file))
                    chmodSync(file, 0o600);
        }
        this.db = new Database(path, { create: true, strict: true });
        this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS threads (
        id TEXT PRIMARY KEY, backend TEXT NOT NULL, engine_thread_id TEXT, cwd TEXT NOT NULL,
        status TEXT NOT NULL, created_at INTEGER NOT NULL, client_thread_id TEXT UNIQUE,
        request_json TEXT NOT NULL, options_json TEXT NOT NULL, data_json TEXT NOT NULL, next_seq INTEGER NOT NULL DEFAULT 1,
        UNIQUE(backend, engine_thread_id)
      );
      CREATE INDEX IF NOT EXISTS threads_engine_id ON threads(engine_thread_id);
      CREATE TABLE IF NOT EXISTS ingress_audit (
        id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL, client_id TEXT NOT NULL,
        method TEXT NOT NULL, thread_id TEXT, code INTEGER NOT NULL, reason TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), ordinal INTEGER NOT NULL,
        status TEXT NOT NULL, client_turn_id TEXT UNIQUE, request_json TEXT NOT NULL, data_json TEXT NOT NULL,
        UNIQUE(thread_id, ordinal)
      );
      CREATE TABLE IF NOT EXISTS items (
        thread_id TEXT NOT NULL REFERENCES threads(id), id TEXT NOT NULL, seq INTEGER NOT NULL,
        turn_id TEXT NOT NULL REFERENCES turns(id), type TEXT NOT NULL, status TEXT NOT NULL,
        payload_json TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER,
        PRIMARY KEY(thread_id, id), UNIQUE(thread_id, seq)
      );
      CREATE INDEX IF NOT EXISTS items_turn ON items(thread_id, turn_id, seq);
      CREATE TABLE IF NOT EXISTS fork_points (thread_id TEXT NOT NULL REFERENCES threads(id), item_id TEXT NOT NULL, native_id TEXT NOT NULL, PRIMARY KEY(thread_id,item_id));
      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), turn_id TEXT REFERENCES turns(id),
        item_id TEXT NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL,
        decided_by TEXT, decision_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS queue (
        turn_id TEXT PRIMARY KEY REFERENCES turns(id), thread_id TEXT NOT NULL REFERENCES threads(id),
        ordinal INTEGER NOT NULL, enqueued_at INTEGER NOT NULL, preview TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS queue_thread ON queue(thread_id, ordinal);
    `);
        // Migrate databases created before completion cursors were introduced.
        const columns = this.db.query("PRAGMA table_info(items)").all();
        if (!columns.some(column => column.name === "completed_seq"))
            this.db.exec("ALTER TABLE items ADD COLUMN completed_seq INTEGER");
        this.transaction(() => {
            for (const row of this.db.query("SELECT thread_id,id FROM items WHERE status != 'inProgress' AND completed_seq IS NULL ORDER BY thread_id,seq").all()) {
                const seq = this.allocateSeq(row.thread_id);
                this.db.query("UPDATE items SET completed_seq=? WHERE thread_id=? AND id=?").run(seq, row.thread_id, row.id);
            }
        });
        // Migrate databases created before readonly_tools_disabled needed a turn-less audit row: SQLite
        // cannot ALTER a NOT NULL constraint away, so rebuild the table per the standard 12-step recipe.
        const approvalColumns = this.db.query("PRAGMA table_info(approvals)").all();
        if (approvalColumns.find(column => column.name === "turn_id")?.notnull) {
            this.db.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN;
        ALTER TABLE approvals RENAME TO approvals_pre_nullable_turn;
        CREATE TABLE approvals (
          id TEXT PRIMARY KEY, thread_id TEXT NOT NULL REFERENCES threads(id), turn_id TEXT REFERENCES turns(id),
          item_id TEXT NOT NULL, kind TEXT NOT NULL, params_json TEXT NOT NULL, status TEXT NOT NULL,
          decided_by TEXT, decision_json TEXT, created_at INTEGER NOT NULL, decided_at INTEGER
        );
        INSERT INTO approvals SELECT * FROM approvals_pre_nullable_turn;
        DROP TABLE approvals_pre_nullable_turn;
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
        }
    }
    allocateSeq(threadId) {
        return this.db.query("UPDATE threads SET next_seq=next_seq+1 WHERE id=? RETURNING next_seq-1 AS next_seq").get(threadId).next_seq;
    }
    transaction(work) { return this.db.transaction(work).immediate(); }
    thread(threadId) {
        const row = this.db.query("SELECT data_json FROM threads WHERE id = ?").get(threadId);
        if (!row)
            throw new ProtocolError(ErrorCode.thread_not_found, "thread not found", { threadId });
        return JSON.parse(row.data_json);
    }
    allThreads() { return this.db.query("SELECT data_json FROM threads ORDER BY created_at, id").all().map(row => JSON.parse(row.data_json)); }
    findEngine(engineId, backend) {
        const row = this.db.query("SELECT data_json FROM threads WHERE engine_thread_id = ? AND (? IS NULL OR backend = ?)").get(engineId, backend ?? null, backend ?? null);
        return row ? JSON.parse(row.data_json) : undefined;
    }
    options(id) { return JSON.parse(this.db.query("SELECT options_json FROM threads WHERE id = ?").get(id).options_json); }
    saveOptions(id, options) { this.db.query("UPDATE threads SET options_json = ? WHERE id = ?").run(JSON.stringify(options), id); }
    saveForkPoint(threadId, itemId, nativeId) {
        this.db.query("INSERT OR REPLACE INTO fork_points VALUES(?,?,?)").run(threadId, itemId, nativeId);
    }
    forkPoint(threadId, itemId) {
        return this.db.query("SELECT native_id FROM fork_points WHERE thread_id=? AND item_id=?").get(threadId, itemId)?.native_id;
    }
    /** Snapshot payloads and cursors; inherited turns get fresh globally unique IDs. */
    copyPrefix(sourceId, targetId, items, copyForkPoints = false) {
        this.transaction(() => {
            const turns = new Map();
            let nextSeq = 1;
            for (const item of items) {
                let turnId = turns.get(item.turnId);
                if (!turnId) {
                    turnId = `tu_${crypto.randomUUID()}`;
                    turns.set(item.turnId, turnId);
                    const original = this.turn(item.turnId, sourceId);
                    const turn = { id: turnId, threadId: targetId, ordinal: turns.size, status: "completed", enqueuedAtMs: original.enqueuedAtMs };
                    this.insertTurn(turn, { threadId: targetId, input: [] }, "");
                    this.dequeue(turnId);
                }
                this.db.query("INSERT INTO items(thread_id,id,seq,turn_id,type,status,payload_json,started_at,completed_at,completed_seq) VALUES(?,?,?,?,?,?,?,?,?,?)").run(targetId, item.id, item.seq, turnId, item.type, item.status ?? "inProgress", JSON.stringify(item.payload), item.startedAtMs, item.completedAtMs ?? null, item.completedSeq ?? null);
                nextSeq = Math.max(nextSeq, item.seq + 1, (item.completedSeq ?? 0) + 1);
                if (copyForkPoints) {
                    const point = this.forkPoint(sourceId, item.id);
                    if (point)
                        this.saveForkPoint(targetId, item.id, point);
                }
            }
            this.db.query("UPDATE threads SET next_seq=? WHERE id=?").run(nextSeq, targetId);
        });
    }
    deduplicate(table, key, request) {
        if (!key)
            return;
        const column = table === "threads" ? "client_thread_id" : "client_turn_id";
        const row = this.db.query(`SELECT data_json, request_json FROM ${table} WHERE ${column} = ?`).get(key);
        if (!row)
            return;
        if (row.request_json !== canonical(request))
            throw new ProtocolError(ErrorCode.duplicate_client_id, "idempotency key used for a different payload");
        return JSON.parse(row.data_json);
    }
    insertThread(thread, request, options = request) {
        this.db.query("INSERT INTO threads(id, backend, engine_thread_id, cwd, status, created_at, client_thread_id, request_json, options_json, data_json) VALUES(?,?,?,?,?,?,?,?,?,?)").run(thread.id, thread.backend, thread.engineThreadId, thread.cwd, thread.status.type, thread.createdAtMs, thread.clientThreadId ?? null, canonical(request), JSON.stringify(options), JSON.stringify(thread));
    }
    saveThread(thread) { this.db.query("UPDATE threads SET engine_thread_id = ?, cwd = ?, status = ?, data_json = ? WHERE id = ?").run(thread.engineThreadId, thread.cwd, thread.status.type, JSON.stringify(thread), thread.id); }
    insertTurn(turn, request, preview) {
        this.db.query("INSERT INTO turns(id,thread_id,ordinal,status,client_turn_id,request_json,data_json) VALUES(?,?,?,?,?,?,?)").run(turn.id, turn.threadId, turn.ordinal, turn.status, turn.clientTurnId ?? null, canonical(request), JSON.stringify(turn));
        this.db.query("INSERT INTO queue(turn_id,thread_id,ordinal,enqueued_at,preview) VALUES(?,?,?,?,?)").run(turn.id, turn.threadId, turn.ordinal, turn.enqueuedAtMs, preview);
    }
    turn(id, threadId) {
        const row = this.db.query("SELECT data_json FROM turns WHERE id = ?").get(id);
        const turn = row ? JSON.parse(row.data_json) : undefined;
        if (!turn || (threadId && turn.threadId !== threadId))
            throw new ProtocolError(ErrorCode.turn_not_found, "turn not found", { threadId, turnId: id });
        return turn;
    }
    turnInput(id) { return JSON.parse(this.db.query("SELECT request_json FROM turns WHERE id = ?").get(id).request_json); }
    turns(threadId) { return this.db.query("SELECT data_json FROM turns WHERE thread_id = ? ORDER BY ordinal").all(threadId).map(row => JSON.parse(row.data_json)); }
    saveTurn(turn) { this.db.query("UPDATE turns SET status = ?, data_json = ? WHERE id = ?").run(turn.status, JSON.stringify(turn), turn.id); }
    dequeue(turnId) { this.db.query("DELETE FROM queue WHERE turn_id = ?").run(turnId); }
    queue(threadId) {
        const rows = this.db.query("SELECT q.*,t.client_turn_id FROM queue q JOIN turns t ON t.id=q.turn_id WHERE q.thread_id=? ORDER BY q.ordinal").all(threadId);
        return rows.map((r, position) => ({ turnId: r.turn_id, ...(r.client_turn_id ? { clientTurnId: r.client_turn_id } : {}), position, enqueuedAtMs: r.enqueued_at, preview: r.preview }));
    }
    key(threadId, itemId) { return `${threadId}\0${itemId}`; }
    decodeItem(threadId, row) {
        return structuredClone(this.partial.get(this.key(threadId, row.id)) ?? ItemSchema.parse({ id: row.id, seq: row.seq, ...(row.completed_seq !== null ? { completedSeq: row.completed_seq } : {}), turnId: row.turn_id, type: row.type, status: row.status, payload: JSON.parse(row.payload_json), startedAtMs: row.started_at, ...(row.completed_at !== null ? { completedAtMs: row.completed_at } : {}) }));
    }
    readItems(threadId) {
        return this.logRows(threadId).map(row => this.decodeItem(threadId, row));
    }
    logRows(threadId) { return this.db.query("SELECT * FROM items WHERE thread_id = ? ORDER BY seq").all(threadId); }
    item(threadId, itemId) {
        const partial = this.partial.get(this.key(threadId, itemId));
        if (partial)
            return structuredClone(partial);
        const row = this.db.query("SELECT * FROM items WHERE thread_id=? AND id=?").get(threadId, itemId);
        if (!row)
            throw new ProtocolError(ErrorCode.engine_protocol_error, "item not found", { threadId, itemId });
        return this.decodeItem(threadId, row);
    }
    startItem(threadId, turnId, draft, now = Date.now()) {
        const item = this.transaction(() => {
            this.turn(turnId, threadId);
            const seq = this.db.query("SELECT next_seq FROM threads WHERE id = ?").get(threadId).next_seq;
            const item = ItemSchema.parse({ ...draft, status: draft.status ?? "inProgress", turnId, seq, startedAtMs: now });
            this.db.query("INSERT INTO items(thread_id,id,seq,turn_id,type,status,payload_json,started_at) VALUES(?,?,?,?,?,?,?,?)").run(threadId, item.id, seq, turnId, item.type, item.status, JSON.stringify(item.payload), now);
            this.db.query("UPDATE threads SET next_seq = next_seq + 1 WHERE id = ?").run(threadId);
            return item;
        });
        this.partial.set(this.key(threadId, item.id), structuredClone(item));
        this.publish({ jsonrpc: "2.0", method: "item/started", params: { threadId, turnId, itemId: item.id, item, seq: item.seq, startedAtMs: now } });
        return item;
    }
    delta(threadId, itemId, kind, text) {
        const item = this.item(threadId, itemId);
        if (item.status !== "inProgress")
            throw new ProtocolError(ErrorCode.engine_protocol_error, "delta after item completed", { threadId, itemId });
        const field = kind === "stdout" || kind === "stderr" ? "aggregatedOutput" : kind === "summary" ? "summary" : "text";
        const payload = item.payload;
        payload[field] = String(payload[field] ?? "") + text;
        this.partial.set(this.key(threadId, itemId), ItemSchema.parse(item));
        const base = { threadId, turnId: item.turnId, itemId };
        if (kind === "stdout" || kind === "stderr")
            this.publish({ jsonrpc: "2.0", method: "item/commandExecution/outputDelta", params: { ...base, chunk: text, stream: kind } });
        else
            this.publish({ jsonrpc: "2.0", method: kind === "reasoning" ? "item/reasoning/textDelta" : kind === "summary" ? "item/reasoning/summaryTextDelta" : "item/agentMessage/delta", params: { ...base, delta: text } });
    }
    updateItem(threadId, draft, completed = false, now = Date.now()) {
        const old = this.item(threadId, draft.id);
        if (old.type !== draft.type)
            throw new ProtocolError(ErrorCode.engine_protocol_error, "item type changed");
        const item = this.transaction(() => {
            const item = ItemSchema.parse({ ...old, ...draft, ...(completed ? { status: draft.status === "inProgress" ? "completed" : draft.status ?? "completed", completedAtMs: now, completedSeq: this.allocateSeq(threadId) } : {}) });
            this.db.query("UPDATE items SET status=?,payload_json=?,completed_at=?,completed_seq=? WHERE thread_id=? AND id=?").run(item.status ?? "inProgress", JSON.stringify(item.payload), item.completedAtMs ?? null, item.completedSeq ?? null, threadId, item.id);
            return item;
        });
        if (completed)
            this.partial.delete(this.key(threadId, item.id));
        else
            this.partial.set(this.key(threadId, item.id), structuredClone(item));
        const base = { threadId, turnId: item.turnId, itemId: item.id };
        if (completed)
            this.publish({ jsonrpc: "2.0", method: "item/completed", params: { ...base, item, seq: item.completedSeq, completedAtMs: now } });
        else if (item.type === "fileChange")
            this.publish({ jsonrpc: "2.0", method: "item/fileChange/patchUpdated", params: { ...base, changes: item.payload.changes } });
        else if (item.type === "subAgent")
            this.publish({ jsonrpc: "2.0", method: "item/subAgent/progress", params: { ...base, phase: item.payload.phase, ...(item.payload.progress !== undefined ? { progress: item.payload.progress } : {}) } });
        return item;
    }
    finishOpenItems(threadId, turnId, failed) {
        for (const item of this.readItems(threadId))
            if (item.turnId === turnId && item.status === "inProgress") {
                if (item.type === "fileChange")
                    item.payload.status = failed ? "failed" : "completed";
                this.updateItem(threadId, { ...item, status: failed ? "failed" : "completed" }, true);
            }
    }
    listItems(params) {
        this.thread(params.threadId);
        const direction = params.direction ?? "asc", limit = params.limit ?? 100;
        const cursor = params.cursor === undefined ? undefined : Number(params.cursor);
        if (cursor !== undefined && (!Number.isSafeInteger(cursor) || cursor < 0))
            throw new ProtocolError(ErrorCode.invalid_params, "invalid item cursor");
        const rows = this.db.query(`SELECT * FROM items WHERE thread_id=? AND (? IS NULL OR turn_id=?) AND (? IS NULL OR seq ${direction === "asc" ? ">" : "<"} ?) ORDER BY seq ${direction === "asc" ? "ASC" : "DESC"} LIMIT ?`).all(params.threadId, params.turnId ?? null, params.turnId ?? null, cursor ?? null, cursor ?? null, limit + 1);
        const more = rows.length > limit, items = rows.slice(0, limit).map(row => this.decodeItem(params.threadId, row));
        return { items, nextCursor: more ? String(items.at(-1).seq) : null };
    }
    pendingRequests(threadId) { return this.db.query("SELECT params_json FROM approvals WHERE thread_id=? AND status='pending' ORDER BY created_at,id").all(threadId).map(r => JSON.parse(r.params_json)); }
    snapshot(threadId, sinceSeq = 0) {
        const thread = this.thread(threadId);
        const all = this.readItems(threadId);
        // In-progress items reconcile already-seen identities after a disconnect.
        const items = all.filter(i => Math.max(i.seq, i.completedSeq ?? 0) > sinceSeq || i.status === "inProgress");
        const nextSeq = this.db.query("SELECT next_seq FROM threads WHERE id=?").get(threadId).next_seq;
        return { thread, items, nextSeq, queue: this.queue(threadId), pendingRequests: this.pendingRequests(threadId) };
    }
    subscribe(threadId, listener) {
        this.thread(threadId);
        let group = this.listeners.get(threadId);
        if (!group)
            this.listeners.set(threadId, group = new Set());
        group.add(listener);
        return () => { group.delete(listener); if (!group.size)
            this.listeners.delete(threadId); };
    }
    subscribeServer(listener) {
        this.serverListeners.add(listener);
        return () => { this.serverListeners.delete(listener); };
    }
    attach(threadId, listener, sinceSeq = 0) {
        const detach = this.subscribe(threadId, listener);
        // No await between subscription and snapshot: JS and sqlite run in one owner.
        return { snapshot: this.snapshot(threadId, sinceSeq), detach };
    }
    publish(notification) {
        // Additive AS v1 methods have only the generic JSON params contract here.
        const method = NotificationMethodSchema.safeParse(notification.method);
        const schema = method.success ? NotificationSchemas[method.data] : NotificationSchema.shape.params;
        const parsed = schema.safeParse(notification.params);
        if (!parsed.success) {
            console.error(`Dropped invalid ${notification.method} notification: ${parsed.error.message}`);
            return;
        }
        this.broadcasts.push(structuredClone({ ...notification, params: parsed.data }));
        if (this.broadcasting)
            return;
        this.broadcasting = true;
        try {
            for (let next = this.broadcasts.shift(); next; next = this.broadcasts.shift()) {
                const threadId = "threadId" in next.params ? next.params.threadId : undefined;
                for (const listener of [...(threadId ? this.listeners.get(threadId) ?? [] : this.serverListeners)]) {
                    try {
                        listener(structuredClone(next));
                    }
                    catch { /* A disconnected consumer cannot roll back a committed event. */ }
                }
            }
        }
        finally {
            this.broadcasting = false;
        }
    }
    approval(id) { return this.db.query("SELECT * FROM approvals WHERE id=?").get(id); }
    /**
     * Persists a readonly-auto-allow decision into the same `approvals` table as broker-mediated
     * approvals (status='auto_allowed', decided immediately), so "which rule let this Bash command
     * skip approval" survives process restarts and is queryable the same way regular approvals are,
     * not just visible on the live engineEvent broadcast.
     */
    recordReadonlyAutoAllow(entry) {
        const now = entry.now ?? Date.now();
        const detail = JSON.stringify({ command: entry.command, matchedRules: entry.matchedRules });
        this.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,decided_by,decision_json,created_at,decided_at) VALUES(?,?,?,?,'readonly_auto_allow',?,'auto_allowed',?,?,?,?)")
            .run(entry.id, entry.threadId, entry.turnId, entry.itemId, detail, JSON.stringify({ system: "readonly_auto_allow" }), detail, now, now);
    }
    readonlyAutoAllows(threadId) {
        return this.db.query("SELECT * FROM approvals WHERE thread_id=? AND kind='readonly_auto_allow' ORDER BY created_at,id").all(threadId);
    }
    /** Same rationale as recordReadonlyAutoAllow, for the readonly-thread write-tool direct-deny path. */
    recordReadonlyDenied(entry) {
        const now = entry.now ?? Date.now();
        const detail = JSON.stringify({ toolName: entry.toolName });
        this.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,decided_by,decision_json,created_at,decided_at) VALUES(?,?,?,?,'readonly_denied',?,'auto_denied',?,?,?,?)")
            .run(entry.id, entry.threadId, entry.turnId, entry.itemId, detail, JSON.stringify({ system: "readonly_denied" }), detail, now, now);
    }
    readonlyDenials(threadId) {
        return this.db.query("SELECT * FROM approvals WHERE thread_id=? AND kind='readonly_denied' ORDER BY created_at,id").all(threadId);
    }
    /**
     * Same rationale as recordReadonlyAutoAllow: "this thread's write tools were disabled" must
     * survive past the one-shot spawn-time engineEvent broadcast. Unlike the sibling records this
     * fires before any turn exists, so turn_id is NULL (see the nullable-turn_id migration above)
     * and item_id is a synthetic constant rather than a real tool-use id.
     */
    recordReadonlyToolsDisabled(entry) {
        const now = entry.now ?? Date.now();
        const detail = JSON.stringify({ toolNames: entry.toolNames, reason: entry.reason });
        this.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,decided_by,decision_json,created_at,decided_at) VALUES(?,?,NULL,'spawn','readonly_tools_disabled',?,'auto_denied',?,?,?,?)")
            .run(entry.id, entry.threadId, detail, JSON.stringify({ system: "readonly_tools_disabled" }), detail, now, now);
    }
    readonlyToolsDisabled(threadId) {
        return this.db.query("SELECT * FROM approvals WHERE thread_id=? AND kind='readonly_tools_disabled' ORDER BY created_at,id").all(threadId);
    }
    /** Same persistence pattern as recordReadonlyAutoAllow, for the bypassPermissions/dontAsk and can_use_tool auto-response paths. */
    recordPermissionAutoResponse(entry) {
        const now = entry.now ?? Date.now();
        const detail = JSON.stringify({ toolName: entry.toolName, permission: entry.permission, behavior: entry.behavior });
        this.db.query("INSERT INTO approvals(id,thread_id,turn_id,item_id,kind,params_json,status,decided_by,decision_json,created_at,decided_at) VALUES(?,?,?,?,'permission_auto_response',?,?,?,?,?,?)")
            .run(entry.id, entry.threadId, entry.turnId, entry.itemId, detail, entry.behavior === "allow" ? "auto_allowed" : "auto_denied", JSON.stringify({ system: "permission_auto_response" }), detail, now, now);
    }
    permissionAutoResponses(threadId) {
        return this.db.query("SELECT * FROM approvals WHERE thread_id=? AND kind='permission_auto_response' ORDER BY created_at,id").all(threadId);
    }
    close() { this.listeners.clear(); this.serverListeners.clear(); this.partial.clear(); this.db.close(); }
}
