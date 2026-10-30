import { readJsonBody, roleErrorResponse } from "@/lib/server/roles";
import { getRoleCapabilities, updateRoleCapabilities } from "@/lib/server/role-routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** → RoleCapabilities */
export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return Response.json(getRoleCapabilities(id));
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** body RoleCapabilitiesInput → RoleCapabilities */
export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  try {
    return Response.json(updateRoleCapabilities(id, await readJsonBody(req)));
  } catch (e) {
    return roleErrorResponse(e);
  }
}
