import "server-only";
import os from "node:os";
import path from "node:path";
import { getDB } from "./sqlite";
import { postToHub, hubRelayTarget } from "../hub-relay-client";
import { loadOrCreateVapid, safeHost, sendOptionsFor, webPushSend, type PushSendOptions, type VapidKeys } from "../push-send";
import {
  buildPushPayload,
  dedupeKey,
  isGoneStatus,
  isSessionForeground,
  parsePushSettings,
  pushKindAllowed,
  recordPresence,
  takeDedupeSlot,
  type PresenceEntry,
  type PushKind,
  type PushPayload,
  type PushSettings,
  type PushSubscriptionInput,
  type WaitingGroup,
  waitingBadgeCount,
} from "../push";
import type { PendingSnapshot } from "../pending";
import { DoneScheduler, doneDelayFromEnv, realDoneTimers, type DoneTimers } from "../push-done";

// Web Push 出口：VAPID 密钥、订阅表、发送、触发点调用的入口
// （pushTurnDone / pushWaitingGroups；Herdr 窗格的在 ./herdr-push.ts，也经这里的 gateFor / fire 出去）。
//
// 依赖刻意只有 sqlite.ts（不走 repo.ts）：pending.ts → 这里 → repo.ts → cli-sync-events
// → pending.ts 会绕成环。这里要的那几条 SQL 直接写。
//
// 模块级状态一律挂 globalThis：Next 的 instrumentation 与各 route handler 可能被打进
// 不同 bundle（lib/server/notify.ts 注释里那次实测），模块级 Map 不保证共享。

type Shared = typeof globalThis & {
  trellisPushVapid?: VapidKeys;
  trellisPushDedupe?: Map<string, number>;
  trellisPushPresence?: Map<string, PresenceEntry>;
  trellisPushSender?: Sender;
  // lib/server/pending.ts 写的待处理快照。这里只读、不 import pending.ts（会成环，见上）。
  trellisPendingSnapshot?: PendingSnapshot;
  // ./herdr-push.ts 写的「需要你」窗格（角标计数）。同上，只读、不 import。
  trellisHerdrNeed?: { paneId: string; sessionId: string | null }[];
  // 前台心跳的旁听者（./herdr-push.ts 的「已完成」延迟裁决要知道「看过了」）。
  trellisPushSeenListeners?: Set<(sessionId: string) => void>;
  trellisPushTimers?: DoneTimers;
  trellisPushDoneScheduler?: DoneScheduler<{ nodeId: string }>;
};
const shared = globalThis as Shared;
const dedupe = (shared.trellisPushDedupe ??= new Map());
const presence = (shared.trellisPushPresence ??= new Map());
const seenListeners = (shared.trellisPushSeenListeners ??= new Set());

// 时钟 / 定时器：「已完成」的 60s 延迟、去重窗口、前台心跳都走它，单测换成假时钟。
export const pushTimers: DoneTimers = {
  now: () => (shared.trellisPushTimers ?? realDoneTimers).now(),
  setTimeout: (fn, ms) => (shared.trellisPushTimers ?? realDoneTimers).setTimeout(fn, ms),
  clearTimeout: (h) => (shared.trellisPushTimers ?? realDoneTimers).clearTimeout(h),
};

/** 测试注入：换成假时钟。传 null 恢复。 */
export function setPushTimersForTests(timers: DoneTimers | null): void {
  shared.trellisPushTimers = timers ?? undefined;
}

// ── VAPID ──────────────────────────────────────────────────────────────────
//
// 首次用到时生成，存 ~/.trellis/push-vapid.json（0600，目录 0700）。私钥只在这个
// 文件里，绝不进库、不进 git、不回给前端（前端只拿公钥）。换了私钥 = 所有既有订阅
// 作废（推送服务按公钥认人），所以只生成一次、之后只读。

