import { afterAll, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCodexSessionJsonl } from "./codex-import";
import {
  clearCodexRolloutIndex,
  findCodexRolloutPath,
} from "./codex-transcript-index";
import { parseCliTranscript } from "./cli-transcript";

const fixtureDir = path.join(import.meta.dir, "__fixtures__", "codex");
const modernFixture = path.join(fixtureDir, "modern-response-items.jsonl");
const legacyFixture = path.join(fixtureDir, "legacy-event-messages.jsonl");
const tempRoot = mkdtempSync(path.join(os.tmpdir(), "trellis-codex-transcript-"));

afterAll(() => {
  clearCodexRolloutIndex();
  rmSync(tempRoot, { recursive: true, force: true });
});

describe("Codex rollout lookup", () => {
  test("tolerates a missing sessions directory", () => {
    expect(
      findCodexRolloutPath(
        "00000000-0000-4000-8000-000000000000",
        path.join(tempRoot, "missing"),
      ),
    ).toBeNull();
  });

  test("indexes ids from both filename and session_meta, refreshing on misses", () => {
    const sessionsRoot = path.join(tempRoot, "sessions");
    const dayOne = path.join(sessionsRoot, "2026", "09", "07");
    mkdirSync(dayOne, { recursive: true });
    const filenameId = "33333333-3333-4333-8333-333333333333";
    const first = path.join(
      dayOne,
      `rollout-2026-09-07T08-00-00-prefix-${filenameId}-suffix.jsonl`,
    );
    copyFileSync(modernFixture, first);

    expect(findCodexRolloutPath(filenameId, sessionsRoot)).toBe(first);
    expect(
      findCodexRolloutPath("11111111-1111-4111-8111-111111111111", sessionsRoot),
    ).toBe(first);

    const newMetaId = "44444444-4444-4444-8444-444444444444";
    expect(findCodexRolloutPath(newMetaId, sessionsRoot)).toBeNull();
    const dayTwo = path.join(sessionsRoot, "2026", "09", "08");
    mkdirSync(dayTwo, { recursive: true });
    const second = path.join(dayTwo, "rollout-meta-only.jsonl");
    writeFileSync(
      second,
      `${JSON.stringify({ type: "session_meta", payload: { id: newMetaId } })}\n`,
    );
    expect(findCodexRolloutPath(newMetaId, sessionsRoot)).toBe(second);
  });
});

describe("Codex rollout normalization", () => {
  test("maps modern response_item turns, reasoning boundaries, tools and events", () => {
    const parsed = parseCodexSessionJsonl(modernFixture);
    expect(parsed).not.toBeNull();
    expect(parsed).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
      cwd: "PROJECT",
      gitBranch: "fixture",
    });
    expect(parsed!.turns).toHaveLength(1);
    expect(parsed!.turns[0]).toMatchObject({
      id: "turn-modern-1",
      question: "USER_ONE",
      response: "WORKING\n\nANSWER_ONE",
      finalStart: "WORKING\n\n".length,
      durationMs: 9000,
      tokens: {
        input: 100,
        output: 9,
        cacheRead: 20,
        cacheCreation: 3,
        contextTokens: 120,
      },
    });
    expect(parsed!.turns[0].createdAt).toBe(Date.parse("2026-09-07T08:00:03.000Z"));
    expect(parsed!.turns[0].toolCalls).toEqual([
      expect.objectContaining({
        id: "call-function-1",
        name: "fixture_function",
        input: { value: 7 },
        output: "FUNCTION_OUTPUT",
        status: "done",
        durationMs: 1000,
      }),
    ]);
  });

  test("maps legacy event messages and custom tool calls without duplicates", () => {
    const parsed = parseCodexSessionJsonl(legacyFixture);
    expect(parsed?.turns).toHaveLength(1);
    expect(parsed!.turns[0]).toMatchObject({
      id: "turn-legacy-1",
      question: "USER_LEGACY",
      response: "ANSWER_LEGACY",
      durationMs: 7000,
      tokens: {
        input: 40,
        output: 5,
        cacheRead: 10,
        cacheCreation: 0,
        contextTokens: 50,
      },
    });
    expect(parsed!.turns[0].toolCalls[0]).toMatchObject({
      id: "call-custom-1",
      name: "fixture_custom",
      input: { flag: true },
      output: "CUSTOM_OUTPUT",
    });
  });

  test("skips malformed lines and sees a later append through the provider dispatcher", () => {
    const rollout = path.join(tempRoot, "incremental.jsonl");
    copyFileSync(modernFixture, rollout);
    const before = parseCliTranscript("codex", rollout)!;
    expect(before.turns).toHaveLength(1);

    const line = (timestamp: string, type: string, payload: object) =>
      JSON.stringify({ timestamp, type, payload });
    appendFileSync(
      rollout,
      [
        "",
        line("2026-09-07T08:00:11.000Z", "turn_context", {
          turn_id: "turn-modern-2",
        }),
        line("2026-09-07T08:00:12.000Z", "response_item", {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "USER_TWO" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-modern-2" },
        }),
        "still-not-json",
        line("2026-09-07T08:00:13.000Z", "response_item", {
          type: "message",
          role: "assistant",
          phase: "final_answer",
          content: [{ type: "output_text", text: "ANSWER_TWO" }],
          internal_chat_message_metadata_passthrough: { turn_id: "turn-modern-2" },
        }),
        "",
      ].join("\n"),
    );

    const after = parseCliTranscript("codex", rollout)!;
    expect(after.lastUuid).not.toBe(before.lastUuid);
    expect(after.turns).toHaveLength(2);
    expect(after.turns[1]).toMatchObject({
      id: "turn-modern-2",
      parentId: "turn-modern-1",
      question: "USER_TWO",
      response: "ANSWER_TWO",
      turnOrdinal: 2,
    });
  });

  test("keeps the Claude parser unchanged behind the same dispatcher", () => {
    const claude = path.join(tempRoot, "claude.jsonl");
    writeFileSync(
      claude,
      [
        JSON.stringify({
          type: "user",
          uuid: "claude-user-1",
          parentUuid: null,
          sessionId: "claude-session",
          timestamp: "2026-09-07T09:00:00.000Z",
          message: { role: "user", content: "CLAUDE_USER" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "claude-assistant-1",
          parentUuid: "claude-user-1",
          timestamp: "2026-09-07T09:00:01.000Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "CLAUDE_ASSISTANT" }],
          },
        }),
        "",
      ].join("\n"),
    );
    expect(parseCliTranscript("claude", claude)?.turns[0]).toMatchObject({
      id: "claude-user-1",
      question: "CLAUDE_USER",
      response: "CLAUDE_ASSISTANT",
    });
  });
});
