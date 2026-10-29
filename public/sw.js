// Trellis service worker —— 只做 Web Push，不做离线缓存。
//
// 刻意没有 fetch 处理器：trellis 是一台机器上的实时应用，缓存页面 / 接口只会制造
// 「看到的是旧版本」这类问题；没有 fetch 处理器时浏览器照常走网络，SW 不在请求路径上。
//
// 推送 payload 由 lib/push.ts buildPushPayload 构造：
//   { kind, title, body, tag, url, sessionId, nodeId }

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : "" };
  }
  const title = data.title || "Trellis";
  const options = {
    body: data.body || "",
    // 同一会话的后一条原地替换前一条；renotify 让替换时仍然响一次。
    tag: data.tag || "trellis",
    renotify: true,
    icon: "/icons/icon-192.png",
    badge: "/icons/badge-96.png",
    timestamp: Date.now(),
    data: { url: data.url || "/", sessionId: data.sessionId || null, nodeId: data.nodeId || null, kind: data.kind || null },
  };
  // 前台判定在服务端做（页面心跳，见 hooks/usePushBridge），到这里的都该显示 ——
  // iOS 对「收到推送却不弹通知」的 SW 会直接吊销订阅，所以这里永远 showNotification。
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      // 告诉打开着的页面（验收 / 调试用；页面不处理也无妨）。
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const c of all) c.postMessage({ type: "trellis-push", payload: data });
    })(),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const target = new URL(data.url || "/", self.location.origin);
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const same = all.filter((c) => new URL(c.url).origin === target.origin);
      // 优先已经停在主界面（/）的窗口：发消息让它站内切会话，不整页重载。
      const home = same.find((c) => new URL(c.url).pathname === "/");
      const client = home || same[0];
      if (client) {
        try {
          await client.focus();
        } catch {
          /* 有的平台不给聚焦，照样继续导航 */
        }
        if (home && data.sessionId) {
          home.postMessage({ type: "trellis-open-session", sessionId: data.sessionId, nodeId: data.nodeId });
          return;
        }
        if ("navigate" in client) {
          try {
            await client.navigate(target.href);
            return;
          } catch {
            /* 未受控窗口不让 navigate → 退到开新窗 */
          }
        }
      }
      await self.clients.openWindow(target.href);
    })(),
  );
});
