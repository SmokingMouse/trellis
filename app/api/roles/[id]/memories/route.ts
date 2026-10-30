import { listRoleMemories, roleErrorResponse } from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** RoleMemoryList：USER.md 全文 + memories/*.md（按修改时间降序）。 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json(listRoleMemories(id));
  } catch (e) {
    return roleErrorResponse(e);
  }
}
