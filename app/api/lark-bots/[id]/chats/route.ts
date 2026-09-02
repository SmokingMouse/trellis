import { getLarkBotRecord, listLarkChats } from "@/lib/server/lark/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!getLarkBotRecord(id)) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ chats: listLarkChats(id) });
}
