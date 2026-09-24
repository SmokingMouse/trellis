// 启动补齐水位跳过 + 限速的回归（fj-fix-startup：重启 / 部署后约 2 分钟不可用窗口）。
//
// 现场：BOE devbox 重启后头 ~2 分钟，启动补齐把 1406 个 codex 文件全部重读、重
// 解析、重发现一遍，事件循环被吃满，HTTP 整批超时；补齐一结束立刻恢复。
// 三条硬判据：
//   ① 没变过的会话零读取跳过（N=200，读取计数 = 0，毫秒级）；
//   ② 有变化的大会话补齐期间服务可用（20 × ~5MB，HTTP 探针 p95 < 200ms、无 > 1s）；
//   ③ 水位正确性：追加 / 截断 / 原子替换 / 删除 / 游标作废 / 新 fork / 读不到
//      都不会被误判成「没变」。
import { afterAll, beforeEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeSyntheticClaudeJsonl } from "../../scripts/bench-cli-parse";

mock.module("server-only", () => ({}));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-catchup-wm-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(root, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const transcript = await import("./cli-transcript");
const discover = await import("./cli-discover");
const watcher = await import("./cli-sync-watcher");
const { lineageWatermarksCurrent } = await import("./cli-import-db");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  fs.rmSync(root, { recursive: true, force: true });
});

let seq = 0;
beforeEach(() => {
  // 每条用例从一个干净库开始：补齐遍历的是全表 attached 会话。
  const db = sqlite.getDB();
  db.exec("DELETE FROM cli_lineages; DELETE FROM nodes; DELETE FROM sessions;");
  transcript.resetCliTranscriptCache();
  discover.resetCliDiscoverCache();
});

const line = (x: unknown) => JSON.stringify(x) + "\n";
function turn(sid: string, uuid: string, parent: string | null, t: number): string {
  return (
    line({
      type: "user",
      uuid,
      parentUuid: parent,
      sessionId: sid,
      timestamp: new Date(1_750_000_000_000 + t * 1000).toISOString(),
      message: { role: "user", content: `question ${uuid}` },
    }) +
    line({
      type: "assistant",
      uuid: `${uuid}-a`,
      parentUuid: uuid,
      sessionId: sid,
      timestamp: new Date(1_750_000_000_000 + t * 1000 + 500).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: `answer ${uuid}` }] },
    })
  );
}

type Fixture = { sid: string; dir: string; file: string; tag: string };

/** 一个已 attach 的 claude 会话：独立目录（像 ~/.claude/projects/<cwd>）+ 真 jsonl。 */
function attach(turns = 3): Fixture {
  const tag = `s${seq++}`;
  const sid = `${tag}-cli`;
  const dir = path.join(root, tag);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  let body = "";
  let parent: string | null = null;
  for (let i = 0; i < turns; i++) {
    const u = `${tag}-t${i}`;
    body += turn(sid, u, parent, i);
    parent = `${u}-a`;
  }
  fs.writeFileSync(file, body);
  const db = sqlite.getDB();
  db.prepare(
    "INSERT INTO sessions(id,title,root_node_id,created_at,updated_at,origin,cli_provider,source_jsonl_path) VALUES (?,'fixture','',1,1,'cli-import','claude',?)",
  ).run(sid, file);
  db.prepare(
    "INSERT INTO cli_lineages(trellis_session_id,cli_session_id,provider_family,jsonl_path,is_root) VALUES (?,?,'claude',?,1)",
  ).run(sid, sid, file);
  return { sid, dir, file, tag };
}

const nodeCount = (sid: string) =>
  (sqlite.getDB().prepare("SELECT COUNT(*) AS n FROM nodes WHERE session_id = ?").get(sid) as { n: number }).n;

async function catchUp() {
  const stats = await watcher.catchUpAttachedSessionsForTests();
  expect(stats).not.toBeNull();
  return stats!;
}

/** 对一切「打开 / 读文件」的入口打桩计数（含 readdir —— 零读取就是零读取）。 */
function countReads() {
  const spies = [
    spyOn(fs, "readFileSync"),
    spyOn(fs, "readSync"),
    spyOn(fs, "openSync"),
    spyOn(fs, "readdirSync"),
    spyOn(fs.promises, "open"),
    spyOn(fs.promises, "readFile"),
  ];
  const before = transcript.cliTranscriptCacheStats();
  return () => {
    const fsCalls = spies.reduce((n, s) => n + s.mock.calls.length, 0);
    for (const s of spies) s.mockRestore();
    const after = transcript.cliTranscriptCacheStats();
    return {
      fsCalls,
      parses:
        after.fullReads - before.fullReads + (after.incrementalReads - before.incrementalReads),
      bytesRead: after.bytesRead - before.bytesRead,
    };
  };
}

