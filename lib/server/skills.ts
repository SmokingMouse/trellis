import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { deployPaths } from "@/lib/deploy-state";
import { CODEX_HOME_DIR } from "./codex-paths";

export type SkillProvider = "claude" | "codex";

export type DiscoveredSkill = {
  /** Frontmatter display/invocation name. */
  name: string;
  /** Directory name. Agent definitions persist this for Claude plugin packs. */
  dir: string;
  description: string;
  path: string;
};

function parseFrontmatter(
  raw: string,
  fallbackName: string,
): { name: string; description: string } {
  let name = fallbackName;
  let description = "";
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(raw);
  if (match) {
    const frontmatter = match[1];
    const parsedName = /^name:\s*(.+)$/m.exec(frontmatter);
    const parsedDescription = /^description:\s*(.+)$/m.exec(frontmatter);
    if (parsedName) name = parsedName[1].trim().replace(/^['"]|['"]$/g, "");
    if (parsedDescription) {
      description = parsedDescription[1].trim().replace(/^['"]|['"]$/g, "");
    }
  }
  if (description.length > 120) description = `${description.slice(0, 120)}…`;
  return { name, description };
}

function isDirectory(entryPath: string): boolean {
  try {
    return fs.statSync(entryPath).isDirectory();
  } catch {
    return false;
  }
}

function readSkill(skillDir: string): DiscoveredSkill | null {
  try {
    const raw = fs.readFileSync(path.join(skillDir, "SKILL.md"), "utf8");
    return {
      ...parseFrontmatter(raw, path.basename(skillDir)),
      dir: path.basename(skillDir),
      path: skillDir,
    };
  } catch {
    return null;
  }
}

/** Read direct skills plus one grouping layer such as `$CODEX_HOME/skills/.system`. */
function scanSkillRoot(root: string): DiscoveredSkill[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const skills: DiscoveredSkill[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (!isDirectory(entryPath)) continue;
    const skill = readSkill(entryPath);
    if (skill) {
      skills.push(skill);
      continue;
    }
    if (!entry.name.startsWith(".")) continue;
    let nested: fs.Dirent[];
    try {
      nested = fs.readdirSync(entryPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of nested) {
      const childPath = path.join(entryPath, child.name);
      if (!isDirectory(childPath)) continue;
      const nestedSkill = readSkill(childPath);
      if (nestedSkill) skills.push(nestedSkill);
    }
  }
  return skills;
}

function projectSkillRoots(workspace?: string | null): string[] {
  if (!workspace || !path.isAbsolute(workspace) || !isDirectory(workspace)) return [];
  const roots: string[] = [];
  let current = path.resolve(workspace);
  while (true) {
    roots.push(path.join(current, ".agents", "skills"));
    if (fs.existsSync(path.join(current, ".git"))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return roots;
}

/** trellis 自带技能根（`<app>/skills`，随部署走）。
 *
 * prod 的 cwd 是具体 release 目录（`<root>/releases/<ts>-<sha>`，会被清理），
 * 必须经 `current` 软链取 —— agent-pack 里指向这里的 symlink 才不会随 release
 * 清理悬空，且升级后自动跟到新版。dev checkout 直接用 cwd 下的 skills/。
 * 部署根统一走 deployPaths()，TRELLIS_DEPLOY_ROOT 挪走时这里要跟着挪。 */
export function builtinSkillsRoot(): string {
  const p = deployPaths();
  return process.cwd().startsWith(p.releases + path.sep)
    ? path.join(p.current, "skills")
    : path.join(process.cwd(), "skills");
}

/** claude 侧技能搜索根。顺序即优先级：用户目录赢，内置兜底 —— 同名时用户
 * 自己的版本覆盖 trellis 自带的（listSkills 的 byName 去重是先到先得）。 */
export function claudeSkillRoots(): string[] {
  return [path.join(os.homedir(), ".claude", "skills"), builtinSkillsRoot()];
}

export function listSkills(
  provider: SkillProvider,
  workspace?: string | null,
): DiscoveredSkill[] {
  const roots =
    provider === "claude"
      ? claudeSkillRoots()
      : [
          ...projectSkillRoots(workspace),
          path.join(os.homedir(), ".agents", "skills"),
          // Current Codex distributions keep bundled/system skills here.
          path.join(CODEX_HOME_DIR, "skills"),
          path.join(path.sep, "etc", "codex", "skills"),
        ];

  // Nearer project scopes win over user/admin scopes. The picker needs one
  // stable row per invocation name even when Codex sees the same skill twice.
  const byName = new Map<string, DiscoveredSkill>();
  for (const root of roots) {
    for (const skill of scanSkillRoot(root)) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
