import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";

mock.module("server-only", () => ({}));

const root = mkdtempSync("/tmp/trellis-worktree-clean-");
const workspacePath = path.join(root, "worktree");
mkdirSync(workspacePath);
process.env.TRELLIS_DB_PATH = path.join(root, "trellis.db");

const sqlite = await import("@/lib/server/sqlite");
const batchRoute = await import("./route");
const singleRoute = await import("../route");

beforeAll(() => {
  const db = sqlite.getDB();
  db.prepare(
    `INSERT INTO projects
     (id,name,cluster_key,git_remote,created_at,updated_at)
     VALUES ('p','repo','test:repo',NULL,1,1)`,
  ).run();
  db.prepare(
    `INSERT INTO workspaces
     (id,project_id,name,path,kind,git_branch,created_by,created_at,last_used_at)
     VALUES ('w','p','feature',?,'worktree','feature','trellis',1,1)`,
  ).run(workspacePath);
  const addSession = db.prepare(
    `INSERT INTO sessions
     (id,title,root_node_id,created_at,updated_at,archived,workspace_id)
     VALUES (?,?,?,?,?,?,?)`,
  );
  addSession.run("active", "active", "n1", 1, 1, 0, "w");
  addSession.run("archived", "archived", "n2", 1, 1, 1, "w");
});

afterAll(() => {
  sqlite.getDB().close();
  rmSync(root, { recursive: true, force: true });
});

describe("worktree clean previews", () => {
  test("batch preview reports only non-archived sessions without blocking opt-in", async () => {
    const response = await batchRoute.POST(
      new Request("http://localhost/api/workspaces/worktree/clean", {
        method: "POST",
        body: JSON.stringify({ workspaceIds: ["w"], force: false }),
      }),
    );
    const body = (await response.json()) as {
      items: Array<{ sessionCount: number; canClean: boolean }>;
    };
    expect(body.items[0]).toMatchObject({ sessionCount: 1, canClean: true });
  });

  test("single-delete preview reports the same active session count", async () => {
    const response = await singleRoute.DELETE(
      new Request("http://localhost/api/workspaces/worktree?workspaceId=w", {
        method: "DELETE",
      }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ preview: true, sessionCount: 1 });
  });
});
