import "server-only";
import { getDB } from "./sqlite";
import { dbWrite } from "./db-error";
import { getAgent, type AgentRecord } from "./agents";
import { createSessionWithRoot, getAppSetting, setAppSetting } from "./repo";
import {
  RoleError,
  adoptRoleHomeSession,
  ensureRoleDir,
  roleSessionMode,
  roleWorkspacePath,
} from "./roles";
import { appendSystemNode, finishSystemNode } from "./system-node";
import { isHerdrWaiting, waitingSessionIds } from "@/lib/attention";
import { pendingSummary, type PendingItem } from "@/lib/pending";
import type { HerdrConsolePane } from "@/lib/herdr-console";
import type { PendingInteraction } from "@/lib/types";
import {
  FOLLOW_STATES,
  ROLE_FOLLOW_INTERVAL_MS,
  clampStaleMinutes,
  followChecklistMarkdown,
  followTitle,
  type FollowState,
  type RoleFollowInput,
  type RoleFollowItem,
  type RoleFollowStatus,
} from "@/lib/role-follow";

// 角色 P4「跟进我的会话」（docs/roles-p2.md C，共享类型 lib/role-follow.ts）。
//
// 全局一个开关：app_settings.role_follow = { roleId, staleMinutes, baselineNeeded, lastScanAt }。
// 打开时先静默拍一张基线（已经处在这些状态的不报），之后每 15 分钟扫一遍：
//   · 普通会话（kind='user'）：等你 = pending 审批 / 提问（与侧栏「等你处理」同一判定，lib/attention）；
//     卡住 = 最新一轮在跑、输出指纹 N 分钟没变；失败 = 最新一轮出错（用户自己停的不算）；
//     完成 = 最新一轮完成且未读；
//   · Herdr 窗格：等你 = waiting / blocked（isHerdrWaiting）；卡住 = working 且最近活动早于 N 分钟；
//     完成 = done。
// 对象（会话 / 窗格）的上一次状态存 role_follow_state：状态（含落在哪个节点）没变 = 不出声；
// 离开所有状态就删行，再进来才算「新进入」。**没有新进入的就什么都不做，不调模型。**
// 有就往角色固定会话插一条 role-follow 系统节点；角色绑了飞书 bot 再用 bot 推一条（bot 身份）。

const SETTING_KEY = "role_follow";
const SESSION_SCAN_LIMIT = 300;
/** 只看最近这么久有动静的会话：半年前的失败不是「新进入」。 */
const SESSION_LOOKBACK_MS = 7 * 24 * 60 * 60_000;

type FollowSettings = {
  roleId: string | null;
  staleMinutes: number;
  /** 刚打开：下一次扫描只拍基线、不报 */
  baselineNeeded: boolean;
  lastScanAt: number | null;
};

function readSettings(): FollowSettings {
  let raw: Partial<FollowSettings> = {};
  try {
    raw = JSON.parse(getAppSetting(SETTING_KEY) ?? "{}") as Partial<FollowSettings>;
  } catch {
    raw = {};
  }
  return {
    roleId: typeof raw.roleId === "string" && raw.roleId ? raw.roleId : null,
    staleMinutes: clampStaleMinutes(raw.staleMinutes),
    baselineNeeded: raw.baselineNeeded === true,
    lastScanAt: typeof raw.lastScanAt === "number" ? raw.lastScanAt : null,
  };
}

function writeSettings(s: FollowSettings): void {
  setAppSetting(SETTING_KEY, JSON.stringify(s));
}

/** 开着跟进、且角色还在、还启用。 */
function activeFollowRole(s: FollowSettings = readSettings()): AgentRecord | null {
  if (!s.roleId) return null;
  const a = getAgent(s.roleId);
  return a && a.kind === "role" && a.enabled ? a : null;
}

export function getFollowStatus(roleId: string): RoleFollowStatus {
  const s = readSettings();
  const active = activeFollowRole(s);
  return {
    enabled: active?.id === roleId,
    activeRoleId: active?.id ?? null,
    activeRoleName: active?.name ?? null,
    staleMinutes: s.staleMinutes,
    lastScanAt: active ? s.lastScanAt : null,
  };
}

