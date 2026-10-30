import { readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { deleteRoleRoutine, updateRoleRoutine } from "@/lib/server/role-routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; taskId: string }> };

/** body Partial<RoleRoutineInput> → { routine } */
export async function PATCH(req: Request, ctx: Ctx) {
  const { id, taskId } = await ctx.params;
  try {
    return Response.json({ routine: updateRoleRoutine(id, taskId, await readJsonBody(req)) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, taskId } = await ctx.params;
  try {
    deleteRoleRoutine(id, taskId);
    return Response.json({ ok: true });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
