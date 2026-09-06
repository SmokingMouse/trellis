import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-bookmarks-"));
process.env.TRELLIS_DB_PATH = path.join(testDir, "bookmarks.db");

const sqlite = await import("./sqlite");
const repo = await import("./repo");
const nodeRoute = await import("../../app/api/nodes/[id]/route");
const bookmarksRoute = await import("../../app/api/bookmarks/route");

beforeAll(() => {
  const db = sqlite.getDB();
  db.prepare(
    "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at) VALUES (?,?,?,?,?)",
  ).run("active", "学习会话", "n1", 1, 1);
  db.prepare(
    "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,archived) VALUES (?,?,?,?,?,1)",
  ).run("archived", "归档会话", "n3", 1, 1);
  const insert = db.prepare(
    `INSERT INTO nodes
       (id,session_id,parent_id,question,response,status,sibling_index,created_at,read_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  );
  insert.run(
    "n1",
    "active",
    null,
    `# ${"问题".repeat(50)}`,
    `**重点** [链接](https://example.com) ${"回答".repeat(80)}`,
    "done",
    0,
    1,
    null,
  );
  insert.run("n2", "active", "n1", "第二问", "第二答", "done", 0, 2, 99);
  insert.run("n3", "archived", null, "归档问题", "归档回答", "done", 0, 3, null);
});

afterAll(() => {
  sqlite.getDB().close();
  rmSync(testDir, { recursive: true, force: true });
});

describe("read-later repository", () => {
  test("migration adds bookmarked_at and list is ordered, summarized and archive-safe", () => {
    const column = sqlite
      .getDB()
      .prepare(
        "SELECT name FROM pragma_table_info('nodes') WHERE name='bookmarked_at'",
      )
      .get() as { name: string } | undefined;
    expect(column?.name).toBe("bookmarked_at");

    repo.setNodeBookmark("n1", true, 1000);
    repo.setNodeBookmark("n2", true, 2000);
    repo.setNodeBookmark("n3", true, 3000);
    const rows = repo.listBookmarks({ limit: 10 });
    expect(rows.map((row) => row.nodeId)).toEqual(["n2", "n1"]);
    expect(rows[0]?.readAt).toBe(99);
    expect(Array.from(rows[1]?.question ?? "")).toHaveLength(80);
    expect(Array.from(rows[1]?.response ?? "").length).toBeLessThanOrEqual(120);
    expect(rows[1]?.response).not.toContain("**");
    expect(rows[1]?.response).not.toContain("https://");
  });

  test("setNodeBookmark is idempotent in both directions", () => {
    expect(repo.setNodeBookmark("n1", true, 4000)).toBe(4000);
    expect(repo.setNodeBookmark("n1", true, 4000)).toBe(4000);
    expect(repo.setNodeBookmark("n1", false)).toBeNull();
    expect(repo.setNodeBookmark("n1", false)).toBeNull();
    expect(repo.getNode("n1")?.bookmarkedAt).toBeNull();
  });
});

describe("read-later routes", () => {
  test("PATCH validates and toggles bookmark state", async () => {
    const bad = await nodeRoute.PATCH(
      new Request("http://localhost/api/nodes/n1", {
        method: "PATCH",
        body: JSON.stringify({ bookmarked: "yes" }),
      }),
      { params: Promise.resolve({ id: "n1" }) },
    );
    expect(bad.status).toBe(400);

    const missing = await nodeRoute.PATCH(
      new Request("http://localhost/api/nodes/missing", {
        method: "PATCH",
        body: JSON.stringify({ bookmarked: true }),
      }),
      { params: Promise.resolve({ id: "missing" }) },
    );
    expect(missing.status).toBe(404);

    const saved = await nodeRoute.PATCH(
      new Request("http://localhost/api/nodes/n1", {
        method: "PATCH",
        body: JSON.stringify({ bookmarked: true }),
      }),
      { params: Promise.resolve({ id: "n1" }) },
    );
    expect(saved.status).toBe(200);
    expect((await saved.json()).bookmarkedAt).toBeNumber();
  });

  test("GET applies its limit", async () => {
    repo.setNodeBookmark("n2", true, Date.now() + 1);
    const response = await bookmarksRoute.GET(
      new Request("http://localhost/api/bookmarks?limit=1"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { bookmarks: unknown[] };
    expect(body.bookmarks).toHaveLength(1);
  });
});
