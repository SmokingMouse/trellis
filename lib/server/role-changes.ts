import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import { getAgent, updateAgent, type AgentRecord } from "./agents";
import {
  MEMORY_FILE_RE,
  RoleError,
  ensureRoleDir,
  parseMemoryFile,
  rebuildMemoryIndex,
  serializeMemory,
} from "./roles";
import { MEMORY_TYPES, type MemoryType } from "@/lib/roles";
import {
  ROLE_CHANGE_KINDS,
  isRevertible,
  type ProposedMemory,
  type RoleChange,
  type RoleChangeKind,
  type RoleChangePayload,
  type RoleChangeStatus,
} from "@/lib/role-changes";
import { ROLE_SKILL_NAME_RE } from "@/lib/role-routines";

// 夜间整理提案（docs/roles-p2.md A 包）：解析模型输出 → role_changes 行 → 接受 / 拒绝 /
// 撤销。照 butler-changes 的「先预览、再落库、可撤销」语义，但落点是角色目录里的文件，
// 不是重放路由：
//
//   · 解析宽进严出：模型输出里抠出 JSON（围栏、前后废话、尾随说明都容忍），逐条校验，
//     坏一条丢一条，不因为一条坏掉整张卡。同一个文件只许被一条提案碰（否则先接受的那条
//     会让后一条的前提失效）。
//   · 接受那一刻再取快照：before_json = { before: {相对路径: 原文|null}, after: {...} }。
//     撤销时先核对文件仍是「接受时写下的样子」，被人改过就拒绝撤销 —— 宁可让用户手动处理，
//     也不拿 7 天前的快照覆盖掉用户后来的编辑。
//   · 路径只由校验过的文件名 / 技能名拼出来，落盘前再核一次真实路径在角色目录内、不是软链。

const MAX_CHANGES = 20;
const BODY_MAX = 64 * 1024;
const REASON_MAX = 200;

// ---------------------------------------------------------------- 解析

