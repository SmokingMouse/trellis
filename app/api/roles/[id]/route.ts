import {
  deleteRole,
  getRole,
  parseRoleInput,
  readJsonBody,
  roleErrorResponse,
  updateRole,
} from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const role = getRole(id);
    if (!role) return Response.json({ error: "role not found" }, { status: 404 });
    return Response.json({ role });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const patch = parseRoleInput(await readJsonBody(req), true);
    return Response.json({ role: updateRole(id, patch) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

/** 内置角色 409；删角色不删目录（改名 <slug>.deleted-<ts>）。 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    deleteRole(id);
    return Response.json({ ok: true });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
