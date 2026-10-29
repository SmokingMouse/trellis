import { getNode } from "@/lib/server/repo";
import { steerProject, SteerUnavailable } from "@/lib/server/as-project";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 插话：POST { text } → 注入该节点正在跑的 AS turn（turn/steer）。
// 409 + steerable:false = 这一轮不能插话（legacy run / 已结束 / daemon 不支持），
// 前端据此把消息改为排队；其它失败 502，前端保留输入框里的文字。
const MAX_STEER_CHARS = 32_000;

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { text?: unknown };
  try { body = await req.json(); } catch { return Response.json({ error: "invalid JSON" }, { status: 400 }); }
  const text = typeof body.text === "string" ? body.text.trim() : "";
  if (!text) return Response.json({ error: "empty text" }, { status: 400 });
  if (text.length > MAX_STEER_CHARS) return Response.json({ error: "text too long" }, { status: 413 });
  const node = getNode(id);
  if (!node) return Response.json({ error: "node not found" }, { status: 404 });
  if (node.status !== "streaming") return Response.json({ error: "这一轮已经结束", steerable: false }, { status: 409 });
  try {
    await steerProject(id, text);
    return Response.json({ ok: true });
  } catch (error) {
    if (error instanceof SteerUnavailable) return Response.json({ error: error.message, steerable: false }, { status: 409 });
    // turn_not_active（-32011）：轮次刚好在这一刻结束 / 换了；lease_held（-32012）：
    // 别的客户端持有输入租约。都不是用户能在这一轮里解决的——同样改排队。
    const code = (error as { code?: unknown })?.code;
    if (code === -32011) return Response.json({ error: "这一轮刚刚结束", steerable: false }, { status: 409 });
    if (code === -32012) return Response.json({ error: "另一个客户端正在操作这条线程", steerable: false }, { status: 409 });
    return Response.json({ error: String(error) }, { status: 502 });
  }
}
