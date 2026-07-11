import type { NextConfig } from "next";
import os from "node:os";

const isDev = process.env.NODE_ENV !== "production";

// Allow tunneled dev (e.g. Cloudflare Tunnel, ngrok) to reach next dev.
// Set TRELLIS_DEV_ORIGIN=your.host.example to whitelist a custom origin.
const devOrigin = process.env.TRELLIS_DEV_ORIGIN;

const nextConfig: NextConfig = {
  ...(devOrigin ? { allowedDevOrigins: [devOrigin] } : {}),
  // @sm/agent + @sm/llm are `file:` dependencies pointing at ~/sdk (absolute
  // path, outside this project dir entirely — not even a sibling). npm links
  // them as symlinks whose targets sit outside this project dir. Turbopack
  // only follows symlinks within its workspace root, so point the root at a
  // common ancestor of trellis and ~/sdk — otherwise `import ... from
  // "@sm/agent"` fails to resolve at build time whenever node_modules holds
  // the symlink (which any `npm install` recreates). Lets npm's natural
  // linking stay harmless.
  turbopack: {
    root: os.homedir(),
  },
  // Codex SDK uses createRequire(import.meta.url) at runtime to resolve the
  // platform-specific CLI binary. Bundling breaks that resolution. Keep it
  // external so it runs from real node_modules.
  // @sm/agent 是 server-only Node 包(spawn child_process),external 它从 node_modules
  // 直接运行(dist 编译产物),不进 bundler。@sm/llm 同理(读 fs)。
  serverExternalPackages: ["@openai/codex-sdk", "@openai/codex", "@sm/agent", "@sm/llm"],
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
