import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import { getAgent, updateAgent, type AgentRecord, type SkillRef } from "./agents";
import { createRootInSession, createSessionWithRoot } from "./repo";
import { RoleError, adoptRoleHomeSession, ensureRoleDir, planRoleNewSession } from "./roles";
import { createTask, createTrigger, deleteTask, getTask, listRuns, listTriggers, updateTask, type Task } from "./tasks";
import { ensureRoleSkillsLink, readRoleSkills } from "./role-changes";
import { parseCron } from "@/lib/cron";
import {
  ROLE_SKILL_NAME_RE,
  ROUTINE_QUIET_SUFFIX,
  isRoutineSilent,
  routineCron,
  type RoleBackgroundTask,
  type RoleCapabilities,
  type RoleCapabilitiesInput,
  type RoleRoutine,
  type RoleRoutineInput,
  type RoutineTrigger,
} from "@/lib/role-routines";

// 角色 P2 A 包的另外三块（docs/roles-p2.md）：例行、后台任务、能力。
//
// 例行 = tasks 行（agent_id = 角色，context_mode = project）+ 一条 cron 触发器。与普通任务
// 唯一的不同在落点：跑出来的那一轮挂进**角色固定会话**（新根 = 时间线里一个新话题），
// 不另开 kind='task' 的 home 会话 —— tasks.home_session_id 刻意不写，否则 deleteTask 会把
// 角色会话翻成 kind='user'。工作目录也跟角色走（launch 时现取），不认 tasks.workspace_path
// 的旧值：角色改了目录，例行跟着改。

function requireRole(roleId: string): AgentRecord {
  const a = getAgent(roleId);
  if (!a || a.kind !== "role") throw new RoleError("role not found", 404);
  return a;
}

// ---------------------------------------------------------------- 例行：执行侧（tasks.ts 调）

/** 这个任务的 agent 是不是一个启用中的角色。是 → 角色行。 */
export function roleForTask(task: Pick<Task, "agentId">): AgentRecord | null {
  if (!task.agentId) return null;
  const a = getAgent(task.agentId);
  return a && a.kind === "role" && a.enabled ? a : null;
}

/** 角色例行的有效执行参数：project 模式、角色当下的工作目录。 */
export function roleRoutineTask<T extends Task>(task: T): T {
  const role = roleForTask(task);
  if (!role) return task;
  const plan = planRoleNewSession(role.id);
  return plan ? { ...task, contextMode: "project", workspacePath: plan.workspacePath } : task;
}

export function isQuietTask(taskId: string): boolean {
  const r = getDB().query("SELECT quiet_if_nothing FROM tasks WHERE id = ?").get(taskId) as
    | { quiet_if_nothing: number }
    | null;
  return r?.quiet_if_nothing === 1;
}

/** 这一轮发给模型的问题：没发现就不出声的例行，追加 [SILENT] 约定。 */
export function routineQuestion(task: Pick<Task, "id" | "prompt">): string {
  return isQuietTask(task.id) ? task.prompt + ROUTINE_QUIET_SUFFIX : task.prompt;
}

/** 在角色固定会话里开一个新根给这次执行；固定会话没了就建一条并认作固定会话。
 * 角色不可用 → null（调用方退回普通任务的 home 会话）。 */
export function createRoleRoutineRoot(
  task: Pick<Task, "agentId" | "providerId">,
  question: string,
  now: number,
): { sessionId: string; nodeId: string } | null {
  const role = roleForTask(task);
  if (!role) return null;
  const plan = planRoleNewSession(role.id);
  if (!plan) return null;
  const nodeId = crypto.randomUUID();
  if (plan.reuseSessionId) {
    createRootInSession({ sessionId: plan.reuseSessionId, nodeId, question, now, attachments: [] });
    return { sessionId: plan.reuseSessionId, nodeId };
  }
  const sessionId = crypto.randomUUID();
  createSessionWithRoot({
    sessionId,
    nodeId,
    title: role.name,
    question,
    now,
    mode: "project",
    workspacePath: plan.workspacePath,
    systemPrompt: null,
    model: task.providerId,
    agentId: role.id,
    attachments: [],
    registerWorkspace: plan.workspacePath !== plan.homeDir,
  });
  adoptRoleHomeSession(role.id, sessionId);
  return { sessionId, nodeId };
}