export function parseFollowInput(body: unknown): RoleFollowInput {
  const o = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (typeof o.enabled !== "boolean") throw new RoleError("enabled 必须是布尔值", 400);
  if (o.staleMinutes !== undefined && (typeof o.staleMinutes !== "number" || !Number.isFinite(o.staleMinutes))) {
    throw new RoleError("staleMinutes 必须是数字", 400);
  }
  return { enabled: o.enabled, ...(o.staleMinutes !== undefined ? { staleMinutes: o.staleMinutes as number } : {}) };
}

/** 打开 = 这个角色接管（别的角色自动关掉）并重拍基线；关掉 = 只有它自己开着时才清。 */
export function setFollow(roleId: string, input: RoleFollowInput): RoleFollowStatus {
  const a = getAgent(roleId);
  if (!a || a.kind !== "role") throw new RoleError("role not found", 404);
  const s = readSettings();
  const staleMinutes = input.staleMinutes !== undefined ? clampStaleMinutes(input.staleMinutes) : s.staleMinutes;
  if (input.enabled) {
    if (!a.enabled) throw new RoleError("角色已停用，不能开跟进", 409);
    const takeover = s.roleId !== roleId;
    if (takeover) dbWrite("roleFollowReset", () => getDB().prepare("DELETE FROM role_follow_state").run());
    writeSettings({
      roleId,
      staleMinutes,
      baselineNeeded: takeover || s.baselineNeeded,
      lastScanAt: takeover ? null : s.lastScanAt,
    });
  } else if (s.roleId === roleId) {
    dbWrite("roleFollowReset", () => getDB().prepare("DELETE FROM role_follow_state").run());
    writeSettings({ roleId: null, staleMinutes, baselineNeeded: false, lastScanAt: null });
  } else {
    writeSettings({ ...s, staleMinutes });
  }
  return getFollowStatus(roleId);
}

// ── 观察 ──────────────────────────────────────────────────────────────────

/** 一次扫描里看到的一个对象。state = null：在跑、还没到「卡住」，只为跟踪输出进度留行。 */
export type FollowObservation = {
  subject: string;
  source: "session" | "herdr";
  state: FollowState | "running" | null;
  /** 状态落在哪（节点 id）：同一会话换了一轮再失败，算新进入 */
  token: string;
  sessionId: string | null;
  title: string;
  detail: string | null;
  /** 在跑的对象的输出指纹 + 已知的最后活动时刻（herdr 有，DB 会话没有 = 首次看到算起） */
  progressSig?: string;
  progressAt?: number | null;
};

export type FollowStateRow = {
  subject: string;
  state: string;
  token: string;
  progressSig: string | null;
  progressAt: number | null;
};

type SessionScanRow = {
  id: string;
  title: string;
  node_id: string | null;
  status: string | null;
  error_message: string | null;
  read_at: number | null;
  question: string | null;
  topic_label: string | null;
  resp_len: number | null;
  tools_len: number | null;
};

function excerpt(text: string | null | undefined, max = 80): string | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return null;
  return t.length > max ? `${t.slice(0, max)}…` : t;
}

