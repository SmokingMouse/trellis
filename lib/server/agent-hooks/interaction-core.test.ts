import { describe, expect, test } from "bun:test";
import {
  alwaysPermissions,
  blockingKind,
  canonicalJson,
  hookOutput,
  interactionId,
  summaryFields,
  validateResolution,
} from "./interaction-core";
import type { ClaudeHookPayload } from "./types";

// 真实形状（Claude Code 2.1.280 hooks 文档 + 本机 transcript）：PreToolUse 带 tool_use_id，
// PermissionRequest 不带、可能带 permission_suggestions。
const ASK: ClaudeHookPayload = {
  session_id: "s-1",
  transcript_path: "/tmp/x.jsonl",
  cwd: "/tmp",
  permission_mode: "default",
  hook_event_name: "PreToolUse",
  tool_name: "AskUserQuestion",
  tool_use_id: "toolu_01ASK",
  tool_input: {
    questions: [
      { question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red", description: "" }, { label: "Blue", description: "" }] },
      { question: "Which toppings?", header: "Top", multiSelect: true, options: [{ label: "A" }, { label: "B" }] },
    ],
  },
};
const PLAN: ClaudeHookPayload = {
  session_id: "s-1",
  hook_event_name: "PermissionRequest",
  permission_mode: "plan",
  tool_name: "ExitPlanMode",
  tool_input: { plan: "# 计划\n\n1. 改 A\n2. 测 B", planFilePath: "/tmp/plan.md" },
};
const BASH: ClaudeHookPayload = {
  session_id: "s-1",
  hook_event_name: "PermissionRequest",
  tool_name: "Bash",
  tool_input: { command: "rm -rf build", description: "clean" },
  permission_suggestions: [
    { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "localSettings" },
    { type: "setMode", mode: "acceptEdits", destination: "session" },
  ],
};

describe("确定性交互 id", () => {
  test("同一次调用（同 tool_use_id）不管重连几次都是同一个 id", () => {
    expect(interactionId(ASK)).toBe(interactionId({ ...ASK }));
    expect(interactionId(ASK, "attempt-a")).toBe(interactionId(ASK, "attempt-b")); // 有 tool_use_id 时 attempt 不参与
    expect(interactionId(ASK)).toMatch(/^ix_[0-9a-f]{20}$/);
  });

  test("tool_use_id / 会话 / 事件不同 → id 不同", () => {
    const base = interactionId(ASK);
    expect(interactionId({ ...ASK, tool_use_id: "toolu_other" })).not.toBe(base);
    expect(interactionId({ ...ASK, session_id: "s-2" })).not.toBe(base);
    expect(interactionId({ ...ASK, hook_event_name: "PermissionRequest" })).not.toBe(base);
  });

  test("没有 tool_use_id：按规范化 input（键序无关）+ attempt", () => {
    const reordered: ClaudeHookPayload = { ...BASH, tool_input: { description: "clean", command: "rm -rf build" } };
    expect(interactionId(BASH, "a1")).toBe(interactionId(reordered, "a1"));
    // 同一会话第二次跑一模一样的命令（新的 hook 进程 = 新 attempt）不能撞上上一次
    expect(interactionId(BASH, "a1")).not.toBe(interactionId(BASH, "a2"));
    expect(interactionId({ ...BASH, tool_input: { command: "ls" } }, "a1")).not.toBe(interactionId(BASH, "a1"));
  });

  test("canonicalJson 递归排序、忽略 undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [1, { y: 2, x: 1 }], c: undefined } })).toBe('{"a":{"d":[1,{"x":1,"y":2}]},"b":1}');
  });
});

describe("blockingKind", () => {
  test("只有 PreToolUse(AskUserQuestion) 与 PermissionRequest 阻塞", () => {
    expect(blockingKind(ASK)).toBe("question");
    expect(blockingKind(PLAN)).toBe("plan");
    expect(blockingKind(BASH)).toBe("permission");
    expect(blockingKind({ ...ASK, tool_name: "Bash" })).toBeNull();
    expect(blockingKind({ ...ASK, hook_event_name: "PostToolUse" })).toBeNull();
    expect(blockingKind({ ...ASK, hook_event_name: "PermissionRequest" })).toBeNull(); // 同一次提问不出两张卡
    expect(blockingKind({ ...ASK, tool_input: { questions: [] } })).toBeNull();
    expect(blockingKind({ ...BASH, session_id: "" })).toBeNull();
  });
});

