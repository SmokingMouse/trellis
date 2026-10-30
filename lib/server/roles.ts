import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDB } from "./sqlite";
import {
  createAgent,
  deleteAgent,
  getAgent,
  getAgentBySlug,
  isValidSlug,
  listAgents,
  updateAgent,
  type AgentInput,
  type AgentRecord,
} from "./agents";
import {
  MEMORY_TYPES,
  type MemoryType,
  type Role,
  type RoleInput,
  type RoleMemory,
  type RoleMemoryList,
  type RoleOpenResult,
} from "@/lib/roles";
import type { AgentSpawn } from "@/lib/llm/types";
import { ensureRoleSkillsLink } from "./role-changes";
import { roleBackgroundTaskHint } from "./role-prompt-extras";

// 角色 P1 的服务端（设计见 docs/roles-p1.md，共享类型见 lib/roles.ts）。
//
// 角色 = agents 表里 kind='role' 的一行 + 角色目录 + 一条固定会话。这里管：
//   · 角色目录（~/.trellis/roles/<slug>/，TRELLIS_ROLES_DIR 可覆盖）的建、读、改名
//   · 记忆文件 memories/*.md 的读写与 MEMORY.md 索引重建
//   · spawn 时追加给 CLI 的记忆说明（buildRoleMemoryPrompt / roleSpawnExtras）
//   · chat 路由「新会话 → 角色固定会话」的判定（planRoleNewSession / adoptRoleHomeSession）

/** 路由层把它翻成对应 HTTP 状态码。 */
export class RoleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------- 目录

export function rolesRoot(): string {
  const override = process.env.TRELLIS_ROLES_DIR?.trim();
  return path.resolve(override || path.join(os.homedir(), ".trellis", "roles"));
}

export function roleHomeDir(slug: string): string {
  // slug 直接拼进路径：入口处校验，别指望调用方。
  if (!isValidSlug(slug)) throw new RoleError(`invalid slug: ${slug}`, 400);
  return path.join(rolesRoot(), slug);
}

