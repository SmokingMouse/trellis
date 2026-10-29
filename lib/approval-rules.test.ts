import { describe, expect, test } from "bun:test";
import {
  allowLabel,
  approvalToolKey,
  describeToolKey,
  matchApprovalRule,
  parseApprovalScope,
  type ApprovalRule,
} from "./approval-rules";

const rule = (over: Partial<ApprovalRule>): ApprovalRule => ({
  id: "r",
  scope: "global",
  sessionId: null,
  toolKey: "Bash",
  createdAt: 1,
  lastUsedAt: null,
  useCount: 0,
  ...over,
});

describe("parseApprovalScope", () => {
  test("显式 scope 优先", () => {
    expect(parseApprovalScope({ scope: "once" })).toBe("once");
    expect(parseApprovalScope({ scope: "session" })).toBe("session");
    expect(parseApprovalScope({ scope: "global", alwaysAllowTool: false })).toBe("global");
  });
  test("旧客户端 alwaysAllowTool:true → 本会话", () => {
    expect(parseApprovalScope({ alwaysAllowTool: true })).toBe("session");
  });
  test("缺省 / 非法值 → 仅本次（最保守）", () => {
    expect(parseApprovalScope({})).toBe("once");
    expect(parseApprovalScope({ scope: "forever" })).toBe("once");
    expect(parseApprovalScope({ scope: 1, alwaysAllowTool: "true" })).toBe("once");
  });
});

describe("approvalToolKey", () => {
  test("普通工具按工具名", () => {
    expect(approvalToolKey({ toolName: "Bash", input: { command: "ls" } })).toBe("Bash");
    expect(approvalToolKey({ toolName: "mcp__lark__send" })).toBe("mcp__lark__send");
  });
  test("文件修改类统一折成 Edit（与 agent-server fileChange 投影一致）", () => {
    for (const name of ["Write", "Edit", "MultiEdit", "NotebookEdit"]) {
      expect(approvalToolKey({ toolName: name })).toBe("Edit");
    }
  });
  test("agent-server 通用权限请求取 permissions.toolName", () => {
    expect(approvalToolKey({ toolName: "Permission", input: { permissions: { toolName: "mcp__x__y", input: {} } } })).toBe("mcp__x__y");
    expect(approvalToolKey({ toolName: "Permission", input: { permissions: { toolName: "Write" } } })).toBe("Edit");
    expect(approvalToolKey({ toolName: "Permission", input: { permissions: {} } })).toBe("Permission");
    expect(approvalToolKey({ toolName: "Permission", input: null })).toBe("Permission");
  });
  test("问答 / 计划审批永远不建规则", () => {
    expect(approvalToolKey({ toolName: "AskUserQuestion" })).toBeNull();
    expect(approvalToolKey({ toolName: "ExitPlanMode" })).toBeNull();
    expect(approvalToolKey({ toolName: "" })).toBeNull();
  });
});

describe("matchApprovalRule", () => {
  const rules = [
    rule({ id: "g-bash", scope: "global", toolKey: "Bash" }),
    rule({ id: "s1-bash", scope: "session", sessionId: "s1", toolKey: "Bash" }),
    rule({ id: "s2-edit", scope: "session", sessionId: "s2", toolKey: "Edit" }),
  ];
  test("会话规则优先于全局", () => {
    expect(matchApprovalRule(rules, { sessionId: "s1", toolKey: "Bash" })?.id).toBe("s1-bash");
  });
  test("没有会话规则时落到全局", () => {
    expect(matchApprovalRule(rules, { sessionId: "s9", toolKey: "Bash" })?.id).toBe("g-bash");
  });
  test("别的会话的会话规则不命中", () => {
    expect(matchApprovalRule(rules, { sessionId: "s1", toolKey: "Edit" })).toBeNull();
    expect(matchApprovalRule(rules, { sessionId: "s2", toolKey: "Edit" })?.id).toBe("s2-edit");
  });
  test("键为 null（不可建规则的交互）永不命中", () => {
    expect(matchApprovalRule(rules, { sessionId: "s1", toolKey: null })).toBeNull();
  });
});

test("文案：主按钮随作用域、规则文本说清放行范围", () => {
  expect(allowLabel("once")).toBe("允许一次");
  expect(allowLabel("session")).toBe("本会话始终允许");
  expect(allowLabel("global")).toBe("所有会话始终允许");
  expect(describeToolKey("Bash")).toContain("任意 shell 命令");
  expect(describeToolKey("Edit")).toContain("Write");
  expect(describeToolKey("mcp__lark__send")).toBe("MCP lark · send");
});
