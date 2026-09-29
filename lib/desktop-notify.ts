"use client";
import { PREF_KEYS, readRaw, writeRaw } from "@/lib/prefs";

// 页面在后台时的系统通知。只在「本来就会出站内提醒」的时刻发（DoneToast 驱动），
// 不另起一套事件源；站内 toast 照常出，切回来还能看到。
//
// 授权只能在用户手势里要：偏好页的开关，或第一次出完成提醒时附带的「开启」按钮
// （只问一次）。iOS 非 PWA 没有 Notification；Android Chrome 的构造器要 SW，会抛
// —— 两种都静默降级成只有站内 toast。

function supported(): boolean {
  return typeof window !== "undefined" && "Notification" in window;
}

function prefOn(): boolean {
  return readRaw(PREF_KEYS.desktopNotify) !== "0";
}

export function desktopNotifyReady(): boolean {
  return supported() && prefOn() && Notification.permission === "granted";
}

/** 还没问过授权、用户也没关掉 → 值得在站内提醒旁边问一句。 */
export function shouldOfferDesktopNotify(): boolean {
  return (
    supported() &&
    prefOn() &&
    Notification.permission === "default" &&
    readRaw(PREF_KEYS.desktopNotifyOffered) !== "1"
  );
}

export function markDesktopNotifyOffered(): void {
  writeRaw(PREF_KEYS.desktopNotifyOffered, "1");
}

/** 必须在点击等用户手势里调用。 */
export async function enableDesktopNotify(): Promise<boolean> {
  writeRaw(PREF_KEYS.desktopNotify, "1");
  if (!supported()) return false;
  if (Notification.permission === "default") {
    try {
      return (await Notification.requestPermission()) === "granted";
    } catch {
      return false;
    }
  }
  return Notification.permission === "granted";
}

export function showDesktopNotification(opts: {
  title: string;
  body?: string;
  tag: string;
  onClick: () => void;
}): void {
  if (!desktopNotifyReady()) return;
  try {
    const n = new Notification(opts.title, {
      body: opts.body,
      // 同一条提醒重发（话题标签晚到等）按 tag 原地替换，不叠第二条。
      tag: opts.tag,
      icon: "/icon.svg",
    });
    n.onclick = () => {
      window.focus();
      opts.onClick();
      n.close();
    };
  } catch {
    /* Android Chrome：只能走 ServiceWorker 通知，这里不支持就算了 */
  }
}