/** 建好角色目录骨架（幂等，已有文件不动），返回绝对路径。 */
export function ensureRoleDir(slug: string): string {
  const dir = roleHomeDir(slug);
  fs.mkdirSync(path.join(dir, "memories"), { recursive: true });
  for (const f of ["USER.md", "MEMORY.md"]) {
    try {
      fs.writeFileSync(path.join(dir, f), "", { flag: "wx" });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  return dir;
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => {
    try {
      return fs.realpathSync(p);
    } catch {
      return path.resolve(p);
    }
  };
  return norm(a) === norm(b);
}

// ---------------------------------------------------------------- 角色行

/** 固定会话「还在」= 行存在、未归档、仍挂在这个角色上。 */
function aliveHomeSession(
  sessionId: string | null,
  roleId: string,
): { id: string; updatedAt: number } | null {
  if (!sessionId) return null;
  const row = getDB()
    .query("SELECT id, updated_at FROM sessions WHERE id = ? AND archived = 0 AND agent_id = ?")
    .get(sessionId, roleId) as { id: string; updated_at: number } | null;
  return row ? { id: row.id, updatedAt: row.updated_at } : null;
}

function getRoleRecord(id: string): AgentRecord | null {
  const a = getAgent(id);
  return a && a.kind === "role" ? a : null;
}

function requireRoleRecord(id: string): AgentRecord {
  const a = getRoleRecord(id);
  if (!a) throw new RoleError("role not found", 404);
  return a;
}

function toRole(a: AgentRecord): Role {
  const homeDir = roleHomeDir(a.slug);
  const home = aliveHomeSession(a.homeSessionId, a.id);
  return {
    id: a.id,
    slug: a.slug,
    name: a.name,
    intro: a.intro,
    systemPrompt: a.systemPrompt,
    avatarHue: a.avatarHue,
    avatarGlyph: a.avatarGlyph,
    model: a.model,
    workDir: a.workDir,
    memoryEnabled: a.memoryEnabled,
    builtin: a.builtin,
    enabled: a.enabled,
    homeDir,
    homeSessionId: home?.id ?? null,
    memoryCount: listMemoryFiles(homeDir).length,
    lastActiveAt: home?.updatedAt ?? null,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt,
  };
}

/** 按 lastActiveAt 降序；没聊过的排在后面，按 sortOrder / 创建时间。 */
export function listRoles(): Role[] {
  const records = listAgents({ kind: "role" });
  const order = new Map(records.map((a, i) => [a.id, i]));
  return records.map(toRole).sort((x, y) => {
    if (x.lastActiveAt !== null || y.lastActiveAt !== null) {
      if (x.lastActiveAt === null) return 1;
      if (y.lastActiveAt === null) return -1;
      if (x.lastActiveAt !== y.lastActiveAt) return y.lastActiveAt - x.lastActiveAt;
    }
    return (order.get(x.id) ?? 0) - (order.get(y.id) ?? 0);
  });
}

export function getRole(id: string): Role | null {
  const a = getRoleRecord(id);
  return a ? toRole(a) : null;
}

export function openRole(id: string): RoleOpenResult {
  const a = requireRoleRecord(id);
  return { sessionId: aliveHomeSession(a.homeSessionId, a.id)?.id ?? null };
}

// ---------------------------------------------------------------- 输入校验

const NAME_MAX = 40;
const INTRO_MAX = 200;
const PROMPT_MAX = 100_000;

/** 把不可信 body 收成 RoleInput（partial = PATCH）。非法直接抛 400。 */
export function parseRoleInput(body: unknown, partial: false): RoleInput;
export function parseRoleInput(body: unknown, partial: true): Partial<RoleInput>;
export function parseRoleInput(body: unknown, partial: boolean): Partial<RoleInput> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new RoleError("expected JSON object", 400);
  }
  const o = body as Record<string, unknown>;
  const out: Partial<RoleInput> = {};
  const bad = (msg: string): never => {
    throw new RoleError(msg, 400);
  };

  if (o.name !== undefined || !partial) {
    if (typeof o.name !== "string" || !o.name.trim()) bad("name 必填");
    const name = (o.name as string).trim();
    if (Array.from(name).length > NAME_MAX) bad(`name 最多 ${NAME_MAX} 个字`);
    out.name = name;
  }
  if (o.slug !== undefined) {
    if (partial) bad("slug 不可修改");
    if (typeof o.slug !== "string" || !isValidSlug(o.slug)) {
      bad("slug 只允许小写字母/数字/连字符，≤32 字符");
    }
    out.slug = o.slug as string;
  }
  if (o.intro !== undefined) {
    if (typeof o.intro !== "string") bad("intro 必须是字符串");
    const intro = (o.intro as string).trim();
    if (Array.from(intro).length > INTRO_MAX) bad(`intro 最多 ${INTRO_MAX} 个字`);
    out.intro = intro;
  }
  if (o.systemPrompt !== undefined) {
    if (typeof o.systemPrompt !== "string") bad("systemPrompt 必须是字符串");
    if ((o.systemPrompt as string).length > PROMPT_MAX) bad("systemPrompt 过长");
    out.systemPrompt = o.systemPrompt as string;
  }
  if (o.avatarHue !== undefined) {
    const h = o.avatarHue;
    if (typeof h !== "number" || !Number.isInteger(h) || h < 0 || h > 359) {
      bad("avatarHue 必须是 0–359 的整数");
    }
    out.avatarHue = h as number;
  }
  if (o.avatarGlyph !== undefined) {
    if (typeof o.avatarGlyph !== "string") bad("avatarGlyph 必须是字符串");
    const g = (o.avatarGlyph as string).trim();
    if (Array.from(g).length > 2) bad("avatarGlyph 最多 2 个字");
    out.avatarGlyph = g;
  }
  if (o.model !== undefined) {
    if (o.model !== null && typeof o.model !== "string") bad("model 必须是字符串或 null");
    const m = typeof o.model === "string" ? o.model.trim() : "";
    out.model = m || null;
  }
  if (o.workDir !== undefined) {
    if (o.workDir !== null && typeof o.workDir !== "string") bad("workDir 必须是字符串或 null");
    const w = typeof o.workDir === "string" ? o.workDir.trim() : "";
    if (!w) {
      out.workDir = null;
    } else {
      if (!path.isAbsolute(w)) bad("workDir 必须是绝对路径");
      if (!isDirectory(w)) bad(`workDir 不存在或不是目录：${w}`);
      out.workDir = path.resolve(w);
    }
  }
  if (o.memoryEnabled !== undefined) {
    if (typeof o.memoryEnabled !== "boolean") bad("memoryEnabled 必须是布尔值");
    out.memoryEnabled = o.memoryEnabled as boolean;
  }
  return out;
}