/** 例行跑完：没发现就不出声的、回答恰为 [SILENT] 的，把这一轮在时间线里收起（hidden_at）。 */
export function settleRoleRoutineRun(taskId: string, nodeId: string | null, status: string): boolean {
  if (status !== "done" || !nodeId) return false;
  const task = getTask(taskId);
  if (!task || !roleForTask(task) || !isQuietTask(taskId)) return false;
  const row = getDB().query("SELECT response, final_start, parent_id FROM nodes WHERE id = ?").get(nodeId) as
    | { response: string; final_start: number | null; parent_id: string | null }
    | null;
  if (!row || row.parent_id) return false;
  const start = row.final_start ?? 0;
  const final = start > 0 && start < row.response.length ? row.response.slice(start) : row.response;
  if (!isRoutineSilent(final) && !isRoutineSilent(row.response)) return false;
  getDB().prepare("UPDATE nodes SET hidden_at = ? WHERE id = ?").run(Date.now(), nodeId);
  return true;
}

// ---------------------------------------------------------------- 例行：管理侧

const NAME_MAX = 60;
const PROMPT_MAX = 20_000;

function firstCron(taskId: string): { id: string; expr: string } | null {
  const t = listTriggers(taskId).find((x) => x.kind === "cron");
  return t ? { id: t.id, expr: String(t.config.expr ?? "") } : null;
}

function toRoutine(t: Task): RoleRoutine {
  const run = listRuns(t.id, 1)[0];
  return {
    taskId: t.id,
    name: t.name,
    prompt: t.prompt,
    enabled: t.enabled,
    cron: firstCron(t.id)?.expr ?? null,
    quiet: isQuietTask(t.id),
    lastRun: run ? { status: run.status, at: run.endedAt ?? run.startedAt ?? run.createdAt } : null,
    createdAt: t.createdAt,
  };
}

function roleTasks(roleId: string): Task[] {
  const ids = getDB().query("SELECT id FROM tasks WHERE agent_id = ? ORDER BY created_at ASC").all(roleId) as {
    id: string;
  }[];
  return ids.map((r) => getTask(r.id)).filter((t): t is Task => t !== null);
}

export function listRoleRoutines(roleId: string): RoleRoutine[] {
  requireRole(roleId);
  return roleTasks(roleId).map(toRoutine);
}

function requireRoutine(roleId: string, taskId: string): Task {
  const t = getTask(taskId);
  if (!t || t.agentId !== roleId) throw new RoleError("没有这条例行", 404);
  return t;
}

function parseTrigger(raw: unknown): { trigger: RoutineTrigger; expr: string } {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const kind = o.kind;
  let trigger: RoutineTrigger;
  if (kind === "daily" || kind === "weekdays") trigger = { kind, time: String(o.time ?? "") };
  else if (kind === "weekly") trigger = { kind, day: Number(o.day), time: String(o.time ?? "") };
  else if (kind === "cron") trigger = { kind, expr: String(o.expr ?? "") };
  else throw new RoleError("trigger.kind 只能是 daily / weekdays / weekly / cron", 400);
  const expr = routineCron(trigger);
  if (!expr || !parseCron(expr)) throw new RoleError("触发时间不合法", 400);
  return { trigger, expr };
}

export function parseRoutineInput(body: unknown, partial: boolean): Partial<RoleRoutineInput> & { expr?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RoleError("expected JSON object", 400);
  const o = body as Record<string, unknown>;
  const out: Partial<RoleRoutineInput> & { expr?: string } = {};
  if (o.name !== undefined || !partial) {
    if (typeof o.name !== "string" || !o.name.trim()) throw new RoleError("名字必填", 400);
    if (Array.from(o.name.trim()).length > NAME_MAX) throw new RoleError(`名字最多 ${NAME_MAX} 个字`, 400);
    out.name = o.name.trim();
  }
  if (o.prompt !== undefined || !partial) {
    if (typeof o.prompt !== "string" || !o.prompt.trim()) throw new RoleError("要它做什么（prompt）必填", 400);
    if (o.prompt.length > PROMPT_MAX) throw new RoleError("prompt 过长", 400);
    out.prompt = o.prompt.trim();
  }
  if (o.trigger !== undefined || !partial) {
    const t = parseTrigger(o.trigger);
    out.trigger = t.trigger;
    out.expr = t.expr;
  }
  if (o.quiet !== undefined) {
    if (typeof o.quiet !== "boolean") throw new RoleError("quiet 必须是布尔值", 400);
    out.quiet = o.quiet;
  }
  if (o.enabled !== undefined) {
    if (typeof o.enabled !== "boolean") throw new RoleError("enabled 必须是布尔值", 400);
    out.enabled = o.enabled;
  }
  return out;
}

