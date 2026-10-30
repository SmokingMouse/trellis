import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getDB } from "./sqlite";
import { getAgent, type AgentRecord } from "./agents";
import { resolveAgentSpawn } from "./agent-pack";
import { planRoleNewSession, roleSpawnExtras } from "./roles";
import {
  claudeJsonlExists,
  createBranchNode,
  createRootInSession,
  finalizeNode,
  getNode,
  setSessionArchived,
  type ApiNode,
} from "./repo";
import { abortRun, startRun, type ProviderEvent } from "./run-bus";
import { appendSystemNode } from "./system-node";
import { getProvider } from "@/lib/llm/server";
import { runLabelSpawn } from "@/lib/llm/topic";
import { DEFAULT_PROVIDER, isProviderId, providerFamily, type ProviderFamily, type ProviderId } from "@/lib/llm";
import type { AgentSpawn } from "@/lib/llm/types";
import {
  GROUP_DEFAULT_MAX_MESSAGES,
  GROUP_DEFAULT_MAX_PASSES,
  GROUP_MAX_MEMBERS,
  GROUP_MESSAGES_RANGE,
  GROUP_MIN_MEMBERS,
  GROUP_PASSES_RANGE,
  GROUP_POLICIES,
  GROUP_SKIP_TOKEN,
  GROUP_USER_LABEL,
  GroupRoundBudget,
  clampSetting,
  formatUnseenDelta,
  groupNodeMeta,
  isSkipReply,
  pickRoutedMember,
  planUserResponders,
  replyHandoffs,
  routeByName,
  type Group,
  type GroupEvent,
  type GroupInput,
  type GroupMember,
  type GroupNodeMeta,
  type GroupPatch,
  type GroupReplyPolicy,
  type GroupReplyTo,
  type GroupRound,
  type GroupSettings,
  type GroupTranscriptItem,
} from "@/lib/groups";

// 群聊服务端（docs/roles-p2.md B）：建群 / 成员 / 设置、群消息落库、一轮发言的编排、
// 轮次状态的广播。共享类型与纯函数在 lib/groups.ts。
//
// 编排一条用户消息（runRound）：
//   1. 挑这一遍的人：@ 了谁就谁；没 @ 按策略 —— route 先看有没有直接叫名字，再起一次轻量模型
//      （runLabelSpawn，haiku）挑一位，挑不出来落第一位；all 每位依次看、可以回（跳过）；
//      mention-only 没人回。
//   2. 依次让每位发言：各自 resume 自己在群里的 CLI 会话（group_members.cli_session_id），
//      带自己的人设 + 记忆注入（roleSpawnExtras）+ 群聊说明（--append-system-prompt），
//      只喂它没看过的群消息（last_seen_seq 之后，「[名字]：内容」）。
//      每位的发言是一个节点，走 run-bus：客户端照普通回答那样流式看到。
//   3. 发言里 @ 了别人 → 排进下一遍。最多 maxPasses 遍、maxMessages 条，到顶插
//      group-round-end 系统节点（前端渲染上限卡：继续讨论 / 让管家记成任务）。
//   停下这一轮 = 置停 + abort 正在说的那位的 run。

export class GroupError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export function groupErrorResponse(e: unknown): Response {
  if (e instanceof GroupError) return Response.json({ error: e.message }, { status: e.status });
  console.error("[groups]", e);
  return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 });
}

export async function readGroupJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const v = await req.json();
    if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* fallthrough */
  }
  throw new GroupError("expected JSON object", 400);
}

// ---------------------------------------------------------------- 进程内状态

type Listener = (e: GroupEvent) => void;

type RoundCtx = {
  sessionId: string;
  round: GroupRound;
  stopped: boolean;
  provider: ProviderId;
  done: Promise<void>;
};

type GroupsState = { rounds: Map<string, RoundCtx>; listeners: Map<string, Set<Listener>> };
const G: GroupsState = ((globalThis as { __trellisGroups?: GroupsState }).__trellisGroups ??= {
  rounds: new Map(),
  listeners: new Map(),
});

export function subscribeGroup(sessionId: string, fn: Listener): () => void {
  let set = G.listeners.get(sessionId);
  if (!set) G.listeners.set(sessionId, (set = new Set()));
  set.add(fn);
  return () => {
    set!.delete(fn);
    if (set!.size === 0) G.listeners.delete(sessionId);
  };
}

function emit(sessionId: string, e: GroupEvent): void {
  for (const fn of G.listeners.get(sessionId) ?? []) {
    try {
      fn(e);
    } catch {
      /* 一个断掉的订阅者不该拖垮编排 */
    }
  }
}

function emitRound(ctx: RoundCtx): void {
  emit(ctx.sessionId, { type: "round", round: { ...ctx.round, queued: [...ctx.round.queued] } });
}

function emitNode(sessionId: string, nodeId: string): void {
  const node = getNode(nodeId);
  if (node) emit(sessionId, { type: "node", node });
}

/** 正在进行的一轮（routing / running）；没有 = null。 */
export function activeRound(sessionId: string): GroupRound | null {
  const ctx = G.rounds.get(sessionId);
  return ctx ? { ...ctx.round, queued: [...ctx.round.queued] } : null;
}