// ---------------------------------------------------------------- slug

function slugTaken(slug: string): boolean {
  return !!getAgentBySlug(slug) || fs.existsSync(path.join(rolesRoot(), slug));
}

function randomSuffix(): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

/** 从名字生成 slug：ASCII 名字取小写连字符形式，冲突加 -2、-3…；
 * 非 ASCII（中文名）回落成 role-<6 位随机>。 */
export function generateRoleSlug(name: string): string {
  const base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (base && isValidSlug(base)) {
    if (!slugTaken(base)) return base;
    for (let n = 2; n < 1000; n++) {
      const tail = `-${n}`;
      const cand = base.slice(0, 32 - tail.length).replace(/-+$/, "") + tail;
      if (isValidSlug(cand) && !slugTaken(cand)) return cand;
    }
  }
  for (let i = 0; i < 20; i++) {
    const cand = `role-${randomSuffix()}`;
    if (!slugTaken(cand)) return cand;
  }
  throw new RoleError("无法生成可用的 slug", 500);
}

// ---------------------------------------------------------------- 增删改

export function createRole(input: RoleInput): Role {
  let slug: string;
  if (input.slug) {
    if (!isValidSlug(input.slug)) throw new RoleError(`invalid slug: ${input.slug}`, 400);
    if (slugTaken(input.slug)) throw new RoleError(`slug 已被占用：${input.slug}`, 409);
    slug = input.slug;
  } else {
    slug = generateRoleSlug(input.name);
  }
  const agentInput: AgentInput = {
    slug,
    name: input.name,
    // description 是 --agents JSON 里 agent 的自述；角色拿介绍顶上。
    description: input.intro ?? "",
    systemPrompt: input.systemPrompt ?? "",
    model: input.model ?? null,
    // 角色恒继承本机环境（CLAUDE.md / skill / MCP）：它是长期搭档，不是沙箱。
    inheritEnv: true,
    kind: "role",
    intro: input.intro ?? "",
    avatarHue: input.avatarHue ?? 254,
    avatarGlyph: input.avatarGlyph ?? "",
    workDir: input.workDir ?? null,
    memoryEnabled: input.memoryEnabled ?? true,
  };
  let record: AgentRecord;
  try {
    record = createAgent(agentInput);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("UNIQUE")) throw new RoleError(`slug 已被占用：${slug}`, 409);
    throw e;
  }
  try {
    ensureRoleDir(slug);
  } catch (e) {
    // 目录建不出来的角色记不住东西 —— 回滚行，别留半个角色。
    deleteAgent(record.id);
    throw e;
  }
  return toRole(record);
}

export function updateRole(id: string, patch: Partial<RoleInput>): Role {
  const before = requireRoleRecord(id);
  if (patch.slug !== undefined) throw new RoleError("slug 不可修改", 400);
  const agentPatch: Partial<AgentInput> = {};
  if (patch.name !== undefined) agentPatch.name = patch.name;
  if (patch.intro !== undefined) {
    agentPatch.intro = patch.intro;
    agentPatch.description = patch.intro;
  }
  if (patch.systemPrompt !== undefined) agentPatch.systemPrompt = patch.systemPrompt;
  if (patch.avatarHue !== undefined) agentPatch.avatarHue = patch.avatarHue;
  if (patch.avatarGlyph !== undefined) agentPatch.avatarGlyph = patch.avatarGlyph;
  if (patch.model !== undefined) agentPatch.model = patch.model;
  if (patch.workDir !== undefined) agentPatch.workDir = patch.workDir;
  if (patch.memoryEnabled !== undefined) agentPatch.memoryEnabled = patch.memoryEnabled;
  const after = updateAgent(id, agentPatch);
  if (!after) throw new RoleError("role not found", 404);

  // 换了工作目录：固定会话跟着搬（照 tasks.updateTask）。旧 cwd 下的 CLI 会话
  // resume 不到了，chat 路由会自愈成 fresh + DB 历史折叠。
  if (patch.workDir !== undefined && patch.workDir !== before.workDir) {
    const home = aliveHomeSession(after.homeSessionId, id);
    if (home) {
      getDB()
        .prepare("UPDATE sessions SET workspace_path = ? WHERE id = ?")
        .run(roleWorkspacePath(after), home.id);
    }
  }
  return toRole(after);
}

