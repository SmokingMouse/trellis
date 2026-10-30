import "server-only";
import fs from "node:fs";
import path from "node:path";
import type { ConfigDiffItem, ImportResultItem, RolePackItem } from "@/lib/config-sync";
import { MEMORY_TYPES, type MemoryType } from "@/lib/roles";
import { getAgentBySlug, isValidSlug, listAgents, updateAgent, type AgentRecord } from "./agents";
import {
  MEMORY_FILE_RE,
  createRole,
  listRoleMemories,
  rolesRoot,
  updateRole,
  writeRoleMemory,
  writeRoleUserMd,
} from "./roles";

// 配置同步里的「角色」一类（docs/roles-p2.md C）。对齐键 slug，规则与 agents 一致：
//   · 只导自定义角色（builtin=0）—— 管家这种内置角色每台机器各自种；
//   · 目标同 slug 是内置 / 是普通 Agent / 有同名角色目录但没有角色行 → 不可同步（绝不改到别的东西）；
//   · 同 slug 的自定义角色内容不同 = 冲突，默认跳过，勾覆盖才改：行字段整体覆盖，USER.md 覆盖，
//     包里的记忆文件逐个覆盖写入，本机多出来的记忆保留（不删用户在目标机器上攒的记忆）。
// 固定会话（聊天记录）不进包。

const ROLE_FIELDS: { key: keyof RolePackItem; label: string }[] = [
  { key: "name", label: "名字" },
  { key: "intro", label: "介绍" },
  { key: "systemPrompt", label: "人设" },
  { key: "avatarHue", label: "头像色" },
  { key: "avatarGlyph", label: "头像字" },
  { key: "model", label: "模型" },
  { key: "workDir", label: "默认目录" },
  { key: "memoryEnabled", label: "使用记忆" },
  { key: "enabled", label: "启用" },
  { key: "userMd", label: "USER.md" },
];

function roleToPack(a: AgentRecord): RolePackItem {
  const mem = listRoleMemories(a.id);
  return {
    slug: a.slug,
    name: a.name,
    intro: a.intro,
    systemPrompt: a.systemPrompt,
    avatarHue: a.avatarHue,
    avatarGlyph: a.avatarGlyph,
    model: a.model,
    workDir: a.workDir,
    memoryEnabled: a.memoryEnabled,
    enabled: a.enabled,
    userMd: mem.userMd,
    memories: mem.memories
      .map((m) => ({ file: m.file, name: m.name, description: m.description, type: m.type, body: m.body }))
      .sort((x, y) => x.file.localeCompare(y.file)),
  };
}

export function exportRoles(): RolePackItem[] {
  return listAgents({ kind: "role" })
    .filter((a) => !a.builtin)
    .map(roleToPack);
}

// ── 校验 ────────────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** fail 由调用方注入（config-sync.ts 的 ConfigSyncInputError），保持「任何一项不合格整包 400」。 */
export function validateRole(v: unknown, i: number, fail: (msg: string) => never): RolePackItem {
  const f = `roles[${i}]`;
  if (!isObj(v)) fail(`${f} 格式错误`);
  const str = (x: unknown, field: string, max: number): string => {
    if (typeof x !== "string") fail(`${f}.${field} 必须是字符串`);
    if ((x as string).length > max) fail(`${f}.${field} 过长`);
    return x as string;
  };
  const slug = str(v.slug, "slug", 32);
  if (!isValidSlug(slug)) fail(`${f}.slug 非法：${slug}`);
  const hue = v.avatarHue ?? 254;
  if (typeof hue !== "number" || !Number.isInteger(hue) || hue < 0 || hue > 359) fail(`${f}.avatarHue 非法`);
  const memRaw = v.memories ?? [];
  if (!Array.isArray(memRaw) || memRaw.length > 500) fail(`${f}.memories 必须是 ≤500 项的数组`);
  const seen = new Set<string>();
  const memories = (memRaw as unknown[]).map((m, j) => {
    const mf = `memories[${j}]`;
    if (!isObj(m)) fail(`${f}.${mf} 格式错误`);
    const file = str(m.file, `${mf}.file`, 90);
    // 文件名直接拼进路径：与 /api/roles/[id]/memories/[file] 同一条正则，拒绝路径穿越。
    if (!MEMORY_FILE_RE.test(file)) fail(`${f}.${mf}.file 非法：${file}`);
    if (seen.has(file)) fail(`${f}.${mf}.file 重复：${file}`);
    seen.add(file);
    const type = m.type;
    if (typeof type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(type)) fail(`${f}.${mf}.type 非法`);
    return {
      file,
      name: str(m.name, `${mf}.name`, 200),
      description: str(m.description ?? "", `${mf}.description`, 500),
      type: type as MemoryType,
      body: str(m.body ?? "", `${mf}.body`, 64 * 1024),
    };
  });
  const model = v.model === null || v.model === undefined ? null : str(v.model, "model", 200);
  const workDir = v.workDir === null || v.workDir === undefined ? null : str(v.workDir, "workDir", 4096);
  return {
    slug,
    name: str(v.name, "name", 40),
    intro: str(v.intro ?? "", "intro", 200),
    systemPrompt: str(v.systemPrompt ?? "", "systemPrompt", 100_000),
    avatarHue: hue as number,
    avatarGlyph: str(v.avatarGlyph ?? "", "avatarGlyph", 8),
    model,
    workDir,
    memoryEnabled: v.memoryEnabled !== false,
    enabled: v.enabled !== false,
    userMd: str(v.userMd ?? "", "userMd", 256 * 1024),
    memories,
  };
}

