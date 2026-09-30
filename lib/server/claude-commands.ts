import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudeSlashCommand } from "@/lib/claude-commands";
import { parseFrontmatter, scanSkillRoot } from "./skills";

// Herdr 窗格里 Claude Code 能识别的用户级 / 项目级斜杠命令：
//   技能：~/.claude/skills/*/SKILL.md、<项目>/.claude/skills/*/SKILL.md
//   命令：~/.claude/commands/*.md、<项目>/.claude/commands/*.md（子目录 = 命名空间 `dir:name`）
// 近的赢：项目级同名覆盖用户级。结果按 (home, workspace) 缓存 30 秒 —— 补全面板每次
// 打开都会请求，目录扫描不值得每次都做。

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function firstLine(raw: string): string {
  const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
  const line = body.split(/\r?\n/).map((l) => l.replace(/^#+\s*/, "").trim()).find(Boolean) ?? "";
  return line.length > 120 ? `${line.slice(0, 120)}…` : line;
}

function readCommandFile(file: string, name: string): ClaudeSlashCommand | null {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const { description } = parseFrontmatter(raw, name);
  return { name, description: description || firstLine(raw), kind: "command" };
}

/** 扫一个 commands 目录：顶层 *.md → name；一层子目录 dir/*.md → `dir:name`。 */
export function scanCommandRoot(root: string): ClaudeSlashCommand[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: ClaudeSlashCommand[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.name.startsWith(".")) continue;
    if (entry.name.endsWith(".md") && !isDirectory(entryPath)) {
      const command = readCommandFile(entryPath, entry.name.slice(0, -3));
      if (command) out.push(command);
      continue;
    }
    if (!isDirectory(entryPath)) continue;
    let nested: fs.Dirent[];
    try {
      nested = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      if (!child.name.endsWith(".md")) continue;
      const command = readCommandFile(path.join(entryPath, child.name), `${entry.name}:${child.name.slice(0, -3)}`);
      if (command) out.push(command);
    }
  }
  return out;
}

function skillsAt(root: string): ClaudeSlashCommand[] {
  return scanSkillRoot(root).map((skill) => ({ name: skill.name, description: skill.description, kind: "skill" as const }));
}

/** 项目根：从 workspace 往上找第一个带 .git 的目录；找不到就用 workspace 本身。 */
function projectRoot(workspace: string): string {
  let current = path.resolve(workspace);
  while (true) {
    if (fs.existsSync(path.join(current, ".git"))) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(workspace);
    current = parent;
  }
}

export function listClaudeCommands(
  workspace?: string | null,
  home: string = os.homedir(),
): ClaudeSlashCommand[] {
  const userClaude = path.join(home, ".claude");
  const groups: ClaudeSlashCommand[][] = [];
  if (workspace && path.isAbsolute(workspace) && isDirectory(workspace)) {
    const project = path.join(projectRoot(workspace), ".claude");
    if (project !== userClaude) {
      groups.push(skillsAt(path.join(project, "skills")), scanCommandRoot(path.join(project, "commands")));
    }
  }
  groups.push(skillsAt(path.join(userClaude, "skills")), scanCommandRoot(path.join(userClaude, "commands")));
  const byName = new Map<string, ClaudeSlashCommand>();
  for (const command of groups.flat()) {
    if (!byName.has(command.name)) byName.set(command.name, command);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; commands: ClaudeSlashCommand[] }>();

export function listClaudeCommandsCached(
  workspace?: string | null,
  now = Date.now(),
): ClaudeSlashCommand[] {
  const key = `${os.homedir()}\u0000${workspace ?? ""}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.commands;
  const commands = listClaudeCommands(workspace);
  if (cache.size >= 64) cache.delete(cache.keys().next().value!);
  cache.set(key, { at: now, commands });
  return commands;
}
