import "server-only";
import { getDB } from "./sqlite";

// 自定义 Agent 的仓储层。刻意不放进 repo.ts —— 那个文件已经 1900 行，且 agent 与
// session/node 的读写路径完全不相交（agent 只在 spawn 前被读一次）。

/** agent 的技能引用。
 *
 * 只实现 host（引用本机 ~/.claude/skills/<name>）：本机真实 skill 全是多文件包，
 * 带 scripts/ references/ 甚至可执行脚本，一个 Web textarea 产不出来。inline 判别位
 * 先留着，等真有「在 Trellis 里写 skill」的需求再实现。 */
export type SkillRef =
  | { kind: "host"; name: string }
  | { kind: "inline"; name: string; body: string };

export type AgentPermission = "full" | "default" | "readonly" | "auto-edit";

export type AgentRecord = {
  id: string;
  slug: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: string | null;
  /** null = 不限制工具；[] = 无工具 */
  tools: string[] | null;
  disallowedTools: string[] | null;
  skills: SkillRef[];
  /** true = 读本机 CLAUDE.md / settings / skill / MCP；false = 隔离 */
  inheritEnv: boolean;
  permission: AgentPermission | null;
  requireApproval: boolean | null;
  builtin: boolean;
  enabled: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type AgentInput = {
  slug: string;
  name: string;
  description?: string;
  systemPrompt?: string;
  model?: string | null;
  tools?: string[] | null;
  disallowedTools?: string[] | null;
  skills?: SkillRef[];
  inheritEnv?: boolean;
  permission?: AgentPermission | null;
  requireApproval?: boolean | null;
  enabled?: boolean;
  sortOrder?: number;
};

type AgentRow = {
  id: string;
  slug: string;
  name: string;
  description: string;
  system_prompt: string;
  model: string | null;
  tools_json: string | null;
  disallowed_tools_json: string | null;
  skills_json: string | null;
  inherit_env: number;
  permission: string | null;
  require_approval: number | null;
  builtin: number;
  enabled: number;
  sort_order: number;
  created_at: number;
  updated_at: number;
};

const AGENT_COLS = `id, slug, name, description, system_prompt, model, tools_json,
       disallowed_tools_json, skills_json, inherit_env, permission, require_approval,
       builtin, enabled, sort_order, created_at, updated_at`;

/** slug 同时是 claude `--agent` 的值、pack 里 agents/<slug>.md 的文件名、未来 @提及的名字。
 * 三者都要求它是安全的路径片段 —— 校验放在唯一入口，别指望调用方自觉。 */
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidSlug(slug: string): boolean {
  return SLUG_RE.test(slug);
}

function parseJsonArray<T>(raw: string | null): T[] | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? (v as T[]) : null;
  } catch {
    // 手改过 DB / 老格式残留：当作「没配」而不是让整个 agent 列表 500。
    return null;
  }
}