/** 删角色不删目录：改名成 <slug>.deleted-<ts> 留底。固定会话保留（kind='role'，
 * agent_id 被外键置空），历史不连坐。 */
export function deleteRole(id: string): void {
  const a = requireRoleRecord(id);
  if (a.builtin) throw new RoleError("内置角色不可删除", 409);
  const r = deleteAgent(id);
  if (!r.ok) throw new RoleError(r.reason ?? "delete failed", r.reason === "not found" ? 404 : 409);
  // 先删行再改名：改名失败最多留个旧目录（slugTaken 会避开它），不会留下没目录的角色。
  const dir = roleHomeDir(a.slug);
  try {
    if (fs.existsSync(dir)) {
      fs.renameSync(dir, path.join(rolesRoot(), `${a.slug}.deleted-${Date.now()}`));
    }
  } catch (e) {
    console.error(`[roles] 角色目录改名失败（行已删）：${dir}`, e);
  }
}

// ---------------------------------------------------------------- 记忆

export const MEMORY_FILE_RE = /^[a-z0-9][a-z0-9._-]{0,80}\.md$/;
const MEMORY_BODY_MAX = 64 * 1024;
const USER_MD_MAX = 256 * 1024;

function memoriesDir(homeDir: string): string {
  return path.join(homeDir, "memories");
}

/** memories/ 下合法、非软链的 .md 文件名。目录不存在 = []。 */
function listMemoryFiles(homeDir: string): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(memoriesDir(homeDir), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile() && MEMORY_FILE_RE.test(e.name))
    .map((e) => e.name)
    .sort();
}

/** 校验文件名 + 真实路径包含关系，返回可读写的绝对路径。 */
function memoryPath(homeDir: string, file: string): string {
  if (!MEMORY_FILE_RE.test(file)) throw new RoleError(`非法的记忆文件名：${file}`, 400);
  const dir = memoriesDir(homeDir);
  fs.mkdirSync(dir, { recursive: true });
  const realHome = fs.realpathSync(homeDir);
  const realDir = fs.realpathSync(dir);
  if (realDir !== path.join(realHome, "memories")) {
    throw new RoleError("memories 目录不在角色目录内", 400);
  }
  const p = path.join(realDir, file);
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new RoleError("拒绝写入软链", 400);
  } catch (e) {
    if (e instanceof RoleError) throw e;
    /* 不存在：可写 */
  }
  return p;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    try {
      return String(JSON.parse(t));
    } catch {
      return t.slice(1, -1);
    }
  }
  if (t.length >= 2 && t.startsWith("'") && t.endsWith("'")) {
    return t.slice(1, -1).replace(/''/g, "'");
  }
  return t;
}

/** 解析一条记忆文件。frontmatter 只认 name / description / metadata.type（或顶层
 * type）；格式坏了也不抛 —— 名字回落成文件名，正文给全文。 */
