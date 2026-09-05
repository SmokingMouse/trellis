import type { NextConfig } from "next";
import os from "node:os";
import { DEFAULT_SETTINGS_TAB } from "./lib/settings-tabs";

const isDev = process.env.NODE_ENV !== "production";

// @smokingmouse/agent + @smokingmouse/llm are normal registry dependencies
// now (real directories inside node_modules) — no symlink games in the
// default install path. This wider `root` only still matters for the local
// SDK-hacking flow (`make link-sdk`, which symlinks the two packages back to
// ~/sdk): Turbopack only follows symlinks *within* its configured root, and
// ~/sdk sits outside the project dir, so root must be a common ancestor.
// Harmless otherwise (long since proven in prod on this machine), so it
// stays unconditional rather than link-detection-conditional.
const projectRoot = os.homedir();

// Allow tunneled dev (e.g. Cloudflare Tunnel, ngrok) to reach next dev.
// Set TRELLIS_DEV_ORIGIN=your.host.example to whitelist a custom origin.
const devOrigin = process.env.TRELLIS_DEV_ORIGIN;
const distDir = process.env.TRELLIS_DIST_DIR;

const nextConfig: NextConfig = {
  ...(distDir ? { distDir } : {}),
  // 127.0.0.1 必须显式进白名单：Next 16 dev 的跨源防护只认启动 hostname（localhost）。
  // 用 http://127.0.0.1:<port> 打开 dev 页时，HMR WebSocket 握手带 Origin: http://127.0.0.1
  // 会被 dev server **静默掐断**（不回 HTTP 响应、不打日志），而 dev 的 RSC/hydration
  // promise 与这条 WS 绑死（vercel/next.js#91770）—— 症状是整页 SSR 正常渲染但 React
  // 永不 hydrate、交互全死、console 零报错（S75 悬案，S97 破案，全链见 failures.md）。
  // 判法：curl 加 `-H "Origin: http://127.0.0.1:<port>"` 打 /_next/webpack-hmr 收到空响应，
  // 换 localhost Origin 收到 101。
  allowedDevOrigins: ["127.0.0.1", ...(devOrigin ? [devOrigin] : [])],
  turbopack: {
    root: projectRoot,
  },
  // Codex SDK uses createRequire(import.meta.url) at runtime to resolve the
  // platform-specific CLI binary. Bundling breaks that resolution. Keep it
  // external so it runs from real node_modules.
  // @smokingmouse/agent 是 server-only Node 包(spawn child_process),external 它从 node_modules
  // 直接运行(dist 编译产物),不进 bundler。@smokingmouse/llm 同理(读 fs)。
  // S134：@larksuiteoapi/node-sdk 及其依赖 ws 也必须 external。Turbopack 默认把它们内联进
  // server chunk，而 Bun 只对**按名字** require("ws") 做原生 WebSocket 替换 —— 内联的真 ws 走
  // node http upgrade 路径，在 Bun 下握手直接 `Unexpected server response: 101`，飞书长连接
  // 永远连不上且 SDK 不回调（prod 只见 "[ws] ws connect failed"）。external 之后运行时按名解析
  // 到 Bun 的 ws 实现，launchd 下实测 0.4s onReady。scripts/test-lark-bot.ts 有守卫断言。
  serverExternalPackages: [
    "@openai/codex-sdk",
    "@openai/codex",
    "@smokingmouse/agent",
    "@smokingmouse/llm",
    "@larksuiteoapi/node-sdk",
    "ws",
  ],
  // S89: 管理台改成 tab 壳之后的两条路由兼容。放在 next.config 而不是留一张 redirect 页 ——
  // 这里在文件系统路由之前生效，不用为了转发而渲染一个 React 树，也就不会有「先闪一下空页
  // 再跳走」。
  //
  // permanent: false（307）是有意的：308 会被浏览器**永久**缓存，而这两条都还可能再动
  // （/settings 将来若做成有内容的总览页，308 会让老浏览器再也进不去）。本机应用，
  // 少一次 301 缓存的收益远小于把自己锁死的风险。
  async redirects() {
    return [
      // /settings 落到第一个 tab。默认值取自 lib/settings-tabs.ts，改 tab 顺序即改这里。
      {
        source: "/settings",
        destination: `/settings/${DEFAULT_SETTINGS_TAB}`,
        permanent: false,
      },
      // S88 时任务是顶级页 /tasks。书签、Header 旧图标、以及任何贴出去的链接都还指着它。
      { source: "/tasks", destination: "/settings/tasks", permanent: false },
    ];
  },
  // Tunneled dev (Cloudflare CDN, etc.): some CDNs rewrite Next dev's
  // `Cache-Control: no-cache` into `max-age=14400`, so edits to globals.css
  // don't reach the browser for hours. `no-store` is one of the few
  // directives CDNs typically won't override — they treat it as
  // bypass-cache. Only apply in dev; production builds use hashed
  // filenames so caching is actually useful there.
  ...(isDev
    ? {
        async headers() {
          return [
            {
              source: "/_next/:path*",
              headers: [
                {
                  key: "Cache-Control",
                  value:
                    "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0",
                },
              ],
            },
            {
              source: "/",
              headers: [
                {
                  key: "Cache-Control",
                  value: "no-store, no-cache, must-revalidate, max-age=0",
                },
              ],
            },
          ];
        },
      }
    : {}),
};

export default nextConfig;
