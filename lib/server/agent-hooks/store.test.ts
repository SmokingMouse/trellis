import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
mock.module("server-only", () => ({}));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-hook-store-"));
const previousDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "test.db");
const sqlite = await import("../sqlite");
sqlite.resetDBForTests();
const store = await import("./store");
afterAll(() => {
  sqlite.resetDBForTests();
  if (previousDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousDbPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("expired hook records are removed while recent waiting records survive", () => {
  store.recordClaudeHook({ hook_event_name: "SessionStart", session_id: "expired" }, { now: Date.now() - store.HOOK_RETENTION_MS - 1 });
  store.recordClaudeHook({ hook_event_name: "PermissionRequest", session_id: "recent", tool_name: "Bash" });
  expect(store.listHookRecords().map(record => record.sessionId)).toEqual(["recent"]);
  expect(store.getHookRecord("expired")).toBeNull();
  expect(store.getHookRecord("recent")?.state).toBe("waiting");
});
