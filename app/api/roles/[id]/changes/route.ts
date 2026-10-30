import { RoleError, readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { acceptAllRoleChanges, listRoleChanges } from "@/lib/server/role-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** ?nodeId=<整理卡> 只看这张卡（按提案顺序）；?decided=1 只看已接受 / 已撤销（整理历史）。
 * → { changes: RoleChange[] } */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const q = new URL(req.url).searchParams;
  try {
    const changes = listRoleChanges(id, {
      nodeId: q.get("nodeId") ?? undefined,
      decidedOnly: q.get("decided") === "1",
      limit: Number(q.get("limit")) || undefined,
    });
    return Response.json({ changes });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** body { action: 'accept-all', nodeId } → { changes } */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const body = (await readJsonBody(req)) as { action?: unknown; nodeId?: unknown } | null;
    if (body?.action !== "accept-all" || typeof body.nodeId !== "string" || !body.nodeId) {
      throw new RoleError("expected { action: 'accept-all', nodeId }", 400);
    }
    return Response.json({ changes: acceptAllRoleChanges(id, body.nodeId) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
