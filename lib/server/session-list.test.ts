import { afterAll, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-session-list-"));
const previousPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { listSessions, listRecentChains, countArchivedSessions } = await import("./repo");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previousPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousPath;
  rmSync(dir, { recursive: true, force: true });
});

test("四种来源进入会话与最近链列表，归档和隐藏根仍隔离", () => {
  const db = sqlite.getDB();
  for (const kind of ["user", "lark", "herdr", "task"]) {
    for (const archived of [0, 1]) {
      const id = `${kind}-${archived}`;
      db.prepare(`INSERT INTO sessions
        (id,title,root_node_id,created_at,updated_at,kind,archived,context_mode)
        VALUES (?,?,?,1,1,?,?, 'chat')`).run(id, id, id, kind, archived);
      db.prepare(`INSERT INTO nodes
        (id,session_id,parent_id,question,status,created_at)
        VALUES (?,?,NULL,?,'done',1)`).run(id, id, id);
    }
  }
  db.prepare(`INSERT INTO nodes
    (id,session_id,parent_id,question,status,created_at,hidden_at)
    VALUES ('hidden','herdr-0',NULL,'hidden','done',2,2)`).run();
  expect(listSessions().map(s => s.id).sort()).toEqual(["herdr-0", "lark-0", "task-0", "user-0"]);
  expect(listSessions().find(s => s.id === "task-0")?.kind).toBe("task");
  expect(listSessions().every(s => s.mode === "chat" && !s.archived)).toBeTrue();
  expect(listSessions({ archived: true }).map(s => s.id).sort()).toEqual(["herdr-1", "lark-1", "task-1", "user-1"]);
  expect(countArchivedSessions()).toBe(4);
  expect(listRecentChains().map(c => c.tipId).sort()).toEqual(["herdr-0", "lark-0", "task-0", "user-0"]);
  expect(listSessions().find(s => s.id === "herdr-0")?.treeCount).toBe(1);
  db.prepare(`INSERT INTO nodes (id,session_id,parent_id,question,status,created_at)
    VALUES ('second-topic','herdr-0',NULL,'topic','done',3),
           ('child','herdr-0','second-topic','child','done',4)`).run();
  expect(listSessions().find(s => s.id === "herdr-0")?.treeCount).toBe(2);
  expect(listSessions({ archived: true }).every(s => s.treeCount === 1)).toBeTrue();
});
