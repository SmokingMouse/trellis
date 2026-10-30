import { openRole, roleErrorResponse } from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RoleOpenResult：固定会话还在就给 id，否则 null（前端进草稿态）。 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json(openRole(id));
  } catch (e) {
    return roleErrorResponse(e);
  }
}