/** 从模型输出里抠出第一个能解析的 JSON 值（对象或数组）。抠不出 → null。 */
export function extractJson(text: string): unknown {
  const t = text.trim();
  if (!t) return null;
  const tryParse = (s: string): unknown => {
    try {
      return JSON.parse(s);
    } catch {
      return undefined;
    }
  };
  const whole = tryParse(t);
  if (whole !== undefined && whole !== null && typeof whole === "object") return whole;
  // ```json ... ``` 围栏（取第一个能解析的）
  for (const m of t.matchAll(/```(?:json|JSON)?\s*\n([\s\S]*?)```/g)) {
    const v = tryParse(m[1].trim());
    if (v !== undefined && v !== null && typeof v === "object") return v;
  }
  // 前后夹着废话：从每个 { / [ 起做括号配平（认字符串与转义），配平即试解析。
  for (let start = 0; start < t.length; start++) {
    const ch = t[start];
    if (ch !== "{" && ch !== "[") continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < t.length; i++) {
      const c = t[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{" || c === "[") depth++;
      else if (c === "}" || c === "]") {
        depth--;
        if (depth === 0) {
          const v = tryParse(t.slice(start, i + 1));
          if (v !== undefined && v !== null && typeof v === "object") return v;
          break;
        }
      }
    }
  }
  return null;
}

/** 解析时要知道的角色目录现状。 */
export type ProposalContext = {
  /** memories/ 下现有文件名 → 记忆名 */
  memories: Map<string, string>;
  /** skills/ 下现有技能名 */
  skills: Set<string>;
};

export type ParsedProposal = {
  /** 解析成功（拿到了 JSON）；false = 输出里根本没有 JSON */
  ok: boolean;
  summary: string;
  changes: RoleChangePayload[];
  /** 校验不过被丢掉的条数 */
  dropped: number;
};

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** 名字 → 记忆文件名（小写 ASCII 连字符；中文名回落成 memory-<n>）。 */
function fileFromName(name: string, taken: Set<string>): string {
  let base = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\.md$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "");
  if (!base) base = "memory";
  let cand = `${base}.md`;
  for (let n = 2; taken.has(cand) || !MEMORY_FILE_RE.test(cand); n++) {
    cand = `${base}-${n}.md`;
    if (n > 999) break;
  }
  return cand;
}

function normalizeFile(raw: unknown): string | null {
  let f = str(raw).trim();
  if (!f) return null;
  f = f.replace(/^memories\//, "");
  if (!f.endsWith(".md")) f += ".md";
  return MEMORY_FILE_RE.test(f) ? f : null;
}

function parseMemory(
  raw: unknown,
  opts: { taken: Set<string>; allowExisting: boolean },
): ProposedMemory | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const name = str(o.name).trim().slice(0, 200);
  const body = str(o.body);
  if (!name || !body.trim() || body.length > BODY_MAX) return null;
  const type = (MEMORY_TYPES as readonly string[]).includes(str(o.type))
    ? (o.type as MemoryType)
    : "project";
  let file = o.file !== undefined ? normalizeFile(o.file) : null;
  if (o.file !== undefined && !file) return null; // 给了但不合法：可能是路径穿越，整条丢
  if (!file || (!opts.allowExisting && opts.taken.has(file))) file = fileFromName(file ?? name, opts.taken);
  return {
    file,
    name,
    description: str(o.description).replace(/[\r\n]+/g, " ").trim().slice(0, 500),
    type,
    body,
  };
}

/**
 * 模型输出 → 提案列表。期望形状：
 * `{ "summary": "...", "changes": [ {kind:"add", memory:{...}, reason}, {kind:"merge", files:[...], into:{...}},
 *    {kind:"delete", file, reason}, {kind:"skill", name, description, body, reason} ] }`
 * 也认顶层直接是数组、add 的记忆字段平铺在条目上。
 */
export function parseNightlyProposal(text: string, ctx: ProposalContext): ParsedProposal {
  const v = extractJson(text);
  if (v === null) return { ok: false, summary: "", changes: [], dropped: 0 };
  const root = (Array.isArray(v) ? { changes: v } : v) as Record<string, unknown>;
  const rawChanges = Array.isArray(root.changes) ? root.changes : [];
  const summary = str(root.summary).replace(/[\r\n]+/g, " ").trim().slice(0, 300);

  // 同一个文件 / 技能只许被一条提案碰。taken = 现有文件 + 本批新建的文件。
  const touched = new Set<string>();
  const taken = new Set(ctx.memories.keys());
  const changes: RoleChangePayload[] = [];
  let dropped = 0;

  for (const raw of rawChanges) {
    if (changes.length >= MAX_CHANGES) {
      dropped++;
      continue;
    }
    const c = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = str(c.kind) as RoleChangeKind;
    const reason = str(c.reason).replace(/[\r\n]+/g, " ").trim().slice(0, REASON_MAX);
    const parsed = ((): RoleChangePayload | null => {
      if (!(ROLE_CHANGE_KINDS as readonly string[]).includes(kind)) return null;
      if (kind === "add") {
        const m = parseMemory(c.memory ?? c, { taken, allowExisting: false });
        if (!m || touched.has(`m:${m.file}`)) return null;
        taken.add(m.file);
        touched.add(`m:${m.file}`);
        return { kind, memory: m, reason };
      }
      if (kind === "merge") {
        if (!Array.isArray(c.files)) return null;
        const files = [...new Set(c.files.map(normalizeFile))];
        if (files.length < 2 || files.some((f) => !f || !ctx.memories.has(f) || touched.has(`m:${f}`))) return null;
        const intoRaw = (c.into && typeof c.into === "object" ? c.into : {}) as Record<string, unknown>;
        // into.file 缺省 = 第一个源文件；指向别的现有文件不行（会把第三条记忆覆盖掉）。
        const into = parseMemory(
          { ...intoRaw, file: intoRaw.file ?? files[0] },
          { taken: new Set([...taken].filter((f) => !files.includes(f))), allowExisting: true },
        );
        if (!into) return null;
        if (!files.includes(into.file) && (taken.has(into.file) || touched.has(`m:${into.file}`))) return null;
        for (const f of files) touched.add(`m:${f}`);
        touched.add(`m:${into.file}`);
        taken.add(into.file);
        return { kind, files: files as string[], into, reason };
      }
      if (kind === "delete") {
        const f = normalizeFile(c.file);
        if (!f || !ctx.memories.has(f) || touched.has(`m:${f}`)) return null;
        touched.add(`m:${f}`);
        return { kind, file: f, name: ctx.memories.get(f) ?? f, reason };
      }
      // skill
      const name = str(c.name).trim();
      const body = str(c.body);
      if (!ROLE_SKILL_NAME_RE.test(name) || !body.trim() || body.length > BODY_MAX) return null;
      if (touched.has(`s:${name}`)) return null;
      touched.add(`s:${name}`);
      return {
        kind: "skill",
        name,
        description: str(c.description).replace(/[\r\n]+/g, " ").trim().slice(0, 500),
        body,
        reason,
      };
    })();
    if (parsed) changes.push(parsed);
    else dropped++;
  }
  return { ok: true, summary, changes, dropped };
}

// ---------------------------------------------------------------- 角色目录现状

function requireRole(roleId: string): AgentRecord {
  const a = getAgent(roleId);
  if (!a || a.kind !== "role") throw new RoleError("role not found", 404);
  return a;
}

export function readRoleSkills(homeDir: string): { name: string; description: string; updatedAt: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(path.join(homeDir, "skills"), { withFileTypes: true });
  } catch {
    return [];
  }
  const out: { name: string; description: string; updatedAt: number }[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || !ROLE_SKILL_NAME_RE.test(e.name)) continue;
    const p = path.join(homeDir, "skills", e.name, "SKILL.md");
    try {
      const st = fs.lstatSync(p);
      if (!st.isFile()) continue;
      const m = parseMemoryFile("SKILL.md", fs.readFileSync(p, "utf8"), st.mtimeMs);
      out.push({ name: e.name, description: m.description, updatedAt: st.mtimeMs });
    } catch {
      /* 没有 SKILL.md 的目录不算技能 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export function proposalContext(homeDir: string): ProposalContext {
  const memories = new Map<string, string>();
  try {
    for (const e of fs.readdirSync(path.join(homeDir, "memories"), { withFileTypes: true })) {
      if (!e.isFile() || !MEMORY_FILE_RE.test(e.name)) continue;
      const p = path.join(homeDir, "memories", e.name);
      memories.set(e.name, parseMemoryFile(e.name, fs.readFileSync(p, "utf8"), 0).name);
    }
  } catch {
    /* 没有 memories/ */
  }
  return { memories, skills: new Set(readRoleSkills(homeDir).map((s) => s.name)) };
}

