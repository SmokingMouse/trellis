"use client";

// 主屏图标角标（Badging API）：装到主屏的 PWA 在图标上显示「等你回答」的会话数。
// 页面侧由 hooks/useAttentionTitle 与标题前缀同步；页面没开着时由 public/sw.js 在收到
// 推送时按 payload.badge 设。不支持的浏览器（桌面 Firefox、未装到主屏的 iOS Safari 等）
// 静默跳过；没给通知权限时 iOS 会 reject，同样吞掉。

export function syncAppBadge(count: number): void {
  if (typeof navigator === "undefined" || !("setAppBadge" in navigator)) return;
  const n = Math.max(0, Math.floor(count));
  try {
    const p = n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge();
    void p?.catch(() => {});
  } catch {
    /* 同步抛错（极少数实现）：角标只是提示，不影响页面 */
  }
}
