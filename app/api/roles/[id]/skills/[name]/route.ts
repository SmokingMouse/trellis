import { roleErrorResponse } from "@/lib/server/roles";
import { deleteRoleSkill } from "@/lib/server/role-routines";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; name: string }> };

/** 删角色自己的技能目录 <roleDir>/skills/<name>/（名字校验在服务端）。 */
export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, name } = await ctx.params;
  try {
    deleteRoleSkill(id, decodeURIComponent(name));
    return Response.json({ ok: true });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
