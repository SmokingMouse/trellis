import { getFollowStatus, parseFollowInput, setFollow } from "@/lib/server/role-follow";
import { getRole, readJsonBody, roleErrorResponse } from "@/lib/server/roles";

// 角色 P4「跟进我的会话」开关（docs/roles-p2.md C，类型见 lib/role-follow.ts）。
// GET → RoleFollowStatus；PUT { enabled, staleMinutes? } → RoleFollowStatus。
// 全局只有一个角色开着：PUT enabled=true 会把开关从别的角色手里接过来。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    if (!getRole(id)) return Response.json({ error: "role not found" }, { status: 404 });
    return Response.json(getFollowStatus(id));
  } catch (e) {
    return roleErrorResponse(e);
  }
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    return Response.json(setFollow(id, parseFollowInput(await readJsonBody(req))));
  } catch (e) {
    return roleErrorResponse(e);
  }
}