// TRELLIS_PUSH_VAPID_PATH 只给单测用：Bun 的 os.homedir() 不认进程内改写的 HOME，
// 测试没法靠改 HOME 把文件挪进临时目录（启动前设 HOME 则照常生效）。
function vapidPath(): string {
  return process.env.TRELLIS_PUSH_VAPID_PATH || path.join(os.homedir(), ".trellis", "push-vapid.json");
}

export function getVapidKeys(): VapidKeys {
  return (shared.trellisPushVapid ??= loadOrCreateVapid(vapidPath()));
}

// ── 设置 ───────────────────────────────────────────────────────────────────

export function readPushSettings(): PushSettings {
  const stmt = getDB().prepare("SELECT value FROM app_settings WHERE key = ?");
  return parsePushSettings((key) => (stmt.get(key) as { value: string } | null)?.value ?? null);
}

// ── 订阅表 ─────────────────────────────────────────────────────────────────

type SubRow = { endpoint: string; p256dh: string; auth: string };

export function saveSubscription(sub: PushSubscriptionInput, ua: string | null): void {
  getDB()
    .prepare(
      `INSERT INTO push_subscriptions (endpoint, p256dh, auth, ua, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, ua = excluded.ua`,
    )
    .run(sub.endpoint, sub.p256dh, sub.auth, ua?.slice(0, 300) ?? null, Date.now());
}

export function deleteSubscription(endpoint: string): boolean {
  return getDB().prepare("DELETE FROM push_subscriptions WHERE endpoint = ?").run(endpoint).changes > 0;
}

export function hasSubscription(endpoint: string): boolean {
  return !!getDB().prepare("SELECT 1 FROM push_subscriptions WHERE endpoint = ?").get(endpoint);
}

export function countSubscriptions(): number {
  return (getDB().prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get() as { n: number }).n;
}

