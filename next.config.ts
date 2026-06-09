import type { NextConfig } from "next";
import path from "node:path";

const isDev = process.env.NODE_ENV !== "production";

// Allow tunneled dev (e.g. Cloudflare Tunnel, ngrok) to reach next dev.
// Set TRELLIS_DEV_ORIGIN=your.host.example to whitelist a custom origin.
const devOrigin = process.env.TRELLIS_DEV_ORIGIN;

const nextConfig: NextConfig = {
  ...(devOrigin ? { allowedDevOrigins: [devOrigin] } : {}),
  // agent-gateway is a sibling `file:` dependency (../../agent-gateway), so npm
  // links it as a symlink whose target sits OUTSIDE this project dir. Turbopack
  // only follows symlinks within its workspace root, so point the root at the
  // shared parent — otherwise `import ... from "agent-gateway"` fails to
  // resolve at build time whenever node_modules holds the symlink (which any
  // `npm install` recreates). Lets npm's natural linking stay harmless.
  turbopack: {
    root: path.join(__dirname, "..", ".."),
  },
  // Codex SDK uses createRequire(import.meta.url) at runtime to resolve the
  // platform-specific CLI binary. Bundling breaks that resolution. Keep it
  // external so it runs from real node_modules.
  // agent-gateway 是 server-only Node 包(spawn child_process),external 它从 node_modules
  // 直接运行(dist 编译产物),不进 bundler。
  serverExternalPackages: ["@openai/codex-sdk", "@openai/codex", "agent-gateway"],
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