/** 测试用：等这一轮跑完。 */
export async function waitForRound(sessionId: string): Promise<void> {
  await G.rounds.get(sessionId)?.done;
}

// ---------------------------------------------------------------- 读

type GroupSessionRow = {
  id: string;
  title: string;
  workspace_path: string | null;
  model: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
};

function groupRow(sessionId: string): GroupSessionRow | null {
  return getDB()
    .query(
      "SELECT id, title, workspace_path, model, created_at, updated_at, archived FROM sessions WHERE id = ? AND kind = 'group'",
    )
    .get(sessionId) as GroupSessionRow | null;
}

function requireGroupRow(sessionId: string): GroupSessionRow {
  const row = groupRow(sessionId);
  if (!row) throw new GroupError("group not found", 404);
  return row;
}

/** 成员（只算启用中的角色），按 sort_order。 */
export function listMembers(sessionId: string): GroupMember[] {
  const rows = getDB()
    .query(
      `SELECT m.role_id, m.sort_order, a.name, a.intro, a.avatar_hue, a.avatar_glyph
       FROM group_members m JOIN agents a ON a.id = m.role_id
       WHERE m.session_id = ? AND a.kind = 'role' AND a.enabled = 1
       ORDER BY m.sort_order, m.joined_at`,
    )
    .all(sessionId) as {
    role_id: string;
    sort_order: number;
    name: string;
    intro: string;
    avatar_hue: number;
    avatar_glyph: string;
  }[];
  return rows.map((r) => ({
    roleId: r.role_id,
    name: r.name,
    intro: r.intro,
    avatarHue: r.avatar_hue,
    avatarGlyph: r.avatar_glyph,
    sortOrder: r.sort_order,
  }));
}

export function getSettings(sessionId: string): GroupSettings {
  const row = getDB()
    .query("SELECT reply_policy, max_passes, max_messages FROM group_settings WHERE session_id = ?")
    .get(sessionId) as { reply_policy: GroupReplyPolicy; max_passes: number; max_messages: number } | null;
  return {
    replyPolicy: row?.reply_policy ?? "route",
    maxPasses: row?.max_passes ?? GROUP_DEFAULT_MAX_PASSES,
    maxMessages: row?.max_messages ?? GROUP_DEFAULT_MAX_MESSAGES,
  };
}

/**
 * 群的消息流水（给增量和路由用）：用户消息 + 已完成、没跳过的角色发言，按 rowid。
 * 系统节点、出错 / 停下的发言不进。
 */
export function loadTranscript(sessionId: string): GroupTranscriptItem[] {
  const rows = getDB()
    .query(
      `SELECT n.rowid AS seq, n.question, n.response, n.status, n.agent_id, n.meta_json, a.name AS agent_name
       FROM nodes n LEFT JOIN agents a ON a.id = n.agent_id
       WHERE n.session_id = ? AND n.meta_json IS NOT NULL
       ORDER BY n.rowid`,
    )
    .all(sessionId) as {
    seq: number;
    question: string;
    response: string;
    status: string;
    agent_id: string | null;
    meta_json: string;
    agent_name: string | null;
  }[];
  const out: GroupTranscriptItem[] = [];
  for (const r of rows) {
    let meta: GroupNodeMeta | null = null;
    try {
      meta = groupNodeMeta(JSON.parse(r.meta_json));
    } catch {
      meta = null;
    }
    if (meta?.kind === "group-user") {
      out.push({ seq: r.seq, roleId: null, name: GROUP_USER_LABEL, text: r.question });
    } else if (meta?.kind === "group-reply" && !meta.skipped && r.status === "done" && r.response.trim()) {
      out.push({ seq: r.seq, roleId: meta.roleId, name: r.agent_name ?? "已删除的角色", text: r.response });
    }
  }
  return out;
}

function lastMessageOf(sessionId: string): Group["lastMessage"] {
  const t = loadTranscript(sessionId).at(-1);
  if (!t) return null;
  const name = t.roleId ? t.name : "你";
  return { name, text: t.text.replace(/\s+/g, " ").trim().slice(0, 60) };
}

function toGroup(row: GroupSessionRow): Group {
  return {
    id: row.id,
    name: row.title,
    workDir: row.workspace_path,
    members: listMembers(row.id),
    settings: getSettings(row.id),
    model: row.model,
    createdAt: row.created_at,
    lastActiveAt: row.updated_at,
    lastMessage: lastMessageOf(row.id),
    round: activeRound(row.id),
  };
}

export function listGroups(): Group[] {
  const rows = getDB()
    .query(
      "SELECT id, title, workspace_path, model, created_at, updated_at, archived FROM sessions WHERE kind = 'group' AND archived = 0 ORDER BY updated_at DESC",
    )
    .all() as GroupSessionRow[];
  return rows.map(toGroup);
}

export function getGroup(sessionId: string): Group | null {
  const row = groupRow(sessionId);
  return row ? toGroup(row) : null;
}

export function isGroupSession(sessionId: string | null | undefined): boolean {
  return !!sessionId && !!groupRow(sessionId);
}
// ---------------------------------------------------------------- 写

