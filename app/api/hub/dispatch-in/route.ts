import "server-only";
import { DISPATCH_FROM_HEADER, MACHINE_NAME_RE, parseDispatchInput } from "@/lib/hub-dispatch";
import { startDispatchedRun } from "@/lib/server/hub-dispatch";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/hub/dispatch-in {prompt, workspace?, provider?}  ← hub 中继（/__gw/relay/dispatch）
// 别的机器派来的活：新建会话开跑一轮，返回 {sessionId, nodeId}。
// 来源机器名在 x-trellis-dispatch-from 里，由网关在校验完凭证与策略后写入；网关的
// cookie 路由与 via 直通都拦掉了这个路径，所以经 hub 只有中继能打到这里。本机直连
// 照旧只靠 proxy.ts 的 cookie 闸（与 /api/chat 同一道门，本来就能起 run）。
export async function POST(req: Request) {
  const from = req.headers.get(DISPATCH_FROM_HEADER)?.trim() || "";
  if (!MACHINE_NAME_RE.test(from)) {
    return Response.json({ error: "缺来源机器（只接受 hub 中继的调用）" }, { status: 400 });
  }
  const input = parseDispatchInput(await req.json().catch(() => null));
  if (typeof input === "string") return Response.json({ error: input }, { status: 400 });
  const r = await startDispatchedRun(from, input);
  if (!r.ok) return Response.json({ error: r.error }, { status: r.status });
  return Response.json({ sessionId: r.sessionId, nodeId: r.nodeId }, { status: 201 });
}
