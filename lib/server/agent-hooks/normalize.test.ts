import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyHookEvent } from "./normalize";
import { readLastAssistantMessage } from "./transcript";
import type { AgentHookRecord, ClaudeHookPayload } from "./types";

const SID = "sess-1";

function ev(
  hook_event_name: string,
  extra: Partial<ClaudeHookPayload> = {},
): ClaudeHookPayload {
  return { hook_event_name, session_id: SID, ...extra };
}

/** 顺着喂一串事件，返回最终记录。 */
function feed(
  events: ClaudeHookPayload[],
  start: AgentHookRecord | null = null,
  now = 1000,
): AgentHookRecord {
  let rec = start;
  let t = now;
  for (const e of events) {
    rec = applyHookEvent(rec, e, { now: t, tailScan: () => null });
    t += 10;
  }
  return rec as AgentHookRecord;
}

describe("事件归一化", () => {
  test("没有 session_id 的 payload 直接丢弃", () => {
    expect(applyHookEvent(null, { hook_event_name: "Stop" })).toBeNull();
  });

  test("SessionStart 建记录并带上 cwd / transcript", () => {
    const rec = feed([
      ev("SessionStart", { cwd: "/repo", transcript_path: "/t.jsonl" }),
    ]);
    expect(rec.sessionId).toBe(SID);
    expect(rec.agent).toBe("claude");
    expect(rec.state).toBe("working");
    expect(rec.cwd).toBe("/repo");
    expect(rec.transcriptPath).toBe("/t.jsonl");
    expect(rec.stateStartedAt).toBe(1000);
  });

  test("SessionEnd 标 done", () => {
    const rec = feed([ev("SessionStart"), ev("SessionEnd")]);
    expect(rec.state).toBe("done");
  });

  test("UserPromptSubmit / PreToolUse → working，且记下 prompt 与工具", () => {
    const rec = feed([
      ev("UserPromptSubmit", { prompt: "改一下这个 bug" }),
      ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }),
    ]);
    expect(rec.state).toBe("working");
    expect(rec.prompt).toBe("改一下这个 bug");
    expect(rec.toolName).toBe("Bash");
    expect(rec.toolInput).toEqual({ command: "ls" });
  });

  test("state 不变时 stateStartedAt 不刷新，变了才刷新", () => {
    const first = feed([ev("SessionStart")], null, 1000);
    expect(first.stateStartedAt).toBe(1000);
    const still = applyHookEvent(first, ev("PreToolUse", { tool_name: "Read" }), {
      now: 5000,
    })!;
    expect(still.state).toBe("working");
    expect(still.stateStartedAt).toBe(1000);
    expect(still.updatedAt).toBe(5000);
    const moved = applyHookEvent(still, ev("Stop"), { now: 9000, tailScan: () => null })!;
    expect(moved.stateStartedAt).toBe(9000);
  });

  test("paneKey 由请求侧带入，空值不覆盖已有的", () => {
    const a = applyHookEvent(null, ev("SessionStart"), { paneKey: "pane-7" })!;
    expect(a.paneKey).toBe("pane-7");
    const b = applyHookEvent(a, ev("PreToolUse"), { paneKey: "" })!;
    expect(b.paneKey).toBe("pane-7");
  });

  test("未知事件不动状态机，只刷新 updatedAt", () => {
    const start = feed([ev("SessionStart")], null, 1000);
    const rec = applyHookEvent(start, ev("Notification"), { now: 4321 })!;
    expect(rec.state).toBe("working");
    expect(rec.updatedAt).toBe(4321);
  });
});

describe("卡片形状", () => {
  test("AskUserQuestion 的 PreToolUse → waiting，interactivePrompt 是 tool_input 原样", () => {
    const toolInput = {
      questions: [
        { question: "选哪个方案？", header: "方案", options: [{ label: "A" }, { label: "B" }] },
      ],
    };
    const rec = feed([
      ev("SessionStart"),
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: toolInput }),
    ]);
    expect(rec.state).toBe("waiting");
    expect(rec.toolName).toBe("AskUserQuestion");
    // 原样 —— 前端要照着渲染选项，任何归一化都是丢信息
    expect(rec.interactivePrompt).toEqual({ ...toolInput, tool_name: "AskUserQuestion" });
  });

  test("PermissionRequest → waiting，interactivePrompt 是 approval 卡", () => {
    const rec = feed([
      ev("SessionStart"),
      ev("PermissionRequest", {
        tool_name: "Bash",
        tool_input: { command: "rm -rf /tmp/x" },
      }),
    ]);
    expect(rec.state).toBe("waiting");
    expect(rec.interactivePrompt).toEqual({
      tool_name: "Bash",
      approval: { tool: "Bash", summary: "rm -rf /tmp/x" },
    });
  });

  test("PermissionRequest 带 summary 时优先用它", () => {
    const rec = feed([
      ev("PermissionRequest", {
        tool_name: "Write",
        summary: "写入 /etc/hosts",
        tool_input: { file_path: "/etc/hosts" },
      }),
    ]);
    expect(rec.interactivePrompt).toEqual({
      tool_name: "Write",
      approval: { tool: "Write", summary: "写入 /etc/hosts" },
    });
  });

  test("普通工具的 PreToolUse 不立卡", () => {
    const rec = feed([ev("PreToolUse", { tool_name: "Read", tool_input: { file_path: "/a" } })]);
    expect(rec.state).toBe("working");
    expect(rec.interactivePrompt).toBeNull();
  });
});