describe("作答校验", () => {
  test("AskUserQuestion：每题都要答，多选数组用 \", \" 连接", () => {
    expect(validateResolution("question", ASK, { type: "answers", answers: { "Which color?": "Blue", "Which toppings?": ["A", "B"] } }))
      .toEqual({ type: "answers", answers: { "Which color?": "Blue", "Which toppings?": "A, B" } });
    expect(validateResolution("question", ASK, { type: "answers", answers: { "Which color?": "Blue" } })).toBeNull();
    expect(validateResolution("question", ASK, { type: "permission", allow: true })).toBeNull();
    // 自由文本也收
    expect(validateResolution("question", ASK, { type: "answers", answers: { "Which color?": " 紫色 ", "Which toppings?": "都不要" } }))
      .toEqual({ type: "answers", answers: { "Which color?": "紫色", "Which toppings?": "都不要" } });
  });

  test("计划：approve 必须带合法 mode；打回带意见", () => {
    expect(validateResolution("plan", PLAN, { type: "plan", approve: true, mode: "acceptEdits" })).toEqual({ type: "plan", approve: true, mode: "acceptEdits" });
    expect(validateResolution("plan", PLAN, { type: "plan", approve: true, mode: "plan" })).toBeNull();
    expect(validateResolution("plan", PLAN, { type: "plan", approve: false, feedback: " 先写测试 " })).toEqual({ type: "plan", approve: false, feedback: "先写测试" });
  });

  test("授权：always 只在支持时保留", () => {
    expect(validateResolution("permission", BASH, { type: "permission", allow: true, always: true })).toEqual({ type: "permission", allow: true, always: true });
    expect(validateResolution("permission", BASH, { type: "permission", allow: false })).toEqual({ type: "permission", allow: false });
    expect(validateResolution("permission", BASH, { type: "permission" })).toBeNull();
  });
});

describe("hook stdout JSON 的形状", () => {
  test("AskUserQuestion：PreToolUse allow + updatedInput 带原 questions 与 answers", () => {
    const out = hookOutput(ASK, { type: "answers", answers: { "Which color?": "Blue", "Which toppings?": "A" } });
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: "已在 Trellis 作答",
        updatedInput: { questions: (ASK.tool_input as { questions: unknown[] }).questions, answers: { "Which color?": "Blue", "Which toppings?": "A" } },
      },
    });
  });

  test("ExitPlanMode 放行：allow + updatedInput（原样）+ setMode（bypass 先垫 auto）", () => {
    expect(hookOutput(PLAN, { type: "plan", approve: true, mode: "bypassPermissions" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: {
          behavior: "allow",
          updatedInput: PLAN.tool_input,
          updatedPermissions: [
            { type: "setMode", mode: "auto", destination: "session" },
            { type: "setMode", mode: "bypassPermissions", destination: "session" },
          ],
        },
      },
    });
    const edits = hookOutput(PLAN, { type: "plan", approve: true, mode: "acceptEdits" }) as { hookSpecificOutput: { decision: { updatedPermissions: unknown[] } } };
    expect(edits.hookSpecificOutput.decision.updatedPermissions).toEqual([{ type: "setMode", mode: "acceptEdits", destination: "session" }]);
  });

  test("ExitPlanMode 打回：deny + message 带意见", () => {
    const out = hookOutput(PLAN, { type: "plan", approve: false, feedback: "先写测试" }) as { hookSpecificOutput: { decision: Record<string, unknown> } };
    expect(out.hookSpecificOutput.decision.behavior).toBe("deny");
    expect(String(out.hookSpecificOutput.decision.message)).toContain("先写测试");
    expect(out.hookSpecificOutput.decision.updatedPermissions).toBeUndefined();
  });

  test("一般授权：allow / always（用 permission_suggestions 的 addRules，落 session）/ deny", () => {
    expect(hookOutput(BASH, { type: "permission", allow: true })).toEqual({
      hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow", updatedInput: BASH.tool_input } },
    });
    const always = hookOutput(BASH, { type: "permission", allow: true, always: true }) as { hookSpecificOutput: { decision: { updatedPermissions: unknown[] } } };
    expect(always.hookSpecificOutput.decision.updatedPermissions).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm -rf build" }], behavior: "allow", destination: "session" },
    ]);
    const deny = hookOutput(BASH, { type: "permission", allow: false, message: "别删" }) as { hookSpecificOutput: { decision: Record<string, unknown> } };
    expect(deny.hookSpecificOutput.decision).toEqual({ behavior: "deny", message: "别删" });
  });

  test("没有 addRules 建议时：Bash 按命令首词放行，其余工具整个放行", () => {
    // 2.1.280 实测普通 Bash 授权的建议只有 addDirectories / setMode
    const plain = { ...BASH, permission_suggestions: [{ type: "addDirectories", directories: ["/tmp"], destination: "session" }, { type: "setMode", mode: "acceptEdits", destination: "session" }] };
    expect(alwaysPermissions(plain)).toEqual([
      { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "rm:*" }], behavior: "allow", destination: "session" },
    ]);
    expect(alwaysPermissions({ session_id: "s", hook_event_name: "PermissionRequest", tool_name: "WebFetch", tool_input: { url: "https://x" } })).toEqual([
      { type: "addRules", rules: [{ toolName: "WebFetch" }], behavior: "allow", destination: "session" },
    ]);
  });

  test("摘要字段：题目 / 计划 / 授权说明", () => {
    expect(summaryFields("question", ASK).questions).toHaveLength(2);
    expect(summaryFields("plan", PLAN)).toEqual({ plan: "# 计划\n\n1. 改 A\n2. 测 B" });
    expect(summaryFields("permission", BASH)).toEqual({ summary: "rm -rf build", canAlways: true });
  });
});
