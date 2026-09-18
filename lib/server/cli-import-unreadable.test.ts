import { afterAll, afterEach, expect, mock, spyOn, test } from "bun:test";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// S177 F1（fj-review-ab-2c36）：文件**存在但读不到**时，清理会把已有 fork 节点
// 剥掉。旧判据只看 existsSync —— EACCES / EIO / EISDIR 下文件都还在，于是残缺的
// turn 集合被当成权威，「不在集合里就删」照常开跑。
//
// 四类各一条：ENOENT（旧判据已覆盖，防回归）、EACCES、EIO、合法空文件。
// 最后一条是**反向**对照：合法零轮次会话本来就解析成 null，绝不能因此被当成
// unreadable —— 那会把清理永久禁掉。

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-unreadable-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { importCliLineage } = await import("./cli-import-db");

afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

const line = (x: unknown) => JSON.stringify(x) + "\n";
const turn = (sid: string, name: string) =>
  line({
    type: "user",
    uuid: name,
    parentUuid: null,
    sessionId: sid,
    timestamp: "2026-09-18T00:00:00Z",
    message: { role: "user", content: "question" },
  }) +
  line({
    type: "assistant",
    uuid: `${name}-answer`,
    parentUuid: name,
    sessionId: sid,
    timestamp: "2026-09-18T00:00:01Z",
    message: { role: "assistant", content: [{ type: "text", text: "answer" }] },
  });

type Fixture = { sid: string; root: string; fork: string; uFork: string };

/**
 * 两条 lineage（root + fork），先正常导入一轮，然后往 root 追加一条**以 fork turn
 * 的 uuid 为 uuid 的非 turn 元数据** —— 这正是清理闸（id ∈ jsonl entry uuid 集合、
 * 无子节点、非 streaming）真正会命中的形状。之后把 fork 弄坏，再导一次。
 */
function seed(tag: string): Fixture {
  const db = sqlite.getDB();
  const sid = `unreadable-${tag}`;
  const root = path.join(dir, `${tag}-root.jsonl`);
  const fork = path.join(dir, `${tag}-fork.jsonl`);
  const uRoot = `${tag}-root`;
  const uFork = `${tag}-fork`;
  fs.writeFileSync(root, turn(sid, uRoot));
  fs.writeFileSync(fork, turn(sid, uFork));
  db.prepare(
    "INSERT INTO sessions(id,title,root_node_id,created_at,updated_at,origin) VALUES (?,'fixture',?,1,1,'cli-import')",
  ).run(sid, uRoot);
  const insert = db.prepare(
    "INSERT INTO cli_lineages(trellis_session_id,cli_session_id,provider_family,jsonl_path,is_root) VALUES (?,?,'claude',?,?)",
  );
  insert.run(sid, `${sid}-root`, root, 1);
  insert.run(sid, `${sid}-fork`, fork, 0);
  importCliLineage(sid);
  expect(nodeExists(uFork)).toBe(true);
  fs.appendFileSync(
    root,
    line({ type: "system", uuid: uFork, content: "metadata" }) +
      turn(sid, `${tag}-later`),
  );
  return { sid, root, fork, uFork };
}

function nodeExists(id: string): boolean {
  return Boolean(
    sqlite.getDB().prepare("SELECT id FROM nodes WHERE id = ?").get(id),
  );
}

afterEach(() => mock.restore());

test("ENOENT：fork jsonl 被删 → 保留该 lineage 的节点", () => {
  const f = seed("enoent");
  fs.unlinkSync(f.fork);
  expect(importCliLineage(f.sid).status).toBe("updated");
  expect(nodeExists(f.uFork)).toBe(true);
});

test("EACCES：fork jsonl 存在但打不开 → 仍须保留节点", () => {
  const f = seed("eacces");
  fs.chmodSync(f.fork, 0o000);
  try {
    // 前提核对：文件还在，只是读不到 —— 这正是旧的 existsSync 判据看不见的那格。
    expect(fs.existsSync(f.fork)).toBe(true);
    let code: string | null = null;
    try {
      fs.readFileSync(f.fork);
    } catch (e) {
      code = (e as NodeJS.ErrnoException).code ?? null;
    }
    expect(code).toBe("EACCES");
    expect(importCliLineage(f.sid).status).toBe("updated");
    expect(nodeExists(f.uFork)).toBe(true);
  } finally {
    fs.chmodSync(f.fork, 0o600);
  }
});

test("EIO：读 fork jsonl 抛 I/O 错 → 仍须保留节点", () => {
  const f = seed("eio");
  const real = fs.readFileSync;
  spyOn(fs, "readFileSync").mockImplementation(((
    file: Parameters<typeof fs.readFileSync>[0],
    options?: Parameters<typeof fs.readFileSync>[1],
  ) => {
    if (file === f.fork) {
      const err = new Error("EIO: i/o error, read") as NodeJS.ErrnoException;
      err.code = "EIO";
      throw err;
    }
    return real(file, options);
  }) as typeof fs.readFileSync);
  expect(importCliLineage(f.sid).status).toBe("updated");
  expect(nodeExists(f.uFork)).toBe(true);
});

test("合法空文件：读得到、零轮次 → 不算 unreadable，清理照常开跑", () => {
  const f = seed("legal-empty");
  // 每行都是合法 JSON，只是没有任何 turn（mode / 快照噪声行）。确定性的 empty。
  fs.writeFileSync(
    f.fork,
    line({ type: "summary", summary: "noise" }) +
      line({ type: "file-history-snapshot", messageId: "x" }),
  );
  expect(importCliLineage(f.sid).status).toBe("updated");
  // 闸没被过度收紧：残留节点照删。把所有 null 都当 unreadable 的话这里会是 true。
  expect(nodeExists(f.uFork)).toBe(false);
});