/**
 * 角色技能怎么被 CLI 发现（2026-10-30 用 claude 2.1.280 实测）：
 *   · `--add-dir X` 会加载 `X/.claude/skills/<name>/SKILL.md`，技能名就是 `<name>`；
 *   · 只认 `.claude/skills`，`X/skills/` 不会被扫；
 *   · `.claude/skills` 是指向 `../skills` 的相对软链时照样加载、能被 Skill 工具调起。
 * 所以技能正文按约定放 `<roleDir>/skills/<name>/SKILL.md`，再挂一条
 * `<roleDir>/.claude/skills -> ../skills` 软链；角色 spawn 本来就 `--add-dir` 角色目录
 * （cwd 就是角色目录时，项目级 `.claude/skills` 同样生效）。幂等；已有真实目录不动。
 */
export function ensureRoleSkillsLink(homeDir: string): void {
  try {
    fs.mkdirSync(path.join(homeDir, "skills"), { recursive: true });
    const dotClaude = path.join(homeDir, ".claude");
    fs.mkdirSync(dotClaude, { recursive: true });
    const link = path.join(dotClaude, "skills");
    let st: fs.Stats | null = null;
    try {
      st = fs.lstatSync(link);
    } catch {
      st = null;
    }
    if (!st) {
      fs.symlinkSync("../skills", link, "dir");
    } else if (st.isSymbolicLink() && fs.readlinkSync(link) !== "../skills") {
      fs.unlinkSync(link);
      fs.symlinkSync("../skills", link, "dir");
    }
  } catch (e) {
    console.warn(`[role-changes] 角色技能软链没建成：${homeDir}`, e);
  }
}

