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

test("hook fields are bounded UTF-8 and fleet state projects six fields with ETag", async () => {
  const large = '中"\\'.repeat(40_000);
  store.recordClaudeHook({ hook_event_name: "PreToolUse", session_id: "large", tool_name: "Write", tool_input: { content: large } });
  store.recordClaudeHook({ hook_event_name: "Stop", session_id: "large", last_assistant_message: large });
  const row = sqlite.getDB().prepare("SELECT length(CAST(last_assistant_message AS BLOB)) AS size FROM agent_hook_state WHERE session_id = 'large'").get() as { size: number };
  expect(row.size).toBeLessThanOrEqual(store.HOOK_FIELD_MAX_BYTES);
  store.recordClaudeHook({ hook_event_name: "PreToolUse", session_id: "large", tool_name: "Write", tool_input: { content: large } });
  const input = sqlite.getDB().prepare("SELECT tool_input FROM agent_hook_state WHERE session_id = 'large'").get() as { tool_input: string };
  expect(Buffer.byteLength(input.tool_input)).toBeLessThanOrEqual(store.HOOK_FIELD_MAX_BYTES);
  expect(JSON.parse(input.tool_input).truncated).toBeTrue();
  const route = await import("../../../app/api/hooks/state/route");
  const first = await route.GET();
  const body = await first.json();
  expect(Object.keys(body.records[0]).sort()).toEqual(["sessionId", "state", "toolName", "interactivePrompt", "paneKey", "updatedAt"].sort());
  const tag = first.headers.get("etag")!;
  const unchanged = await route.GET(new Request("http://localhost/api/hooks/state", { headers: { "If-None-Match": tag } }));
  expect(unchanged.status).toBe(304);
  expect(await unchanged.text()).toBe("");
  store.recordClaudeHook({ hook_event_name: "PermissionRequest", session_id: "large", tool_name: "Bash" });
  expect((await route.GET()).headers.get("etag")).not.toBe(tag);
});

test("truncating a stashed tool payload preserves the restorable state envelope", () => {
  const waiting = store.recordClaudeHook({ hook_event_name: "PermissionRequest", session_id: "stash-large", tool_name: "Bash" })!;
  store.saveHookRecord({ ...waiting, subagents: ["child"], stashed: {
    state: "working", toolName: "Write", toolInput: { content: "x".repeat(100_000) }, interactivePrompt: null,
  } });
  const restored = store.recordClaudeHook({ hook_event_name: "SubagentStop", session_id: "stash-large", agent_type: "child" })!;
  expect(restored.state).toBe("working");
  expect(restored.toolName).toBe("Write");
  expect(restored.toolInput).toMatchObject({ truncated: true });
});