const NAME_MAX = 40;

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function parseName(v: unknown): string {
  if (typeof v !== "string" || !v.trim()) throw new GroupError("群名必填", 400);
  const name = v.trim();
  if (Array.from(name).length > NAME_MAX) throw new GroupError(`群名最多 ${NAME_MAX} 个字`, 400);
  return name;
}

function parseWorkDir(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") throw new GroupError("workDir 必须是字符串或 null", 400);
  const w = v.trim();
  if (!w) return null;
  if (!path.isAbsolute(w)) throw new GroupError("workDir 必须是绝对路径", 400);
  if (!isDirectory(w)) throw new GroupError(`workDir 不存在或不是目录：${w}`, 400);
  return path.resolve(w);
}

function parseRoleIds(v: unknown, field: string): string[] {
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new GroupError(`${field} 必须是字符串数组`, 400);
  }
  const ids = [...new Set(v as string[])];
  for (const id of ids) {
    const a = getAgent(id);
    if (!a || a.kind !== "role") throw new GroupError(`不是角色：${id}`, 400);
    if (!a.enabled) throw new GroupError(`角色已停用：${a.name}`, 400);
  }
  return ids;
}

export function parseGroupInput(body: Record<string, unknown>): GroupInput {
  const roleIds = parseRoleIds(body.roleIds, "roleIds");
  if (roleIds.length < GROUP_MIN_MEMBERS || roleIds.length > GROUP_MAX_MEMBERS) {
    throw new GroupError(`群里要有 ${GROUP_MIN_MEMBERS}–${GROUP_MAX_MEMBERS} 位角色`, 400);
  }
  return {
    name: parseName(body.name),
    roleIds,
    workDir: parseWorkDir(body.workDir),
    provider: isProviderId(body.provider) ? body.provider : undefined,
  };
}

export function parseGroupPatch(body: Record<string, unknown>): GroupPatch {
  const out: GroupPatch = {};
  if (body.name !== undefined) out.name = parseName(body.name);
  if (body.workDir !== undefined) out.workDir = parseWorkDir(body.workDir);
  if (body.addRoleIds !== undefined) out.addRoleIds = parseRoleIds(body.addRoleIds, "addRoleIds");
  if (body.removeRoleIds !== undefined) {
    if (!Array.isArray(body.removeRoleIds) || body.removeRoleIds.some((x) => typeof x !== "string")) {
      throw new GroupError("removeRoleIds 必须是字符串数组", 400);
    }
    out.removeRoleIds = body.removeRoleIds as string[];
  }
  if (body.settings !== undefined) {
    const s = body.settings as Record<string, unknown> | null;
    if (!s || typeof s !== "object") throw new GroupError("settings 必须是对象", 400);
    const patch: Partial<GroupSettings> = {};
    if (s.replyPolicy !== undefined) {
      if (!GROUP_POLICIES.includes(s.replyPolicy as GroupReplyPolicy)) {
        throw new GroupError(`replyPolicy 必须是 ${GROUP_POLICIES.join(" / ")} 之一`, 400);
      }
      patch.replyPolicy = s.replyPolicy as GroupReplyPolicy;
    }
    if (s.maxPasses !== undefined) patch.maxPasses = clampSetting(s.maxPasses, GROUP_PASSES_RANGE, GROUP_DEFAULT_MAX_PASSES);
    if (s.maxMessages !== undefined) {
      patch.maxMessages = clampSetting(s.maxMessages, GROUP_MESSAGES_RANGE, GROUP_DEFAULT_MAX_MESSAGES);
    }
    out.settings = patch;
  }
  return out;
}

export function createGroup(input: GroupInput): Group {
  const db = getDB();
  const id = crypto.randomUUID();
  const now = Date.now();
  const provider = input.provider && isProviderId(input.provider) ? input.provider : DEFAULT_PROVIDER;
  db.transaction(() => {
    // root_node_id = ''：群在第一条消息之前就存在（侧栏要能看到它）；createRootInSession
    // 会在第一条根落地时回填（同 as-adopt 收编的空线程）。
    db.prepare(
      `INSERT INTO sessions (id, title, title_source, root_node_id, created_at, updated_at,
                             context_mode, workspace_path, model, kind)
       VALUES (?, ?, 'user', '', ?, ?, 'project', ?, ?, 'group')`,
    ).run(id, input.name, now, now, input.workDir ?? null, provider);
    db.prepare(
      "INSERT INTO group_settings (session_id, reply_policy, max_passes, max_messages, updated_at) VALUES (?, 'route', ?, ?, ?)",
    ).run(id, GROUP_DEFAULT_MAX_PASSES, GROUP_DEFAULT_MAX_MESSAGES, now);
    const ins = db.prepare(
      "INSERT INTO group_members (session_id, role_id, sort_order, joined_at) VALUES (?, ?, ?, ?)",
    );
    input.roleIds.forEach((rid, i) => ins.run(id, rid, i, now));
  })();
  return getGroup(id)!;
}

