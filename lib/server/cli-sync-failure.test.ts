import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// S177 P1：cli-sync 的 reimport 失败原先只 console.error，界面永远停在旧快照。
// 这里锁住**出口分流**：瞬时争用只记日志等下一轮，盘满 / IO 错才惊动人。
//
// 判据必须是 db-error 的 classifyDbError / isDbFailure ——
// importCliLineage 的事务还没纳入 dbWrite（P2 待办），禁区里原始的 SQLiteError
// 会直接抛上来，只判 `instanceof DbWriteError` 会整个漏掉。下面第一条就是它。

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-clisync-fail-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { DbWriteError } = await import("./db-error");
const { reportReimportFailure, noteReimportSuccess } = await import(
  "./cli-sync-watcher"
);
import type { CliSyncFailure } from "./cli-sync-events";

afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

function sqliteError(code: string, message = `${code}: injected`): Error {
  const e = new Error(message) as Error & { code: string };
  e.code = code;
  return e;
}

/** 一套独立的注入桩：告警 / 事件 / 时钟 / 日志全部可观测，互不污染。 */
function harness(start = 1_000_000) {
  const alerts: { title: string; body: string }[] = [];
  const events: CliSyncFailure[] = [];
  const alertState: Record<string, number> = {};
  const eventState: Record<string, number> = {};
  let now = start;
  return {
    alerts,
    events,
    advance: (ms: number) => (now += ms),
    reset: () => noteReimportSuccess({ alertState, eventState }),
    deps: {
      now: () => now,
      alertState,
      eventState,
      send: (e: { title: string; body: string }) => {
        alerts.push(e);
      },
      publish: (f: CliSyncFailure) => {
        events.push(f);
      },
      log: () => {},
    },
  };
}

test("原始 SQLiteError(SQLITE_FULL)：没包成 DbWriteError 也要告警 + 推事件", async () => {
  const h = harness();
  const out = await reportReimportFailure(
    "/tmp/a.jsonl",
    "sess-a",
    sqliteError("SQLITE_FULL", "SQLITE_FULL: database or disk is full"),
    h.deps,
  );
  expect(out.kind).toBe("full");
  expect(out.exit).toBe("surfaced");
  expect(out.alerted).toBe(true);
  expect(h.alerts).toHaveLength(1);
  expect(h.events).toHaveLength(1);
  expect(h.events[0]).toMatchObject({
    path: "/tmp/a.jsonl",
    sessionId: "sess-a",
    kind: "full",
  });
});

test("DbWriteError(IOERR)：同样走告警通道", async () => {
  const h = harness();
  const out = await reportReimportFailure(
    "/tmp/b.jsonl",
    "sess-b",
    new DbWriteError("import", sqliteError("SQLITE_IOERR_WRITE"), 1),
    h.deps,
  );
  expect(out.kind).toBe("io");
  expect(out.alerted).toBe(true);
  expect(h.events[0].kind).toBe("io");
});

test("BUSY：瞬时争用只记日志，不告警、不推事件、等下一轮", async () => {
  const h = harness();
  const out = await reportReimportFailure(
    "/tmp/c.jsonl",
    "sess-c",
    sqliteError("SQLITE_BUSY", "database is locked"),
    h.deps,
  );
  expect(out.exit).toBe("retry");
  expect(out.alerted).toBe(false);
  expect(out.published).toBe(false);
  expect(h.alerts).toHaveLength(0);
  expect(h.events).toHaveLength(0);
});

test("盘满时几十个文件同时失败：告警按类别去重，只响一次", async () => {
  const h = harness();
  for (let i = 0; i < 20; i++) {
    await reportReimportFailure(
      `/tmp/storm-${i}.jsonl`,
      `sess-${i}`,
      sqliteError("SQLITE_FULL"),
      h.deps,
    );
  }
  expect(h.alerts).toHaveLength(1);
  // 事件按会话分，界面才知道是哪些会话停更了；但同一会话的重复失败被短窗压住。
  expect(h.events).toHaveLength(20);
  await reportReimportFailure(
    "/tmp/storm-0.jsonl",
    "sess-0",
    sqliteError("SQLITE_FULL"),
    h.deps,
  );
  expect(h.events).toHaveLength(20);
});