// ── 预览 / 应用 ────────────────────────────────────────────────────────────

type RolePlan = {
  diff: ConfigDiffItem;
  apply?: (action: "create" | "overwrite") => Pick<ImportResultItem, "outcome" | "message" | "warnings">;
};

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** 包里的 workDir 是来源机器的路径：目标机器上没有就置空，并在结果里说一声。 */
function portableWorkDir(item: RolePackItem): { workDir: string | null; warnings: string[] } {
  if (!item.workDir) return { workDir: null, warnings: [] };
  if (path.isAbsolute(item.workDir) && isDirectory(item.workDir)) return { workDir: path.resolve(item.workDir), warnings: [] };
  return { workDir: null, warnings: [`默认目录 ${item.workDir} 在目标机器上不存在，已改用角色自己的目录`] };
}

function writeRoleFiles(roleId: string, item: RolePackItem): void {
  writeRoleUserMd(roleId, item.userMd);
  for (const m of item.memories) {
    writeRoleMemory(roleId, m.file, { name: m.name, description: m.description, type: m.type, body: m.body });
  }
}

export function planRoles(items: RolePackItem[]): RolePlan[] {
  return items.map((item) => {
    const existing = getAgentBySlug(item.slug);
    const { workDir, warnings } = portableWorkDir(item);
    const base = {
      kind: "roles" as const,
      key: item.slug,
      label: item.name,
      summary: [item.intro || item.slug, `${item.memories.length} 条记忆`].join(" · "),
      warnings,
    };
    const fields = {
      name: item.name,
      intro: item.intro,
      systemPrompt: item.systemPrompt,
      avatarHue: item.avatarHue,
      avatarGlyph: item.avatarGlyph,
      model: item.model,
      workDir,
      memoryEnabled: item.memoryEnabled,
    };

    if (!existing) {
      // 没有角色行却有同名目录：多半是手工拷进来的 / 残留目录。不认领，免得把别人的记忆当成这个角色的。
      if (fs.existsSync(path.join(rolesRoot(), item.slug))) {
        return { diff: { ...base, status: "blocked", reason: "目标机器上已有同名的角色目录，但没有这个角色" } };
      }
      return {
        diff: { ...base, status: "new" },
        apply: () => {
          const role = createRole({ slug: item.slug, ...fields });
          if (!item.enabled) updateAgent(role.id, { enabled: false });
          writeRoleFiles(role.id, item);
          return { outcome: "created", warnings };
        },
      };
    }
    if (existing.kind !== "role") {
      return { diff: { ...base, status: "blocked", reason: "目标机器上同 slug 的是 Agent，不覆盖" } };
    }
    if (existing.builtin) {
      return { diff: { ...base, status: "blocked", reason: "目标机器上同 slug 的是内置角色，不覆盖" } };
    }

    const ours = roleToPack(existing);
    // workDir 按「落到目标机器之后」的值比：来源路径在目标上不存在、两边都会是 null。
    const theirs: RolePackItem = { ...item, workDir };
    const changes = ROLE_FIELDS.filter((f) => JSON.stringify(ours[f.key]) !== JSON.stringify(theirs[f.key])).map(
      (f) => f.label,
    );
    const oursByFile = new Map(ours.memories.map((m) => [m.file, m]));
    const memChanged = item.memories.filter((m) => {
      const o = oursByFile.get(m.file);
      return !o || o.name !== m.name || o.description !== m.description || o.type !== m.type || o.body !== m.body;
    }).length;
    if (memChanged) changes.push(`记忆 ${memChanged} 条不同`);
    const extra = ours.memories.filter((m) => !item.memories.some((x) => x.file === m.file)).length;
    const overwriteWarnings = extra ? [...warnings, `目标机器上多出的 ${extra} 条记忆保留不动`] : warnings;
    if (!changes.length) return { diff: { ...base, status: "same", warnings: [] } };
    return {
      diff: { ...base, status: "conflict", changes, warnings: overwriteWarnings },
      apply: () => {
        updateRole(existing.id, fields);
        if (existing.enabled !== item.enabled) updateAgent(existing.id, { enabled: item.enabled });
        writeRoleFiles(existing.id, item);
        return { outcome: "overwritten", warnings: overwriteWarnings };
      },
    };
  });
}