test("① 200 个没变过的 attached 会话：启动补齐零读取、毫秒级", async () => {
  const fixtures = Array.from({ length: 200 }, () => attach());
  // 升级首启：没有水位 → 全部走老路径，并在成功导入后落水位。
  const first = await catchUp();
  expect(first).toMatchObject({ sessions: 200, skipped: 0, processed: 200, failed: 0 });
  for (const f of fixtures) expect(nodeCount(f.sid)).toBe(3);

  // 模拟重启：进程内的指纹 / 解析缓存全空。
  transcript.resetCliTranscriptCache();
  discover.resetCliDiscoverCache();
  const stop = countReads();
  const t0 = performance.now();
  const second = await catchUp();
  const elapsed = performance.now() - t0;
  const reads = stop();
  console.log(
    `[catchup-skip] N=200 first=${Math.round(first.totalMs)}ms second=${elapsed.toFixed(1)}ms ` +
      `fsCalls=${reads.fsCalls} parses=${reads.parses} bytes=${reads.bytesRead}`,
  );
  expect(second).toMatchObject({ sessions: 200, skipped: 200, processed: 0, failed: 0 });
  expect(reads).toEqual({ fsCalls: 0, parses: 0, bytesRead: 0 });
  expect(elapsed).toBeLessThan(500);
  for (const f of fixtures) expect(nodeCount(f.sid)).toBe(3);
}, 60_000);

test("③ 追加 → 失配重导，导完落新水位，再下一轮又能跳过", async () => {
  const f = attach(2);
  await catchUp();
  expect(lineageWatermarksCurrent(f.sid)).toBe(true);
  fs.appendFileSync(f.file, turn(f.sid, `${f.tag}-t9`, `${f.tag}-t1-a`, 9));
  expect(lineageWatermarksCurrent(f.sid)).toBe(false);
  const s = await catchUp();
  expect(s).toMatchObject({ skipped: 0, processed: 1 });
  expect(nodeCount(f.sid)).toBe(3);
  expect((await catchUp()).skipped).toBe(1);
});

test("③ 截断 / 原地重写 / 原子替换（ino 变）都不会被当成「没变」", async () => {
  const a = attach(3);
  const b = attach(3);
  const c = attach(3);
  await catchUp();
  // 截断：保留第一轮。
  fs.writeFileSync(a.file, turn(a.sid, `${a.tag}-t0`, null, 0));
  // 同尺寸原地重写：size 相同，mtime 必须前移（显式设，免得落在同一毫秒）。
  const bBody = fs.readFileSync(b.file, "utf8").replace("question", "QUESTION");
  fs.writeFileSync(b.file, bBody);
  const future = new Date(Date.now() + 5000);
  fs.utimesSync(b.file, future, future);
  // 原子替换：内容 / 大小 / mtime 全照抄，只有 inode 变。
  const st = fs.statSync(c.file);
  const tmp = `${c.file}.tmp`;
  fs.copyFileSync(c.file, tmp);
  fs.utimesSync(tmp, st.atime, st.mtime);
  fs.renameSync(tmp, c.file);
  expect(fs.statSync(c.file).ino).not.toBe(st.ino);
  for (const f of [a, b, c]) expect(lineageWatermarksCurrent(f.sid)).toBe(false);
  const s = await catchUp();
  expect(s).toMatchObject({ sessions: 3, skipped: 0, processed: 3, failed: 0 });
  // 截断：被截掉的两轮 uuid 已不在 jsonl 里，按既有清理闸（只删 jsonl 里还认得
  // 的假 turn）保守保留 —— 与水位无关的原行为；这里只证明它被重新补齐了。
  expect(nodeCount(a.sid)).toBe(3);
  expect(lineageWatermarksCurrent(a.sid)).toBe(true);
  // 同 uuid 的原地重写：水位失配 → 确实重新走了导入（上面 processed=3）；至于
  // 内容，既有 synced_uuid 游标判它 unchanged（末行 uuid 没变）—— 那是游标的
  // 原有语义，与本单无关。水位随这次导入刷新。
  expect(lineageWatermarksCurrent(b.sid)).toBe(true);
  expect(lineageWatermarksCurrent(c.sid)).toBe(true);
});

