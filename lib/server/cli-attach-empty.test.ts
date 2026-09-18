// 根因 A 的分类层回归：attach 一个「合法但零轮次」的 CLI transcript 不是错误，
// 「读不到 / JSON 损坏」仍然必须是错误（可重试）。去重层的断言在 herdr-fleet.test.ts。
import { afterAll, expect, mock, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
mock.module("server-only", () => ({}));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-attach-empty-"));
const previousDbPath = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "test.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();
const { attachSession, classifyRootTranscript } = await import("./cli-sync-watcher");
const { importCliLineage } = await import("./cli-import-db");
const { CliTranscriptUnreadableError } = await import("./cli-attach");

// devbox 上真实触发无限重试的那种文件：mode / file-history-snapshot / 一条
// slash command 包装行 / 一条 local-command 输出 / 一条 system 行，没有任何对话轮次。
function emptySessionLines(sid: string, cwd: string): string {
  return (
    [
      { type: "mode", mode: "default", sessionId: sid, cwd, timestamp: "2026-09-17T02:00:00.000Z" },
      { type: "file-history-snapshot", messageId: "m1", snapshot: { trackedFileBackups: {} }, sessionId: sid },
      { type: "user", uuid: "u-login", parentUuid: null, isMeta: true, sessionId: sid, cwd, timestamp: "2026-09-17T02:00:01.000Z", message: { role: "user", content: "<command-message>login</command-message>\n<command-name>/login</command-name>" } },
      { type: "user", uuid: "u-out", parentUuid: "u-login", isMeta: true, sessionId: sid, cwd, timestamp: "2026-09-17T02:00:02.000Z", message: { role: "user", content: "<local-command-stdout>Login successful</local-command-stdout>" } },
      { type: "system", subtype: "local_command", uuid: "s1", parentUuid: "u-out", sessionId: sid, cwd, timestamp: "2026-09-17T02:00:03.000Z", content: "/login" },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

function conversationLines(sid: string, cwd: string, suffix = ""): string {
  return (
    [
      { type: "user", uuid: `u1${suffix}`, parentUuid: null, sessionId: sid, cwd, timestamp: "2026-09-17T03:00:00.000Z", message: { role: "user", content: `question${suffix}` } },
      { type: "assistant", uuid: `a1${suffix}`, parentUuid: `u1${suffix}`, sessionId: sid, cwd, timestamp: "2026-09-17T03:00:01.000Z", message: { role: "assistant", content: [{ type: "text", text: "answer" }], usage: { input_tokens: 1, output_tokens: 1 } } },
    ]
      .map((entry) => JSON.stringify(entry))
      .join("\n") + "\n"
  );
}

afterAll(() => {
  sqlite.resetDBForTests();
  if (previousDbPath === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previousDbPath;
  fs.rmSync(dir, { recursive: true, force: true });
});

test("a legal zero-turn transcript is skipped as empty, never thrown", () => {
  const sid = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
  const file = path.join(dir, "empty", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, emptySessionLines(sid, path.dirname(file)));

  expect(classifyRootTranscript("claude", file)).toEqual({ kind: "empty", sessionId: sid });
  expect(attachSession(file, "claude", { origin: "herdr" })).toEqual({
    sessionId: sid,
    status: "empty",
    turns: 0,
  });
  const db = sqlite.getDB();
  expect(db.prepare("SELECT 1 FROM sessions WHERE id = ?").get(sid)).toBeNull();
  expect(
    db.prepare("SELECT 1 FROM cli_lineages WHERE trellis_session_id = ?").get(sid),
  ).toBeNull();

  // 空会话不是永久黑名单：文件长出真对话后同一个路径必须能 attach 进来。
  fs.writeFileSync(file, conversationLines(sid, path.dirname(file)));
  expect(classifyRootTranscript("claude", file).kind).toBe("ready");
  expect(attachSession(file, "claude", { origin: "herdr" }).status).toBe("imported");
  expect(db.prepare("SELECT origin FROM sessions WHERE id = ?").get(sid)).toEqual({
    origin: "herdr",
  });
});

test("missing and corrupt transcripts stay retryable errors", () => {
  const missing = path.join(dir, "missing", "nope.jsonl");
  expect(classifyRootTranscript("claude", missing)).toEqual({ kind: "unreadable" });
  expect(() => attachSession(missing)).toThrow(CliTranscriptUnreadableError);

  const sid = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
  const corrupt = path.join(dir, "corrupt", `${sid}.jsonl`);
  fs.mkdirSync(path.dirname(corrupt), { recursive: true });
  // 行被截断、解析不出任何轮次 —— 和「合法的空会话」长得一样但成因是损坏 / 写到
  // 一半，必须留在可重试那一侧。
  fs.writeFileSync(corrupt, `{"type":"mode","sessionId":"${sid}"}\n{"type":"user","uuid":"u1`);
  expect(classifyRootTranscript("claude", corrupt)).toEqual({ kind: "unreadable" });
  expect(() => attachSession(corrupt)).toThrow(CliTranscriptUnreadableError);
  expect(
    sqlite.getDB().prepare("SELECT 1 FROM sessions WHERE id = ?").get(sid),
  ).toBeNull();
});

test("importCliLineage still refuses to prune nodes when a lineage jsonl is unreadable", () => {
  const sid = "cccccccc-3333-4333-8333-cccccccccccc";
  const home = path.join(dir, "unreadable");
  fs.mkdirSync(home, { recursive: true });
  const root = path.join(home, `${sid}.jsonl`);
  fs.writeFileSync(root, conversationLines(sid, home));
  expect(attachSession(root).status).toBe("imported");

  const forkSid = "dddddddd-4444-4444-8444-dddddddddddd";
  const fork = path.join(home, `${forkSid}.jsonl`);
  fs.writeFileSync(fork, conversationLines(sid, home) + conversationLines(forkSid, home, "-fork"));
  const db = sqlite.getDB();
  db.prepare(
    `INSERT INTO cli_lineages
       (trellis_session_id, cli_session_id, provider_family, jsonl_path, fork_point_uuid, is_root, synced_uuid)
     VALUES (?, ?, 'claude', ?, 'a1', 0, NULL)`,
  ).run(sid, forkSid, fork);
  expect(importCliLineage(sid).turns).toBe(2);
  const nodes = () =>
    (db.prepare("SELECT id FROM nodes WHERE session_id = ?").all(sid) as { id: string }[])
      .map((row) => row.id)
      .sort();
  expect(nodes()).toEqual(["u1", "u1-fork"]);

  // fork 的 jsonl 消失 = 对它的 turn 集合一无所知 → 绝不能拿残缺集合去剥节点。
  fs.rmSync(fork);
  importCliLineage(sid);
  expect(nodes()).toEqual(["u1", "u1-fork"]);
});