export function createRoleRoutine(roleId: string, body: unknown): RoleRoutine {
  const role = requireRole(roleId);
  const input = parseRoutineInput(body, false);
  const plan = planRoleNewSession(role.id);
  if (!plan) throw new RoleError("角色已停用，不能建例行", 409);
  const task = createTask({
    name: input.name!,
    prompt: input.prompt!,
    agentId: role.id,
    contextMode: "project",
    workspacePath: plan.workspacePath,
    enabled: input.enabled ?? true,
    // 例行的结果就在角色时间线里，用户自己会看到；只有失败才通知。
    notifyOn: "error",
  });
  getDB().prepare("UPDATE tasks SET quiet_if_nothing = ? WHERE id = ?").run(input.quiet ? 1 : 0, task.id);
  createTrigger(task.id, "cron", { expr: input.expr });
  return toRoutine(getTask(task.id)!);
}

export function updateRoleRoutine(roleId: string, taskId: string, body: unknown): RoleRoutine {
  requireRole(roleId);
  requireRoutine(roleId, taskId);
  const input = parseRoutineInput(body, true);
  updateTask(taskId, {
    ...(input.name !== undefined ? { name: input.name } : {}),
    ...(input.prompt !== undefined ? { prompt: input.prompt } : {}),
    ...(input.enabled !== undefined ? { enabled: input.enabled } : {}),
  });
  if (input.quiet !== undefined) {
    getDB().prepare("UPDATE tasks SET quiet_if_nothing = ? WHERE id = ?").run(input.quiet ? 1 : 0, taskId);
  }
  if (input.expr) {
    const cur = firstCron(taskId);
    if (cur) {
      getDB().prepare("UPDATE task_triggers SET config_json = ? WHERE id = ?").run(JSON.stringify({ expr: input.expr }), cur.id);
    } else {
      createTrigger(taskId, "cron", { expr: input.expr });
    }
  }
  return toRoutine(getTask(taskId)!);
}

export function deleteRoleRoutine(roleId: string, taskId: string): void {
  requireRole(roleId);
  requireRoutine(roleId, taskId);
  deleteTask(taskId);
}

// ---------------------------------------------------------------- 后台任务

/**
 * 「后台任务」在 trellis 里落成什么（docs/roles-p2.md 让 A 包先摸清再选）：
 *   · CLI 自己的后台活（run_in_background 的 Bash / 异步子 agent）活不过这一轮 ——
 *     `claude -p` 一轮结束就把它们杀了（skills/trellis-admin/SKILL.md、lib/server/push.ts 实测）；
 *   · task_runs 是定时任务的执行，不是「对话里起的活」；
 *   · 真正能脱离这一轮独立跑完、结果落库、界面可看的，是平台内 `trellisctl ask --new`
 *     开出的一条普通会话（run 与 HTTP 解耦，进程退出不杀 run）。原型的交互说明也写的是
 *     「角色开后台任务（就是普通会话）」。
 * 所以：trellisctl ask --new 在 Trellis 会话里跑时带上 originNodeId（= TRELLIS_NODE_ID），
 * chat 路由建完新会话调这里；来源节点在角色会话里才记一行。
 */
export function recordRoleBackgroundTask(args: { originNodeId: unknown; sessionId: string; nodeId: string }): boolean {
  if (typeof args.originNodeId !== "string" || !args.originNodeId) return false;
  try {
    return recordBg(args.originNodeId, args.sessionId, args.nodeId);
  } catch (e) {
    // 记不上只是少一张卡，不能拦住新会话本身。
    console.error("[role-routines] 记后台任务失败", e);
    return false;
  }
}