export function updateGroup(sessionId: string, patch: GroupPatch): Group {
  requireGroupRow(sessionId);
  const db = getDB();
  const now = Date.now();
  db.transaction(() => {
    if (patch.name !== undefined) {
      db.prepare("UPDATE sessions SET title = ?, title_source = 'user' WHERE id = ?").run(patch.name, sessionId);
    }
    if (patch.workDir !== undefined) {
      // 换了目录：成员旧 cwd 下的 CLI 会话 resume 不到了，cli_cwd 对不上时下一轮自动起新的。
      db.prepare("UPDATE sessions SET workspace_path = ? WHERE id = ?").run(patch.workDir, sessionId);
    }
    if (patch.settings && Object.keys(patch.settings).length > 0) {
      const cur = getSettings(sessionId);
      const next = { ...cur, ...patch.settings };
      db.prepare(
        `INSERT INTO group_settings (session_id, reply_policy, max_passes, max_messages, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(session_id) DO UPDATE SET reply_policy = excluded.reply_policy,
           max_passes = excluded.max_passes, max_messages = excluded.max_messages, updated_at = excluded.updated_at`,
      ).run(sessionId, next.replyPolicy, next.maxPasses, next.maxMessages, now);
    }
    if (patch.removeRoleIds?.length) {
      const del = db.prepare("DELETE FROM group_members WHERE session_id = ? AND role_id = ?");
      for (const rid of patch.removeRoleIds) del.run(sessionId, rid);
    }
    if (patch.addRoleIds?.length) {
      const maxOrder =
        (db.query("SELECT MAX(sort_order) AS m FROM group_members WHERE session_id = ?").get(sessionId) as {
          m: number | null;
        }).m ?? -1;
      const ins = db.prepare(
        "INSERT OR IGNORE INTO group_members (session_id, role_id, sort_order, joined_at) VALUES (?, ?, ?, ?)",
      );
      patch.addRoleIds.forEach((rid, i) => ins.run(sessionId, rid, maxOrder + 1 + i, now));
    }
    const count = (db.query("SELECT COUNT(*) AS c FROM group_members WHERE session_id = ?").get(sessionId) as {
      c: number;
    }).c;
    if (count > GROUP_MAX_MEMBERS) throw new GroupError(`群里最多 ${GROUP_MAX_MEMBERS} 位角色`, 400);
    if (count < GROUP_MIN_MEMBERS) throw new GroupError(`群里至少要有 ${GROUP_MIN_MEMBERS} 位角色`, 400);
  })();
  return getGroup(sessionId)!;
}

/** 删群 = 归档会话（数据保留、列表里不再出现）；进行中的一轮先停下。 */
export function archiveGroup(sessionId: string): void {
  requireGroupRow(sessionId);
  stopRound(sessionId);
  setSessionArchived(sessionId, true, Date.now());
}

// ---------------------------------------------------------------- 节点

function nid(): string {
  return crypto.randomUUID();
}

/** 新消息接在哪：会话里最后一条群消息（用户 / 角色发言，不含系统节点）。没有 = 新根。 */
function latestMessageNodeId(sessionId: string): string | null {
  const row = getDB()
    .query(
      `SELECT id FROM nodes WHERE session_id = ?
         AND json_extract(meta_json, '$.kind') IN ('group-user', 'group-reply')
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(sessionId) as { id: string } | null;
  return row?.id ?? null;
}

function createGroupNode(sessionId: string, question: string, meta: GroupNodeMeta, agentId: string | null): string {
  const nodeId = nid();
  const now = Date.now();
  const parent = latestMessageNodeId(sessionId);
  if (parent) {
    createBranchNode({ nodeId, parentId: parent, question, parentAnchor: null, now });
  } else {
    createRootInSession({ sessionId, nodeId, question, now });
  }
  getDB()
    .prepare("UPDATE nodes SET meta_json = ?, agent_id = ?, agent_scope = ? WHERE id = ?")
    .run(JSON.stringify(meta), agentId, agentId ? "group" : null, nodeId);
  return nodeId;
}

function patchNodeMeta(nodeId: string, patch: Record<string, unknown>): void {
  const row = getDB().query("SELECT meta_json FROM nodes WHERE id = ?").get(nodeId) as { meta_json: string | null } | null;
  let cur: Record<string, unknown> = {};
  try {
    cur = row?.meta_json ? JSON.parse(row.meta_json) : {};
  } catch {
    cur = {};
  }
  getDB().prepare("UPDATE nodes SET meta_json = ? WHERE id = ?").run(JSON.stringify({ ...cur, ...patch }), nodeId);
}

function nodeSeq(nodeId: string): number {
  return (getDB().query("SELECT rowid AS seq FROM nodes WHERE id = ?").get(nodeId) as { seq: number } | null)?.seq ?? 0;
}
// ---------------------------------------------------------------- 提示词

/** 追加在角色人设（+ 记忆说明）之后的群聊说明。 */
export function buildGroupSystemPrompt(groupName: string, self: GroupMember, members: GroupMember[]): string {
  const others = members.filter((m) => m.roleId !== self.roleId);
  const roster = others.map((m) => `- ${m.name}${m.intro ? `：${m.intro}` : ""}`).join("\n");
  return [
    `# 你在一个群聊里`,
    ``,
    `群名「${groupName}」。你是「${self.name}」。群里还有用户本人，以及这些角色：`,
    ``,
    roster || "（暂时没有别的角色）",
    ``,
    `规则：`,
    `- 群消息以「[名字]：内容」的格式发给你，「[${GROUP_USER_LABEL}]」是用户本人。你只看得到发给你的这些消息。`,
    `- 只代表你自己发言：不替别人说话，回复开头不要加「[${self.name}]：」之类的署名。`,
    `- 简短：一般 1–4 句。有新东西才说，不复述别人已经说过的；同意就说同意并补一个具体的点。`,
    `- 需要某位接话时在回复里 @ 他的名字（例如 @${others[0]?.name ?? "名字"}），一次最多 @ 一两位；不需要就别 @，也不要 @ 自己。`,
    `- 讨论出结论、需要落成任务时，提醒用户点「让管家记成任务」，不要自己去建任务。`,
  ].join("\n");
}

