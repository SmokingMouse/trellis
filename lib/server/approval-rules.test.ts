import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// 审批三档作用域：规则存储（approval_rules）+ legacy run-bus 的「发起审批前先匹配
// 规则、命中自动放行并在 ToolCall 上留痕」。走真实 sqlite / repo / run-bus 路径，
// provider 用一个按脚本吐事件、调 onCanUseTool 的 factory 代替。

mock.module("server-only", () => ({}));
const dir = mkdtempSync(path.join(tmpdir(), "trellis-approval-rules-"));
const previous = process.env.TRELLIS_DB_PATH;
process.env.TRELLIS_DB_PATH = path.join(dir, "data.db");
const sqlite = await import("./sqlite");
sqlite.resetDBForTests();

const { createSessionWithRoot, getNode } = await import("./repo");
const rules = await import("./approval-rules");
const { startRun, subscribe, resolveInteraction } = await import("./run-bus");
import type { RunContext, RunEvent, CatchupEvent } from "./run-bus";

afterAll(() => {
  sqlite.resetDBForTests();
  if (previous === undefined) delete process.env.TRELLIS_DB_PATH;
  else process.env.TRELLIS_DB_PATH = previous;
  rmSync(dir, { recursive: true, force: true });
});

function seed(id: string, requireApproval = true) {
  createSessionWithRoot({ sessionId: id, nodeId: `${id}-root`, title: id, question: "q", now: Date.now(), requireApproval });
  return `${id}-root`;
}

describe("approval_rules 存储", () => {
  test("会话规则只对本会话生效，全局对所有会话生效；会话优先", () => {
    seed("store-a");
    seed("store-b");
    const s = rules.grantApprovalRule({ scope: "session", sessionId: "store-a", interaction: { toolName: "Bash" } });
    expect(s?.scope).toBe("session");
    expect(rules.findApprovalRule("store-a", { toolName: "Bash" })?.rule.id).toBe(s!.id);
    expect(rules.findApprovalRule("store-b", { toolName: "Bash" })).toBeNull();

    const g = rules.grantApprovalRule({ scope: "global", sessionId: "store-a", interaction: { toolName: "Bash" } });
    expect(g?.sessionId).toBeNull();
    expect(rules.findApprovalRule("store-b", { toolName: "Bash" })?.rule.id).toBe(g!.id);
    expect(rules.findApprovalRule("store-a", { toolName: "Bash" })?.rule.id).toBe(s!.id);

    // 文件修改类共用一个键
    rules.grantApprovalRule({ scope: "session", sessionId: "store-b", interaction: { toolName: "Write" } });
    expect(rules.findApprovalRule("store-b", { toolName: "MultiEdit" })?.approval.toolKey).toBe("Edit");
    // 全局 Bash 规则会污染后面的 run-bus 用例
    rules.revokeApprovalRule(g!.id);
  });

  test("重复授权幂等；once 与问答类不落库", () => {
    seed("store-c");
    const a = rules.grantApprovalRule({ scope: "session", sessionId: "store-c", interaction: { toolName: "Read" } });
    const b = rules.grantApprovalRule({ scope: "session", sessionId: "store-c", interaction: { toolName: "Read" } });
    expect(a!.id).toBe(b!.id);
    expect(rules.grantApprovalRule({ scope: "once", sessionId: "store-c", interaction: { toolName: "Glob" } })).toBeNull();
    expect(rules.grantApprovalRule({ scope: "global", sessionId: "store-c", interaction: { toolName: "AskUserQuestion" } })).toBeNull();
    expect(rules.listApprovalRules().filter((r) => r.sessionId === "store-c")).toHaveLength(1);
  });

  test("命中记使用次数；撤销立即生效；会话删除级联清掉会话规则", async () => {
    seed("store-d");
    const r = rules.grantApprovalRule({ scope: "session", sessionId: "store-d", interaction: { toolName: "WebFetch" } })!;
    rules.findApprovalRule("store-d", { toolName: "WebFetch" }, 1234);
    const listed = rules.listApprovalRules().find((x) => x.id === r.id)!;
    expect(listed.useCount).toBe(1);
    expect(listed.lastUsedAt).toBe(1234);
    expect(listed.sessionTitle).toBe("store-d");

    expect(rules.revokeApprovalRule(r.id)).toBe(true);
    expect(rules.revokeApprovalRule(r.id)).toBe(false);
    expect(rules.findApprovalRule("store-d", { toolName: "WebFetch" })).toBeNull();

    const again = rules.grantApprovalRule({ scope: "session", sessionId: "store-d", interaction: { toolName: "WebFetch" } })!;
    const { deleteSession } = await import("./repo");
    deleteSession("store-d");
    expect(rules.listApprovalRules().some((x) => x.id === again.id)).toBe(false);
  });
});

// ── run-bus 集成 ───────────────────────────────────────────────────────────

type Step =
  | { kind: "start"; id: string; name?: string }
  | { kind: "ask"; id: string; name?: string };