test("③ 源文件被删：不跳过、按失败出口报，已有节点一个不删", async () => {
  const f = attach(3);
  await catchUp();
  fs.rmSync(f.file);
  expect(lineageWatermarksCurrent(f.sid)).toBe(false);
  const s = await catchUp();
  expect(s).toMatchObject({ skipped: 0, processed: 1, failed: 1 });
  expect(nodeCount(f.sid)).toBe(3);
  // 下一轮仍然不会凭旧水位跳过。
  expect((await catchUp()).skipped).toBe(0);
});

test("③ 游标被单独作废（v1 式强制重导）：以 synced_uuid 为准，不跳过", async () => {
  const f = attach(2);
  await catchUp();
  sqlite.getDB().prepare("UPDATE cli_lineages SET synced_uuid = NULL WHERE trellis_session_id = ?").run(f.sid);
  expect(lineageWatermarksCurrent(f.sid)).toBe(false);
  expect(await catchUp()).toMatchObject({ skipped: 0, processed: 1 });
  expect(lineageWatermarksCurrent(f.sid)).toBe(true);
});

test("③ 离线期间同目录出现新 fork：不跳过，discover 把它认领进 lineage", async () => {
  const f = attach(2);
  await catchUp();
  // 目录 mtime 精度兜底：保证 fork 的 mtime 严格晚于记下的目录水位。
  await Bun.sleep(20);
  const forkSid = `${f.tag}-fork`;
  const fork = path.join(f.dir, `${forkSid}.jsonl`);
  const shared = fs.readFileSync(f.file, "utf8").replaceAll(`"sessionId":"${f.sid}"`, `"sessionId":"${forkSid}"`);
  fs.writeFileSync(fork, shared + turn(forkSid, `${f.tag}-f0`, `${f.tag}-t1-a`, 5));
  expect(lineageWatermarksCurrent(f.sid)).toBe(false);
  expect(await catchUp()).toMatchObject({ skipped: 0, processed: 1, failed: 0 });
  const members = sqlite.getDB()
    .prepare("SELECT cli_session_id FROM cli_lineages WHERE trellis_session_id = ? ORDER BY cli_session_id")
    .all(f.sid) as { cli_session_id: string }[];
  expect(members.map((m) => m.cli_session_id)).toEqual([forkSid, f.sid].sort());
  expect(nodeCount(f.sid)).toBe(3);
  expect((await catchUp()).skipped).toBe(1);
});

test("③ 目录只是删了无关文件：仍然跳过，并推进目录水位", async () => {
  const f = attach(2);
  const junk = path.join(f.dir, "unrelated.jsonl");
  fs.writeFileSync(junk, "");
  await catchUp();
  await Bun.sleep(20);
  fs.rmSync(junk);
  const before = sqlite.getDB().prepare("SELECT wm_dir_mtime_ms AS m FROM cli_lineages WHERE trellis_session_id = ?").get(f.sid) as { m: number };
  expect((await catchUp()).skipped).toBe(1);
  const after = sqlite.getDB().prepare("SELECT wm_dir_mtime_ms AS m FROM cli_lineages WHERE trellis_session_id = ?").get(f.sid) as { m: number };
  expect(after.m).toBe(fs.statSync(f.dir).mtimeMs);
  expect(after.m).not.toBe(before.m);
});