export type TurnTrigger =
  | { kind: "user" }
  | { kind: "route" }
  | { kind: "optional" }
  | { kind: "handoff"; from: string }
  | { kind: "continue" };

/** 这一轮喂给成员的那条「用户消息」：没看过的群消息 + 为什么轮到它。 */
export function buildTurnPrompt(delta: { text: string; count: number }, trigger: TurnTrigger): string {
  const why =
    trigger.kind === "handoff"
      ? `「${trigger.from}」在上面 @ 了你，轮到你接话。`
      : trigger.kind === "route"
        ? "调度挑了你来回应上面这条消息。"
        : trigger.kind === "optional"
          ? `每位成员都会看到这条消息。你有要补充的就直接说；没有就只回「${GROUP_SKIP_TOKEN}」这四个字，别的什么都不写。`
          : trigger.kind === "continue"
            ? "用户让大家接着讨论，轮到你。"
            : "用户在群里发了消息，轮到你回。";
  return [
    delta.count > 0 ? `群里有 ${delta.count} 条你还没看过的消息：` : "（群里没有你没看过的新消息）",
    "",
    delta.text,
    "",
    "———",
    why,
    "直接写你要在群里说的话。",
  ].join("\n");
}

// ---------------------------------------------------------------- 一位成员发言

export type GroupStreamArgs = {
  member: GroupMember;
  members: GroupMember[];
  prompt: string;
  trigger: TurnTrigger;
  /** 最近一条用户消息（mock 据此决定要不要接力 / 跳过） */
  lastUserText: string;
  signal: AbortSignal;
};

type StreamOverride = (args: GroupStreamArgs) => AsyncIterable<ProviderEvent>;
type RouterOverride = (args: { text: string; members: GroupMember[] }) => Promise<string | null>;
let streamOverride: StreamOverride | null = null;
let routerOverride: RouterOverride | null = null;

