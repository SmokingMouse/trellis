import { getDB } from "@/lib/server/sqlite";
import { POST as cleanPost } from "@/app/api/workspaces/worktree/clean/route";
import { GET as diffGet } from "@/app/api/workspaces/git-diff/route";

let failed = 0;
function check(label: string, condition: boolean, extra?: string) {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.log(`  ✗ ${label}${extra ? `\n    ${extra}` : ""}`);
  }
}

async function main() {
  console.log("Testing Workspace Read & Write Optimizations...");
  const db = getDB();

  // 确保测试 Project 存在
  let p = db.prepare("SELECT id FROM projects LIMIT 1").get() as { id: string } | undefined;
  if (!p) {
    db.prepare("INSERT OR IGNORE INTO projects (id, name, cluster_key, created_at) VALUES ('test-p', 'test-p', 'test-p', ?)")
      .run(Date.now());
    p = { id: "test-p" };
  }
  const projectId = p.id;

  // 1. GET /api/workspaces/git-diff 缺少 workspaceId
  {
    const req = new Request("http://localhost/api/workspaces/git-diff");
    const res = await diffGet(req);
    check("GET /api/workspaces/git-diff should return 400 when missing workspaceId", res.status === 400);
    const data = await res.json();
    check("GET /api/workspaces/git-diff error message contains workspaceId", typeof data.error === "string" && data.error.includes("workspaceId"));
  }

  // 2. GET /api/workspaces/git-diff 正常读取
  {
    const cwd = process.cwd();
    let ws = db
      .prepare("SELECT id, name, path FROM workspaces WHERE path = ?")
      .get(cwd) as { id: string; name: string; path: string } | undefined;

    if (!ws) {
      const id = "test-ws-" + Math.random().toString(36).slice(2);
      const now = Date.now();
      db.prepare(
        `INSERT INTO workspaces (id, project_id, name, path, kind, git_branch, created_by, created_at, last_used_at)
         VALUES (?, ?, 'test-ws', ?, 'worktree', 'main', 'test', ?, ?)`,
      ).run(id, projectId, cwd, now, now);
      ws = { id, name: "test-ws", path: cwd };
    }

    const req = new Request(`http://localhost/api/workspaces/git-diff?workspaceId=${ws.id}`);
    const res = await diffGet(req);
    check("GET /api/workspaces/git-diff returns 200 for valid workspace", res.status === 200);
    const data = await res.json();
    check("GET /api/workspaces/git-diff matches workspaceId", data.workspaceId === ws.id);
    check("GET /api/workspaces/git-diff recognizes git workspace", data.isGit === true);
    check("GET /api/workspaces/git-diff returns files array", Array.isArray(data.files));
  }

  // 3. POST /api/workspaces/worktree/clean 校验与预检模式
  {
    const badReq = new Request("http://localhost/api/workspaces/worktree/clean", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const badRes = await cleanPost(badReq);
    check("POST /api/workspaces/worktree/clean returns 400 when missing workspaceIds", badRes.status === 400);

    const dummyId = "dummy-ws-" + Math.random().toString(36).slice(2);
    const now = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, project_id, name, path, kind, git_branch, created_by, created_at, last_used_at)
       VALUES (?, ?, 'dummy-reclaim', '/tmp/nonexistent-dummy-dir', 'worktree', 'fix/dummy', 'test', ?, ?)`,
    ).run(dummyId, projectId, now, now);

    // 预检预览模式
    const previewReq = new Request("http://localhost/api/workspaces/worktree/clean", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [dummyId], force: false }),
    });
    const previewRes = await cleanPost(previewReq);
    check("POST /api/workspaces/worktree/clean preview returns 200", previewRes.status === 200);
    const previewData = await previewRes.json();
    check("POST /api/workspaces/worktree/clean preview returns preview: true", previewData.preview === true);
    check("POST /api/workspaces/worktree/clean preview finds dummy workspace", previewData.items[0]?.id === dummyId);

    // 真正执行模式
    const forceReq = new Request("http://localhost/api/workspaces/worktree/clean", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workspaceIds: [dummyId], force: true }),
    });
    const forceRes = await cleanPost(forceReq);
    check("POST /api/workspaces/worktree/clean force execution returns 200", forceRes.status === 200);
    const forceData = await forceRes.json();
    check("POST /api/workspaces/worktree/clean returns ok: true", forceData.ok === true);
    check("POST /api/workspaces/worktree/clean removed count is 1", forceData.removedCount === 1);

    const checkRow = db.prepare("SELECT id FROM workspaces WHERE id = ?").get(dummyId);
    check("Dummy workspace was cleaned from DB", checkRow === undefined || checkRow === null);
  }

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} checks failed.`);
    process.exit(1);
  } else {
    console.log(`\nALL PASS!`);
  }
}

main().catch((err) => {
  console.error("Test failed with error:", err);
  process.exit(1);
});
