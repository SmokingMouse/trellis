import { describe, expect, test } from "bun:test";
import { modeToRunOptions } from "./sdk-adapter";
import type { AgentSpawn, StreamRequest } from "./types";

// 角色 P1：AgentSpawn.addDirs / appendSystemPrompt → RunOptions 的翻译。

const claudeRole: AgentSpawn = {
  runtime: "claude",
  slug: "mem-role",
  agentsJson: JSON.stringify({ "mem-role": { description: "d", prompt: "你是角色" } }),
  inheritEnv: true,
  addDirs: ["/roles/mem-role"],
  appendSystemPrompt: "MEMORY PROMPT",
};

function req(agent: AgentSpawn | null, extra: Partial<StreamRequest> = {}): StreamRequest {
  return { history: [], question: "q", cwd: "/work", agent, ...extra };
}

describe("applyAgent 角色记忆翻译", () => {
  test("claude：addDirs → additionalWorkspaces，appendSystemPrompt → extraArgs，人设仍走 --agent", () => {
    const o = modeToRunOptions("project", "m", req(claudeRole));
    expect(o.workspace).toBe("/work");
    expect(o.additionalWorkspaces).toEqual(["/roles/mem-role"]);
    expect(o.extraArgs).toEqual(["--append-system-prompt", "MEMORY PROMPT"]);
    expect(o.agent).toBe("mem-role");
    expect(o.systemPrompt).toBeUndefined();
  });

  test("claude：与已有 extraArgs 合并而不覆盖", () => {
    const o = modeToRunOptions("project", "m", req(claudeRole, { extraArgs: ["--max-budget-usd", "1"] }));
    expect(o.extraArgs).toEqual(["--max-budget-usd", "1", "--append-system-prompt", "MEMORY PROMPT"]);
  });

  test("没有角色字段：不出现 additionalWorkspaces / extraArgs", () => {
    const plain: AgentSpawn = { ...claudeRole, addDirs: undefined, appendSystemPrompt: undefined };
    const o = modeToRunOptions("project", "m", req(plain));
    expect(o.additionalWorkspaces).toBeUndefined();
    expect(o.extraArgs).toBeUndefined();
  });

  test("codex：记忆说明接在人设后，目录挂 additionalWorkspaces", () => {
    const codex: AgentSpawn = {
      runtime: "codex",
      slug: "mem-role",
      inheritEnv: true,
      systemPrompt: "你是角色",
      addDirs: ["/roles/mem-role"],
      appendSystemPrompt: "MEMORY PROMPT",
    };
    const o = modeToRunOptions("project", "m", req(codex));
    expect(o.systemPrompt).toBe("你是角色\n\n---\n\nMEMORY PROMPT");
    expect(o.additionalWorkspaces).toEqual(["/roles/mem-role"]);
    expect(o.extraArgs).toBeUndefined();
  });
});
