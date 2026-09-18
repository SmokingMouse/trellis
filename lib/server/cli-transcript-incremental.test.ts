// cli-transcript 的增量/短路/分片三条性质的回归。
//
// 这三条各自的失效后果都不是"慢一点"：
//   等价性破了 → 增量解析出来的 turn 树和全量不一样，镜像会话默默长出/丢掉节点；
//   短路破了   → 回到每次 reimport 全量重读，就是这次要修的 CPU 尖峰本身；
//   截断回退破了 → 文件被重写后缓存里的旧 turn 残留，UI 显示已经不存在的对话。
import { afterAll, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseCliSessionJsonl } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";
import {
  cliTranscriptCacheStats,
  parseCliTranscript,
  parseCliTranscriptAsync,
  resetCliTranscriptCache,
} from "./cli-transcript";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "trellis-cli-incr-"));
afterAll(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

beforeEach(() => resetCliTranscriptCache());

// ── fixtures ────────────────────────────────────────────────────────────────

const ts = (i: number) => new Date(1750000000000 + i * 1000).toISOString();
const uuid = (n: number) =>
  `${n.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`;

/** 一个 claude turn = user 提问 + assistant（文本 + tool_use）+ tool_result。 */
function claudeTurnLines(turnIndex: number): string[] {
  const q = uuid(turnIndex * 3 + 1);
  const a = uuid(turnIndex * 3 + 2);
  const r = uuid(turnIndex * 3 + 3);
  const parent = turnIndex === 0 ? null : uuid((turnIndex - 1) * 3 + 3);
  return [
    JSON.stringify({
      type: "user",
      uuid: q,
      parentUuid: parent,
      sessionId: "incr-session",
      cwd: "/tmp/incr",
      gitBranch: "main",
      timestamp: ts(turnIndex * 10),
      promptSource: "typed",
      message: { role: "user", content: `问题 ${turnIndex} 带中文避免全 ASCII` },
    }),
    JSON.stringify({
      type: "assistant",
      uuid: a,
      parentUuid: q,
      sessionId: "incr-session",
      timestamp: ts(turnIndex * 10 + 1),
      message: {
        role: "assistant",
        usage: { input_tokens: 7, output_tokens: 11, cache_read_input_tokens: 3 },
        content: [
          { type: "text", text: `思考中 ${turnIndex}` },
          {
            type: "tool_use",
            id: `tu-${turnIndex}`,
            name: "Bash",
            input: { command: "ls" },
          },
          { type: "text", text: `最终答复 ${turnIndex}` },
        ],
      },
    }),
    JSON.stringify({
      type: "user",
      uuid: r,
      parentUuid: a,
      timestamp: ts(turnIndex * 10 + 2),
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: `tu-${turnIndex}`, content: "ok" },
        ],
      },
    }),
  ];
}

function codexTurnLines(turnIndex: number): string[] {
  const head =
    turnIndex === 0
      ? [
          JSON.stringify({
            timestamp: ts(0),
            type: "session_meta",
            payload: {
              id: "11111111-2222-4333-8444-555555555555",
              cwd: "/tmp/incr",
              git: { branch: "main" },
            },
          }),
        ]
      : [];
  const tid = `turn-${turnIndex}`;
  return [
    ...head,
    JSON.stringify({
      timestamp: ts(turnIndex * 10 + 1),
      type: "turn_context",
      payload: { turn_id: tid },
    }),
    JSON.stringify({
      timestamp: ts(turnIndex * 10 + 2),
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `问题 ${turnIndex} 中文` }],
        internal_chat_message_metadata_passthrough: { turn_id: tid },
      },
    }),
    JSON.stringify({
      timestamp: ts(turnIndex * 10 + 3),
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: `call-${turnIndex}`,
        name: "shell",
        arguments: '{"cmd":"ls"}',
        internal_chat_message_metadata_passthrough: { turn_id: tid },
      },
    }),
    JSON.stringify({
      timestamp: ts(turnIndex * 10 + 4),
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: `call-${turnIndex}`,
        output: "ok",
        internal_chat_message_metadata_passthrough: { turn_id: tid },
      },
    }),
    JSON.stringify({
      timestamp: ts(turnIndex * 10 + 5),
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: `答复 ${turnIndex}` }],
        internal_chat_message_metadata_passthrough: { turn_id: tid },
      },
    }),
  ];
}

function fixturePath(name: string): string {
  return path.join(tempRoot, `${name}-${Math.random().toString(36).slice(2)}.jsonl`);
}

// ── 1. 等价性：全量一次 === 分三次增量（其中一次切在半行上）─────────────────