/**
 * 按脚本跑一次 run：start = 吐 tool_call_start；ask = 调 onCanUseTool 并等结果。
 * 遇到 interaction_required 时交给 answer 决定怎么回。返回广播事件与每次 ask 的决定。
 */
async function runScript(
  nodeId: string,
  steps: Step[],
  answer: (toolUseId: string) => { behavior: "allow" | "deny"; scope?: "once" | "session" | "global" },
) {
  const seen: (RunEvent | CatchupEvent)[] = [];
  const decisions: Record<string, string> = {};
  await new Promise<void>((resolve) => {
    startRun({
      nodeId,
      resumeFamily: "mock",
      interactive: true,
      requireApproval: true,
      factory: async function* (_signal: AbortSignal, ctx: RunContext) {
        for (const step of steps) {
          const name = step.name ?? "Bash";
          if (step.kind === "start") {
            yield { type: "tool_call_start", id: step.id, name, input: { command: `echo ${step.id}` }, startedAt: Date.now() };
          } else {
            const d = await ctx.onCanUseTool!({ toolName: name, toolUseId: step.id, requestId: step.id, input: { command: `echo ${step.id}` } });
            decisions[step.id] = d.behavior;
          }
        }
        yield { type: "done", usage: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 } };
      },
    });
    subscribe(nodeId, {
      onEvent: (e) => {
        seen.push(e);
        if (e.type === "interaction_required") {
          const a = answer(e.toolUseId);
          queueMicrotask(() =>
            resolveInteraction(nodeId, e.toolUseId, { behavior: a.behavior, updatedInput: {} }, { scope: a.scope }),
          );
        }
      },
      onClose: () => resolve(),
    });
  });
  await Bun.sleep(30);
  return { seen, decisions };
}

describe("run-bus：发起审批前先匹配规则", () => {
  test("选「本会话」后，同会话同工具不再弹卡并留痕；两种到达顺序都挂得上", async () => {
    const nodeId = seed("bus-a");
    const { seen, decisions } = await runScript(
      nodeId,
      [
        { kind: "start", id: "t1" },
        { kind: "ask", id: "t1" },
        { kind: "start", id: "t2" }, // 先 tool_use 后 can_use_tool（claude 常态）
        { kind: "ask", id: "t2" },
        { kind: "ask", id: "t3" }, // 先审批后 tool_use（痕迹暂存，落库时补）
        { kind: "start", id: "t3" },
      ],
      () => ({ behavior: "allow", scope: "session" }),
    );
    expect(decisions).toEqual({ t1: "allow", t2: "allow", t3: "allow" });
    const prompted = seen.filter((e) => e.type === "interaction_required").map((e) => (e as { toolUseId: string }).toolUseId);
    expect(prompted).toEqual(["t1"]);
    const marked = seen.filter((e) => e.type === "tool_call_approval").map((e) => (e as { id: string }).id);
    expect(marked.sort()).toEqual(["t2", "t3"]);

    const calls = getNode(nodeId)!.toolCalls;
    expect(calls.find((c) => c.id === "t1")?.approval).toBeUndefined();
    expect(calls.find((c) => c.id === "t2")?.approval).toMatchObject({ by: "rule", scope: "session", toolKey: "Bash" });
    expect(calls.find((c) => c.id === "t3")?.approval?.scope).toBe("session");
  });

  test("别的会话不受本会话规则影响；拒绝 / 仅本次不落规则", async () => {
    const nodeId = seed("bus-b");
    const { seen } = await runScript(
      nodeId,
      [
        { kind: "ask", id: "u1" },
        { kind: "ask", id: "u2" },
        { kind: "ask", id: "u3" },
      ],
      (id) => (id === "u1" ? { behavior: "deny", scope: "global" } : { behavior: "allow", scope: "once" }),
    );
    // bus-a 的会话规则不覆盖 bus-b；deny+global 与 once 都不建规则 → 三次都弹卡
    expect(seen.filter((e) => e.type === "interaction_required")).toHaveLength(3);
    expect(rules.findApprovalRule("bus-b", { toolName: "Bash" })).toBeNull();
  });

  test("全局规则跨会话生效；问答类工具无视规则照常暂停", async () => {
    rules.grantApprovalRule({ scope: "global", sessionId: "bus-a", interaction: { toolName: "mcp__x__y" } });
    const nodeId = seed("bus-c");
    const { seen, decisions } = await runScript(
      nodeId,
      [
        { kind: "ask", id: "v1", name: "mcp__x__y" },
        { kind: "ask", id: "v2", name: "AskUserQuestion" },
      ],
      () => ({ behavior: "allow", scope: "global" }),
    );
    expect(decisions).toEqual({ v1: "allow", v2: "allow" });
    const prompted = seen.filter((e) => e.type === "interaction_required").map((e) => (e as { toolUseId: string }).toolUseId);
    expect(prompted).toEqual(["v2"]);
  });
});
