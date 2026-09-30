import { afterAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

mock.module("server-only", () => ({}));
const { listClaudeCommands, scanCommandRoot } = await import("./claude-commands");

const root = mkdtempSync(path.join(tmpdir(), "trellis-claude-commands-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

function write(file: string, body: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const home = path.join(root, "home");
const repo = path.join(root, "repo");
write(path.join(home, ".claude/skills/deepdive/SKILL.md"), "---\nname: deepdive\ndescription: 深度调研\n---\nbody");
write(path.join(home, ".claude/skills/shared/SKILL.md"), "---\nname: shared\ndescription: 用户级\n---\n");
write(path.join(home, ".claude/commands/ship.md"), "---\ndescription: 发布\n---\n# ignored");
write(path.join(home, ".claude/commands/notes.md"), "# 记笔记\n正文");
write(path.join(home, ".claude/commands/git/sync.md"), "同步远端");
write(path.join(home, ".claude/commands/.hidden.md"), "no");
mkdirSync(path.join(repo, ".git"), { recursive: true });
write(path.join(repo, ".claude/commands/test-all.md"), "---\ndescription: 跑全部测试\n---\n");
write(path.join(repo, ".claude/skills/shared/SKILL.md"), "---\nname: shared\ndescription: 项目级\n---\n");
mkdirSync(path.join(repo, "packages/app"), { recursive: true });

describe("Claude 用户 / 项目命令发现", () => {
  test("commands 目录：frontmatter 描述 > 首行；子目录成命名空间；隐藏文件跳过", () => {
    const list = scanCommandRoot(path.join(home, ".claude/commands"));
    const byName = Object.fromEntries(list.map((c) => [c.name, c.description]));
    expect(byName).toEqual({ ship: "发布", notes: "记笔记", "git:sync": "同步远端" });
    expect(list.every((c) => c.kind === "command")).toBeTrue();
  });

  test("用户级 skills + commands；项目级从子目录往上找到 git 根，同名项目级赢", () => {
    const list = listClaudeCommands(path.join(repo, "packages/app"), home);
    const byName = new Map(list.map((c) => [c.name, c]));
    expect(byName.get("deepdive")).toEqual({ name: "deepdive", description: "深度调研", kind: "skill" });
    expect(byName.get("shared")?.description).toBe("项目级");
    expect(byName.get("test-all")?.kind).toBe("command");
    expect(byName.has("git:sync")).toBeTrue();
    expect(list.map((c) => c.name)).toEqual([...list.map((c) => c.name)].sort((a, b) => a.localeCompare(b)));
  });

  test("workspace 缺失 / 相对路径 → 只有用户级", () => {
    expect(listClaudeCommands(null, home).find((c) => c.name === "shared")?.description).toBe("用户级");
    expect(listClaudeCommands("relative/path", home).some((c) => c.name === "test-all")).toBeFalse();
  });
});