test("一直不修：6h 冷却后再提醒一次", async () => {
  const h = harness();
  await reportReimportFailure("/tmp/d.jsonl", "s", sqliteError("SQLITE_FULL"), h.deps);
  h.advance(5 * 3600_000);
  await reportReimportFailure("/tmp/d.jsonl", "s", sqliteError("SQLITE_FULL"), h.deps);
  expect(h.alerts).toHaveLength(1);
  h.advance(2 * 3600_000);
  await reportReimportFailure("/tmp/d.jsonl", "s", sqliteError("SQLITE_FULL"), h.deps);
  expect(h.alerts).toHaveLength(2);
});

test("边沿：恢复一轮后再坏，重新告警（不用等冷却）", async () => {
  const h = harness();
  await reportReimportFailure("/tmp/e.jsonl", "s", sqliteError("SQLITE_FULL"), h.deps);
  expect(h.alerts).toHaveLength(1);
  h.advance(1000);
  h.reset(); // 一次真的写进去了的 reimport
  await reportReimportFailure("/tmp/e.jsonl", "s", sqliteError("SQLITE_FULL"), h.deps);
  expect(h.alerts).toHaveLength(2);
  expect(h.events).toHaveLength(2);
});

test("非 DB 异常：推事件让界面能显示同步失败，但不惊动人", async () => {
  const h = harness();
  const out = await reportReimportFailure(
    "/tmp/f.jsonl",
    null,
    new Error("root CLI jsonl has no parseable turns"),
    h.deps,
  );
  expect(out.kind).toBe("other");
  expect(out.alerted).toBe(false);
  expect(out.published).toBe(true);
  expect(h.alerts).toHaveLength(0);
  expect(h.events[0]).toMatchObject({ sessionId: null, kind: "other" });
});

test("reimport 真实路径：import 抛 SQLITE_FULL → notify + sync_failed 事件", async () => {
  const temporary = mkdtempSync(path.join(tmpdir(), "trellis-clisync-wire-"));
  // 子进程隔离 module mock 与 watcher 的进程级状态（同 cli-sync-startup.test.ts）。
  const jsonl = path.join(temporary, "wire.jsonl");
  fs.writeFileSync(jsonl, "{}\n");
  const script = `
    import { mock } from "bun:test";
    import assert from "node:assert/strict";
    const sent = [];
    mock.module(${JSON.stringify(path.resolve("lib/server/notify.ts"))}, () => ({
      notify: async (e) => { sent.push(e); },
      registerChannel() {}, installDefaultChannels() {},
      commandChannel: { id: "command", async send() {} },
    }));
    const importDb = ${JSON.stringify(path.resolve("lib/server/cli-import-db.ts"))};
    const original = await import(importDb);
    mock.module(importDb, () => ({
      ...original,
      importCliLineage() {
        const e = Error("SQLITE_FULL: database or disk is full");
        e.code = "SQLITE_FULL";
        throw e;
      },
    }));
    const { getDB } = await import(${JSON.stringify(path.resolve("lib/server/sqlite.ts"))});
    const db = getDB();
    db.prepare("INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,origin) VALUES ('wire','f','',1,1,'cli-import')").run();
    db.prepare("INSERT INTO cli_lineages (trellis_session_id,cli_session_id,provider_family,jsonl_path,is_root) VALUES ('wire','wire-root','claude',?,1)").run(${JSON.stringify(jsonl)});
    const events = [];
    const { subscribeCliSync } = await import(${JSON.stringify(path.resolve("lib/server/cli-sync-events.ts"))});
    subscribeCliSync({ onEvent: (e) => events.push(e), onClose() {} });
    const { reimport } = await import(${JSON.stringify(path.resolve("lib/server/cli-sync-watcher.ts"))});
    reimport(${JSON.stringify(jsonl)});
    const deadline = Date.now() + 3000;
    while (sent.length === 0 && Date.now() < deadline) await Bun.sleep(5);
    assert.equal(sent.length, 1, "盘满必须走告警通道，不能只有一行 console.error");
    const failed = events.filter((e) => e.type === "sync_failed");
    assert.equal(failed.length, 1, "前端必须收得到同步失败事件");
    assert.equal(failed[0].kind, "full");
    assert.equal(failed[0].sessionId, "wire");
    console.log(JSON.stringify({ sent: sent.length, failed: failed.length }));
    process.exit(0);
  `;
  try {
    const child = Bun.spawn(["bun", "--conditions", "react-server", "-e", script], {
      env: {
        ...process.env,
        TRELLIS_DB_PATH: path.join(temporary, "data.db"),
        http_proxy: "",
        https_proxy: "",
        ALL_PROXY: "",
        no_proxy: "*",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exit, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exit, stderr + stdout).toBe(0);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}, 15000);
