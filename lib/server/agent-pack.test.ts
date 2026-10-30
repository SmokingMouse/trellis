import { describe, expect, mock, test } from "bun:test";

mock.module("server-only", () => ({}));

const { claudeAgentPrompt, resolveAgentSpawn } = await import("./agent-pack");

const base = {
  id: "a1",
  slug: "role-x",
  name: "写作教练",
  description: "",
  systemPrompt: "",
  model: null,
  tools: null,
  disallowedTools: null,
  skills: [],
  inheritEnv: true,
  permission: null,
  requireApproval: null,
  builtin: false,
  enabled: true,
  sortOrder: 0,
  createdAt: 0,
  updatedAt: 0,
  kind: "role" as const,
  intro: "帮我改文章",
  avatarHue: 0,
  avatarGlyph: "",
  workDir: null,
  memoryEnabled: true,
  homeSessionId: null,
};

describe("claudeAgentPrompt", () => {
  test("人设为空时兜一句自我介绍（--agents 的 prompt 为空串 claude 起不来）", () => {
    expect(claudeAgentPrompt(base)).toBe("你是「写作教练」：帮我改文章。");
    expect(claudeAgentPrompt({ ...base, intro: "", description: "" })).toBe("你是「写作教练」。");
    expect(claudeAgentPrompt({ ...base, systemPrompt: "  \n " })).toBe("你是「写作教练」：帮我改文章。");
  });

  test("有人设就原样用", () => {
    expect(claudeAgentPrompt({ ...base, systemPrompt: "你是冷静的写作教练。" })).toBe("你是冷静的写作教练。");
  });

  test("resolveAgentSpawn 的 --agents JSON 里 prompt 不为空", () => {
    const spawn = resolveAgentSpawn(base, "claude", null);
    const def = JSON.parse(spawn.agentsJson!)["role-x"] as { prompt: string };
    expect(def.prompt).toBe("你是「写作教练」：帮我改文章。");
  });
});
