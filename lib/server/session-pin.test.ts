import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-session-pin-"));
const previousPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { listSessions, setSessionPinned, getSession } = await import("./repo");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previousPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

test("置顶写 pinned_at、重复置顶保留原时刻、取消清空，且不动 updated_at", () => {
  const db = sqlite.getDB();
  for (const id of ["a", "b"]) {
    db.prepare(`INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,context_mode)
      VALUES (?,?,?,1,1,'chat')`).run(id, id, id);
  }
  expect(listSessions().every((s) => s.pinnedAt === null)).toBeTrue();

  expect(setSessionPinned("a", true, 100)?.pinnedAt).toBe(100);
  expect(setSessionPinned("a", true, 200)?.pinnedAt).toBe(100);
  expect(getSession("a")?.updatedAt).toBe(1);
  expect(listSessions().find((s) => s.id === "a")?.pinnedAt).toBe(100);

  expect(setSessionPinned("a", false, 300)?.pinnedAt).toBeNull();
  expect(setSessionPinned("missing", true, 1)).toBeNull();
});

test("迁移幂等：再跑一遍 migrate 不报错，列只有一份", () => {
  sqlite.resetDBForTests();
  const db = sqlite.getDB();
  const cols = db
    .prepare("SELECT name FROM pragma_table_info('sessions') WHERE name = 'pinned_at'")
    .all();
  expect(cols.length).toBe(1);
});
