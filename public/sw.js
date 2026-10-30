// Trellis service worker —— Web Push + 主屏角标 + app shell 离线兜底。
//
// fetch 处理只管两类请求，其余（/api/*、/term、RSC 请求、跨域……）一律不 respondWith，
// 照常走网络、绝不进缓存（接口带鉴权数据，缓存既有泄漏面又会陈旧）：
//   ① 页面导航（app 自己的几条路由）：network-first，3s 没回来、断网或 5xx（隧道断了）→
//      回退到上一次成功的同路径 HTML（app shell）。shell 本身不含会话数据（主界面是 client
//      page，数据走 /api），最近会话的「秒开」在页面里用 IndexedDB 做（lib/offline-cache.ts）。
//   ② /_next/static/*：文件名带内容 hash、不可变 → cache-first。
//
// 鉴权：未登录时导航会被 proxy.ts 重定向到 /login —— 重定向（opaqueredirect / redirected）
// 和 /login 本身都不进缓存。登出 / 落到登录页时页面会清掉全部 trellis-* 缓存
// （lib/offline-cache.ts clearOfflineData，app/login/page.tsx 调）。
//
// 版本：页面以 /sw.js?v=<构建版本> 注册（lib/push-client.ts swUrl，值来自 next.config）。
// 部署后脚本 URL 变 → 浏览器装新 SW → activate 删掉不属于本版本的缓存，再预热新 shell。
// v=dev（next dev）时不接管任何请求：dev 的 chunk 没有 hash，cache-first 会卡住 HMR。
//
// 推送 payload 由 lib/push.ts buildPushPayload / buildHerdrPushPayload 构造（badge 由
// lib/server/push.ts 发送时补）：
//   { kind: done | waiting | resolved | test, title, body, tag, url, sessionId, nodeId, badge? }
// 经 hub 中继时网关会改写（tenancy/gateway/push.ts）：url → /__gw/go/<机器>/...，tag 前缀机器名，
// badge 为各机器之和。

const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const OFFLINE_ENABLED = VERSION !== "dev";
const SHELL_CACHE = `trellis-shell-${VERSION}`;
const STATIC_CACHE = `trellis-static-${VERSION}`;
const NAV_TIMEOUT_MS = 3000;

/** 能当 app shell 缓存 / 回退的导航路径。/login、/term、/api 等都不在内。 */
function isShellPath(pathname) {
  return (
    pathname === "/" ||
    pathname === "/herdr" ||
    pathname === "/butler" ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/") ||
    pathname.startsWith("/settings/")
  );
}

/** 只缓存「真拿到了这一页」的响应：同源 200、没被重定向（未登录会被导去 /login）、是 HTML。 */
function cacheableShell(res) {
  if (!res || res.status !== 200 || res.type !== "basic" || res.redirected) return false;
  if (new URL(res.url).pathname === "/login") return false;
  return (res.headers.get("content-type") || "").includes("text/html");
}

/** shell 按路径缓存，去掉 ?session= 等查询串。 */
function shellKey(url) {
  return new URL(url.pathname, self.location.origin).href;
}

const STATIC_RE = /\/_next\/static\/[^"'\s()\\<>]+/g;

/** 静态资源只缓存真正的资源响应。上游挂掉时网关会用一张 HTML 维护页顶替 CSS/JS
 * （曾经还是 200），cache-first 收下它就会让页面长期无样式，直到下一次部署换缓存。 */
function cacheableStatic(res) {
  return res.ok && res.type === "basic" && !(res.headers.get("content-type") || "").includes("text/html");
}

/** 把 shell HTML 里引用到的 /_next/static 资源补进缓存（已有的跳过）。 */
async function warmAssets(html) {
  const urls = new Set((html.match(STATIC_RE) || []).map((p) => new URL(p, self.location.origin).href));
  if (urls.size === 0) return;
  const cache = await caches.open(STATIC_CACHE);
  await Promise.all(
    [...urls].map(async (u) => {
      try {
        if (await cache.match(u)) return;
        const res = await fetch(u);
        if (cacheableStatic(res)) await cache.put(u, res);
      } catch {
        /* 预热失败无妨：真用到时 fetch 处理器还会再取 */
      }
    }),
  );
}

async function storeShell(key, res) {
  const html = await res.clone().text();
  const cache = await caches.open(SHELL_CACHE);
  await cache.put(key, res);
  await warmAssets(html);
}

/** 预热主界面 shell：SW 刚装上时页面是在它之前加载的，那次导航没经过 fetch 处理器。 */
async function warmShell() {
  try {
    const res = await fetch("/", { credentials: "same-origin", cache: "no-store" });
    if (cacheableShell(res)) await storeShell(shellKey(new URL("/", self.location.origin)), res);
  } catch {
    /* 离线 / 未登录：等下一次成功导航再缓存 */
  }
}

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set([SHELL_CACHE, STATIC_CACHE]);
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k.startsWith("trellis-") && !keep.has(k)).map((k) => caches.delete(k)));
      await self.clients.claim();
      if (OFFLINE_ENABLED) await warmShell();
    })(),
  );
});

