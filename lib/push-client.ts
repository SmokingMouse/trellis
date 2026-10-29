"use client";
import { PREF_KEYS, readRaw, writeRaw } from "@/lib/prefs";

// 浏览器侧的 Web Push：注册 SW、订阅 / 退订、环境探测。UI 在 components/PushSettings.tsx，
// 页面级桥接（SW 消息、前台心跳）在 hooks/usePushBridge.ts。

export type PushEnv = {
  /** 浏览器有 SW + PushManager + Notification。 */
  supported: boolean;
  /** 安全上下文（https / localhost）。不是的话 SW 根本注册不了。 */
  secure: boolean;
  ios: boolean;
  /** 从主屏图标打开（display-mode: standalone / navigator.standalone）。 */
  standalone: boolean;
};

export function detectPushEnv(): PushEnv {
  if (typeof window === "undefined") return { supported: false, secure: false, ios: false, standalone: false };
  const ua = navigator.userAgent;
  // iPadOS 13+ 的 Safari 报的是 Mac UA，靠触屏点数区分。
  const ios = /iPad|iPhone|iPod/.test(ua) || (ua.includes("Macintosh") && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia?.("(display-mode: standalone)").matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true;
  return {
    supported: "serviceWorker" in navigator && "PushManager" in window && "Notification" in window,
    secure: window.isSecureContext,
    ios,
    standalone,
  };
}

export function swUrl(): string {
  return `/sw.js?v=${encodeURIComponent(process.env.NEXT_PUBLIC_TRELLIS_SW_VERSION || "dev")}`;
}

export async function registerPushWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator) || !window.isSecureContext) return null;
  try {
    // updateViaCache: none —— SW 脚本本身永远走网络取，改了推送逻辑下次打开就生效。
    // ?v= 是构建版本（next.config swVersion）：部署后脚本 URL 变了，浏览器装新 SW 并在
    // activate 时清掉旧版本的离线缓存（public/sw.js）。
    return await navigator.serviceWorker.register(swUrl(), { scope: "/", updateViaCache: "none" });
  } catch (err) {
    console.warn("[push] service worker 注册失败：", err);
    return null;
  }
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  const reg = await registerPushWorker();
  if (!reg) return null;
  return reg.pushManager.getSubscription();
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.trim());
  return (await res.json()) as T;
}

/** 必须在用户手势里调用（iOS 只在点击里放行授权弹窗）。 */
export async function subscribePush(): Promise<PushSubscription> {
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(permission === "denied" ? "通知权限被拒绝，请在系统设置里允许" : "没有拿到通知权限");
  const reg = await registerPushWorker();
  if (!reg) throw new Error("service worker 注册失败");
  await navigator.serviceWorker.ready;
  const { publicKey } = await json<{ publicKey: string }>(await fetch("/api/push/key"));
  const key = urlBase64ToUint8Array(publicKey);
  let sub = await reg.pushManager.getSubscription();
  // 服务端换过 VAPID 密钥时，旧订阅绑的是旧公钥，推送服务会拒 —— 先退掉再订。
  if (sub && !sameKey(sub.options.applicationServerKey, key)) {
    await sub.unsubscribe().catch(() => {});
    sub = null;
  }
  sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  await json(
    await fetch("/api/push/subscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON() }),
    }),
  );
  // 标记本浏览器已订阅：DoneToast 的页内系统通知看到它就让位（同一件事别弹两条）。
  writeRaw(PREF_KEYS.pushSubscribed, "1");
  return sub;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

export async function unsubscribePush(): Promise<void> {
  const sub = await currentSubscription();
  writeRaw(PREF_KEYS.pushSubscribed, "0");
  if (!sub) return;
  const endpoint = sub.endpoint;
  await sub.unsubscribe().catch(() => {});
  await fetch("/api/push/subscribe", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ endpoint }),
  });
}

export type PushTestReport = {
  sent: number;
  removed: number;
  failed: { endpointHost: string; status: number | null; message: string }[];
};

export async function sendTestPush(endpoint?: string): Promise<PushTestReport> {
  return json<PushTestReport>(
    await fetch("/api/push/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(endpoint ? { endpoint } : {}),
    }),
  );
}

export async function serverKnows(endpoint: string): Promise<{ known: boolean; total: number }> {
  return json(await fetch(`/api/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`));
}

export function pushSubscribedHere(): boolean {
  return readRaw(PREF_KEYS.pushSubscribed) === "1";
}
