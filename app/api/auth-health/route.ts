import { getAuthHealth } from "@/lib/server/auth-health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// S95: claude / codex CLI 授权健康快照。只读、无副作用（探测是 spawn 两个
// status 命令 + 读两个本地文件，30s 模块缓存；?force=1 绕过缓存给「刷新」按钮用）。
// 响应里只有时间戳/布尔/账号名 —— 任何 token 内容都不出 lib/server/auth-health.ts。
export async function GET(req: Request) {
  const force = new URL(req.url).searchParams.get("force") === "1";
  return Response.json(await getAuthHealth(force));
}