function offlinePage() {
  const html =
    '<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Trellis · 离线</title><body style="font-family:system-ui;padding:2rem;line-height:1.6">' +
    '<h1 style="font-size:1.1rem">连不上 Trellis</h1><p>当前离线，这台设备上也还没有可用的页面缓存。</p>' +
    '<p><a href="">重试</a></p></body></html>';
  return new Response(html, { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

async function handleNavigation(event, url) {
  const key = shellKey(url);
  const network = fetch(event.request);
  // 网络回来就更新 shell（不阻塞响应）。注意先注册这个 then：clone 必须发生在浏览器读 body 之前。
  const updated = network
    .then(async (res) => {
      if (cacheableShell(res)) await storeShell(key, res.clone());
      return res;
    })
    .catch(() => null);
  event.waitUntil(updated);

  const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), NAV_TIMEOUT_MS));
  const first = await Promise.race([network.then((res) => res, () => "error"), timeout]);
  // 正常回来（含 307 去登录页、4xx）原样给浏览器；只有超时 / 断网 / 5xx 才考虑缓存。
  if (first instanceof Response && first.status < 500) return first;
  const hit = await caches.open(SHELL_CACHE).then((c) => c.match(key));
  if (hit) return hit;
  if (first instanceof Response) return first;
  // 没缓存：超时就继续等网络，彻底失败给一张离线说明页。
  if (first === "timeout") {
    const res = await updated;
    if (res) return res;
  }
  return offlinePage();
}

async function handleStatic(request) {
  const cache = await caches.open(STATIC_CACHE);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (cacheableStatic(res)) await cache.put(request, res.clone());
  return res;
}

self.addEventListener("fetch", (event) => {
  if (!OFFLINE_ENABLED) return;
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (req.mode === "navigate") {
    if (isShellPath(url.pathname)) event.respondWith(handleNavigation(event, url));
    return;
  }
  if (url.pathname.startsWith("/_next/static/")) event.respondWith(handleStatic(req));
  // 其余（含全部 /api/*）不接管：不缓存、不改写。
});

/** 主屏角标（Badging API）。payload 没带 badge 时不动；不支持 / 没权限时静默。 */
async function applyBadge(n) {
  if (typeof n !== "number" || !("setAppBadge" in self.navigator)) return;
  try {
    if (n > 0) await self.navigator.setAppBadge(n);
    else await self.navigator.clearAppBadge();
  } catch {
    /* 没通知权限等 */
  }
}

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
  //
  // 收回（kind = resolved，lib/server/herdr-push.ts）：同 tag 静默替换掉那条「需要你」，再把它
  // 关掉。仍然先 showNotification，守住上面那条 iOS 规矩；替换不响（renotify 关、silent 开）。
  const resolved = data.kind === "resolved";
  if (resolved) {
    options.renotify = false;
    options.silent = true;
  }
  event.waitUntil(
    (async () => {
      await self.registration.showNotification(title, options);
      if (resolved) {
        try {
          const shown = await self.registration.getNotifications({ tag: options.tag });
          for (const n of shown) n.close();
        } catch {
          /* 不支持 getNotifications：留着那条「已处理」，下一条同 tag 的会替换它 */
        }
      }
      await applyBadge(data.badge);
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
        // 经 hub 中继来的通知（url = /__gw/go/<机器>/...）必须整页导航：网关要换机器 cookie，
        // 站内切会话会在「当前那台」上找这个 sessionId，切错机器。
        const viaHub = target.pathname.startsWith("/__gw/go/");
        // url 里的定位参数（?focus=pending / ?pane=<窗格>，lib/push.ts）一并交给页面：
        // 站内切过去之后滚到并聚焦那张卡（hooks/usePushBridge）。没绑会话的 Herdr 窗格
        // （?view=herdr&pane=）同样站内处理：打开总览再定位。
        const pane = target.searchParams.get("pane");
        if (home && !viaHub && (data.sessionId || pane)) {
          home.postMessage({
            type: "trellis-open-session",
            sessionId: data.sessionId,
            nodeId: data.nodeId,
            url: target.pathname + target.search,
          });
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
