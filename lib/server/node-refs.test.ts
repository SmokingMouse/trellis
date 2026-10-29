import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

// `@` 引用其他会话 / 节点的服务端部分：候选列表、展开节点、按 id 现取并组装上下文。

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-node-refs-"));
const prevDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(testDir, "refs.db");

const sqlite = await import("./sqlite");
const refs = await import("./node-refs");
const { appendNodeRefs, NODE_REF_LEAD, NODE_REF_RESPONSE_CAP } = await import("@/lib/node-refs");

beforeAll(() => {
  const db = sqlite.getDB();
  const sess = db.prepare(
    "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at,archived,kind) VALUES (?,?,?,?,?,?,?)",
  );
  sess.run("s-rust", "Rust 所有权笔记", "r1", 1, 30, 0, "user");
  sess.run("s-react", "前端杂记", "f1", 1, 20, 0, "user");
  sess.run("s-arch", "归档的会话", "a1", 1, 40, 1, "user");
  sess.run("s-hidden", "内部会话", "h1", 1, 50, 0, "internal");
  const node = db.prepare(
    "INSERT INTO nodes (id,session_id,parent_id,question,response,status,created_at,topic_label) VALUES (?,?,?,?,?,?,?,?)",
  );
  node.run("r1", "s-rust", null, "drop flag 是什么", "drop flag 是编译器插入的运行时标记。", "done", 100, "drop flags");
  node.run("r2", "s-rust", "r1", "NLL 呢", "x".repeat(NODE_REF_RESPONSE_CAP + 50), "done", 200, null);
  node.run("r3", "s-rust", "r2", "还在跑", "半截", "streaming", 300, null);
  node.run("f1", "s-react", null, "fiber 是什么", "React 的调和单元。", "done", 100, "React fiber 调和");
  node.run("a1", "s-arch", null, "旧问题", "旧回答", "done", 100, null);
  node.run("h1", "s-hidden", null, "内部", "内部回答", "done", 100, null);
  db.prepare(
    "INSERT INTO search_index (text, source_kind, source_id, session_id) VALUES (?,?,?,?)",
  ).run("React 的调和单元。", "node_response", "f1", "s-react");
});

afterAll(() => {
  if (prevDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDbPath;
  rmSync(testDir, { recursive: true, force: true });
});

describe("listRefCandidates", () => {
  test("空查询：最近活跃在前，排除归档 / 不可见来源；默认节点 = 最新已完成节点", () => {
    const res = refs.listRefCandidates("");
    expect(res.map((s) => s.sessionId)).toEqual(["s-rust", "s-react"]);
    // r3 还在 streaming，最新已完成是 r2（序号 2）。
    expect(res[0].latest).toMatchObject({ nodeId: "r2", index: 2 });
  });

  test("标题模糊匹配，多词都要命中", () => {
    expect(refs.listRefCandidates("所有").map((s) => s.sessionId)).toEqual(["s-rust"]);
    expect(refs.listRefCandidates("rust 笔记").map((s) => s.sessionId)).toEqual(["s-rust"]);
    expect(refs.listRefCandidates("rust 前端")).toEqual([]);
  });

  test("topic 命中也算", () => {
    expect(refs.listRefCandidates("fiber").map((s) => s.sessionId)).toEqual(["s-react"]);
  });

  test("标题 / topic 都没中时用全文索引补充", () => {
    expect(refs.listRefCandidates("调和单元").map((s) => s.sessionId)).toEqual(["s-react"]);
  });

  test("LIKE 通配符被转义", () => {
    expect(refs.listRefCandidates("%")).toEqual([]);
  });
});

describe("listRefNodes", () => {
  test("只列已完成节点，新的在前，带序号", () => {
    expect(refs.listRefNodes("s-rust")?.map((n) => [n.nodeId, n.index])).toEqual([
      ["r2", 2],
      ["r1", 1],
    ]);
  });
  test("会话不存在 / 不可见返回 null", () => {
    expect(refs.listRefNodes("nope")).toBeNull();
    expect(refs.listRefNodes("s-hidden")).toBeNull();
  });
});

describe("buildNodeRefContext", () => {
  const ref = (sessionId: string, nodeId: string, title = "T", index: number | null = 1) => ({
    sessionId,
    nodeId,
    title,
    index,
  });

  test("无引用：原样返回、无 suffix", () => {
    expect(refs.buildNodeRefContext("普通问题")).toEqual({ readable: "普通问题", suffix: "", resolved: [], missing: [] });
  });

  test("按 id 现取内容，忽略标记里的标签（不信客户端）", () => {
    const q = appendNodeRefs("对比一下", [ref("s-rust", "r1", "被篡改的标题", 99)]);
    const ctx = refs.buildNodeRefContext(q, "new-node");
    expect(ctx.readable).toBe("对比一下\n\n[@被篡改的标题 #99]");
    expect(ctx.resolved).toHaveLength(1);
    expect(ctx.suffix.startsWith(`\n\n${NODE_REF_LEAD}`)).toBe(true);
    expect(ctx.suffix).toContain('<referenced_node session="s-rust" node="r1" title="Rust 所有权笔记 #1" topic="drop flags">');
    expect(ctx.suffix).toContain("drop flag 是编译器插入的运行时标记。");
  });

  test("长回答截断并标注出处", () => {
    const ctx = refs.buildNodeRefContext(appendNodeRefs("q", [ref("s-rust", "r2")]), "new-node");
    expect(ctx.suffix).toContain("…（已截断，全文见 会话「Rust 所有权笔记」 #2）");
  });

  test("未完成节点带说明", () => {
    const ctx = refs.buildNodeRefContext(appendNodeRefs("q", [ref("s-rust", "r3")]), "new-node");
    expect(ctx.suffix).toContain("该节点引用时仍在生成");
  });

  test("不存在 / 会话不匹配 / 不可见来源 / 引用自己 → missing", () => {
    const q = appendNodeRefs("q", [
      ref("s-rust", "gone", "已删", 1),
      ref("s-react", "r1", "错配", 1),
      ref("s-hidden", "h1", "内部", 1),
      ref("s-rust", "self", "自己", 1),
    ]);
    const ctx = refs.buildNodeRefContext(q, "self");
    expect(ctx.resolved).toEqual([]);
    expect(ctx.missing.map((m) => m.nodeId)).toEqual(["gone", "r1", "h1", "self"]);
    expect(ctx.suffix).not.toContain("<referenced_node");
    expect(ctx.suffix).toContain("（引用「已删 #1」已不存在或无法访问，已忽略）");
  });

  test("归档会话的节点仍可按 id 引用（用户自己的数据）", () => {
    const ctx = refs.buildNodeRefContext(appendNodeRefs("q", [ref("s-arch", "a1")]), "new-node");
    expect(ctx.resolved.map((r) => r.nodeId)).toEqual(["a1"]);
  });
});
