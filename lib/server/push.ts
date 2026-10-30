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

// Web Push 出口：VAPID 密钥、订阅表、发送、触发点调用的两个入口
// （pushTurnDone / pushWaitingGroups）。
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
};
const shared = globalThis as Shared;
const dedupe = (shared.trellisPushDedupe ??= new Map());
const presence = (shared.trellisPushPresence ??= new Map());

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
  recordPresence(presence, clientId, sessionId, visible, Date.now());
}

// ── 触发点入口 ─────────────────────────────────────────────────────────────
//
// 都是同步调用、立刻返回：门槛判断（开关 / 有无订阅 / 前台 / 去重）同步做完，真正的
// 网络发送丢到后台。调用方都在 run 收尾或 DB 写路径上，推送慢或失败绝不能拖住它们。

function gate(kind: PushKind, sessionId: string): boolean {
  if (!pushKindAllowed(readPushSettings(), kind)) return false;
  // 本机没订阅不代表没人收：挂在 hub 下时还要交给 hub 中继（见 fire）。
  if (countSubscriptions() === 0 && !hubRelayTarget()) return false;
  const now = Date.now();
  if (isSessionForeground(presence, sessionId, now)) return false;
  return takeDedupeSlot(dedupe, dedupeKey(kind, sessionId), now);
}

/** 当前「等你回答」的会话数，随每条推送带给 SW 设主屏角标。快照在 pushWaitingGroups
 *  被调之前已经换成新版（pending.ts），所以这里读到的就是含本次新项的总数。 */
function currentBadge(): number {
  return waitingBadgeCount(shared.trellisPendingSnapshot?.items ?? []);
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

function fire(payload: PushPayload): void {
  const full = { ...payload, badge: currentBadge() };
  if (countSubscriptions() > 0) {
    void sendPush(full).catch((err) => console.warn("[push] 发送异常：", err));
  }
  if (hubRelayTarget()) void relayPushToHub(full);
}

/** 一轮回答正常结束（run-bus / AS 两条执行路径的终态处各调一次）。 */
export function pushTurnDone(nodeId: string): void {
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
    console.warn("[push] pushTurnDone：", err);
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