describe("撤卡", () => {
  test("background child tools and SubagentStop cannot dismiss the parent's question", () => {
    const waiting = feed([
      ev("SubagentStart", { agent_type: "Explore" }),
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_use_id: "parent-question", tool_input: { questions: [] } }),
    ]);
    const after = feed([
      ev("PreToolUse", { tool_name: "Read", tool_use_id: "child-read" }),
      ev("PostToolUse", { tool_name: "Read", tool_use_id: "child-read" }),
      ev("PostToolUseFailure", { tool_name: "AskUserQuestion", tool_use_id: "other-question" }),
      ev("SubagentStop", { agent_type: "Explore" }),
    ], waiting);
    expect(after.state).toBe("waiting");
    expect(after.interactivePrompt).toEqual(waiting.interactivePrompt);
    expect(after.stashed).toBeNull();
    const closed = feed([ev("PostToolUse", { tool_name: "AskUserQuestion", tool_use_id: "parent-question" })], after);
    expect(closed.interactivePrompt).toBeNull();
    expect(closed.state).toBe("working");
  });

  test("unrelated completion preserves an approval card", () => {
    const waiting = feed([ev("PermissionRequest", { tool_name: "Bash", tool_use_id: "approval" })]);
    const after = feed([ev("PostToolUse", { tool_name: "Read" })], waiting);
    expect(after.interactivePrompt).toEqual(waiting.interactivePrompt);
    expect(after.state).toBe("waiting");
    expect(feed([ev("PostToolUseFailure", { tool_name: "Bash", tool_use_id: "approval" })], after).interactivePrompt).toBeNull();
  });
  for (const dismiss of ["PostToolUse", "PostToolUseFailure", "UserPromptSubmit"]) {
    test(`${dismiss} 到来即撤卡`, () => {
      const rec = feed([
        ev("SessionStart"),
        ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [] } }),
        ev(dismiss, { tool_name: "AskUserQuestion" }),
      ]);
      expect(rec.interactivePrompt).toBeNull();
      expect(rec.state).toBe("working");
    });
  }

  test("Stop 也把卡清掉", () => {
    const rec = feed([
      ev("PermissionRequest", { tool_name: "Bash" }),
      ev("Stop", { last_assistant_message: "done" }),
    ]);
    expect(rec.interactivePrompt).toBeNull();
    expect(rec.state).toBe("done");
  });
});

describe("Stop 的 lastAssistantMessage", () => {
  test("payload 直接给了就用它，不去读文件", () => {
    const rec = applyHookEvent(null, ev("Stop", { last_assistant_message: "写好了" }), {
      tailScan: () => {
        throw new Error("不该走尾扫");
      },
    })!;
    expect(rec.lastAssistantMessage).toBe("写好了");
    expect(rec.state).toBe("done");
  });

  test("没给就按 transcript_path 尾扫", () => {
    const rec = applyHookEvent(null, ev("Stop", { transcript_path: "/t.jsonl" }), {
      tailScan: (p) => (p === "/t.jsonl" ? "从 transcript 捞的" : null),
    })!;
    expect(rec.lastAssistantMessage).toBe("从 transcript 捞的");
  });

  test("StopFailure 同样归 done", () => {
    const rec = feed([ev("StopFailure")]);
    expect(rec.state).toBe("done");
  });
});

