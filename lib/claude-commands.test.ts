import { describe, expect, test } from "bun:test";
import {
  CLAUDE_BUILTIN_COMMANDS,
  matchClaudeCommands,
  mergeClaudeCommands,
  type ClaudeSlashCommand,
} from "./claude-commands";

const skill = (name: string): ClaudeSlashCommand => ({ name, description: `${name} skill`, kind: "skill" });

describe("Claude 斜杠命令", () => {
  test("内置常量表含常用命令", () => {
    const names = CLAUDE_BUILTIN_COMMANDS.map((c) => c.name);
    for (const name of ["compact", "clear", "model", "cost", "context", "review", "init"]) {
      expect(names).toContain(name);
    }
  });

  test("合并：内置在前，同名以内置为准，去重", () => {
    const merged = mergeClaudeCommands([skill("deepdive"), skill("clear"), skill("deepdive")]);
    expect(merged.filter((c) => c.name === "clear")).toEqual([
      CLAUDE_BUILTIN_COMMANDS.find((c) => c.name === "clear")!,
    ]);
    expect(merged.filter((c) => c.name === "deepdive")).toHaveLength(1);
    expect(merged.at(-1)?.name).toBe("deepdive");
  });

  test("匹配：只认开头的 / 且未打空格；前缀命中排在包含命中之前", () => {
    const list = mergeClaudeCommands([skill("xcompact-helper"), skill("co-review")]);
    expect(matchClaudeCommands("hello /c", list)).toEqual([]);
    expect(matchClaudeCommands("/compact now", list)).toEqual([]);
    const names = matchClaudeCommands("/co", list, 20).map((c) => c.name);
    expect(names.slice(0, 5)).toEqual(["compact", "cost", "context", "config", "co-review"]);
    expect(names).toContain("xcompact-helper");
    expect(names.indexOf("xcompact-helper")).toBeGreaterThan(names.indexOf("co-review"));
  });

  test("只输入 / 时列出全部（受 limit 限制）", () => {
    expect(matchClaudeCommands("/", CLAUDE_BUILTIN_COMMANDS, 5)).toHaveLength(5);
  });
});
