import { readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { createRoleRoutine, listRoleRoutines } from "@/lib/server/role-routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** → { routines: RoleRoutine[] }（不含内置的夜间整理，那个走 /nightly） */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return Response.json({ routines: listRoleRoutines(id) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** body RoleRoutineInput → { routine }（tasks 行 + cron 触发器，agent_id = 角色） */
export async function POST(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return Response.json({ routine: createRoleRoutine(id, await readJsonBody(req)) }, { status: 201 });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