/** 普通会话的观察：最近 7 天有动静的 kind='user' 会话，看 pending 与「最新一轮真实节点」。 */
export function observeSessions(now: number): FollowObservation[] {
  const db = getDB();
  const since = now - SESSION_LOOKBACK_MS;
  const rows = db
    .prepare(
      `SELECT s.id, s.title, n.id AS node_id, n.status, n.error_message, n.read_at, n.question, n.topic_label,
              length(n.response) AS resp_len, length(n.tool_calls_json) AS tools_len
         FROM sessions s
         LEFT JOIN nodes n ON n.id = (
           SELECT id FROM nodes
            WHERE session_id = s.id AND kind = 'qa' AND meta_json IS NULL
            ORDER BY created_at DESC, id DESC LIMIT 1)
        WHERE s.kind = 'user' AND s.archived = 0 AND s.updated_at >= ?
        ORDER BY s.updated_at DESC
        LIMIT ?`,
    )
    .all(since, SESSION_SCAN_LIMIT) as SessionScanRow[];
  if (rows.length === 0) return [];

  // 等你：与侧栏 / 标签页标题同一来源（pending 快照的原料 nodes.pending_interaction_json + lib/attention）。
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const pendingRows = db
    .prepare(
      `SELECT id, session_id, created_at, pending_interaction_json FROM nodes
        WHERE pending_interaction_json IS NOT NULL AND session_id IN (${marks})`,
    )
    .all(...ids) as { id: string; session_id: string; created_at: number; pending_interaction_json: string }[];
  const pending: Pick<PendingItem, "sessionId" | "nodeId" | "summary">[] = [];
  for (const p of pendingRows) {
    try {
      const interaction = JSON.parse(p.pending_interaction_json) as PendingInteraction;
      if (!interaction?.toolUseId || !interaction.toolName) continue;
      pending.push({ sessionId: p.session_id, nodeId: p.id, summary: pendingSummary(interaction) });
    } catch {
      /* 坏 JSON：pending 快照同样跳过 */
    }
  }
  const waiting = waitingSessionIds(pending, new Set(), new Map());

  const out: FollowObservation[] = [];
  for (const r of rows) {
    const base = { subject: `s:${r.id}`, source: "session" as const, sessionId: r.id, title: r.title || "未命名会话" };
    // 说明和标题一样（首问就是标题）就不重复
    const about = (t: string | null | undefined) => {
      const e = excerpt(t);
      return e && e !== excerpt(base.title) ? e : null;
    };
    if (waiting.has(r.id)) {
      const p = pending.find((x) => x.sessionId === r.id)!;
      out.push({ ...base, state: "waiting", token: p.nodeId, detail: excerpt(p.summary) });
      continue;
    }
    if (!r.node_id) continue;
    if (r.status === "streaming") {
      out.push({
        ...base,
        state: "running",
        token: r.node_id,
        detail: about(r.topic_label ?? r.question),
        progressSig: `${r.resp_len ?? 0}:${r.tools_len ?? 0}`,
        progressAt: null,
      });
    } else if (r.status === "error" && r.error_message !== "aborted") {
      out.push({ ...base, state: "failed", token: r.node_id, detail: excerpt(r.error_message, 120) });
    } else if (r.status === "done" && r.read_at === null) {
      out.push({ ...base, state: "done", token: r.node_id, detail: about(r.topic_label ?? r.question) });
    }
  }
  return out;
}

/** Herdr 窗格的观察。shell / 离线窗格不跟。 */
export function observeHerdr(panes: HerdrConsolePane[]): FollowObservation[] {
  const out: FollowObservation[] = [];
  for (const p of panes) {
    if (p.lane === "shell" || p.lane === "off") continue;
    const base = {
      subject: `h:${p.key}`,
      source: "herdr" as const,
      sessionId: p.sessionId,
      title: p.title || p.tabLabel || "Herdr 窗格",
      token: "",
    };
    const where = [p.workspaceLabel, p.tabLabel].filter(Boolean).join(" · ") || null;
    if (p.lane === "need" || isHerdrWaiting({ alive: true, status: p.status ?? "unknown" })) {
      out.push({ ...base, state: "waiting", detail: where });
    } else if (p.status === "working") {
      out.push({ ...base, state: "running", detail: where, progressSig: String(p.activityAt ?? ""), progressAt: p.activityAt });
    } else if (p.status === "done") {
      out.push({ ...base, state: "done", detail: where });
    }
  }
  return out;
}

// ── 比较（纯函数）──────────────────────────────────────────────────────────

/**
 * 上一次的状态表 + 这一次的观察 → 要报的项 + 新状态表。
 * herdrAvailable=false：Herdr 这次没连上，h: 行原样保留（断线不能当成「全都处理掉了」，
 * 否则重连后每个窗格都会被当成新进入再报一遍）。
 */
export function diffFollow(
  prev: ReadonlyMap<string, FollowStateRow>,
  observations: readonly FollowObservation[],
  now: number,
  staleMs: number,
  opts: { herdrAvailable: boolean },
): { report: RoleFollowItem[]; next: FollowStateRow[] } {
  const report: RoleFollowItem[] = [];
  const next: FollowStateRow[] = [];
  const seen = new Set<string>();
  for (const o of observations) {
    if (seen.has(o.subject)) continue;
    seen.add(o.subject);
    const before = prev.get(o.subject);
    let state: string | null = o.state;
    let progressSig: string | null = null;
    let progressAt: number | null = null;
    if (o.state === "running") {
      progressSig = o.progressSig ?? "";
      // 输出指纹没变：沿用上次记下的「最后变化时刻」；变了（或第一次看到）从已知活动时刻 / 现在算起。
      progressAt =
        before && before.progressSig === progressSig && before.token === o.token && before.progressAt !== null
          ? before.progressAt
          : (o.progressAt ?? now);
      if (now - progressAt >= staleMs) state = "stuck";
    }
    if (state === null) continue;
    next.push({ subject: o.subject, state, token: o.token, progressSig, progressAt });
    const reportable = (FOLLOW_STATES as readonly string[]).includes(state);
    const changed = !before || before.state !== state || before.token !== o.token;
    if (reportable && changed) {
      const mins = state === "stuck" && progressAt !== null ? Math.floor((now - progressAt) / 60_000) : null;
      report.push({
        subject: o.subject,
        source: o.source,
        state: state as FollowState,
        sessionId: o.sessionId,
        title: o.title,
        detail: mins !== null ? `已经 ${mins} 分钟没有新输出${o.detail ? ` · ${o.detail}` : ""}` : o.detail,
      });
    }
  }
  if (!opts.herdrAvailable) {
    for (const [subject, row] of prev) if (subject.startsWith("h:") && !seen.has(subject)) next.push(row);
  }
  return { report, next };
}