describe("子 agent 名单与父状态 stash/restore", () => {
  test("子 agent 的 waiting 顶掉父状态，SubagentStop 后复位", () => {
    const working = feed([
      ev("SessionStart"),
      ev("PreToolUse", { tool_name: "Bash", tool_input: { command: "ls" } }),
    ]);
    expect(working.state).toBe("working");

    const started = applyHookEvent(working, ev("SubagentStart", { agent_type: "Explore" }))!;
    expect(started.subagents).toEqual(["Explore"]);
    expect(started.state).toBe("working");

    const waiting = applyHookEvent(
      started,
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: { questions: [1] }, agent_id: "child" }),
    )!;
    expect(waiting.state).toBe("waiting");
    expect(waiting.stashed).toEqual({
      state: "working",
      toolName: "Bash",
      toolInput: { command: "ls" },
      interactivePrompt: null,
    });

    const stopped = applyHookEvent(waiting, ev("SubagentStop", { agent_type: "Explore" }))!;
    expect(stopped.subagents).toEqual([]);
    expect(stopped.state).toBe("working");
    expect(stopped.toolName).toBe("Bash");
    expect(stopped.interactivePrompt).toBeNull();
    expect(stopped.stashed).toBeNull();
  });

  test("多个子 agent：最后一个退出才复位", () => {
    let rec = feed([ev("SessionStart")]);
    rec = applyHookEvent(rec, ev("SubagentStart", { agent_type: "a" }))!;
    rec = applyHookEvent(rec, ev("SubagentStart", { agent_type: "b" }))!;
    rec = applyHookEvent(
      rec,
      ev("PermissionRequest", { tool_name: "Bash", summary: "跑测试", agent_id: "child" }),
    )!;
    expect(rec.state).toBe("waiting");
    rec = applyHookEvent(rec, ev("SubagentStop", { agent_type: "a" }))!;
    expect(rec.subagents).toEqual(["b"]);
    expect(rec.state).toBe("waiting"); // 还有子 agent 在跑，不复位
    rec = applyHookEvent(rec, ev("SubagentStop", { agent_type: "b" }))!;
    expect(rec.subagents).toEqual([]);
    expect(rec.state).toBe("working");
  });

  test("期间已经正常撤过卡的，SubagentStop 不把状态拨回去", () => {
    let rec = feed([ev("SessionStart")]);
    rec = applyHookEvent(rec, ev("SubagentStart", { agent_type: "a" }))!;
    rec = applyHookEvent(
      rec,
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: {} }),
    )!;
    rec = applyHookEvent(rec, ev("PostToolUse", { tool_name: "AskUserQuestion" }))!;
    rec = applyHookEvent(rec, ev("Stop", { last_assistant_message: "收工" }), {
      tailScan: () => null,
    })!;
    expect(rec.state).toBe("done");
    rec = applyHookEvent(rec, ev("SubagentStop", { agent_type: "a" }))!;
    expect(rec.state).toBe("done");
    expect(rec.stashed).toBeNull();
  });

  test("没有子 agent 在跑时不 stash（父自己弹的卡，撤了就完了）", () => {
    const rec = feed([
      ev("SessionStart"),
      ev("PreToolUse", { tool_name: "AskUserQuestion", tool_input: {} }),
    ]);
    expect(rec.state).toBe("waiting");
    expect(rec.stashed).toBeNull();
  });
});

describe("transcript 尾扫", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "trellis-hook-transcript-"));

  function write(name: string, lines: string[]): string {
    const p = path.join(dir, name);
    writeFileSync(p, lines.join("\n") + "\n");
    return p;
  }

  test("取最后一条 assistant 文本（结构化 content 块）", () => {
    const p = write("a.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "第一条" }] } }),
      JSON.stringify({ type: "user", message: { role: "user", content: "问题" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "最后一条" }] } }),
    ]);
    expect(readLastAssistantMessage(p)).toBe("最后一条");
  });

  test("a trailing sidechain answer cannot replace the parent session's last answer", () => {
    const p = write("sidechain.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "parent answer" } }),
      JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "child answer" } }),
    ]);
    expect(readLastAssistantMessage(p)).toBe("parent answer");
    const onlyChild = write("only-child.jsonl", [JSON.stringify({ type: "assistant", isSidechain: true, message: { role: "assistant", content: "child answer" } })]);
    expect(readLastAssistantMessage(onlyChild)).toBeNull();
  });

  test("content 是纯字符串的形态也认", () => {
    const p = write("b.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: "纯串" } }),
    ]);
    expect(readLastAssistantMessage(p)).toBe("纯串");
  });

  test("只有 tool_use 块（无文本）的 assistant 行跳过，继续往前找", () => {
    const p = write("c.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "有文本的" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] } }),
    ]);
    expect(readLastAssistantMessage(p)).toBe("有文本的");
  });

  test("跨块：目标在 64KB 分块边界之前也能捞到", () => {
    const filler = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(2000) },
    });
    const p = write("d.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "深处的回答" }] } }),
      ...Array.from({ length: 40 }, () => filler), // ~80KB 垫料，跨过一个 chunk
    ]);
    expect(readLastAssistantMessage(p)).toBe("深处的回答");
  });

  test("超出 256KB 上限就放弃（返回 null，不是读整个文件）", () => {
    const filler = JSON.stringify({
      type: "user",
      message: { role: "user", content: "x".repeat(4000) },
    });
    const p = write("e.jsonl", [
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "太远了" }] } }),
      ...Array.from({ length: 80 }, () => filler), // ~320KB
    ]);
    expect(readLastAssistantMessage(p)).toBeNull();
  });

  test("坏行 / 文件不存在都不炸", () => {
    const p = write("f.jsonl", ["{ 不是 json", "", "still not json"]);
    expect(readLastAssistantMessage(p)).toBeNull();
    expect(readLastAssistantMessage(path.join(dir, "nope.jsonl"))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});
