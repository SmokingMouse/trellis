// Web Push 发送的共用底层：VAPID 密钥落盘、Topic 头、代理选择、真实网络发送。
// node 侧（lib/server/push.ts）与 hub 网关（tenancy/gateway/push.ts）各持一套密钥、
// 各自的订阅表，但发送方式完全一样，所以抽到这里。只依赖 node: 内置模块与 web-push，
// 不带 "server-only"（网关是裸 bun 进程，不经 Next 打包）。

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";

export type VapidKeys = { publicKey: string; privateKey: string; subject: string };
export type PushTarget = { endpoint: string; p256dh: string; auth: string };
export type PushSendOptions = { TTL: number; urgency: "normal" | "high"; topic?: string };

// Apple 的推送服务要求 JWT sub 是 mailto: 或 https:，localhost 一类会被拒（BadJwtToken）。
export const DEFAULT_VAPID_SUBJECT = "mailto:trellis@users.noreply.github.com";

function readVapidFile(file: string): VapidKeys | null {
  try {
    const v = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<VapidKeys>;
    if (typeof v.publicKey !== "string" || typeof v.privateKey !== "string") return null;
    return { publicKey: v.publicKey, privateKey: v.privateKey, subject: v.subject || DEFAULT_VAPID_SUBJECT };
  } catch {
    return null;
  }
}

/** 读密钥文件；没有就生成一次（0600，目录 0700）。换私钥 = 既有订阅全部作废，所以只生成一次。 */
export function loadOrCreateVapid(file: string): VapidKeys {
  let keys = readVapidFile(file);
  if (!keys) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const fresh = webpush.generateVAPIDKeys();
    const next: VapidKeys = {
      publicKey: fresh.publicKey,
      privateKey: fresh.privateKey,
      subject: process.env.TRELLIS_PUSH_SUBJECT || DEFAULT_VAPID_SUBJECT,
    };
    try {
      // wx：两个 bundle / 进程同时首次生成时只有一个写得进去，另一个读回赢家的。
      fs.writeFileSync(file, JSON.stringify(next, null, 2) + "\n", { mode: 0o600, flag: "wx" });
      keys = next;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      keys = readVapidFile(file);
      if (!keys) throw new Error(`${file} 已存在但读不出密钥`);
    }
  }
  // umask / 手动拷贝都可能让权限变宽，每次进程首读都收紧一次。
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* 只读挂载等：读得出来就照用 */
  }
  return keys;
}

/** Topic 头：推送服务对同 topic 的未投递消息只留最新一条（手机离线时防积压）。
 *  规范限 ≤32 个 base64url 字符，所以取 hash。 */
export function topicFor(tag: string): string {
  return crypto.createHash("sha256").update(tag).digest("base64url").slice(0, 32);
}

/** 按 payload.kind 定 TTL / urgency：「等你回答」一直有效到被处理；「完成」过了几小时再收到没意义；
 *  收回（resolved）与「等你回答」同 TTL——它靠同一个 Topic 顶掉手机离线时还没送达的那条。 */
export function sendOptionsFor(kind: string, tag: string): PushSendOptions {
  return {
    TTL: kind === "waiting" || kind === "resolved" ? 24 * 3600 : 6 * 3600,
    urgency: kind === "waiting" ? "high" : "normal",
    topic: topicFor(tag),
  };
}

// 推送端点在公网（FCM / APNs / Mozilla）。本机若靠 http(s)_proxy 出网（实测 FCM 直连不通），
// web-push 不会自己读环境变量，要显式传 proxy。TRELLIS_PUSH_PROXY 优先，设成 "off" 强制直连。
export function proxyFor(endpoint: string): string | undefined {
  const explicit = process.env.TRELLIS_PUSH_PROXY;
  if (explicit === "off") return undefined;
  const proxy = explicit || process.env.https_proxy || process.env.HTTPS_PROXY;
  if (!proxy) return undefined;
  if (!explicit) {
    const host = new URL(endpoint).hostname;
    const noProxy = (process.env.no_proxy || process.env.NO_PROXY || "")
      .split(",")
      .map((s) => s.trim().replace(/^\*?\./, ""))
      .filter(Boolean);
    if (noProxy.some((d) => host === d || host.endsWith(`.${d}`))) return undefined;
  }
  return proxy;
}

export async function webPushSend(
  vapid: VapidKeys,
  sub: PushTarget,
  body: string,
  opts: PushSendOptions,
): Promise<{ statusCode: number }> {
  const res = await webpush.sendNotification(
    { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
    body,
    {
      TTL: opts.TTL,
      urgency: opts.urgency,
      ...(opts.topic ? { topic: opts.topic } : {}),
      vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
      proxy: proxyFor(sub.endpoint),
      timeout: 10_000,
    },
  );
  return { statusCode: res.statusCode };
}

export function safeHost(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return "?";
  }
}
