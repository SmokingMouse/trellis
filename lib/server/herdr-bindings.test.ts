import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));

const testHome = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-herdr-bindings-"));
process.env.TRELLIS_DB_PATH = path.join(testHome, "trellis.db");

const { ensureHerdrSchema, getDB } = await import("./sqlite");
const {
  claudeProjectSlug,
  getHerdrBinding,
  markHerdrPaneClosed,
  reconcileHerdrPane,
  reconcileHerdrSnapshot,
  resolveTranscriptPath,
} = await import("./herdr-bindings");
const { attachSession } = await import("./cli-sync-watcher");
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

  test("Herdr auto-attach imports Claude as a read-only origin", () => {
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
    attachSession(file, "claude", { origin: "herdr" });
    const row = getDB()
      .prepare("SELECT origin, source_jsonl_path FROM sessions WHERE id = ?")
      .get(sessionId) as { origin: string; source_jsonl_path: string };
    expect(row.origin).toBe("herdr");
    expect(row.source_jsonl_path).toBe(file);
  });
});