// ── 扫描 ──────────────────────────────────────────────────────────────────

export type FollowDeps = {
  now: () => number;
  /** 当前 Herdr 窗格；Herdr 不可用 = null。不给 = 读真 fleet */
  herdrPanes?: (now: number) => HerdrConsolePane[] | null;
  /** 飞书推送（bot 身份）。返回值只用于日志 / 测试 */
  pushLark: (args: { botId: string; chatId: string; markdown: string; title: string }) => Promise<unknown>;
  publicUrl: () => string | null | undefined;
};

async function realHerdrPanes(now: number): Promise<HerdrConsolePane[] | null> {
  try {
    const { realHerdrPushDeps } = await import("./herdr-push");
    return realHerdrPushDeps.panes(now);
  } catch (e) {
    console.warn("[role-follow] 读 Herdr 窗格失败：", e);
    return null;
  }
}

function readStateRows(): Map<string, FollowStateRow> {
  const rows = getDB()
    .prepare("SELECT subject, state, token, progress_sig, progress_at FROM role_follow_state")
    .all() as { subject: string; state: string; token: string; progress_sig: string | null; progress_at: number | null }[];
  return new Map(
    rows.map((r) => [r.subject, { subject: r.subject, state: r.state, token: r.token, progressSig: r.progress_sig, progressAt: r.progress_at }]),
  );
}