test("不变量：读不到的成员清空水位（不参与跳过）、anyUnreadable 闸照旧保住 fork 节点", async () => {
  if (process.getuid?.() === 0) return; // root 无视 chmod
  const f = attach(2);
  await catchUp();
  // 手工挂一个 fork 成员并导入。
  const forkSid = `${f.tag}-fork`;
  const fork = path.join(f.dir, `${forkSid}.jsonl`);
  fs.writeFileSync(fork, turn(forkSid, `${f.tag}-f0`, `${f.tag}-t1-a`, 5));
  sqlite.getDB()
    .prepare("INSERT INTO cli_lineages(trellis_session_id,cli_session_id,provider_family,jsonl_path,is_root) VALUES (?,?,'claude',?,0)")
    .run(f.sid, forkSid, fork);
  expect(await catchUp()).toMatchObject({ processed: 1, failed: 0 });
  expect(nodeCount(f.sid)).toBe(3);
  expect(lineageWatermarksCurrent(f.sid)).toBe(true);
  // fork 读不到 + root 有新内容（逼一次真正的提交与清理判定）。
  fs.chmodSync(fork, 0o000);
  try {
    fs.appendFileSync(f.file, turn(f.sid, `${f.tag}-t9`, `${f.tag}-t1-a`, 9));
    transcript.resetCliTranscriptCache();
    await catchUp();
    const wm = sqlite.getDB()
      .prepare("SELECT wm_size AS s FROM cli_lineages WHERE cli_session_id = ?")
      .get(forkSid) as { s: number | null };
    expect(wm.s).toBeNull();
    expect(lineageWatermarksCurrent(f.sid)).toBe(false);
    // fork 节点没被当成「不在集合里」剥掉。
    expect(sqlite.getDB().prepare("SELECT 1 FROM nodes WHERE id = ?").get(`${f.tag}-f0`)).toBeTruthy();
  } finally {
    fs.chmodSync(fork, 0o644);
  }
});

test("空会话（0 turn 根）：与原行为一致 —— discover 判 NoTurns、不建节点、不落水位", async () => {
  const f = attach(0);
  expect(fs.statSync(f.file).size).toBe(0);
  const first = await catchUp();
  expect(first.failed).toBe(1); // discover 对 0 turn 根抛 NoTurns（确定性错误，与原行为一致）
  expect(nodeCount(f.sid)).toBe(0);
  // 0 turn 根在 discover 就被判死，import 没跑到 → 没有水位 → 仍走老路径（原行为）。
  expect(lineageWatermarksCurrent(f.sid)).toBe(false);
});

// ── ② 补齐期间服务可用 ──────────────────────────────────────────────────────

function percentile(xs: number[], p: number): number {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
}

test("② 20 个 ~5MB 有变化的会话补齐期间：HTTP p95 < 200ms、无 > 1s", async () => {
  const SESSIONS = Number(process.env.CATCHUP_BENCH_SESSIONS ?? 20);
  const TURNS = Math.round((5 * 1024 * 1024) / 17000); // 每 turn ≈ 17KB
  let totalBytes = 0;
  const db = sqlite.getDB();
  for (let i = 0; i < SESSIONS; i++) {
    const dir = path.join(root, `big${i}`);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, "bench-session.jsonl");
    // 每个会话的 turn uuid 段错开（nodes.id 全局唯一）。
    totalBytes += writeSyntheticClaudeJsonl(file, TURNS, 0, i * 1_000_000).bytes;
    const sid = `big-${i}`;
    db.prepare(
      "INSERT INTO sessions(id,title,root_node_id,created_at,updated_at,origin,cli_provider,source_jsonl_path) VALUES (?,'fixture','',1,1,'cli-import','claude',?)",
    ).run(sid, file);
    db.prepare(
      "INSERT INTO cli_lineages(trellis_session_id,cli_session_id,provider_family,jsonl_path,is_root) VALUES (?,'bench-session','claude',?,1)",
    ).run(sid, file);
  }
  transcript.resetCliTranscriptCache();
  discover.resetCliDiscoverCache();

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => Response.json({ ok: true }),
  });
  const samples: number[] = [];
  let done = false;
  const probe = (async () => {
    while (!done) {
      const t = performance.now();
      await (await fetch(server.url, { proxy: undefined })).json();
      samples.push(performance.now() - t);
      await Bun.sleep(20);
    }
  })();
  const t0 = performance.now();
  const stats = await catchUp();
  // macOS 的 FSEvents 会把 watch 建立前刚发生的写入补报上来，watcher 可能先于
  // 补齐循环把个别会话导掉（之后补齐按水位跳过它）—— 两条路都算「补齐期间」，
  // 探针一直打到 20 个会话全部落库为止。
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const landed = (db.prepare(
      "SELECT COUNT(DISTINCT session_id) AS n FROM nodes WHERE session_id LIKE 'big-%'",
    ).get() as { n: number }).n;
    if (landed === SESSIONS) break;
    await Bun.sleep(50);
  }
  const elapsed = performance.now() - t0;
  done = true;
  await probe;
  server.stop(true);

  const p50 = percentile(samples, 50);
  const p95 = percentile(samples, 95);
  const p99 = percentile(samples, 99);
  const max = Math.max(...samples);
  const over1s = samples.filter((x) => x > 1000).length;
  console.log(
    `[catchup-load] duty=${watcher.catchUpDuty()} ${SESSIONS}×${(totalBytes / SESSIONS / 1048576).toFixed(1)}MB ` +
      `catchup=${(elapsed / 1000).toFixed(1)}s processed=${stats.processed} paced=${(stats.pacedSleepMs / 1000).toFixed(1)}s ` +
      `samples=${samples.length} p50=${p50.toFixed(1)} p95=${p95.toFixed(1)} p99=${p99.toFixed(1)} ` +
      `max=${max.toFixed(1)} >1s=${over1s}`,
  );
  expect(stats).toMatchObject({ sessions: SESSIONS, failed: 0 });
  expect(stats.processed + stats.skipped).toBe(SESSIONS);
  expect(stats.processed).toBeGreaterThan(0);
  const landed = db.prepare(
    "SELECT COUNT(DISTINCT session_id) AS n FROM nodes WHERE session_id LIKE 'big-%'",
  ).get() as { n: number };
  expect(landed.n).toBe(SESSIONS);
  expect(samples.length).toBeGreaterThan(10);
  expect(p95).toBeLessThan(200);
  expect(over1s).toBe(0);
}, 300_000);

