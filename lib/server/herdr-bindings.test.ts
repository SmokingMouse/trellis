import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-bindings-"));

const { ensureHerdrSchema } = await import("./sqlite");
const {
  claudeProjectSlug,
  getHerdrBinding,
  markHerdrPaneClosed,
  reconcileHerdrPane,
  reconcileHerdrSnapshot,
  resolveTranscriptPath,
  transcriptCwd,
} = await import("./herdr-bindings");
import type { HerdrPane } from "./herdr-types";

afterAll(() => {
  fs.rmSync(testHome, { recursive: true, force: true });
});

function makePane(
  sessionId: string,
  agent: "claude" | "codex" = "claude",
  cwd = "/tmp/example.project",
): HerdrPane {
  return {
    pane_id: "w1:p1",
    terminal_id: "term-1",
    workspace_id: "w1",
    tab_id: "w1:t1",
    focused: false,
    agent,
    agent_session: {
      source: `herdr:${agent}`,
      agent,
      kind: "id",
      value: sessionId,
    },
    agent_status: "idle",
    cwd,
    revision: 7,
  };
}

function write(file: string, contents: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

describe("Herdr transcript bindings", () => {
  test("large transcripts stop after the cwd header (review rv_perf regression)", () => {
    const file = path.join(testHome, "large.jsonl");
    write(file, JSON.stringify({ cwd: "/large-project" }) + "\n");
    const fd = fs.openSync(file, "r+");
    fs.ftruncateSync(fd, 12 * 1024 * 1024);
    fs.closeSync(fd);
    const reads = spyOn(fs, "readSync");
    try {
      expect(transcriptCwd("claude", file)).toBe("/large-project");
      expect(reads.mock.calls).toHaveLength(1);
      expect(reads.mock.calls[0][1].byteLength).toBe(8192);
    } finally { reads.mockRestore(); }
    write(file, 'bad line\n' + JSON.stringify({ padding: "中".repeat(4000), payload: { cwd: "/跨块" } }));
    expect(transcriptCwd("codex", file)).toBe("/跨块");
  });

  test("misses skip repeated traversal but expire when a transcript appears", () => {
    const home = path.join(testHome, "miss-cache");
    const pane = makePane("missing-id", "codex", "/project");
    expect(resolveTranscriptPath(pane, home, 1_000)).toBeNull();
    const file = path.join(home, ".codex", "sessions", "nested", "rollout-test-missing-id.jsonl");
    write(file, JSON.stringify({ payload: { cwd: "/project" } }) + "\n");
    const scans = spyOn(fs, "readdirSync");
    try {
      expect(resolveTranscriptPath(pane, home, 1_001)).toBeNull();
      expect(scans.mock.calls).toHaveLength(0);
    } finally { scans.mockRestore(); }
    expect(resolveTranscriptPath(pane, home, 6_001)).toBe(file);
  });

  test("creates the complete herdr_sessions schema", () => {
    const db = new Database(":memory:");
    ensureHerdrSchema(db);
    const names = (db.query("SELECT name FROM pragma_table_info('herdr_sessions')").all() as {
      name: string;
    }[]).map((row) => row.name);
    expect(names).toEqual([
      "session_id",
      "session_source",
      "session_kind",
      "agent_kind",
      "pane_id",
      "terminal_id",
      "workspace_id",
      "tab_id",
      "label",
      "agent_name",
      "cwd",
      "transcript_path",
      "agent_status",
      "revision",
      "state_change_seq",
      "first_seen_at",
      "last_seen_at",
      "alive",
    ]);
    db.close();
  });

  test("finds Claude by glob first and rejects a transcript whose cwd disagrees", () => {
    const home = path.join(testHome, "claude-home");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const cwd = "/tmp/example.project";
    const file = path.join(home, ".claude", "projects", "any-slug", `${sessionId}.jsonl`);
    write(file, `${JSON.stringify({ sessionId, cwd })}\n`);
    expect(resolveTranscriptPath(makePane(sessionId, "claude", cwd), home)).toBe(file);
    expect(resolveTranscriptPath(makePane(sessionId, "claude", "/tmp/other"), home)).toBeNull();
    expect(claudeProjectSlug("/a/.b_c/中文")).toBe("-a--b-c---");
  });

  test("uses Claude slug fallback after an ambiguous glob", () => {
    const home = path.join(testHome, "claude-fallback-home");
    const sessionId = "22222222-2222-4222-8222-222222222222";
    const cwd = "/tmp/a.b";
    const fallback = path.join(
      home,
      ".claude",
      "projects",
      claudeProjectSlug(cwd),
      `${sessionId}.jsonl`,
    );
    write(fallback, `${JSON.stringify({ sessionId, cwd })}\n`);
    write(
      path.join(home, ".claude", "projects", "collision", `${sessionId}.jsonl`),
      `${JSON.stringify({ sessionId, cwd: "/tmp/wrong" })}\n`,
    );
    expect(resolveTranscriptPath(makePane(sessionId, "claude", cwd), home)).toBe(fallback);
  });

  test("finds Codex rollout recursively without deriving a date", () => {
    const home = path.join(testHome, "codex-home");
    const sessionId = "01a07702-753d-7000-8fd6-36bf2cf28942";
    const cwd = "/tmp/codex-project";
    const file = path.join(
      home,
      ".codex",
      "sessions",
      "unexpected",
      "nested",
      `rollout-anything-${sessionId}.jsonl`,
    );
    write(file, `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`);
    expect(resolveTranscriptPath(makePane(sessionId, "codex", cwd), home)).toBe(file);
  });

  test("offers resolved Codex transcripts to the mirror importer", () => {
    const db = new Database(":memory:");
    ensureHerdrSchema(db);
    const home = path.join(testHome, "codex-attach-home");
    const sessionId = "01a07702-753d-7000-8fd6-36bf2cf20000";
    const cwd = "/tmp/codex-attach";
    const file = path.join(
      home,
      ".codex",
      "sessions",
      "nested",
      `rollout-test-${sessionId}.jsonl`,
    );
    write(
      file,
      `${JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } })}\n`,
    );
    const attached: [string, string][] = [];
    reconcileHerdrPane(makePane(sessionId, "codex", cwd), undefined, {
      db,
      home,
      attachTranscript: (transcriptPath, agentKind) =>
        attached.push([transcriptPath, agentKind]),
    });
    expect(attached).toEqual([[file, "codex"]]);
    db.close();
  });

  test("upserts by session id, preserves first_seen_at, and tombstones closed panes", () => {
    const db = new Database(":memory:");
    ensureHerdrSchema(db);
    const pane = makePane("session-upsert");
    reconcileHerdrPane(pane, { pane_id: pane.pane_id, name: "worker", state_change_seq: 4 }, {
      db,
      home: path.join(testHome, "empty-home"),
      now: 100,
    });
    reconcileHerdrPane(
      { ...pane, pane_id: "w1:p2", revision: 9, agent_status: "working" },
      { pane_id: "w1:p2", name: "worker-2", state_change_seq: 6 },
      { db, home: path.join(testHome, "empty-home"), now: 200 },
    );
    const binding = getHerdrBinding("session-upsert", db)!;
    expect(binding.firstSeenAt).toBe(100);
    expect(binding.lastSeenAt).toBe(200);
    expect(binding.paneId).toBe("w1:p2");
    expect(binding.stateChangeSeq).toBe(6);
    markHerdrPaneClosed("w1:p2", db, 300);
    expect(getHerdrBinding("session-upsert", db)?.alive).toBeFalse();
    db.close();
  });

  test("full snapshot marks missing panes dead without deleting history", () => {
    const db = new Database(":memory:");
    ensureHerdrSchema(db);
    const first = makePane("gone");
    reconcileHerdrPane(first, undefined, { db, home: testHome, now: 100 });
    reconcileHerdrSnapshot([], [], { db, home: testHome, now: 200 });
    expect(getHerdrBinding("gone", db)?.alive).toBeFalse();
    db.close();
  });

  test("Herdr auto-attach imports Claude as a read-only origin", async () => {
    const sessionId = "33333333-3333-4333-8333-333333333333";
    const cwd = "/tmp/herdr-readonly";
    const file = path.join(testHome, "attach", `${sessionId}.jsonl`);
    write(
      file,
      [
        {
          type: "user",
          uuid: "turn-user",
          parentUuid: null,
          sessionId,
          cwd,
          timestamp: "2026-01-01T00:00:00.000Z",
          message: { role: "user", content: "question" },
        },
        {
          type: "assistant",
          uuid: "turn-assistant",
          parentUuid: "turn-user",
          sessionId,
          cwd,
          timestamp: "2026-01-01T00:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "answer" }],
            usage: { input_tokens: 1, output_tokens: 1 },
          },
        },
      ]
        .map((entry) => JSON.stringify(entry))
        .join("\n") + "\n",
    );
    const dbPath = path.join(testHome, "attach-origin.db");
    const script = `
      const { attachSession } = await import(${JSON.stringify(path.resolve("lib/server/cli-sync-watcher.ts"))});
      const { getDB } = await import(${JSON.stringify(path.resolve("lib/server/sqlite.ts"))});
      attachSession(${JSON.stringify(file)}, "claude", { origin: "herdr" });
      const row = getDB().prepare("SELECT origin, source_jsonl_path FROM sessions WHERE id = ?").get(${JSON.stringify(sessionId)});
      process.stdout.write(JSON.stringify(row));
      process.exit(0);
    `;
    const child = Bun.spawn(["bun", "--conditions", "react-server", "-e", script], {
      cwd: process.cwd(),
      env: { ...process.env, TRELLIS_DB_PATH: dbPath },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, stderr).toBe(0);
    const row = JSON.parse(stdout) as { origin: string; source_jsonl_path: string };
    expect(row.origin).toBe("herdr");
    expect(row.source_jsonl_path).toBe(file);
  });
});
