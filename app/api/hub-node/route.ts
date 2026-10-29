import "server-only";
import {
  parseConnectionString,
  redeemConnectionString,
  removeHubNodeFile,
  resolveHubNodeConfig,
  writeHubNodeFile,
} from "@/lib/hub-node-config";
import { AUTH_COOKIE } from "@/lib/auth-cookie";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET    /api/hub-node            → 本机是否接入 hub、连没连上
// POST   /api/hub-node {connectionString} → 兑换连接串、写 ~/.trellis/hub-node.json
// DELETE /api/hub-node            → 断开（删配置文件）
//
// **接入 hub = 把这台机器的完整控制权交给那个 hub**（hub 能以本机身份调任意
// /api，包括起 CLI）。这条路由和 /api/update 一样只靠 proxy.ts 的 cookie 闸；
// 连接串只能由 hub 管理员生成，且票据一次性、10 分钟过期。
// 真正连隧道的是 server.ts：它轮询配置文件，变了就重连，这里不碰进程。

async function tunnelConnected(): Promise<boolean | null> {
  const port = process.env.TRELLIS_PORT;
  if (!port) return null;
  const token = process.env.TRELLIS_AUTH_TOKEN;
  try {
    const r = await fetch(`http://127.0.0.1:${port}/__gate/health`, {
      headers: token ? { cookie: `${AUTH_COOKIE}=${token}` } : {},
      signal: AbortSignal.timeout(2000),
    });
    const body = (await r.json()) as { hub?: { connected?: boolean } | null };
    return body.hub?.connected ?? false;
  } catch {
    return null;
  }
}

export async function GET(req: Request) {
  const cfg = resolveHubNodeConfig();
  return Response.json(
    {
      configured: Boolean(cfg),
      source: cfg?.source ?? null,
      hubURL: cfg?.hubURL ?? null,
      nodeName: cfg?.nodeName ?? null,
      connected: cfg ? await tunnelConnected() : false,
      // 网关转发远端 node 时打的标记：当前页面本身就是经这条隧道打开的，
      // 断开会把自己也断掉——界面据此加一道确认。
      viaHub: req.headers.get("x-trellis-hub-node"),
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export async function POST(req: Request) {
  const current = resolveHubNodeConfig();
  if (current?.source === "env") {
    return Response.json(
      { error: "本机的 hub 接入写在服务环境变量里（TRELLIS_HUB_URL 等），请改服务定义" },
      { status: 409 },
    );
  }
  const body = (await req.json().catch(() => null)) as { connectionString?: unknown } | null;
  const conn = typeof body?.connectionString === "string" ? parseConnectionString(body.connectionString) : null;
  if (!conn) return Response.json({ error: "连接串格式不对，应以 trellis://v1/ 开头" }, { status: 400 });
  try {
    const cfg = await redeemConnectionString(conn);
    writeHubNodeFile(cfg);
    return Response.json({ ok: true, hubURL: cfg.hubURL, nodeName: cfg.nodeName });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 502 });
  }
}

export async function DELETE() {
  const current = resolveHubNodeConfig();
  if (current?.source === "env") {
    return Response.json(
      { error: "本机的 hub 接入写在服务环境变量里，请改服务定义" },
      { status: 409 },
    );
  }
  removeHubNodeFile();
  return Response.json({ ok: true });
}
