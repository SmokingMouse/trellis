import { afterAll, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-session-list-"));
const previousPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { listSessions, listRecentChains, countArchivedSessions } = await import("./repo");
const { listProjectTree } = await import("./workspaces");

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

test("项目树对 Herdr / task 等来源的计数与统一列表一致，工作区语义过滤保留", () => {
  const db = sqlite.getDB();
  db.prepare(`INSERT INTO projects (id,name,cluster_key,created_at,updated_at)
    VALUES ('sources','sources','dir:sources',1,1)`).run();
  const addWorkspace = (id: string, createdBy = "discovered", exists = true) => {
    const workspacePath = path.join(dir, id);
    if (exists) mkdirSync(workspacePath);
    db.prepare(`INSERT INTO workspaces (id,project_id,name,path,kind,created_by,created_at)
      VALUES (?,'sources',?,?,'main',?,1)`).run(id, id, workspacePath, createdBy);
  };
  for (const session of listSessions()) {
    const workspaceId = `workspace-${session.kind}`;
    addWorkspace(workspaceId);
    db.prepare("UPDATE sessions SET workspace_id = ? WHERE kind = ?").run(workspaceId, session.kind!);
  }
  addWorkspace("archive-only");
  db.prepare("UPDATE sessions SET workspace_id = 'archive-only' WHERE id = 'herdr-1'").run();
  addWorkspace("empty-discovered");
  addWorkspace("empty-created", "trellis");
  addWorkspace("missing", "trellis", false);
  const workspaces = listProjectTree(db).find(p => p.id === "sources")!.workspaces;
  expect(workspaces.map(w => w.id).sort()).toEqual([
    "empty-created", "workspace-herdr", "workspace-lark", "workspace-task", "workspace-user",
  ]);
  for (const workspace of workspaces) {
    expect(workspace.sessionCount).toBe(listSessions().filter(s => s.workspaceId === workspace.id).length);
  }
  expect(workspaces.find(w => w.id === "workspace-herdr")?.sessionCount).toBe(1);
  expect(workspaces.find(w => w.id === "workspace-task")?.sessionCount).toBe(1);
  expect(listSessions({ archived: true }).find(s => s.id === "herdr-1")?.workspaceId).toBe("archive-only");
  const complete = listProjectTree(db, { includeEmpty: true }).find(p => p.id === "sources")!.workspaces;
  expect(complete.map(w => w.id).sort()).toEqual([
    "archive-only", "empty-created", "empty-discovered",
    "workspace-herdr", "workspace-lark", "workspace-task", "workspace-user",
  ]);
  const archivedSession = listSessions({ archived: true }).find(s => s.id === "herdr-1")!;
  expect(complete.find(w => w.id === archivedSession.workspaceId)?.sessionCount).toBe(0);
  expect(complete.some(w => w.id === "missing")).toBeFalse();
  // 显式请求 V2 骨架不会改变后续旧调用方的默认行为。
  expect(listProjectTree(db).find(p => p.id === "sources")!.workspaces).toEqual(workspaces);
});
