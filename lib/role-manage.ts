// 角色管理面（设置页、新建弹窗）用的纯函数。和 lib/roles.ts 分开放：那份是前后端共享契约，
// 这里只是界面层的推导（文件名、筛选分组、副本命名），改它不该牵动后端。
import { MEMORY_TYPES, type MemoryType, type RoleMemory } from "./roles";

/** 与服务端 [file] 校验同一条正则（docs/roles-p1.md）：前端先自检，免得拼出一个必被 400 的名字。 */
export const MEMORY_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/;

export function randomHex6(): string {
  const buf = new Uint8Array(3);
  globalThis.crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * 手动加一条记忆时由名字推文件名：ASCII 部分转小写短横线；中文名字推不出 ASCII，
 * 回落成 mem-<6位hex>.md（与服务端 slug 的 role-<6位> 回落同一思路）。
 * 和已有文件撞名时加 -2、-3… 后缀——PUT 是覆盖语义，撞了会悄悄改掉另一条记忆。
 */
export function memoryFileFromName(
  name: string,
  existing: Iterable<string> = [],
  rand: () => string = randomHex6,
): string {
  const taken = new Set(existing);
  const slug = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  // 中文名里夹一两个字母（「看 PR」→「pr」）推出来的名字太短没信息量，也走随机
  let base = slug.length >= 3 ? slug : `mem-${rand()}`;
  if (!MEMORY_FILE_RE.test(`${base}.md`)) base = `mem-${rand()}`;
  let file = `${base}.md`;
  for (let i = 2; taken.has(file); i++) file = `${base}-${i}.md`;
  return file;
}

export type MemoryFilter = "all" | MemoryType;

/** 筛选条每个 chip 的计数（「全部」= 搜索后的总数）。 */
export function countMemories(memories: RoleMemory[]): Record<MemoryFilter, number> {
  const out = { all: memories.length } as Record<MemoryFilter, number>;
  for (const t of MEMORY_TYPES) out[t] = 0;
  for (const m of memories) out[m.type] = (out[m.type] ?? 0) + 1;
  return out;
}

/** 搜索：名字 / 描述 / 正文里包含关键字（不分大小写）。 */
export function searchMemories(memories: RoleMemory[], query: string): RoleMemory[] {
  const q = query.trim().toLowerCase();
  if (!q) return memories;
  return memories.filter((m) =>
    [m.name, m.description, m.body].some((s) => s.toLowerCase().includes(q)),
  );
}

/** 按类型分组（固定 MEMORY_TYPES 顺序，空组不出），组内按更新时间倒序。 */
export function groupMemories(
  memories: RoleMemory[],
  filter: MemoryFilter,
): { type: MemoryType; items: RoleMemory[] }[] {
  return MEMORY_TYPES.filter((t) => filter === "all" || filter === t)
    .map((type) => ({
      type,
      items: memories.filter((m) => m.type === type).sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .filter((g) => g.items.length > 0);
}

/** 「复制成新角色」的名字：老周 → 老周 副本；已有就 老周 副本 2、3…（名字不能重复）。 */
export function copyRoleName(name: string, existingNames: Iterable<string>): string {
  const taken = new Set(Array.from(existingNames, (n) => n.trim()));
  const base = `${name.trim()} 副本`;
  if (!taken.has(base)) return base;
  let i = 2;
  while (taken.has(`${base} ${i}`)) i++;
  return `${base} ${i}`;
}

/** 名字是否和别的角色重复（trim 后比较；selfId 是正在编辑的那个，自己不算）。 */
export function isRoleNameTaken(
  name: string,
  roles: { id: string; name: string }[],
  selfId?: string,
): boolean {
  const n = name.trim();
  return !!n && roles.some((r) => r.id !== selfId && r.name.trim() === n);
}

/** 记忆列表里的正文摘录：去掉 markdown 列表 / 标题记号、丢掉空行，按行保留（配
 * whitespace-pre-line + line-clamp 显示前两行）。直接塞原文会把「- 口语痛点」「- 听力
 * 痛点」挤成一坨。 */
export function memoryExcerpt(body: string, maxLines = 3): string {
  return body
    .split("\n")
    .map((l) => l.trim().replace(/^#{1,6}\s+/, "").replace(/^[-*+]\s+/, "• "))
    .filter(Boolean)
    .slice(0, maxLines)
    .join("\n");
}