export function parseMemoryFile(
  file: string,
  text: string,
  updatedAt: number,
): RoleMemory {
  const fallbackName = file.replace(/\.md$/, "");
  const norm = text.replace(/\r\n/g, "\n");
  let fm: string | null = null;
  let body = norm;
  if (norm.startsWith("---\n")) {
    const end = norm.indexOf("\n---", 4);
    if (end !== -1) {
      const after = norm.indexOf("\n", end + 4);
      fm = norm.slice(4, end);
      body = after === -1 ? "" : norm.slice(after + 1);
    }
  }
  const top: Record<string, string> = {};
  const meta: Record<string, string> = {};
  if (fm !== null) {
    let inMeta = false;
    for (const line of fm.split("\n")) {
      if (!line.trim() || line.trim().startsWith("#")) continue;
      const indented = /^\s/.test(line);
      const m = /^\s*([A-Za-z_][\w-]*)\s*:\s?(.*)$/.exec(line);
      if (!m) continue;
      if (!indented) {
        inMeta = m[1] === "metadata" && !m[2].trim();
        if (!inMeta) top[m[1]] = unquote(m[2]);
      } else if (inMeta) {
        meta[m[1]] = unquote(m[2]);
      }
    }
  }
  const rawType = meta.type ?? top.type;
  const type: MemoryType = (MEMORY_TYPES as readonly string[]).includes(rawType ?? "")
    ? (rawType as MemoryType)
    : "project";
  return {
    file,
    name: top.name?.trim() || fallbackName,
    description: top.description?.trim() ?? "",
    type,
    body: body.replace(/^\n+/, ""),
    updatedAt,
  };
}

/** YAML 标量：需要时用双引号（JSON 字符串是合法的 YAML 双引号串）。 */
function yamlScalar(v: string): string {
  const one = v.replace(/[\r\n]+/g, " ").trim();
  if (!one || /[:#'"\\[\]{},&*!|>%@`]/.test(one) || /^[-?]/.test(one)) {
    return JSON.stringify(one);
  }
  return one;
}

export function serializeMemory(m: Pick<RoleMemory, "name" | "description" | "type" | "body">): string {
  const body = m.body.replace(/\r\n/g, "\n").replace(/^\n+/, "");
  return [
    "---",
    `name: ${yamlScalar(m.name)}`,
    `description: ${yamlScalar(m.description)}`,
    "metadata:",
    `  type: ${m.type}`,
    "---",
    "",
    body.endsWith("\n") || !body ? body : body + "\n",
  ].join("\n");
}

function readMemoryAt(homeDir: string, file: string): RoleMemory | null {
  const p = path.join(memoriesDir(homeDir), file);
  try {
    const st = fs.lstatSync(p);
    if (!st.isFile()) return null;
    return parseMemoryFile(file, fs.readFileSync(p, "utf8"), st.mtimeMs);
  } catch {
    return null;
  }
}

function readMemoriesAt(homeDir: string): RoleMemory[] {
  return listMemoryFiles(homeDir)
    .map((f) => readMemoryAt(homeDir, f))
    .filter((m): m is RoleMemory => m !== null);
}

/** MEMORY.md 由 memories/ 全量重建：每行 `- [name](memories/<file>) — description`。 */
export function rebuildMemoryIndex(homeDir: string): string {
  const lines = readMemoriesAt(homeDir).map((m) => {
    const name = m.name.replace(/[\r\n]+/g, " ").replace(/[[\]]/g, "");
    const desc = m.description.replace(/[\r\n]+/g, " ");
    return `- [${name}](memories/${m.file})${desc ? ` — ${desc}` : ""}`;
  });
  const text = lines.length ? lines.join("\n") + "\n" : "";
  atomicWrite(path.join(homeDir, "MEMORY.md"), text);
  return text;
}

function atomicWrite(p: string, text: string): void {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, p);
}

function readTextOr(p: string, fallback = ""): string {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return fallback;
  }
}

export function listRoleMemories(id: string): RoleMemoryList {
  const a = requireRoleRecord(id);
  const homeDir = roleHomeDir(a.slug);
  return {
    memoryEnabled: a.memoryEnabled,
    userMd: readTextOr(path.join(homeDir, "USER.md")),
    memories: readMemoriesAt(homeDir).sort((x, y) => y.updatedAt - x.updatedAt),
  };
}

/** 校验 PUT body：{ name, description, type, body }。 */
export function parseMemoryInput(body: unknown): Pick<RoleMemory, "name" | "description" | "type" | "body"> {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof o.name !== "string" || !o.name.trim()) throw new RoleError("name 必填", 400);
  if (o.description !== undefined && typeof o.description !== "string") {
    throw new RoleError("description 必须是字符串", 400);
  }
  if (typeof o.type !== "string" || !(MEMORY_TYPES as readonly string[]).includes(o.type)) {
    throw new RoleError(`type 必须是 ${MEMORY_TYPES.join(" / ")} 之一`, 400);
  }
  if (typeof o.body !== "string") throw new RoleError("body 必须是字符串", 400);
  if (o.body.length > MEMORY_BODY_MAX) throw new RoleError("body 过长", 400);
  return {
    name: o.name.trim().slice(0, 200),
    description: ((o.description as string | undefined) ?? "").trim().slice(0, 500),
    type: o.type as MemoryType,
    body: o.body,
  };
}