for (const provider of ["claude", "codex"] as const) {
  const makeTurn = provider === "claude" ? claudeTurnLines : codexTurnLines;
  const fullParse =
    provider === "claude" ? parseCliSessionJsonl : parseCodexSessionJsonl;

  test(`[${provider}] 分三次增量（含半行截断）与一次全量解析结果完全相同`, () => {
    const file = fixturePath(`equiv-${provider}`);
    const allLines = [0, 1, 2, 3].flatMap(makeTurn);
    // 切三段：前 2 个 turn 的行 → 半行 → 剩下的全部。
    const head = allLines.slice(0, makeTurn(0).length + makeTurn(1).length);
    const rest = allLines.slice(head.length);
    const halfLine = rest[0].slice(0, Math.floor(rest[0].length / 2));
    const tail = `${rest[0].slice(halfLine.length)}\n${rest.slice(1).join("\n")}\n`;

    // 第一段：完整行 + 换行结尾。
    fs.writeFileSync(file, `${head.join("\n")}\n`);
    const step1 = parseCliTranscript(provider, file);
    expect(step1).toEqual(fullParse(file));
    expect(step1!.turns).toHaveLength(2);

    // 第二段：只写半行。半行必须被当成"还没写完"，不能当成损坏而丢失后续。
    fs.appendFileSync(file, halfLine);
    const step2 = parseCliTranscript(provider, file);
    expect(step2).toEqual(fullParse(file));
    // 半行无法 JSON.parse → 这一步看到的 turn 数与第一段相同。
    expect(step2!.turns).toHaveLength(2);

    // 第三段：补齐半行 + 剩余内容。
    fs.appendFileSync(file, tail);
    const incremental = parseCliTranscript(provider, file);

    // 与"从未见过这个文件、一次性全量解析"逐字段深比较。
    resetCliTranscriptCache();
    const oneShotCached = parseCliTranscript(provider, file);
    expect(incremental).toEqual(fullParse(file));
    expect(incremental).toEqual(oneShotCached);
    expect(incremental!.turns).toHaveLength(4);
  });

  test(`[${provider}] 末行没有换行符时，增量与全量看到同一条 entry`, () => {
    const file = fixturePath(`nonewline-${provider}`);
    const lines = [0, 1].flatMap(makeTurn);
    // 先写到倒数第二行，再把最后一行**不带换行**追加上去。
    fs.writeFileSync(file, `${lines.slice(0, -1).join("\n")}\n`);
    parseCliTranscript(provider, file);
    fs.appendFileSync(file, lines.at(-1)!);
    expect(parseCliTranscript(provider, file)).toEqual(fullParse(file));
  });

  test(`[${provider}] 多字节字符被切在两次读取之间也不损坏`, () => {
    const file = fixturePath(`utf8-${provider}`);
    const lines = [0, 1].flatMap(makeTurn);
    const whole = `${lines.join("\n")}\n`;
    const bytes = Buffer.from(whole, "utf8");
    // 找一个三字节中文字符，切在它中间。
    const cut = bytes.indexOf(Buffer.from("问", "utf8")) + 1;
    expect(cut).toBeGreaterThan(0);
    fs.writeFileSync(file, bytes.subarray(0, cut));
    parseCliTranscript(provider, file);
    fs.appendFileSync(file, bytes.subarray(cut));
    expect(parseCliTranscript(provider, file)).toEqual(fullParse(file));
  });

  test(`[${provider}] 异步分片解析与同步解析结果相同`, async () => {
    const file = fixturePath(`async-${provider}`);
    fs.writeFileSync(file, `${[0, 1, 2].flatMap(makeTurn).join("\n")}\n`);
    const asyncParsed = await parseCliTranscriptAsync(provider, file);
    expect(asyncParsed).toEqual(fullParse(file));
    resetCliTranscriptCache();
    expect(asyncParsed).toEqual(parseCliTranscript(provider, file));
  });
}

// ── 2. 短路：mtime/size 未变 → 一次文件读取都不发生 ──────────────────────────

test("mtime/size 未变时再次解析不读文件（fs spy 断言读取次数为 0）", () => {
  const file = fixturePath("shortcircuit");
  fs.writeFileSync(file, `${[0, 1].flatMap(claudeTurnLines).join("\n")}\n`);

  const first = parseCliTranscript("claude", file);
  expect(first!.turns).toHaveLength(2);

  const realOpenSync = fs.openSync;
  const realReadFileSync = fs.readFileSync;
  const realReadSync = fs.readSync;
  let opens = 0;
  let reads = 0;
  let readFiles = 0;
  const target = fs as unknown as Record<string, unknown>;
  target.openSync = (...args: Parameters<typeof fs.openSync>) => {
    opens++;
    return realOpenSync(...args);
  };
  target.readSync = (...args: Parameters<typeof fs.readSync>) => {
    reads++;
    return (realReadSync as (...a: unknown[]) => number)(...args);
  };
  target.readFileSync = (...args: Parameters<typeof fs.readFileSync>) => {
    readFiles++;
    return realReadFileSync(...args);
  };

  let second: ReturnType<typeof parseCliTranscript>;
  let statsDelta: ReturnType<typeof cliTranscriptCacheStats>;
  try {
    const before = cliTranscriptCacheStats();
    second = parseCliTranscript("claude", file);
    const after = cliTranscriptCacheStats();
    statsDelta = {
      shortCircuits: after.shortCircuits - before.shortCircuits,
      incrementalReads: after.incrementalReads - before.incrementalReads,
      fullReads: after.fullReads - before.fullReads,
      bytesRead: after.bytesRead - before.bytesRead,
      evictions: after.evictions - before.evictions,
    };
  } finally {
    target.openSync = realOpenSync;
    target.readSync = realReadSync;
    target.readFileSync = realReadFileSync;
  }

  expect(opens).toBe(0);
  expect(reads).toBe(0);
  expect(readFiles).toBe(0);
  expect(statsDelta.shortCircuits).toBe(1);
  expect(statsDelta.bytesRead).toBe(0);
  // 结果不是"空壳"，是上一次那份完整结果。
  expect(second).toEqual(first);
});

