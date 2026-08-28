import { testLarkCredentials } from "@/lib/server/lark/sdk";
import {
  getLarkBotRecord,
  setLarkBotIdentity,
} from "@/lib/server/lark/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const bot = getLarkBotRecord(id);
  if (!bot) return Response.json({ error: "not found" }, { status: 404 });
  try {
    const info = await testLarkCredentials(bot.appId, bot.appSecret);
    setLarkBotIdentity(id, info.openId, info.name);
    return Response.json({ ok: true, bot: info });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return Response.json({ ok: false, error: message }, { status: 400 });
  }
}