export function writeRoleMemory(
  id: string,
  file: string,
  input: Pick<RoleMemory, "name" | "description" | "type" | "body">,
): RoleMemory {
  const a = requireRoleRecord(id);
  const homeDir = ensureRoleDir(a.slug);
  const p = memoryPath(homeDir, file);
  atomicWrite(p, serializeMemory(input));
  rebuildMemoryIndex(homeDir);
  return readMemoryAt(homeDir, file)!;
}

export function deleteRoleMemory(id: string, file: string): void {
  const a = requireRoleRecord(id);
  const homeDir = ensureRoleDir(a.slug);
  const p = memoryPath(homeDir, file);
  if (!fs.existsSync(p)) throw new RoleError("memory not found", 404);
  fs.unlinkSync(p);
  rebuildMemoryIndex(homeDir);
}

export function writeRoleUserMd(id: string, text: unknown): string {
  if (typeof text !== "string") throw new RoleError("text 必须是字符串", 400);
  if (text.length > USER_MD_MAX) throw new RoleError("USER.md 过长", 400);
  const a = requireRoleRecord(id);
  const homeDir = ensureRoleDir(a.slug);
  atomicWrite(path.join(homeDir, "USER.md"), text);
  return text;
}

// ---------------------------------------------------------------- spawn 注入

const PROMPT_SECTION_MAX = 16 * 1024;

function clip(text: string): string {
  if (text.length <= PROMPT_SECTION_MAX) return text;
  return text.slice(0, PROMPT_SECTION_MAX) + "\n…（已截断，完整内容请直接读文件）";
}

/** 追加在角色人设之后的记忆说明（--append-system-prompt）。读当下的 USER.md /
 * MEMORY.md，所以每轮 spawn 都拿到最新的索引。 */
export function buildRoleMemoryPrompt(role: Pick<Role, "name" | "homeDir">): string {
  const dir = role.homeDir;
  const userMd = readTextOr(path.join(dir, "USER.md")).trim();
  const memoryMd = readTextOr(path.join(dir, "MEMORY.md")).trim();
  return [
    `# 你的长期记忆`,
    ``,
    `你是「${role.name}」，一个会长期陪用户工作的角色。你有自己的记忆目录：`,
    ``,
    `    ${dir}`,
    ``,
    `- \`${path.join(dir, "USER.md")}\`：你对用户的了解（自由文本）。`,
    `- \`${path.join(dir, "MEMORY.md")}\`：记忆索引，每条记忆一行。`,
    `- \`${path.join(dir, "memories")}/\`：记忆正文，一条一个文件，文件名用小写字母、数字、连字符，以 .md 结尾（如 \`prefers-short-answers.md\`）。`,
    ``,
    `## 怎么写记忆`,
    ``,
    `用 Write / Edit 工具直接写 memories/ 下的文件（用上面的绝对路径），格式：`,
    ``,
    "```markdown",
    `---`,
    `name: prefers-short-answers`,
    `description: 一句话说明这条记忆是什么，写进索引`,
    `metadata:`,
    `  type: feedback`,
    `---`,
    ``,
    `正文：事实本身，必要时附上来由（用户原话、日期）。`,
    "```",
    ``,
    `type 只用这四种：user（关于用户本人）、feedback（用户的偏好与纠正）、project（项目事实）、reference（外部资料 / 链接 / 去哪找什么）。`,
    ``,
    `新增或删除一条记忆后，同步更新 MEMORY.md：每条一行 \`- [name](memories/<文件名>) — description\`。改已有记忆时优先 Edit 原文件，别重复建。`,
    ``,
    `## 什么值得记`,
    ``,
    `- 用户的身份、习惯、偏好，以及用户纠正过你的地方`,
    `- 从代码里推不出来的项目事实：决定、约定、背景、谁负责什么`,
    `- 有用的外部参考：链接、文档位置、账号或环境在哪`,
    ``,
    `不记：这一轮的临时任务细节、进度流水、仓库里本来就查得到的东西（代码结构、git 历史）、密钥与口令。`,
    ``,
    `学到值得长期记住的东西就当场写，不要等到对话结束。用户说「记住…」「以后…」时一定要写。用户说某条不对时，改掉或删掉那条。`,
    ``,
    `## USER.md 当前内容`,
    ``,
    userMd ? clip(userMd) : "（空）",
    ``,
    `## MEMORY.md 当前内容`,
    ``,
    memoryMd ? clip(memoryMd) : "（还没有记忆）",
  ].join("\n");
}