function rowToAgent(r: AgentRow): AgentRecord {
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    description: r.description,
    systemPrompt: r.system_prompt,
    model: r.model,
    tools: parseJsonArray<string>(r.tools_json),
    disallowedTools: parseJsonArray<string>(r.disallowed_tools_json),
    skills: parseJsonArray<SkillRef>(r.skills_json) ?? [],
    inheritEnv: r.inherit_env === 1,
    permission: (r.permission as AgentPermission | null) ?? null,
    requireApproval: r.require_approval === null ? null : r.require_approval === 1,
    builtin: r.builtin === 1,
    enabled: r.enabled === 1,
    sortOrder: r.sort_order,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export function listAgents(opts?: { enabledOnly?: boolean }): AgentRecord[] {
  const db = getDB();
  const where = opts?.enabledOnly ? "WHERE enabled = 1" : "";
  const rows = db
    .query(`SELECT ${AGENT_COLS} FROM agents ${where} ORDER BY sort_order ASC, created_at ASC`)
    .all() as AgentRow[];
  return rows.map(rowToAgent);
}

export function getAgent(id: string): AgentRecord | null {
  const db = getDB();
  const row = db.query(`SELECT ${AGENT_COLS} FROM agents WHERE id = ?`).get(id) as
    | AgentRow
    | undefined;
  return row ? rowToAgent(row) : null;
}

export function getAgentBySlug(slug: string): AgentRecord | null {
  const db = getDB();
  const row = db.query(`SELECT ${AGENT_COLS} FROM agents WHERE slug = ?`).get(slug) as
    | AgentRow
    | undefined;
  return row ? rowToAgent(row) : null;
}

/** 供 chat route 钳制用：id 存在且 enabled 才认，否则退回默认人设。
 * 停用一个 agent 不该让引用它的老会话报错 —— 静默降级到默认是对的。 */
export function resolveEnabledAgent(id: string | null | undefined): AgentRecord | null {
  if (!id) return null;
  const a = getAgent(id);
  return a && a.enabled ? a : null;
}

export function createAgent(input: AgentInput): AgentRecord {
  if (!isValidSlug(input.slug)) {
    throw new Error(`invalid slug: ${input.slug}（只允许小写字母/数字/连字符，≤32 字符）`);
  }
  const db = getDB();
  const now = Date.now();
  const id = crypto.randomUUID();
  db.prepare(
    `INSERT INTO agents
       (id, slug, name, description, system_prompt, model, tools_json,
        disallowed_tools_json, skills_json, inherit_env, permission, require_approval,
        builtin, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
  ).run(
    id,
    input.slug,
    input.name,
    input.description ?? "",
    input.systemPrompt ?? "",
    input.model ?? null,
    input.tools ? JSON.stringify(input.tools) : null,
    input.disallowedTools ? JSON.stringify(input.disallowedTools) : null,
    input.skills?.length ? JSON.stringify(input.skills) : null,
    // 新建的自定义 agent 默认**隔离** —— 这才是「可复现、能搬机器」的用法。
    // 内置那五个纯人设相反（见 sqlite.ts seedBuiltinAgents）。
    input.inheritEnv ? 1 : 0,
    input.permission ?? null,
    input.requireApproval === undefined || input.requireApproval === null
      ? null
      : input.requireApproval
        ? 1
        : 0,
    input.enabled === false ? 0 : 1,
    input.sortOrder ?? 100,
    now,
    now,
  );
  return getAgent(id)!;
}

export function updateAgent(id: string, patch: Partial<AgentInput>): AgentRecord | null {
  const existing = getAgent(id);
  if (!existing) return null;
  if (patch.slug !== undefined && !isValidSlug(patch.slug)) {
    throw new Error(`invalid slug: ${patch.slug}`);
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (col: string, v: unknown) => {
    sets.push(`${col} = ?`);
    vals.push(v);
  };
  if (patch.slug !== undefined) put("slug", patch.slug);
  if (patch.name !== undefined) put("name", patch.name);
  if (patch.description !== undefined) put("description", patch.description);
  if (patch.systemPrompt !== undefined) put("system_prompt", patch.systemPrompt);
  if (patch.model !== undefined) put("model", patch.model);
  if (patch.tools !== undefined) put("tools_json", patch.tools ? JSON.stringify(patch.tools) : null);
  if (patch.disallowedTools !== undefined) {
    put(
      "disallowed_tools_json",
      patch.disallowedTools ? JSON.stringify(patch.disallowedTools) : null,
    );
  }
  if (patch.skills !== undefined) {
    put("skills_json", patch.skills.length ? JSON.stringify(patch.skills) : null);
  }
  if (patch.inheritEnv !== undefined) put("inherit_env", patch.inheritEnv ? 1 : 0);
  if (patch.permission !== undefined) put("permission", patch.permission);
  if (patch.requireApproval !== undefined) {
    put(
      "require_approval",
      patch.requireApproval === null ? null : patch.requireApproval ? 1 : 0,
    );
  }
  if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
  if (patch.sortOrder !== undefined) put("sort_order", patch.sortOrder);
  if (!sets.length) return existing;
  put("updated_at", Date.now());
  vals.push(id);
  getDB()
    .prepare(`UPDATE agents SET ${sets.join(", ")} WHERE id = ?`)
    .run(...(vals as never[]));
  return getAgent(id);
}

/** 内置 agent 不可删（下次 boot 的 seed 会把它原样种回来，删了等于闪一下）。
 * 想让它消失请 updateAgent(id, { enabled: false })。 */
export function deleteAgent(id: string): { ok: boolean; reason?: string } {
  const a = getAgent(id);
  if (!a) return { ok: false, reason: "not found" };
  if (a.builtin) return { ok: false, reason: "内置 Agent 不可删除，请改用「停用」" };
  // sessions.agent_id 是 ON DELETE SET NULL —— 用过它的历史会话退回默认人设，不连坐。
  // 清理可能绑定在该 agent 上的飞书机器人和任务，避免悬空 id。
  getDB().prepare("UPDATE lark_bots SET agent_id = NULL WHERE agent_id = ?").run(id);
  getDB().prepare("UPDATE tasks SET agent_id = NULL WHERE agent_id = ?").run(id);
  getDB().prepare("DELETE FROM agents WHERE id = ?").run(id);
  return { ok: true };
}