test("追加后只读新增字节，不重读前缀", () => {
  const file = fixturePath("appendonly");
  const head = `${[0, 1].flatMap(claudeTurnLines).join("\n")}\n`;
  fs.writeFileSync(file, head);
  parseCliTranscript("claude", file);

  const appended = `${claudeTurnLines(2).join("\n")}\n`;
  fs.appendFileSync(file, appended);

  const before = cliTranscriptCacheStats();
  const parsed = parseCliTranscript("claude", file);
  const after = cliTranscriptCacheStats();

  expect(after.incrementalReads - before.incrementalReads).toBe(1);
  expect(after.fullReads - before.fullReads).toBe(0);
  expect(after.bytesRead - before.bytesRead).toBe(Buffer.byteLength(appended));
  expect(parsed!.turns).toHaveLength(3);
  expect(parsed).toEqual(parseCliSessionJsonl(file));
});

// ── 3. 截断 / 重写 / 重建：必须回退全量，且不残留旧 turn ─────────────────────

test("文件被截短后回退全量，旧 turn 不残留", () => {
  const file = fixturePath("truncate");
  fs.writeFileSync(file, `${[0, 1, 2].flatMap(claudeTurnLines).join("\n")}\n`);
  expect(parseCliTranscript("claude", file)!.turns).toHaveLength(3);

  fs.writeFileSync(file, `${claudeTurnLines(0).join("\n")}\n`);
  const before = cliTranscriptCacheStats();
  const parsed = parseCliTranscript("claude", file);
  const after = cliTranscriptCacheStats();

  expect(after.fullReads - before.fullReads).toBe(1);
  expect(after.evictions - before.evictions).toBe(1);
  expect(parsed!.turns).toHaveLength(1);
  expect(parsed!.turns.map((t) => t.id)).toEqual([uuid(1)]);
  expect(parsed).toEqual(parseCliSessionJsonl(file));
});

test("等长原地重写（size 相同、内容不同）也回退全量", () => {
  const file = fixturePath("rewrite");
  const original = [0, 1].flatMap(claudeTurnLines).join("\n");
  fs.writeFileSync(file, `${original}\n`);
  const first = parseCliTranscript("claude", file);
  expect(first!.turns[1].question).toContain("问题 1");

  // 同样字节数、不同内容（把 "问题 1" 换成 "问题 9"）。
  const rewritten = original.replace("问题 1 带中文", "问题 9 带中文");
  expect(Buffer.byteLength(rewritten)).toBe(Buffer.byteLength(original));
  fs.writeFileSync(file, `${rewritten}\n`);
  // mtimeMs 必须真的变化，否则这条断言测的就不是同一件事。
  const parsed = parseCliTranscript("claude", file);
  expect(parsed!.turns[1].question).toContain("问题 9");
  expect(parsed).toEqual(parseCliSessionJsonl(file));
});

test("文件被删后重建（inode 变化）回退全量", () => {
  const file = fixturePath("recreate");
  fs.writeFileSync(file, `${[0, 1, 2].flatMap(claudeTurnLines).join("\n")}\n`);
  const inoBefore = fs.statSync(file).ino;
  expect(parseCliTranscript("claude", file)!.turns).toHaveLength(3);

  fs.rmSync(file);
  // 中间的这次解析必须报"读不到"（见下一条测试的不变量）。
  expect(parseCliTranscript("claude", file)).toBeNull();

  fs.writeFileSync(file, `${[0, 1].flatMap(claudeTurnLines).join("\n")}\n`);
  expect(fs.statSync(file).ino).not.toBe(inoBefore);
  const parsed = parseCliTranscript("claude", file);
  expect(parsed!.turns).toHaveLength(2);
  expect(parsed).toEqual(parseCliSessionJsonl(file));
});

test("文件消失时返回 null 并作废缓存（anyUnreadable 不变量）", () => {
  const file = fixturePath("vanish");
  fs.writeFileSync(file, `${claudeTurnLines(0).join("\n")}\n`);
  expect(parseCliTranscript("claude", file)).not.toBeNull();

  fs.rmSync(file);
  // 关键：不能因为缓存里还留着上次那份结果就吐回去 —— cli-import-db 的
  // anyUnreadable 闸靠「parse 空 + 文件不存在」判"对这条 lineage 一无所知"，
  // 吐旧快照会让它误判成"读到了但没内容"，进而拿残缺集合去删节点。
  expect(parseCliTranscript("claude", file)).toBeNull();
  expect(fs.existsSync(file)).toBe(false);
});