/** 测试用：替换所有成员发言的流 / 路由（null 复原）。 */
export function __setGroupStreamForTests(fn: StreamOverride | null): void {
  streamOverride = fn;
}
export function __setGroupRouterForTests(fn: RouterOverride | null): void {
  routerOverride = fn;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * mock 引擎的群聊版：不吃人设，回一句可辨认的话。用户消息里带「接力」时每位都 @ 下一位
 * （用来在隔离实例里走满 3 遍 / 10 条看上限卡）；「都跳过」时可选发言一律（跳过）。
 */
async function* groupMockStream(a: GroupStreamArgs): AsyncGenerator<ProviderEvent> {
  const idx = a.members.findIndex((m) => m.roleId === a.member.roleId);
  const next = a.members[(idx + 1) % a.members.length];
  let text: string;
  if (a.trigger.kind === "optional" && a.lastUserText.includes("都跳过")) {
    text = GROUP_SKIP_TOKEN;
  } else {
    const lines = a.prompt.split("\n").filter((l) => l.startsWith("["));
    const last = lines.at(-1) ?? "";
    text = `（mock）我是${a.member.name}，看到 ${lines.length} 条新消息，最近一条：「${last.slice(0, 40)}」。`;
    if (a.lastUserText.includes("接力") && next && next.roleId !== a.member.roleId) {
      text += ` @${next.name} 你接着说。`;
    }
  }
  for (let i = 0; i < text.length; i += 6) {
    if (a.signal.aborted) {
      yield { type: "error", message: "aborted" };
      return;
    }
    await sleep(15);
    yield { type: "delta", text: text.slice(i, i + 6) };
  }
  yield { type: "done", usage: { input: Math.ceil(a.prompt.length / 4), output: Math.ceil(text.length / 4), cacheRead: 0, cacheCreation: 0 } };
}

type MemberRow = {
  cli_session_id: string | null;
  cli_family: string | null;
  cli_cwd: string | null;
  last_seen_seq: number;
};

function memberRow(sessionId: string, roleId: string): MemberRow | null {
  return getDB()
    .query("SELECT cli_session_id, cli_family, cli_cwd, last_seen_seq FROM group_members WHERE session_id = ? AND role_id = ?")
    .get(sessionId, roleId) as MemberRow | null;
}

/** 成员在群里的 cwd：群配了目录用群的，否则用它自己的（work_dir ?? 角色目录）。 */
function memberCwd(groupWorkDir: string | null, role: AgentRecord): string {
  if (groupWorkDir && isDirectory(groupWorkDir)) return groupWorkDir;
  return planRoleNewSession(role.id)?.workspacePath ?? os.homedir();
}

function resumeIdOf(nodeId: string, family: ProviderFamily): string | null {
  if (family === "mock") return null;
  const col = family === "codex" ? "codex_session_id" : "claude_session_id";
  return (getDB().query(`SELECT ${col} AS sid FROM nodes WHERE id = ?`).get(nodeId) as { sid: string | null } | null)?.sid ?? null;
}

export type TurnResult = { nodeId: string; status: "done" | "error"; text: string; skipped: boolean };

type QueueItem = { roleId: string; trigger: TurnTrigger; replyTo: GroupReplyTo | null };

async function runMemberTurn(
  ctx: RoundCtx,
  item: QueueItem,
  members: GroupMember[],
  groupName: string,
  groupWorkDir: string | null,
): Promise<TurnResult | null> {
  const member = members.find((m) => m.roleId === item.roleId);
  const role = getAgent(item.roleId);
  const row = memberRow(ctx.sessionId, item.roleId);
  if (!member || !role || !row) return null;
  const family = providerFamily(ctx.provider);
  const cwd = memberCwd(groupWorkDir, role);

  // 只 resume 同一家族、同一 cwd 下、jsonl 还在的会话；否则起新会话、从最近的消息喂起。
  let resumeId = row.cli_family === family && row.cli_cwd === cwd ? row.cli_session_id : null;
  if (resumeId && family === "claude" && !claudeJsonlExists(resumeId, cwd)) resumeId = null;
  const transcript = loadTranscript(ctx.sessionId);
  const lastUserText = [...transcript].reverse().find((t) => t.roleId === null)?.text ?? "";
  const delta = formatUnseenDelta(transcript, {
    selfRoleId: item.roleId,
    lastSeenSeq: resumeId || family === "mock" ? row.last_seen_seq : 0,
    maxItems: resumeId ? undefined : 30,
  });
  const prompt = buildTurnPrompt(delta, item.trigger);

  const nodeId = createGroupNode(
    ctx.sessionId,
    "",
    { kind: "group-reply", roleId: item.roleId, pass: ctx.round.pass, roundId: ctx.round.id, replyTo: item.replyTo },
    item.roleId,
  );
  ctx.round.current = { roleId: item.roleId, nodeId };
  emitNode(ctx.sessionId, nodeId);
  emitRound(ctx);

  let agentSpawn: AgentSpawn | null = null;
  if (family !== "mock") {
    const base = resolveAgentSpawn(role, family, cwd);
    const extras = roleSpawnExtras(role, cwd);
    const groupPrompt = buildGroupSystemPrompt(groupName, member, members);
    agentSpawn = {
      ...base,
      ...(extras ?? {}),
      appendSystemPrompt: [extras?.appendSystemPrompt, groupPrompt].filter(Boolean).join("\n\n"),
    };
  }
  const llm = getProvider(ctx.provider, { mode: "project" });
  const settled = new Promise<"done" | "error">((resolve) => {
    startRun({
      nodeId,
      resumeFamily: family,
      // 本轮 CLI 会话 id 先落在节点上，结束后搬到成员行（下一次 resume 用）。
      sessionIdTarget: family === "mock" ? undefined : "node",
      interactive: family !== "mock",
      requireApproval: false,
      pushOnDone: false,
      factory: (signal, rctx) => {
        const args: GroupStreamArgs = { member, members, prompt, trigger: item.trigger, lastUserText, signal };
        if (streamOverride) return streamOverride(args);
        if (family === "mock") return groupMockStream(args);
        return llm.stream({
          history: [],
          question: prompt,
          signal,
          platform: { sessionId: ctx.sessionId, nodeId },
          claudeSessionId: resumeId,
          cwd,
          systemPrompt: null,
          agent: agentSpawn,
          chatEnhanced: false,
          forkSession: false,
          requireApproval: false,
          attachments: [],
          onCanUseTool: rctx?.onCanUseTool,
        });
      },
      onSettled: (r) => resolve(r.status),
    });
  });
  const status = await settled;
  const node = getNode(nodeId);
  const text = node?.response ?? "";
  const skipped = status === "done" && item.trigger.kind === "optional" && isSkipReply(text);
  if (skipped) patchNodeMeta(nodeId, { skipped: true });

  const sid = resumeIdOf(nodeId, family) ?? resumeId;
  getDB()
    .prepare(
      `UPDATE group_members SET cli_session_id = ?, cli_family = ?, cli_cwd = ?,
         last_seen_seq = CASE WHEN ? THEN ? ELSE last_seen_seq END
       WHERE session_id = ? AND role_id = ?`,
    )
    .run(sid, family, cwd, status === "done" ? 1 : 0, nodeSeq(nodeId), ctx.sessionId, item.roleId);
  if (skipped) emitNode(ctx.sessionId, nodeId);
  return { nodeId, status, text, skipped };
}

// ---------------------------------------------------------------- 路由

const ROUTE_SYSTEM_PROMPT =
  "你是群聊的调度员。根据用户最新一条消息和最近的上下文，从成员名单里挑一位最适合回应的成员。只输出那位成员的名字本身，不要标点、解释或别的字。";

async function routeOne(ctx: RoundCtx, text: string, members: GroupMember[]): Promise<string> {
  const fallback = members[0].roleId;
  if (routerOverride) return (await routerOverride({ text, members })) ?? fallback;
  const byName = routeByName(text, members);
  if (byName) return byName;
  const family = providerFamily(ctx.provider);
  if (family === "mock") return fallback;
  const recent = loadTranscript(ctx.sessionId)
    .slice(-7, -1)
    .map((t) => `[${t.name}]：${t.text.replace(/\s+/g, " ").slice(0, 200)}`)
    .join("\n");
  const roster = members.map((m) => `- ${m.name}${m.intro ? `：${m.intro}` : ""}`).join("\n");
  const prompt = `成员：\n${roster}\n\n最近的上下文：\n${recent || "（无）"}\n\n用户最新一条消息：\n${text.slice(0, 1500)}\n\n挑谁回（只写名字）：`;
  try {
    const out = await runLabelSpawn(ROUTE_SYSTEM_PROMPT, prompt, family === "codex" ? "codex" : "claude");
    return (out && pickRoutedMember(out, members)) ?? fallback;
  } catch {
    return fallback;
  }
}
// ---------------------------------------------------------------- 一轮

function excerpt(text: string, n = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

type FirstPass =
  | { kind: "queue"; items: QueueItem[] }
  | { kind: "route"; text: string };

async function runRound(ctx: RoundCtx, first: FirstPass): Promise<void> {
  const row = requireGroupRow(ctx.sessionId);
  const members = listMembers(ctx.sessionId);
  const budget = new GroupRoundBudget(ctx.round.maxPasses, ctx.round.maxMessages);
  let queue: QueueItem[];
  if (first.kind === "route") {
    ctx.round.status = "routing";
    emitRound(ctx);
    const roleId = await routeOne(ctx, first.text, members);
    queue = [{ roleId, trigger: { kind: "route" }, replyTo: null }];
  } else {
    queue = first.items;
  }
  ctx.round.status = "running";

  let limit: { reason: "passes" | "messages"; pending: QueueItem[] } | null = null;
  outer: for (;;) {
    const next: QueueItem[] = [];
    for (let i = 0; i < queue.length; i++) {
      if (ctx.stopped) break outer;
      if (!budget.canSpeak()) {
        limit = { reason: "messages", pending: [...queue.slice(i), ...next] };
        break outer;
      }
      const item = queue[i];
      ctx.round.queued = queue.slice(i + 1).map((q) => q.roleId);
      ctx.round.current = { roleId: item.roleId, nodeId: null };
      emitRound(ctx);
      const r = await runMemberTurn(ctx, item, members, row.title, row.workspace_path);
      if (!r || r.status !== "done" || r.skipped || !r.text.trim()) continue;
      budget.spoke();
      ctx.round.messages = budget.messages;
      const speaker = members.find((m) => m.roleId === item.roleId)!;
      for (const target of replyHandoffs(r.text, members, item.roleId)) {
        // 这一遍里还排着的人会看到这条，不必再排一次。
        if (queue.slice(i + 1).some((q) => q.roleId === target)) continue;
        if (next.some((q) => q.roleId === target)) continue;
        next.push({
          roleId: target,
          trigger: { kind: "handoff", from: speaker.name },
          replyTo: { nodeId: r.nodeId, name: speaker.name, excerpt: excerpt(r.text) },
        });
      }
    }
    if (ctx.stopped || next.length === 0) break;
    if (!budget.canAdvance()) {
      limit = { reason: "passes", pending: next };
      break;
    }
    budget.advance();
    ctx.round.pass = budget.pass;
    queue = next;
  }

  ctx.round.current = null;
  ctx.round.queued = [];
  if (ctx.stopped) {
    ctx.round.status = "stopped";
  } else if (limit) {
    ctx.round.status = "limit";
    const title =
      limit.reason === "passes"
        ? `这一轮已经来回 ${budget.pass} 遍，先停在这。`
        : `这一轮已经说了 ${budget.messages} 条，先停在这。`;
    const { nodeId } = appendSystemNode({
      sessionId: ctx.sessionId,
      title,
      body: title,
      kind: "group-round-end",
      meta: {
        roundId: ctx.round.id,
        reason: limit.reason,
        passes: budget.pass,
        messages: budget.messages,
        pending: limit.pending.map((p) => ({ roleId: p.roleId, triggerNodeId: p.replyTo?.nodeId ?? null })),
      },
    });
    // 上限卡是在你眼前插进来的，不算「完成·未读」。
    getDB().prepare("UPDATE nodes SET read_at = ? WHERE id = ?").run(Date.now(), nodeId);
    emitNode(ctx.sessionId, nodeId);
  } else {
    ctx.round.status = "done";
  }
  ctx.round.endedAt = Date.now();
}

function startRound(sessionId: string, provider: ProviderId, first: FirstPass): GroupRound {
  const settings = getSettings(sessionId);
  const ctx: RoundCtx = {
    sessionId,
    provider,
    stopped: false,
    round: {
      id: nid(),
      status: "running",
      pass: 1,
      maxPasses: settings.maxPasses,
      messages: 0,
      maxMessages: settings.maxMessages,
      current: null,
      queued: [],
      startedAt: Date.now(),
      endedAt: null,
    },
    done: Promise.resolve(),
  };
  G.rounds.set(sessionId, ctx);
  ctx.done = runRound(ctx, first)
    .catch((e) => {
      console.error(`[groups] ${sessionId} 这一轮出错：`, e);
      ctx.round.status = "stopped";
      ctx.round.endedAt = Date.now();
    })
    .finally(() => {
      if (G.rounds.get(sessionId) === ctx) G.rounds.delete(sessionId);
      emitRound(ctx);
    });
  return { ...ctx.round };
}

function resolveProvider(sessionModel: string | null, requested: unknown): ProviderId {
  if (isProviderId(requested)) return requested;
  if (sessionModel && isProviderId(sessionModel)) return sessionModel;
  return DEFAULT_PROVIDER;
}

/** 用户在群里发一条消息：落库 + 起这一轮（不等它跑完）。这一轮还没完 → 409。 */
export function sendGroupMessage(
  sessionId: string,
  text: unknown,
  provider?: unknown,
): { node: ApiNode; round: GroupRound | null } {
  const row = requireGroupRow(sessionId);
  if (typeof text !== "string" || !text.trim()) throw new GroupError("消息不能为空", 400);
  if (text.length > 100_000) throw new GroupError("消息过长", 400);
  if (G.rounds.has(sessionId)) throw new GroupError("这一轮还在进行，先停下或等它说完", 409);
  const members = listMembers(sessionId);
  if (members.length === 0) throw new GroupError("群里没有可用的角色", 409);

  const nodeId = createGroupNode(sessionId, text, { kind: "group-user" }, null);
  finalizeNode({ nodeId, status: "done", tokenInput: 0, tokenOutput: 0, tokenCacheRead: 0, tokenCacheCreation: 0, now: Date.now() });
  getDB().prepare("UPDATE nodes SET read_at = ? WHERE id = ?").run(Date.now(), nodeId);
  emitNode(sessionId, nodeId);

  const plan = planUserResponders(text, members, getSettings(sessionId).replyPolicy);
  let round: GroupRound | null = null;
  const p = resolveProvider(row.model, provider);
  if (plan.mode === "route") {
    round = startRound(sessionId, p, { kind: "route", text });
  } else if (plan.mode === "mention" || plan.mode === "all") {
    const trigger: TurnTrigger = plan.mode === "all" && plan.optional ? { kind: "optional" } : { kind: "user" };
    round = startRound(sessionId, p, {
      kind: "queue",
      items: plan.roleIds.map((roleId) => ({ roleId, trigger, replyTo: null })),
    });
  }
  return { node: getNode(nodeId)!, round };
}

/**
 * 「继续讨论」：从上一张上限卡里还排着的人接着说；卡里没人排着就让上一轮说过话的人依次再说一遍。
 * 上限卡之后用户又发过消息（卡已经过时）→ 409。
 */
export function continueGroupRound(sessionId: string, provider?: unknown): GroupRound {
  const row = requireGroupRow(sessionId);
  if (G.rounds.has(sessionId)) throw new GroupError("这一轮还在进行", 409);
  const db = getDB();
  const last = db
    .query(
      `SELECT id, meta_json FROM nodes WHERE session_id = ? AND meta_json IS NOT NULL
       ORDER BY rowid DESC LIMIT 1`,
    )
    .get(sessionId) as { id: string; meta_json: string } | null;
  const meta = last ? groupNodeMeta(JSON.parse(last.meta_json)) : null;
  if (meta?.kind !== "group-round-end") throw new GroupError("没有可以继续的讨论", 409);
  const members = listMembers(sessionId);
  const alive = new Set(members.map((m) => m.roleId));
  let items: QueueItem[] = meta.pending
    .filter((p) => alive.has(p.roleId))
    .map((p) => {
      const trig = p.triggerNodeId ? getNode(p.triggerNodeId) : null;
      const from = trig?.agentId ? members.find((m) => m.roleId === trig.agentId) : undefined;
      return from && trig
        ? {
            roleId: p.roleId,
            trigger: { kind: "handoff", from: from.name } as TurnTrigger,
            replyTo: { nodeId: trig.id, name: from.name, excerpt: excerpt(trig.response) },
          }
        : { roleId: p.roleId, trigger: { kind: "continue" } as TurnTrigger, replyTo: null };
    });
  if (items.length === 0) {
    const spoke = (
      db
        .query(
          `SELECT DISTINCT json_extract(meta_json, '$.roleId') AS rid FROM nodes
           WHERE session_id = ? AND json_extract(meta_json, '$.roundId') = ? AND json_extract(meta_json, '$.kind') = 'group-reply'`,
        )
        .all(sessionId, meta.roundId) as { rid: string }[]
    )
      .map((r) => r.rid)
      .filter((rid) => alive.has(rid));
    items = (spoke.length ? spoke : members.map((m) => m.roleId)).map((roleId) => ({
      roleId,
      trigger: { kind: "continue" } as TurnTrigger,
      replyTo: null,
    }));
  }
  return startRound(sessionId, resolveProvider(row.model, provider), { kind: "queue", items });
}

/** 停下这一轮：不再排新的人，正在说的那位立即中断。没有进行中的轮次 = false。 */
export function stopRound(sessionId: string): boolean {
  const ctx = G.rounds.get(sessionId);
  if (!ctx) return false;
  ctx.stopped = true;
  const nodeId = ctx.round.current?.nodeId;
  if (nodeId) abortRun(nodeId);
  return true;
}
