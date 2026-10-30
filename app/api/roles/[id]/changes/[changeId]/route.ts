import { RoleError, readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { acceptRoleChange, rejectRoleChange, revertRoleChange } from "@/lib/server/role-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; changeId: string }> };

/** body { action: 'accept' | 'reject' | 'revert' } → { change: RoleChange }。
 * accept 前提不成立（文件已被删 / 撞名）不报错，返回 status='failed' + error。 */
export async function POST(req: Request, ctx: Ctx) {
  const { id, changeId } = await ctx.params;
  try {
    const body = (await readJsonBody(req)) as { action?: unknown } | null;
    const action = body?.action;
    const change =
      action === "accept"
        ? acceptRoleChange(id, changeId)
        : action === "reject"
          ? rejectRoleChange(id, changeId)
          : action === "revert"
            ? revertRoleChange(id, changeId)
            : null;
    if (!change) throw new RoleError("action 只能是 accept / reject / revert", 400);
    return Response.json({ change });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
