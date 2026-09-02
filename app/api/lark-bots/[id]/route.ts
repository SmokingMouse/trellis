import type { LarkBotInput } from "@/lib/lark-types";
import { deleteLarkBot, getLarkBot, updateLarkBot } from "@/lib/server/lark/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Context) {
  const { id } = await ctx.params;
  const bot = getLarkBot(id);
  return bot
    ? Response.json({ bot })
    : Response.json({ error: "not found" }, { status: 404 });
}
export async function PATCH(req: Request, ctx: Context) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const bot = updateLarkBot(id, (body ?? {}) as Partial<LarkBotInput>);
    if (!bot) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ bot });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userError =
      message.includes("不能为空") || message.includes("UNIQUE") || message.includes("取值无效");
    return Response.json(
      { error: message.includes("UNIQUE") ? "app_id 已登记" : message },
      { status: userError ? 400 : 500 },
    );
  }
}

export async function DELETE(_req: Request, ctx: Context) {
  const { id } = await ctx.params;
  return deleteLarkBot(id)
    ? Response.json({ ok: true })
    : Response.json({ error: "not found" }, { status: 404 });
}