// ── 全文索引只重建变更节点（commit 里的 FTS 整表扫描是补齐期间的秒级同步段）──

test("FTS：只重建文本变了的节点；单个 / 多个变更两条路径都不留旧行、不重复", async () => {
  const { importCliLineage } = await import("./cli-import-db");
  const f = attach(3);
  importCliLineage(f.sid);
  const db = sqlite.getDB();
  const rows = (id: string) =>
    db
      .prepare(
        "SELECT source_kind AS k, text FROM search_index WHERE source_id = ? ORDER BY source_kind",
      )
      .all(id) as { k: string; text: string }[];
  expect(rows(`${f.tag}-t2`).map((r) => r.k)).toEqual(["node_question", "node_response"]);
  const rowCount = () =>
    (db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE session_id = ?").get(f.sid) as { n: number }).n;
  expect(rowCount()).toBe(6);

  // 单个变更：最后一轮追加一条 assistant → 只有 t2 的 response 变。
  fs.appendFileSync(
    f.file,
    line({
      type: "assistant",
      uuid: `${f.tag}-t2-b`,
      parentUuid: `${f.tag}-t2-a`,
      sessionId: f.sid,
      timestamp: new Date(1_750_000_000_000 + 2 * 1000 + 800).toISOString(),
      message: { role: "assistant", content: [{ type: "text", text: "more words" }] },
    }),
  );
  importCliLineage(f.sid);
  expect(rowCount()).toBe(6);
  expect(rows(`${f.tag}-t2`).find((r) => r.k === "node_response")!.text).toContain("more words");

  // 多个变更：原地改两轮的问题文本 + 追加一轮（让游标前移，真的提交）。
  const body = fs
    .readFileSync(f.file, "utf8")
    .replace(`question ${f.tag}-t0`, `edited ${f.tag}-t0`)
    .replace(`question ${f.tag}-t1`, `edited ${f.tag}-t1`);
  fs.writeFileSync(f.file, body + turn(f.sid, `${f.tag}-t3`, `${f.tag}-t2-b`, 3));
  // 原地改前缀不是 CLI 的写法，进程内增量缓存按「只追加」复用 —— 清掉它，
  // 这里要测的是提交里的索引重建。
  transcript.resetCliTranscriptCache();
  importCliLineage(f.sid);
  expect(rowCount()).toBe(8);
  for (const i of [0, 1]) {
    const q = rows(`${f.tag}-t${i}`).filter((r) => r.k === "node_question");
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe(`edited ${f.tag}-t${i}`);
  }
  // 搜得到新词、搜不到旧词。
  const hits = (term: string) =>
    (db.prepare("SELECT COUNT(*) AS n FROM search_index WHERE search_index MATCH ?").get(`"${term}"`) as { n: number }).n;
  expect(hits(`edited ${f.tag}-t0`)).toBe(1);
  expect(hits(`question ${f.tag}-t0`)).toBe(0);
});
