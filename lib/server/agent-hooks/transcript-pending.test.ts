import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  TranscriptPromptCache,
  findPendingToolUses,
  pendingToPrompt,
  readTranscriptPrompt,
  readTranscriptTailLines,
} from "./transcript-pending";

const FIXTURE = path.join(import.meta.dir, "..", "__fixtures__", "claude", "harbor-ask-tail.jsonl");

const line = (value: unknown) => JSON.stringify(value);
const assistant = (id: string, content: unknown[], extra: Record<string, unknown> = {}) =>
  line({ type: "assistant", isSidechain: false, message: { id, role: "assistant", content }, ...extra });
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input });
const toolResult = (id: string, extra: Record<string, unknown> = {}) =>
  line({ type: "user", isSidechain: false, message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] }, ...extra });
const human = (text: string) => line({ type: "user", isSidechain: false, message: { role: "user", content: text } });

const ASK_INPUT = {
  questions: [
    { header: "颜色", question: "选哪个颜色？", multiSelect: false, options: [{ label: "红", description: "暖" }, { label: "蓝" }] },
  ],
};

describe("findPendingToolUses / pendingToPrompt", () => {
  test("harbor 真实尾部：末尾未完成的 AskUserQuestion（3 题）", () => {
    const prompt = pendingToPrompt(findPendingToolUses(readFileSync(FIXTURE, "utf8").split("\n")));
    expect(prompt?.toolName).toBe("AskUserQuestion");
    expect(prompt?.toolUseId).toBe("toolu_01W3Gg8XZzhJDfavEdW1YNsu");
    const questions = prompt?.interactivePrompt.questions as { header: string; options: unknown[] }[];
    expect(questions.map((q) => q.header)).toEqual(["方向", "公司设备", "Push"]);
    expect(questions.every((q) => q.options.length >= 2)).toBe(true);
    expect(prompt?.interactivePrompt.tool_use_id).toBe("toolu_01W3Gg8XZzhJDfavEdW1YNsu");
  });

  test("已完成：tool_result 之后不算待答", () => {
    const lines = [assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]), toolResult("t1")];
    expect(findPendingToolUses(lines)).toEqual([]);
  });

  test("流式分片：同一 message.id 的 thinking / text / tool_use 多行，重复 tool_use 只算一次", () => {
    const lines = [
      assistant("m1", [{ type: "thinking", thinking: "…" }]),
      assistant("m1", [{ type: "text", text: "我问一下" }]),
      assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]),
      assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]),
    ];
    const pending = findPendingToolUses(lines);
    expect(pending.map((use) => use.id)).toEqual(["t1"]);
    expect(pendingToPrompt(pending)?.interactivePrompt.questions).toEqual(ASK_INPUT.questions);
  });

  test("sidechain 行不参与：子 agent 的未完成调用不冒充主会话的待答", () => {
    const lines = [
      assistant("m1", [toolUse("t1", "Read", { file_path: "/a" })]),
      toolResult("t1"),
      assistant("s1", [toolUse("s-t1", "Bash", { command: "rm -rf /" })], { isSidechain: true }),
    ];
    expect(findPendingToolUses(lines)).toEqual([]);
  });

  test("权限审批：唯一未完成的 Bash → approval 卡，summary 取命令", () => {
    const lines = [assistant("m1", [toolUse("t1", "Bash", { command: "git push origin main", description: "push" })])];
    const prompt = pendingToPrompt(findPendingToolUses(lines));
    expect(prompt).toEqual({
      toolUseId: "t1",
      toolName: "Bash",
      interactivePrompt: { approval: { tool: "Bash", summary: "git push origin main" }, tool_name: "Bash", tool_use_id: "t1" },
    });
  });

  test("Edit / Write 的审批 summary 取文件路径", () => {
    const prompt = pendingToPrompt(findPendingToolUses([assistant("m1", [toolUse("t1", "Write", { file_path: "/x/y.ts", content: "..." })])]));
    expect((prompt?.interactivePrompt.approval as { summary: string }).summary).toBe("/x/y.ts");
  });

  test("并行调用：已完成的销账，只剩一个悬着 → 就是它", () => {
    const lines = [
      assistant("m1", [toolUse("t1", "Read", { file_path: "/a" })]),
      assistant("m1", [toolUse("t2", "Bash", { command: "ls" })]),
      toolResult("t1"),
    ];
    expect(pendingToPrompt(findPendingToolUses(lines))?.toolUseId).toBe("t2");
  });

  test("多个普通工具同时悬着 → 认不出等的是哪个，交给读屏", () => {
    const lines = [assistant("m1", [toolUse("t1", "Bash", { command: "a" }), toolUse("t2", "Bash", { command: "b" })])];
    expect(findPendingToolUses(lines)).toHaveLength(2);
    expect(pendingToPrompt(findPendingToolUses(lines))).toBeNull();
  });

  test("子 agent 外壳（Agent / Task）悬着 → null", () => {
    expect(pendingToPrompt(findPendingToolUses([assistant("m1", [toolUse("t1", "Agent", { prompt: "x" })])]))).toBeNull();
  });

  test("无待答：最后一条是纯文本回复", () => {
    const lines = [assistant("m1", [toolUse("t1", "Bash", { command: "ls" })]), toolResult("t1"), assistant("m2", [{ type: "text", text: "done" }])];
    expect(findPendingToolUses(lines)).toEqual([]);
  });

  test("旧消息里残留的未完成调用（被中断）不算：只看最后一条 assistant 消息", () => {
    const lines = [assistant("m1", [toolUse("t1", "Bash", { command: "sleep 99" })]), assistant("m2", [{ type: "text", text: "继续" }])];
    expect(findPendingToolUses(lines)).toEqual([]);
  });

  test("人的新输入作废之前的悬挂调用", () => {
    const lines = [assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]), human("[Request interrupted by user]")];
    expect(findPendingToolUses(lines)).toEqual([]);
  });

  test("meta user 行 / 坏行 / 空行不影响", () => {
    const lines = [
      assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]),
      line({ type: "user", isMeta: true, message: { role: "user", content: "<system-reminder>" } }),
      "{not json",
      "",
      line({ type: "attachment", attachment: {} }),
    ];
    expect(findPendingToolUses(lines).map((use) => use.id)).toEqual(["t1"]);
  });

  test("AskUserQuestion 没有 questions → 不出卡", () => {
    expect(pendingToPrompt(findPendingToolUses([assistant("m1", [toolUse("t1", "AskUserQuestion", {})])]))).toBeNull();
  });
});

