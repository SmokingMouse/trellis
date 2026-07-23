import type { NextConfig } from "next";
import os from "node:os";

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

const nextConfig: NextConfig = {
  ...(devOrigin ? { allowedDevOrigins: [devOrigin] } : {}),
  turbopack: {
    root: projectRoot,
  },
  // Codex SDK uses createRequire(import.meta.url) at runtime to resolve the
  // platform-specific CLI binary. Bundling breaks that resolution. Keep it
  // external so it runs from real node_modules.
  // @smokingmouse/agent 是 server-only Node 包(spawn child_process),external 它从 node_modules
  // 直接运行(dist 编译产物),不进 bundler。@smokingmouse/llm 同理(读 fs)。
  serverExternalPackages: ["@openai/codex-sdk", "@openai/codex", "@smokingmouse/agent", "@smokingmouse/llm"],
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
