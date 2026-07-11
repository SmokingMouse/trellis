import type { NextConfig } from "next";
import os from "node:os";

const isDev = process.env.NODE_ENV !== "production";

// @sm/agent + @sm/llm are `file:` dependencies pointing at ~/sdk (absolute
// path, outside this project dir entirely — not even a sibling).
//
// bun's default `file:` linking is NOT a single top-level symlink like npm's
// — it creates a real directory in node_modules but symlinks every individual
// file inside it back to the source (see Makefile's `patch-deps`/`relink-sdk`
// step, which normalizes this to one clean top-level symlink per package,
// same shape npm used to produce). Turbopack's production-build file tracer
// cannot parse a per-file-symlinked package.json (`Error: package.json is
// not parseable: invalid JSON: a redirect can't be parsed as json`) — this
// bites even with root scoped correctly, it's specifically about the
// per-file symlink shape, not root breadth. The single-symlink normalization
// is the actual fix; this `root` setting is the second, independent half —
// Turbopack only follows symlinks *within* its configured root, and the
// symlink targets (~/sdk) sit outside this project dir, so root needs to be
// a common ancestor.
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
