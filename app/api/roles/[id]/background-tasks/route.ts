import { roleErrorResponse } from "@/lib/server/roles";
import { listRoleBackgroundTasks } from "@/lib/server/role-routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** ?limit=N（默认 20）→ { tasks: RoleBackgroundTask[] }，新的在前 */
export async function GET(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    const limit = Number(new URL(req.url).searchParams.get("limit")) || 20;
    return Response.json({ tasks: listRoleBackgroundTasks(id, limit) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