/** resolveAgentSpawn 之后叠在 AgentSpawn 上的角色增量。非角色 / 记忆关掉 → null。
 * cwd 已是角色目录时不重复 --add-dir。 */
export function roleSpawnExtras(
  a: AgentRecord,
  cwd: string | null,
): Pick<AgentSpawn, "addDirs" | "appendSystemPrompt"> | null {
  if (a.kind !== "role" || !a.memoryEnabled) return null;
  const homeDir = ensureRoleDir(a.slug);
  // P2：角色技能经 <homeDir>/.claude/skills -> ../skills 被 --add-dir 发现（见 role-changes.ts）。
  ensureRoleSkillsLink(homeDir);
  return {
    ...(cwd && samePath(cwd, homeDir) ? {} : { addDirs: [homeDir] }),
    appendSystemPrompt: `${buildRoleMemoryPrompt({ name: a.name, homeDir })}\n\n${roleBackgroundTaskHint()}`,
  };
}

// ---------------------------------------------------------------- chat 路由

/** 角色会话的 cwd：work_dir 还在就用它，否则（没配 / 目录没了）用角色目录。
 * 目录不存在时 spawn 抛的 ENOENT 逃得出 run-bus（见 tasks.ts），所以这里兜底。 */
function roleWorkspacePath(a: AgentRecord): string {
  const homeDir = roleHomeDir(a.slug);
  return a.workDir && isDirectory(a.workDir) ? a.workDir : homeDir;
}

export type RoleNewSessionPlan = {
  role: AgentRecord;
  homeDir: string;
  /** 新建时用的 workspace_path（不认客户端 body）。 */
  workspacePath: string;
  /** 固定会话还在 → 在它里面开新根，而不是再建一条。 */
  reuseSessionId: string | null;
};

/** chat 路由「新会话」分支的角色判定。agentId 不是启用中的角色 → null（走原逻辑）。 */
export function planRoleNewSession(agentId: unknown): RoleNewSessionPlan | null {
  if (typeof agentId !== "string" || !agentId) return null;
  const a = getAgent(agentId);
  if (!a || a.kind !== "role" || !a.enabled) return null;
  const homeDir = ensureRoleDir(a.slug);
  return {
    role: a,
    homeDir,
    workspacePath: roleWorkspacePath(a),
    reuseSessionId: aliveHomeSession(a.homeSessionId, a.id)?.id ?? null,
  };
}

/** 新建的会话认作角色固定会话：kind='role'（侧栏看不到）+ 回写 home_session_id。 */
export function adoptRoleHomeSession(roleId: string, sessionId: string): void {
  const db = getDB();
  db.transaction(() => {
    db.prepare("UPDATE sessions SET kind = 'role' WHERE id = ?").run(sessionId);
    db.prepare("UPDATE agents SET home_session_id = ? WHERE id = ?").run(sessionId, roleId);
  })();
}

// ---------------------------------------------------------------- 路由共用

/** RoleError → 对应状态码；其余当 500。 */
export function roleErrorResponse(e: unknown): Response {
  if (e instanceof RoleError) return Response.json({ error: e.message }, { status: e.status });
  console.error("[roles]", e);
  const msg = e instanceof Error ? e.message : String(e);
  return Response.json({ error: msg }, { status: 500 });
}

export async function readJsonBody(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new RoleError("invalid JSON", 400);
  }
}