// ---------------------------------------------------------------- 安全落盘

/** 相对路径白名单：memories/<file>.md 或 skills/<name>/SKILL.md。 */
function checkRel(rel: string): void {
  const m = /^memories\/([^/]+)$/.exec(rel);
  if (m && MEMORY_FILE_RE.test(m[1])) return;
  const s = /^skills\/([^/]+)\/SKILL\.md$/.exec(rel);
  if (s && ROLE_SKILL_NAME_RE.test(s[1])) return;
  throw new RoleError(`非法的目标路径：${rel}`, 400);
}

/** 校验后的绝对路径：真实路径在角色目录内、父目录不是软链、目标本身不是软链。 */
function safePath(homeDir: string, rel: string, forWrite: boolean): string {
  checkRel(rel);
  const realHome = fs.realpathSync(homeDir);
  const dir = path.dirname(path.join(realHome, rel));
  if (forWrite) fs.mkdirSync(dir, { recursive: true });
  let realDir: string;
  try {
    realDir = fs.realpathSync(dir);
  } catch {
    return path.join(dir, path.basename(rel)); // 父目录不存在：读 = 不存在、删 = 无事可做
  }
  if (realDir !== dir || !realDir.startsWith(realHome + path.sep)) {
    throw new RoleError(`目标目录不在角色目录内：${rel}`, 400);
  }
  const p = path.join(realDir, path.basename(rel));
  try {
    if (fs.lstatSync(p).isSymbolicLink()) throw new RoleError(`拒绝写入软链：${rel}`, 400);
  } catch (e) {
    if (e instanceof RoleError) throw e;
  }
  return p;
}

