import "server-only";
// 阻塞交互的存取与长轮询。
//
// 一次交互的生命周期：
//   hook 首段轮询 → 建行（pending）→ 前端看到 HookSummary.blocking → 用户作答（resolved）
//   / 点「交给终端」（handoff）→ hook 下一次轮询拿到结果、打到 stdout 退出。
// hook 每段最多挂 25s，断线（trellis 重启、部署）后脚本最多重连 2 分钟；server 侧
// 按 last_seen_at 保留 3 分钟：期间重连的 hook 用同一个确定性 id 认领同一行。
// 超过 30 分钟未答 → expired，hook 无输出退出，TUI 照常弹框。
import { getDB } from "@/lib/server/sqlite";
import { getHookRecord, recordClaudeHook } from "./store";
import {
  INTERACTION_DETACH_GRACE_MS,
  INTERACTION_MAX_WAIT_MS,
  INTERACTION_TTL_MS,
  blockingKind,
  canonicalJson,
  hookOutput,
  interactionId,
  summaryFields,
  validateResolution,
  type BlockingKind,
  type BlockingSummary,
  type InteractionResolution,
} from "./interaction-core";
import type { ClaudeHookPayload } from "./types";

export type InteractionStatus = "pending" | "resolved" | "handoff" | "expired" | "cancelled";

export type PollResult =
  | { status: "pending"; id: string }
  | { status: "done"; id: string; output: Record<string, unknown> }
  | { status: "pass"; id: string | null; reason: string };

/** 一段轮询之后多久内仍算「hook 连着」（段长 25s + 余量）。 */
const CONNECTED_WINDOW_MS = 40_000;
/** 已了结的行留一天备查。 */
const INTERACTION_RETENTION_MS = 24 * 60 * 60_000;

type Row = {
  id: string;
  session_id: string;
  pane_key: string | null;
  kind: BlockingKind;
  tool_name: string;
  tool_use_id: string | null;
  payload: string;
  status: InteractionStatus;
  resolution: string | null;
  created_at: number;
  last_seen_at: number;
  resolved_at: number | null;
};

// 同进程内的唤醒：作答路由 resolve 之后立刻叫醒挂着的那段长轮询。
const shared = globalThis as typeof globalThis & {
  __trellisHookIxWaiters?: Map<string, Set<() => void>>;
};
function waiters(): Map<string, Set<() => void>> {
  return (shared.__trellisHookIxWaiters ??= new Map());
}
function wake(id: string): void {
  const set = waiters().get(id);
  if (!set) return;
  waiters().delete(id);
  for (const fn of set) fn();
}

