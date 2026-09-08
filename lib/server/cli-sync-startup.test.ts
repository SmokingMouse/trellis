import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

test("startup serves HTTP during offline catchup and retains all mirror sessions", async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cli-startup-"));
  // A child isolates the mocked parser and watcher's process-wide started flag
  // from the rest of the suite. Slow parsing models accumulated CLI histories.
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const attempts = [];
    const original = await import(${JSON.stringify(path.resolve("lib/server/cli-import-db.ts"))});
    mock.module(${JSON.stringify(path.resolve("lib/server/cli-import-db.ts"))}, () => ({
      ...original,
      importCliLineage(id) {
        const until = performance.now() + 15;
        while (performance.now() < until) {}
        attempts.push(id);
        if (id === "mirror-3") throw Error("unreadable transcript");
        return { status: "unchanged", sessionId: id };
      },
    }));
    const { getDB } = await import(${JSON.stringify(path.resolve("lib/server/sqlite.ts"))});
    const db = getDB();
    const insert = db.prepare("INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,origin) VALUES (?,?,'',1,1,?)");
    for (let i = 0; i < 20; i++) insert.run("mirror-"+i,"fixture",i%2 ? "herdr" : "cli-import");
    insert.run("native","not attached","native");
    const { startCliSyncWatcher } = await import(${JSON.stringify(path.resolve("lib/server/cli-sync-watcher.ts"))});
    const server = Bun.serve({hostname:"127.0.0.1",port:0,fetch(){return Response.json({completed:attempts.length});}});
    const response = fetch(server.url);
    startCliSyncWatcher();
    startCliSyncWatcher();
    const seen = await (await response).json();
    assert.ok(seen.completed < 20, "HTTP must be served before all catchup imports finish");
    const deadline=Date.now()+5000;
    while(attempts.length<20 && Date.now()<deadline) await Bun.sleep(10);
    assert.equal(attempts.length,20,"a broken transcript must not stop later mirrors");
    assert.equal(new Set(attempts).size,20,"repeated startup must not duplicate imports");
    assert.ok(!attempts.includes("native"));
    server.stop(true);
    console.log(JSON.stringify({httpDuringCatchup:seen.completed,completed:attempts.length}));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn(["bun", "--conditions", "react-server", "-e", script], {
      env: { ...process.env, TRELLIS_DB_PATH: path.join(temporary, "data.db"), http_proxy: "", https_proxy: "", ALL_PROXY: "", no_proxy: "*" },
      stdout: "pipe", stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect(exit, stderr + stdout).toBe(0);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}, 10000);