describe("尾读 + 缓存", () => {
  test("只读尾部：被截断的首行丢弃，仍能找到末尾的待答", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "transcript-pending-"));
    try {
      const file = path.join(dir, "s.jsonl");
      const filler = Array.from({ length: 200 }, (_, i) => assistant(`old${i}`, [{ type: "text", text: "x".repeat(200) }]));
      writeFileSync(file, [...filler, assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)])].join("\n") + "\n");
      const tail = readTranscriptTailLines(file, 4096);
      expect(tail.every((l) => l === "" || l.startsWith("{"))).toBe(true);
      expect(readTranscriptPrompt(file, 4096)?.toolUseId).toBe("t1");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("缓存按 size+mtime 失效；文件不存在 → null", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "transcript-pending-"));
    try {
      const file = path.join(dir, "s.jsonl");
      writeFileSync(file, assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]) + "\n");
      let reads = 0;
      const cache = new TranscriptPromptCache((f) => { reads++; return readTranscriptPrompt(f); });
      expect(cache.get(file)?.toolUseId).toBe("t1");
      expect(cache.get(file)?.toolUseId).toBe("t1");
      expect(reads).toBe(1);
      writeFileSync(file, [assistant("m1", [toolUse("t1", "AskUserQuestion", ASK_INPUT)]), toolResult("t1")].join("\n") + "\n");
      utimesSync(file, new Date(), new Date(Date.now() + 5_000));
      expect(cache.get(file)).toBeNull();
      expect(reads).toBe(2);
      expect(cache.get(path.join(dir, "missing.jsonl"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