function recordBg(originNodeId: string, sessionId: string, nodeId: string): boolean {
  const args = { originNodeId, sessionId, nodeId };
  const db = getDB();
  const origin = db
    .query(
      `SELECT n.session_id AS sessionId, s.agent_id AS agentId, s.kind AS kind
         FROM nodes n JOIN sessions s ON s.id = n.session_id WHERE n.id = ?`,
    )
    .get(args.originNodeId) as { sessionId: string; agentId: string | null; kind: string } | null;
  if (!origin || origin.kind !== "role" || !origin.agentId) return false;
  if (origin.sessionId === args.sessionId) return false;
  const role = getAgent(origin.agentId);
  if (!role || role.kind !== "role") return false;
  db.prepare(
    `INSERT OR IGNORE INTO role_bg_tasks (session_id, role_id, origin_session_id, origin_node_id, node_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(args.sessionId, role.id, origin.sessionId, args.originNodeId, args.nodeId, Date.now());
  return true;
}

export function listRoleBackgroundTasks(roleId: string, limit = 20): RoleBackgroundTask[] {
  requireRole(roleId);
  const rows = getDB()
    .query(
      `SELECT b.session_id AS sessionId, b.node_id AS nodeId, b.origin_node_id AS originNodeId,
              b.created_at AS createdAt, s.title AS title, s.updated_at AS updatedAt
         FROM role_bg_tasks b JOIN sessions s ON s.id = b.session_id
        WHERE b.role_id = ?
        ORDER BY b.created_at DESC LIMIT ?`,
    )
    .all(roleId, Math.min(Math.max(limit, 1), 100)) as {
    sessionId: string;
    nodeId: string;
    originNodeId: string;
    createdAt: number;
    title: string;
    updatedAt: number;
  }[];
  const nodeStmt = getDB().query(
    `SELECT status, created_at, duration_ms FROM nodes
      WHERE session_id = ? AND system_meta_json IS NULL ORDER BY created_at ASC`,
  );
  return rows.map((r) => {
    const nodes = nodeStmt.all(r.sessionId) as { status: string; created_at: number; duration_ms: number | null }[];
    const last = nodes.at(-1);
    const status = (last?.status === "streaming" || last?.status === "error" ? last.status : "done") as RoleBackgroundTask["status"];
    const end = last ? last.created_at + (last.duration_ms ?? 0) : r.updatedAt;
    return {
      sessionId: r.sessionId,
      nodeId: r.nodeId,
      originNodeId: r.originNodeId,
      title: r.title,
      status,
      turns: nodes.length,
      durationMs: status === "streaming" || !last?.duration_ms ? null : Math.max(0, end - (nodes[0]?.created_at ?? r.createdAt)),
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    };
  });
}

// ---------------------------------------------------------------- 能力

const TOOL_RE = /^[A-Za-z0-9_*():.-]{1,120}$/;
const HOST_SKILL_RE = /^[A-Za-z0-9._-]+$/;

function parseToolList(v: unknown, field: string): string[] | null {
  if (v === null) return null;
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string" || !TOOL_RE.test(x.trim()))) {
    throw new RoleError(`${field} 必须是工具名数组或 null`, 400);
  }
  const list = [...new Set((v as string[]).map((x) => x.trim()))];
  return list.length ? list : null;
}

export function getRoleCapabilities(roleId: string): RoleCapabilities {
  const role = requireRole(roleId);
  const homeDir = ensureRoleDir(role.slug);
  return {
    tools: role.tools,
    disallowedTools: role.disallowedTools,
    hostSkills: role.skills.filter((s) => s.kind === "host").map((s) => s.name),
    roleSkills: readRoleSkills(homeDir),
  };
}

export function updateRoleCapabilities(roleId: string, body: unknown): RoleCapabilities {
  const role = requireRole(roleId);
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new RoleError("expected JSON object", 400);
  const o = body as RoleCapabilitiesInput & Record<string, unknown>;
  const patch: { tools?: string[] | null; disallowedTools?: string[] | null; skills?: SkillRef[] } = {};
  if (o.tools !== undefined) patch.tools = parseToolList(o.tools, "tools");
  if (o.disallowedTools !== undefined) patch.disallowedTools = parseToolList(o.disallowedTools, "disallowedTools");
  if (o.hostSkills !== undefined) {
    if (!Array.isArray(o.hostSkills) || o.hostSkills.some((x) => typeof x !== "string" || !HOST_SKILL_RE.test(x))) {
      throw new RoleError("hostSkills 必须是技能目录名数组", 400);
    }
    patch.skills = [...new Set(o.hostSkills as string[])].map((name) => ({ kind: "host" as const, name }));
  }
  // 白名单里没有 Skill，角色自己的技能就调不动（agent-pack 只在挂了本机技能时自动补）。
  const homeDir = ensureRoleDir(role.slug);
  if (patch.tools && readRoleSkills(homeDir).length && !patch.tools.includes("Skill")) {
    patch.tools = [...patch.tools, "Skill"];
  }
  updateAgent(roleId, patch);
  return getRoleCapabilities(roleId);
}

export function deleteRoleSkill(roleId: string, name: string): void {
  const role = requireRole(roleId);
  if (!ROLE_SKILL_NAME_RE.test(name)) throw new RoleError(`非法的技能名：${name}`, 400);
  const homeDir = ensureRoleDir(role.slug);
  const dir = path.join(homeDir, "skills", name);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(dir);
  } catch {
    throw new RoleError("没有这个技能", 404);
  }
  if (!st.isDirectory() || st.isSymbolicLink()) throw new RoleError("拒绝删除软链或非目录", 400);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** spawn 前确保角色技能能被发现（老角色没有 .claude/skills 软链）。 */
export function prepareRoleSkills(homeDir: string): void {
  ensureRoleSkillsLink(homeDir);
}
