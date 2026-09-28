import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

// 中文短查询：search_index 用 FTS5 trigram，<3 字 MATCH 必然零命中；searchAll
// 对 1–2 字回退参数化 LIKE。这里覆盖 1 / 2 / 3 字三条路径 + 通配符转义。

const testDir = mkdtempSync(path.join(tmpdir(), "trellis-search-short-"));
const prevDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(testDir, "search.db");

const sqlite = await import("./sqlite");
const repo = await import("./repo");

beforeAll(() => {
  const db = sqlite.getDB();
  const sess = db.prepare(
    "INSERT INTO sessions (id,title,root_node_id,created_at,updated_at) VALUES (?,?,?,?,?)",
  );
  sess.run("s-vec", "向量检索笔记", "n1", 1, 20);
  sess.run("s-web3", "web3学习", "n2", 1, 10);
  const idx = db.prepare(
    "INSERT INTO search_index (text, source_kind, source_id, session_id) VALUES (?,?,?,?)",
  );
  idx.run("我们用向量库做召回，再用重排模型排序。", "node_response", "n1", "s-vec");
  idx.run("钱包私钥不要贴进对话里。", "node_question", "n2", "s-web3");
  idx.run("进度 100% 完成，下划线 a_b 也在。", "node_response", "n3", "s-web3");
});

afterAll(() => {
  // 同进程跑全套 lib/ 时 env 会串到后续文件（disk-watch 的真机 statfs 读它），
  // 删目录前先还原。
  if (prevDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = prevDbPath;
  rmSync(testDir, { recursive: true, force: true });
});

describe("searchAll 短查询回退", () => {
  test("1 个中文字走 LIKE，返回结构与 FTS 一致", () => {
    const res = repo.searchAll("钱");
    expect(res.map((r) => r.sessionId)).toEqual(["s-web3"]);
    const hit = res[0].hits[0];
    expect(hit.sourceKind).toBe("node_question");
    expect(hit.sourceId).toBe("n2");
    expect(hit.snippet).toContain("<mark>钱</mark>");
    expect(hit.matchText).toBe("钱包私钥不要贴进对话里。");
    expect(res[0].sessionTitle).toBe("web3学习");
  });

  test("2 个中文字走 LIKE，片段带省略号窗口", () => {
    const res = repo.searchAll("向量");
    expect(res.map((r) => r.sessionId)).toEqual(["s-vec"]);
    expect(res[0].hits[0].snippet).toContain("<mark>向量</mark>");
    expect(res[0].hits[0].matchText).toContain("向量库");
  });

  test("3 个中文字仍走 FTS5 trigram", () => {
    const res = repo.searchAll("向量库");
    expect(res.map((r) => r.sessionId)).toEqual(["s-vec"]);
    expect(res[0].hits[0].snippet).toContain("<mark>");
  });

  test("LIKE 通配符被转义：% 和 _ 只按字面匹配", () => {
    expect(repo.searchAll("%").map((r) => r.hits[0].sourceId)).toEqual(["n3"]);
    expect(repo.searchAll("_").map((r) => r.hits[0].sourceId)).toEqual(["n3"]);
    expect(repo.escapeLikePattern("a%_\\")).toBe("a\\%\\_\\\\");
  });

  test("空白查询直接返回空", () => {
    expect(repo.searchAll("  ")).toEqual([]);
  });

  test("likeSnippet 长文本截窗口并加省略号", () => {
    const text = `${"前".repeat(40)}目标${"后".repeat(40)}`;
    const { snippet, matchText } = repo.likeSnippet(text, "目标");
    expect(snippet.startsWith("…")).toBe(true);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet).toContain("<mark>目标</mark>");
    expect(text).toContain(matchText);
  });
});