function listSubscriptions(endpoint?: string): SubRow[] {
  const db = getDB();
  return endpoint
    ? (db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE endpoint = ?").all(endpoint) as SubRow[])
    : (db.prepare("SELECT endpoint, p256dh, auth FROM push_subscriptions").all() as SubRow[]);
}

// ── 发送 ───────────────────────────────────────────────────────────────────

type Sender = (sub: SubRow, body: string, opts: PushSendOptions) => Promise<{ statusCode: number }>;

/** 测试注入：替换真实的网络发送。传 null 恢复。 */
export function setPushSenderForTests(sender: Sender | null): void {
  shared.trellisPushSender = sender ?? undefined;
}

const realSender: Sender = (sub, body, opts) => webPushSend(getVapidKeys(), sub, body, opts);

export type SendReport = {
  sent: number;
  removed: number;
  failed: { endpointHost: string; status: number | null; message: string }[];
};

export async function sendPush(payload: PushPayload, opts: { endpoint?: string } = {}): Promise<SendReport> {
  const subs = listSubscriptions(opts.endpoint);
  const sender = shared.trellisPushSender ?? realSender;
  const body = JSON.stringify(payload);
  const sendOpts = sendOptionsFor(payload.kind, payload.tag);
  const report: SendReport = { sent: 0, removed: 0, failed: [] };
  await Promise.all(
    subs.map(async (sub) => {
      const host = safeHost(sub.endpoint);
      try {
        await sender(sub, body, sendOpts);
        report.sent++;
        getDB().prepare("UPDATE push_subscriptions SET last_ok_at = ? WHERE endpoint = ?").run(Date.now(), sub.endpoint);
      } catch (err) {
        const status = (err as { statusCode?: number }).statusCode;
        if (isGoneStatus(status)) {
          deleteSubscription(sub.endpoint);
          report.removed++;
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        report.failed.push({ endpointHost: host, status: status ?? null, message: message.slice(0, 200) });
        console.warn(`[push] 发往 ${host} 失败（${status ?? "network"}）：${message}`);
      }
    }),
  );
  return report;
}

// ── 前台心跳 ───────────────────────────────────────────────────────────────

export function reportPresence(clientId: string, sessionId: string | null, visible: boolean): void {
  recordPresence(presence, clientId, sessionId, visible, pushTimers.now());
  // 在前台看过 = 「已完成」延迟窗口里的那次不推（自起会话与 Herdr 窗格各自的裁决器都听）。
  if (visible && sessionId) {
    doneScheduler().seen(sessionId);
    for (const listener of seenListeners) {
      try { listener(sessionId); } catch { /* 旁听者的问题不影响心跳 */ }
    }
  }
}

/** 订阅前台心跳（visible 的那几下）。返回退订函数。 */
export function onPresenceSeen(listener: (sessionId: string) => void): () => void {
  seenListeners.add(listener);
  return () => { seenListeners.delete(listener); };
}

// ── 触发点入口 ─────────────────────────────────────────────────────────────
//
// 都是同步调用、立刻返回：门槛判断（开关 / 有无订阅 / 前台 / 去重）同步做完，真正的
// 网络发送丢到后台。调用方都在 run 收尾或 DB 写路径上，推送慢或失败绝不能拖住它们。

/** 发送门槛：开关 → 有没有人收 → 前台在看 → 去重窗口。presenceId = null 表示没有对应会话（不做前台判定）。 */
export function gateFor(kind: PushKind, presenceId: string | null, dedupeId: string): boolean {
  if (!pushKindAllowed(readPushSettings(), kind)) return false;
  if (!pushReachable()) return false;
  const now = pushTimers.now();
  if (presenceId && isSessionForeground(presence, presenceId, now)) return false;
  return takeDedupeSlot(dedupe, dedupeKey(kind, dedupeId), now);
}

/** 本机有订阅、或挂在 hub 下（本机没订阅不代表没人收：hub 中继，见 fire）。 */
export function pushReachable(): boolean {
  return countSubscriptions() > 0 || !!hubRelayTarget();
}

/** 去重窗口作废（同一窗格的交互被处理掉之后，下一张卡不该被上一张的窗口挡住）。 */
export function releaseDedupe(kind: PushKind, dedupeId: string): void {
  dedupe.delete(dedupeKey(kind, dedupeId));
}

function gate(kind: PushKind, sessionId: string): boolean {
  return gateFor(kind, sessionId, sessionId);
}

/** 当前「等你回答」的数目，随每条推送带给 SW 设主屏角标：待处理快照涉及的会话 + Herdr
 *  「需要你」的窗格。快照在 pushWaitingGroups 被调之前已经换成新版（pending.ts），Herdr
 *  那份在 herdr-push.ts 推送前更新，所以读到的都含本次新项。 */
function currentBadge(): number {
  return waitingBadgeCount(shared.trellisPendingSnapshot?.items ?? [], shared.trellisHerdrNeed ?? []);
}

// ── hub 中继 ───────────────────────────────────────────────────────────────
//
// 经 hub 访问时所有机器同源，浏览器只有一份订阅，绑的是网关自己的 VAPID；各机器的订阅
// 表里没有它。所以挂在 hub 下的机器每次触发都把 payload 交给 hub（/__gw/relay/push），
// 由网关改写点击链接、按用户扇出。直连本机（例如 trellis.home:3088）的订阅仍由这里
// 自己发，两条路并存。凭证 / hub 地址见 lib/hub-relay-client.ts。

/** 交给 hub 中继。失败只记日志：hub 不在线不影响本机直连订阅。 */
export async function relayPushToHub(payload: PushPayload): Promise<boolean> {
  try {
    const res = await postToHub("/__gw/relay/push", payload);
    if (!res) return false;
    if (!res.ok) {
      console.warn(`[push] hub 中继被拒（HTTP ${res.status}）：${(await res.text().catch(() => "")).slice(0, 200)}`);
      return false;
    }
    return true;
  } catch (err) {
    console.warn("[push] hub 中继失败：", err instanceof Error ? err.message : err);
    return false;
  }
}

export function fire(payload: PushPayload): void {
  const full = { ...payload, badge: currentBadge() };
  if (countSubscriptions() > 0) {
    void sendPush(full).catch((err) => console.warn("[push] 发送异常：", err));
  }
  if (hubRelayTarget()) void relayPushToHub(full);
}

// ── 「已完成」：延迟裁决 ─────────────────────────────────────────────────────
//
// 规则见 lib/push-done.ts。自起会话的现场全在库里：同会话又冒出新节点 = 又开始干活；
// 节点 read_at 有值 = 看过了（/api/nodes/[id]/read）。前台心跳由 reportPresence 喂。
//
// 后台任务：run-bus 走 `claude -p`，一轮结束 CLI 会直接杀掉还在跑的后台 Bash / 子 agent
// （实测 task_updated status=killed），run-bus 的 done 本身就在进程退出之后——不存在「结束了
// 但后台还在跑」，这里不挂起。AS 路径的 turn completed 拿不到后台任务信号，同样不挂起。

function doneScheduler(): DoneScheduler<{ nodeId: string }> {
  return (shared.trellisPushDoneScheduler ??= new DoneScheduler<{ nodeId: string }>({
    timers: pushTimers,
    delayMs: () => doneDelayFromEnv(),
    probe: (_key, { nodeId }) => {
      const db = getDB();
      const row = db
        .prepare("SELECT session_id, created_at, read_at FROM nodes WHERE id = ?")
        .get(nodeId) as { session_id: string; created_at: number; read_at: number | null } | null;
      if (!row) return { status: "gone" };
      const newer = db
        .prepare("SELECT 1 FROM nodes WHERE session_id = ? AND id <> ? AND created_at > ? LIMIT 1")
        .get(row.session_id, nodeId, row.created_at);
      if (newer) return { status: "working" };
      return { status: "done", seen: row.read_at !== null };
    },
    deliver: (_key, { nodeId }) => sendTurnDone(nodeId),
  }));
}

/** 一轮回答正常结束（run-bus / AS 两条执行路径的终态处各调一次）。不立刻推：60s 后再裁决。 */
export function pushTurnDone(nodeId: string): void {
  try {
    if (!pushKindAllowed(readPushSettings(), "done") || !pushReachable()) return;
    const row = getDB().prepare("SELECT session_id FROM nodes WHERE id = ?").get(nodeId) as { session_id: string } | null;
    if (!row) return;
    doneScheduler().ended(`session:${row.session_id}`, { nodeId }, row.session_id);
  } catch (err) {
    console.warn("[push] pushTurnDone：", err);
  }
}

function sendTurnDone(nodeId: string): void {
  try {
    const row = getDB()
      .prepare(
        `SELECT n.session_id, n.response, s.title FROM nodes n JOIN sessions s ON s.id = n.session_id WHERE n.id = ?`,
      )
      .get(nodeId) as { session_id: string; response: string | null; title: string | null } | null;
    if (!row || !gate("done", row.session_id)) return;
    fire(
      buildPushPayload({
        kind: "done",
        sessionId: row.session_id,
        sessionTitle: row.title,
        nodeId,
        text: row.response,
      }),
    );
  } catch (err) {
    console.warn("[push] sendTurnDone：", err);
  }
}

/** 待处理快照里新冒出来的审批 / 提问（lib/server/pending.ts 重算快照时调）。 */
export function pushWaitingGroups(groups: readonly WaitingGroup[]): void {
  for (const g of groups) {
    try {
      if (!gate("waiting", g.sessionId)) continue;
      fire(
        buildPushPayload({
          kind: "waiting",
          sessionId: g.sessionId,
          sessionTitle: g.sessionTitle,
          nodeId: g.nodeId,
          text: g.summary,
          count: g.count,
        }),
      );
    } catch (err) {
      console.warn("[push] pushWaitingGroups：", err);
    }
  }
}
