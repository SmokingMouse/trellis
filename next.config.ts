import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["trellis.smokingmouse.cc"],
  // Codex SDK uses createRequire(import.meta.url) at runtime to resolve the
  // platform-specific CLI binary. Bundling breaks that resolution. Keep it
  // external so it runs from real node_modules.
  serverExternalPackages: ["@openai/codex-sdk", "@openai/codex"],
  // Cloudflare-tunneled dev: CF's CDN rewrites `Cache-Control: no-cache`
  // (which Next dev sends) into `max-age=14400`, so edits to globals.css
  // don't reach the browser via trellis.smokingmouse.cc until 4h later.
  // `no-store` is one of the few directives CF won't override — they
  // treat it as bypass-cache. Only apply in dev; production builds use
  // hashed filenames so caching is actually useful there.
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