function writeStateRows(rows: FollowStateRow[], now: number): void {
  const db = getDB();
  dbWrite("roleFollowState", () =>
    db.transaction(() => {
      db.prepare("DELETE FROM role_follow_state").run();
      const ins = db.prepare(
        "INSERT INTO role_follow_state (subject, state, token, progress_sig, progress_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const r of rows) ins.run(r.subject, r.state, r.token, r.progressSig, r.progressAt, now);
    })(),
  );
}

/** 往角色固定会话里插跟进节点；固定会话不在了就连会话一起建（照角色会话的 mode / cwd 规则）。 */
function appendFollowNode(role: AgentRecord, items: RoleFollowItem[], now: number): { sessionId: string; nodeId: string } {
  const title = followTitle(items);
  const body = followChecklistMarkdown(items);
  const meta = { items, scannedAt: now };
  const home = role.homeSessionId
    ? (getDB()
        .prepare("SELECT id FROM sessions WHERE id = ? AND archived = 0 AND agent_id = ?")
        .get(role.homeSessionId, role.id) as { id: string } | undefined)
    : undefined;
  if (home) {
    const { nodeId } = appendSystemNode({ sessionId: home.id, title, body, kind: "role-follow", meta });
    return { sessionId: home.id, nodeId };
  }
  const mode = roleSessionMode(role);
  const homeDir = ensureRoleDir(role.slug);
  const workspacePath = mode === "project" ? roleWorkspacePath(role) : null;
  const sessionId = crypto.randomUUID();
  const nodeId = crypto.randomUUID();
  createSessionWithRoot({
    sessionId,
    nodeId,
    title,
    question: title,
    now,
    mode,
    workspacePath,
    agentId: role.id,
    registerWorkspace: !(workspacePath && workspacePath === homeDir),
  });
  finishSystemNode(nodeId, sessionId, body, "role-follow", meta);
  adoptRoleHomeSession(role.id, sessionId);
  return { sessionId, nodeId };
}

/** 角色绑定的飞书 bot 的最近一个私聊；没有 bot / 没私聊过 = null。 */
function larkTarget(roleId: string): { botId: string; chatId: string } | null {
  const row = getDB()
    .prepare(
      `SELECT b.id AS bot_id, c.chat_id FROM lark_bots b
         JOIN lark_chats c ON c.bot_id = b.id AND c.chat_type = 'p2p'
        WHERE b.agent_id = ? AND b.enabled = 1
        ORDER BY c.last_message_at DESC, c.created_at DESC LIMIT 1`,
    )
    .get(roleId) as { bot_id: string; chat_id: string } | undefined;
  return row ? { botId: row.bot_id, chatId: row.chat_id } : null;
}

export type FollowScanResult =
  | { status: "off" }
  | { status: "not-due" }
  | { status: "baseline"; tracked: number }
  | { status: "quiet"; tracked: number }
  | { status: "reported"; tracked: number; items: RoleFollowItem[]; sessionId: string; nodeId: string; lark: unknown };

async function defaultDeps(): Promise<FollowDeps> {
  const { pushTaskRunToLark } = await import("./lark/push");
  return {
    now: Date.now,
    pushLark: (a) =>
      // nodeId 不给：跟进节点在角色会话里，不该被记成这个飞书 chat 的续聊锚点。
      pushTaskRunToLark({ botId: a.botId, chatId: a.chatId, sessionId: null, nodeId: null, markdown: a.markdown, title: a.title }),
    publicUrl: () => process.env.TRELLIS_PUBLIC_URL,
  };
}

/** 扫一遍。force=true：不管距上次多久（手动「现在扫一次」）。 */
export async function scanFollow(opts: { force?: boolean; deps?: Partial<FollowDeps> } = {}): Promise<FollowScanResult> {
  const s = readSettings();
  const role = activeFollowRole(s);
  if (!role) return { status: "off" };
  const base = await defaultDeps();
  const deps: FollowDeps = { ...base, ...opts.deps };
  const now = deps.now();
  if (!opts.force && !s.baselineNeeded && s.lastScanAt !== null && now - s.lastScanAt < ROLE_FOLLOW_INTERVAL_MS) {
    return { status: "not-due" };
  }
  const panes = deps.herdrPanes ? deps.herdrPanes(now) : await realHerdrPanes(now);
  const observations = [...observeSessions(now), ...(panes ? observeHerdr(panes) : [])];
  const { report, next } = diffFollow(readStateRows(), observations, now, s.staleMinutes * 60_000, {
    herdrAvailable: panes !== null,
  });
  writeStateRows(next, now);
  writeSettings({ ...s, baselineNeeded: false, lastScanAt: now });
  if (s.baselineNeeded) return { status: "baseline", tracked: next.length };
  if (report.length === 0) return { status: "quiet", tracked: next.length };

  const { sessionId, nodeId } = appendFollowNode(role, report, now);
  let lark: unknown = null;
  const target = larkTarget(role.id);
  if (target) {
    const pub = deps.publicUrl()?.trim() || null;
    lark = await deps
      .pushLark({ ...target, markdown: followChecklistMarkdown(report, pub), title: `${role.name} · ${followTitle(report)}` })
      .catch((e: unknown) => ({ status: "error", reason: e instanceof Error ? e.message : String(e) }));
  }
  return { status: "reported", tracked: next.length, items: report, sessionId, nodeId, lark };
}

// ── 调度 ──────────────────────────────────────────────────────────────────

const CHECK_MS = 60_000;
const g = globalThis as typeof globalThis & { __trellisRoleFollowTimer?: ReturnType<typeof setInterval> };

/** instrumentation 里起：每分钟看一眼（便宜：只读一行设置），到 15 分钟 / 刚打开要拍基线才真扫。
 * TRELLIS_SCHEDULER=off 一起关（部署冒烟实例不该往真会话里插跟进卡）。 */
export function startRoleFollowScheduler(): void {
  if (process.env.TRELLIS_SCHEDULER === "off") return;
  if (g.__trellisRoleFollowTimer) return;
  let running = false;
  const tick = () => {
    if (running) return;
    running = true;
    scanFollow()
      .then((r) => {
        if (r.status === "reported") console.log(`[role-follow] 报了 ${r.items.length} 项 → ${r.sessionId}`);
        else if (r.status === "baseline") console.log(`[role-follow] 基线：跟踪 ${r.tracked} 个对象`);
      })
      .catch((e) => console.warn("[role-follow] 扫描失败：", e))
      .finally(() => {
        running = false;
      });
  };
  g.__trellisRoleFollowTimer = setInterval(tick, CHECK_MS);
  setTimeout(tick, 5_000);
}