function readRel(homeDir: string, rel: string): string | null {
  const p = safePath(homeDir, rel, false);
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

function writeRel(homeDir: string, rel: string, content: string | null): void {
  const p = safePath(homeDir, rel, content !== null);
  if (content === null) {
    try {
      fs.unlinkSync(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
    }
    // 技能目录删空了就一起删掉，不留空壳（空壳会被 CLI 当成坏技能报一行警告）。
    if (rel.startsWith("skills/")) {
      try {
        fs.rmdirSync(path.dirname(p));
      } catch {
        /* 目录里还有别的文件：留着 */
      }
    }
    return;
  }
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

function skillFile(p: Extract<RoleChangePayload, { kind: "skill" }>): string {
  // 模型给的正文自带 frontmatter 就原样用；否则补上 name / description。
  if (/^---\r?\n/.test(p.body)) return p.body.endsWith("\n") ? p.body : p.body + "\n";
  const desc = JSON.stringify(p.description || p.name);
  const body = p.body.replace(/^\n+/, "");
  return `---\nname: ${p.name}\ndescription: ${desc}\n---\n\n${body.endsWith("\n") ? body : body + "\n"}`;
}

/** 一条提案要写成的文件：相对路径 → 新内容（null = 删）。也顺带校验前提。 */
function plannedWrites(homeDir: string, p: RoleChangePayload): Map<string, string | null> {
  const out = new Map<string, string | null>();
  const exists = (rel: string) => readRel(homeDir, rel) !== null;
  switch (p.kind) {
    case "add": {
      const rel = `memories/${p.memory.file}`;
      if (exists(rel)) throw new RoleError(`已经有同名记忆文件：${p.memory.file}`, 409);
      out.set(rel, serializeMemory(p.memory));
      break;
    }
    case "merge": {
      for (const f of p.files) {
        if (!exists(`memories/${f}`)) throw new RoleError(`要合并的记忆已经不在了：${f}`, 409);
        out.set(`memories/${f}`, null);
      }
      const intoRel = `memories/${p.into.file}`;
      if (!p.files.includes(p.into.file) && exists(intoRel)) {
        throw new RoleError(`合并目标会覆盖另一条记忆：${p.into.file}`, 409);
      }
      out.set(intoRel, serializeMemory(p.into));
      break;
    }
    case "delete": {
      if (!exists(`memories/${p.file}`)) throw new RoleError(`这条记忆已经不在了：${p.file}`, 409);
      out.set(`memories/${p.file}`, null);
      break;
    }
    case "skill":
      out.set(`skills/${p.name}/SKILL.md`, skillFile(p));
      break;
  }
  return out;
}

/** 按计划落盘；中途失败把已写的恢复原样再抛。 */
function applyWrites(homeDir: string, writes: Map<string, string | null>, before: Record<string, string | null>) {
  const done: string[] = [];
  try {
    for (const [rel, content] of writes) {
      writeRel(homeDir, rel, content);
      done.push(rel);
    }
  } catch (e) {
    for (const rel of done.reverse()) {
      try {
        writeRel(homeDir, rel, before[rel] ?? null);
      } catch {
        /* 回滚尽力而为 */
      }
    }
    throw e;
  } finally {
    if ([...writes.keys()].some((r) => r.startsWith("memories/"))) rebuildMemoryIndex(homeDir);
  }
}

// ---------------------------------------------------------------- 行

type Row = {
  id: string;
  role_id: string;
  node_id: string | null;
  kind: RoleChangeKind;
  payload_json: string;
  status: RoleChangeStatus;
  before_json: string | null;
  error: string | null;
  created_at: number;
  decided_at: number | null;
  reverted_at: number | null;
};

type Snapshot = { before: Record<string, string | null>; after: Record<string, string | null> };

function toChange(r: Row): RoleChange {
  const c: RoleChange = {
    id: r.id,
    roleId: r.role_id,
    nodeId: r.node_id,
    kind: r.kind,
    payload: JSON.parse(r.payload_json) as RoleChangePayload,
    status: r.status,
    error: r.error,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
    revertedAt: r.reverted_at,
    revertible: false,
  };
  c.revertible = isRevertible(c);
  return c;
}

function getRow(id: string): Row | null {
  return (getDB().query("SELECT * FROM role_changes WHERE id = ?").get(id) as Row | null) ?? null;
}

export function getRoleChange(id: string): RoleChange | null {
  const r = getRow(id);
  return r ? toChange(r) : null;
}

export function insertRoleChanges(roleId: string, nodeId: string | null, changes: RoleChangePayload[]): string[] {
  const db = getDB();
  const now = Date.now();
  const ids: string[] = [];
  const ins = db.prepare(
    `INSERT INTO role_changes (id, role_id, node_id, kind, payload_json, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
  );
  db.transaction(() => {
    changes.forEach((c, i) => {
      const id = crypto.randomUUID();
      // 同一批的 created_at 递增 1ms：列表按 created_at 排序时保持模型给的顺序。
      ins.run(id, roleId, nodeId, c.kind, JSON.stringify(c), now + i);
      ids.push(id);
    });
  })();
  return ids;
}

export function listRoleChanges(
  roleId: string,
  opts: { nodeId?: string; decidedOnly?: boolean; limit?: number } = {},
): RoleChange[] {
  const where = ["role_id = ?"];
  const args: (string | number)[] = [roleId];
  if (opts.nodeId) {
    where.push("node_id = ?");
    args.push(opts.nodeId);
  }
  if (opts.decidedOnly) where.push("status IN ('applied','reverted')");
  const order = opts.nodeId ? "created_at ASC" : "COALESCE(reverted_at, decided_at, created_at) DESC";
  args.push(Math.min(Math.max(opts.limit ?? 100, 1), 500));
  const rows = getDB()
    .query(`SELECT * FROM role_changes WHERE ${where.join(" AND ")} ORDER BY ${order} LIMIT ?`)
    .all(...args) as Row[];
  return rows.map(toChange);
}

function setRow(id: string, patch: Partial<Pick<Row, "status" | "before_json" | "error" | "decided_at" | "reverted_at">>) {
  const keys = Object.keys(patch) as (keyof typeof patch)[];
  getDB()
    .prepare(`UPDATE role_changes SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
    .run(...keys.map((k) => (patch[k] ?? null) as string | number | null), id);
}

function requireOwned(roleId: string, id: string): Row {
  const r = getRow(id);
  if (!r || r.role_id !== roleId) throw new RoleError("没有这条改动", 404);
  return r;
}

/** 接受一条：落盘 + 记快照。前提不成立（文件被删了 / 撞名）→ status=failed 并带原因。 */
export function acceptRoleChange(roleId: string, id: string): RoleChange {
  const role = requireRole(roleId);
  const r = requireOwned(roleId, id);
  if (r.status !== "pending") throw new RoleError(`这条改动已经是 ${r.status}`, 409);
  const homeDir = ensureRoleDir(role.slug);
  const payload = JSON.parse(r.payload_json) as RoleChangePayload;
  const now = Date.now();
  try {
    const writes = plannedWrites(homeDir, payload);
    const before: Record<string, string | null> = {};
    for (const rel of writes.keys()) before[rel] = readRel(homeDir, rel);
    if (payload.kind === "skill") ensureRoleSkillsLink(homeDir);
    applyWrites(homeDir, writes, before);
    const snap: Snapshot = { before, after: Object.fromEntries(writes) };
    setRow(id, { status: "applied", before_json: JSON.stringify(snap), decided_at: now, error: null });
    if (payload.kind === "skill") ensureSkillTool(role);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    setRow(id, { status: "failed", error: msg, decided_at: now });
  }
  return getRoleChange(id)!;
}

/** 角色配了工具白名单却没有 Skill 时，技能是摆设（agent-pack 的同款规则）——补上。 */
function ensureSkillTool(role: AgentRecord): void {
  const fresh = getAgent(role.id);
  if (fresh?.tools && !fresh.tools.includes("Skill")) {
    updateAgent(role.id, { tools: [...fresh.tools, "Skill"] });
  }
}

export function rejectRoleChange(roleId: string, id: string): RoleChange {
  requireRole(roleId);
  const r = requireOwned(roleId, id);
  if (r.status !== "pending") throw new RoleError(`这条改动已经是 ${r.status}`, 409);
  setRow(id, { status: "rejected", decided_at: Date.now() });
  return getRoleChange(id)!;
}

/** 撤销：7 天内、文件仍是接受时的样子，按快照写回。 */
export function revertRoleChange(roleId: string, id: string): RoleChange {
  const role = requireRole(roleId);
  const r = requireOwned(roleId, id);
  const c = toChange(r);
  if (c.status !== "applied") throw new RoleError("只有已接受的改动能撤销", 409);
  if (!c.revertible) throw new RoleError("已经超过 7 天，不能撤销了", 409);
  if (!r.before_json) throw new RoleError("这条改动没有快照，不能撤销", 409);
  const snap = JSON.parse(r.before_json) as Snapshot;
  const homeDir = ensureRoleDir(role.slug);
  for (const [rel, after] of Object.entries(snap.after)) {
    if (readRel(homeDir, rel) !== after) {
      throw new RoleError(`「${rel}」接受之后又被改过，撤销会覆盖那些修改 —— 请到记忆页手动处理`, 409);
    }
  }
  applyWrites(homeDir, new Map(Object.entries(snap.before)), snap.after);
  setRow(id, { status: "reverted", reverted_at: Date.now() });
  return getRoleChange(id)!;
}

/** 整理卡上的「全部接受」：这张卡里还 pending 的按顺序逐条接受。 */
export function acceptAllRoleChanges(roleId: string, nodeId: string): RoleChange[] {
  requireRole(roleId);
  for (const c of listRoleChanges(roleId, { nodeId })) {
    if (c.status === "pending") acceptRoleChange(roleId, c.id);
  }
  return listRoleChanges(roleId, { nodeId });
}
