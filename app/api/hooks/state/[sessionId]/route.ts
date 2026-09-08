import { getHookRecord } from "@/lib/server/agent-hooks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hooks/state/<claude session_id> → 单条。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await ctx.params;
  const record = getHookRecord(sessionId);
  return record
    ? Response.json({ record })
    : Response.json({ error: "not found" }, { status: 404 });
}