function parse<T>(raw: string | null): T | null {
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function getRow(id: string): Row | null {
  return (getDB().prepare("SELECT * FROM agent_hook_interaction WHERE id = ?").get(id) as Row | null) ?? null;
}

function setStatus(id: string, status: InteractionStatus, now: number, resolution: InteractionResolution | null = null): void {
  getDB()
    .prepare("UPDATE agent_hook_interaction SET status = ?, resolution = ?, resolved_at = ? WHERE id = ?")
    .run(status, resolution ? JSON.stringify(resolution) : null, now, id);
}

function touch(id: string, paneKey: string | null, now: number): void {
  getDB()
    .prepare("UPDATE agent_hook_interaction SET last_seen_at = ?, pane_key = COALESCE(?, pane_key) WHERE id = ?")
    .run(now, paneKey, id);
}

export function pruneInteractions(now = Date.now()): void {
  getDB()
    .prepare("DELETE FROM agent_hook_interaction WHERE created_at < ?")
    .run(now - INTERACTION_RETENTION_MS);
}

function expireIfStale(row: Row, now: number): Row {
  if (row.status === "pending" && now - row.created_at >= INTERACTION_TTL_MS) {
    setStatus(row.id, "expired", now);
    return { ...row, status: "expired", resolved_at: now };
  }
  return row;
}

function settle(row: Row): PollResult | null {
  if (row.status === "resolved") {
    const resolution = parse<InteractionResolution>(row.resolution);
    const payload = parse<ClaudeHookPayload>(row.payload);
    if (!resolution || !payload) return { status: "pass", id: row.id, reason: "corrupt" };
    return { status: "done", id: row.id, output: hookOutput(payload, resolution) };
  }
  if (row.status !== "pending") return { status: "pass", id: row.id, reason: row.status };
  return null;
}

/**
 * 认领（没有就建）这条 hook 对应的交互。created = 这次是新建（调用方据此推送一次变化）。
 * 新建时如果观测 hook 还没把会话标成 waiting（例如这台机器的全局 settings 没挂观测 hook），
 * 顺手补记一次，保证 herdr 等待态与「等你处理」列表能看到它；已经 waiting 就不重复记。
 */
export function claimInteraction(
  payload: ClaudeHookPayload,
  paneKey: string | null,
  attempt: string | null = null,
  now = Date.now(),
): { row: Row | null; created: boolean; kind: BlockingKind | null } {
  const kind = blockingKind(payload);
  if (!kind) return { row: null, created: false, kind: null };
  const id = interactionId(payload, attempt);
  const existing = getRow(id);
  if (existing) {
    touch(id, paneKey, now);
    return { row: expireIfStale({ ...existing, last_seen_at: now }, now), created: false, kind };
  }
  pruneInteractions(now);
  const row: Row = {
    id,
    session_id: String(payload.session_id),
    pane_key: paneKey,
    kind,
    tool_name: String(payload.tool_name),
    tool_use_id: typeof payload.tool_use_id === "string" && payload.tool_use_id ? payload.tool_use_id : null,
    payload: JSON.stringify(payload),
    status: "pending",
    resolution: null,
    created_at: now,
    last_seen_at: now,
    resolved_at: null,
  };
  getDB()
    .prepare(`INSERT INTO agent_hook_interaction
      (id, session_id, pane_key, kind, tool_name, tool_use_id, payload, status, resolution, created_at, last_seen_at, resolved_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(row.id, row.session_id, row.pane_key, row.kind, row.tool_name, row.tool_use_id, row.payload,
      row.status, row.resolution, row.created_at, row.last_seen_at, row.resolved_at);
  if (getHookRecord(row.session_id)?.state !== "waiting") {
    try {
      recordClaudeHook(payload, { paneKey, now });
    } catch {
      /* 状态补记是锦上添花，不能拦住阻塞本身 */
    }
  }
  return { row, created: true, kind };
}

/**
 * 一段长轮询：认领交互，已有结果立刻返回；否则挂到有结果、waitMs 到点或连接断开。
 * onChange 在新建 / 过期时调（路由用它推控制台变化）。
 */
export async function pollInteraction(
  payload: ClaudeHookPayload,
  paneKey: string | null,
  waitMs: number,
  options: { signal?: AbortSignal; onChange?: () => void; attempt?: string | null } = {},
): Promise<PollResult> {
  const claimed = claimInteraction(payload, paneKey, options.attempt ?? null);
  if (!claimed.row) return { status: "pass", id: null, reason: "not-blocking" };
  if (claimed.created) options.onChange?.();
  const id = claimed.row.id;
  const early = settle(claimed.row);
  if (early) return early;

  const wait = Math.max(0, Math.min(waitMs, INTERACTION_MAX_WAIT_MS, claimed.row.created_at + INTERACTION_TTL_MS - Date.now()));
  await new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", finish);
      waiters().get(id)?.delete(finish);
      resolve();
    };
    const timer = setTimeout(finish, wait);
    options.signal?.addEventListener("abort", finish);
    let set = waiters().get(id);
    if (!set) waiters().set(id, (set = new Set()));
    set.add(finish);
    if (options.signal?.aborted) finish();
  });

  const now = Date.now();
  const row = getRow(id);
  if (!row) return { status: "pass", id, reason: "gone" };
  // 断开那一刻也记下：3 分钟的保留期从 hook 最后一次在线算起。
  touch(id, null, now);
  const fresh = expireIfStale(row, now);
  const result = settle(fresh);
  if (result) {
    if (fresh.status === "expired") options.onChange?.();
    return result;
  }
  return { status: "pending", id };
}

export type ResolveResult =
  | { ok: true; connected: boolean }
  | { ok: false; status: 400 | 404 | 409; error: string };

function liveRow(id: string, now: number): Row | ResolveResult {
  const raw = getRow(id);
  if (!raw) return { ok: false, status: 404, error: "交互不存在" };
  const row = expireIfStale(raw, now);
  if (row.status !== "pending") return { ok: false, status: 409, error: `交互已${STATUS_TEXT[row.status]}` };
  if (now - row.last_seen_at > INTERACTION_DETACH_GRACE_MS) {
    return { ok: false, status: 409, error: "终端那边的 hook 已经断开，交互作废" };
  }
  return row;
}

const STATUS_TEXT: Record<InteractionStatus, string> = {
  pending: "在等待",
  resolved: "作答过了",
  handoff: "交给终端",
  expired: "过期",
  cancelled: "撤销",
};

/** 用户在 Trellis 上作答。body 形状见 interaction-core 的 validateResolution。 */
export function resolveInteraction(id: string, body: unknown, now = Date.now()): ResolveResult {
  const row = liveRow(id, now);
  if ("ok" in row) return row;
  const payload = parse<ClaudeHookPayload>(row.payload);
  const resolution = payload ? validateResolution(row.kind, payload, body) : null;
  if (!resolution) return { ok: false, status: 400, error: "作答与交互不匹配" };
  // 条件更新：并发的两次作答只有一次生效。
  const changed = getDB()
    .prepare("UPDATE agent_hook_interaction SET status = 'resolved', resolution = ?, resolved_at = ? WHERE id = ? AND status = 'pending'")
    .run(JSON.stringify(resolution), now, id).changes;
  if (changed === 0) return { ok: false, status: 409, error: "交互已经了结" };
  wake(id);
  return { ok: true, connected: now - row.last_seen_at < CONNECTED_WINDOW_MS };
}

/** 「交给终端」：hook 无输出退出，TUI 照常弹框。 */
export function handoffInteraction(id: string, now = Date.now()): ResolveResult {
  const row = liveRow(id, now);
  if ("ok" in row) return row;
  const changed = getDB()
    .prepare("UPDATE agent_hook_interaction SET status = 'handoff', resolved_at = ? WHERE id = ? AND status = 'pending'")
    .run(now, id).changes;
  if (changed === 0) return { ok: false, status: 409, error: "交互已经了结" };
  wake(id);
  return { ok: true, connected: now - row.last_seen_at < CONNECTED_WINDOW_MS };
}

/**
 * 观测 hook 报告了后续事件：还挂着的同会话交互作废，前端卡片随之收起。返回作废了几条。
 *   PostToolUse / PostToolUseFailure：只作废同一次工具调用的（tool_use_id 相同；
 *     PermissionRequest 不带 tool_use_id → 比对工具名 + 规范化 input）。并行工具里别的
 *     调用跑完，不能把这张还在等的授权卡带走。
 *   Stop / StopFailure / UserPromptSubmit / SessionEnd：这一轮已经过去了，全部作废
 *     （用户在电脑上 Esc 掉了挂着的 hook，之后就是这些事件）。
 */
export function cancelInteractionsForEvent(payload: ClaudeHookPayload, now = Date.now()): number {
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : "";
  const event = payload.hook_event_name;
  if (!sessionId) return 0;
  const all = event === "Stop" || event === "StopFailure" || event === "UserPromptSubmit" || event === "SessionEnd";
  const perTool = event === "PostToolUse" || event === "PostToolUseFailure";
  if (!all && !perTool) return 0;
  const rows = getDB()
    .prepare("SELECT id, tool_name, tool_use_id, payload FROM agent_hook_interaction WHERE session_id = ? AND status = 'pending'")
    .all(sessionId) as Pick<Row, "id" | "tool_name" | "tool_use_id" | "payload">[];
  let n = 0;
  for (const row of rows) {
    if (perTool) {
      const toolUseId = typeof payload.tool_use_id === "string" ? payload.tool_use_id : null;
      const same = row.tool_use_id
        ? row.tool_use_id === toolUseId
        : row.tool_name === payload.tool_name &&
          canonicalJson(parse<ClaudeHookPayload>(row.payload)?.tool_input ?? null) === canonicalJson(payload.tool_input ?? null);
      if (!same) continue;
    }
    setStatus(row.id, "cancelled", now);
    wake(row.id);
    n++;
  }
  return n;
}

/** 答完后多久内还把「已作答」告诉前端。 */
const RESOLVED_VISIBLE_MS = 10 * 60_000;

/**
 * 按会话给出阻塞交互（每个会话取最新一条），并进 HookSummary.blocking：
 * 仍在等的（hook 3 分钟内在线、没过 30 分钟），或 10 分钟内刚在 Trellis 上答过的。
 */
export function listBlockingSummaries(now = Date.now()): Map<string, BlockingSummary> {
  const rows = getDB()
    .prepare(`SELECT * FROM agent_hook_interaction
      WHERE (status = 'pending' AND created_at > ? AND last_seen_at > ?)
         OR (status = 'resolved' AND resolved_at > ?)
      ORDER BY created_at ASC`)
    .all(now - INTERACTION_TTL_MS, now - INTERACTION_DETACH_GRACE_MS, now - RESOLVED_VISIBLE_MS) as Row[];
  const out = new Map<string, BlockingSummary>();
  for (const row of rows) {
    const payload = parse<ClaudeHookPayload>(row.payload) ?? {};
    out.set(row.session_id, {
      id: row.id,
      kind: row.kind,
      toolName: row.tool_name,
      toolUseId: row.tool_use_id,
      ...(row.status === "pending" ? summaryFields(row.kind, payload) : {}),
      createdAt: row.created_at,
      status: row.status === "pending" ? "pending" : "resolved",
      connected: now - row.last_seen_at < CONNECTED_WINDOW_MS,
    });
  }
  return out;
}

/** 单测 / 排查用。 */
export function getInteraction(id: string): { status: InteractionStatus; resolution: InteractionResolution | null } | null {
  const row = getRow(id);
  return row ? { status: row.status, resolution: parse<InteractionResolution>(row.resolution) } : null;
}
