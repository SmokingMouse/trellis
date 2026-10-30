import { getFollowStatus, scanFollow } from "@/lib/server/role-follow";
import { RoleError, roleErrorResponse } from "@/lib/server/roles";

// 立刻扫一遍（不等 15 分钟）：只对正开着跟进的那个角色有效。刚打开、还没拍基线时这一扫只拍基线。
// POST → FollowScanResult（status: baseline / quiet / reported）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    if (!getFollowStatus(id).enabled) throw new RoleError("这个角色没开跟进", 409);
    return Response.json(await scanFollow({ force: true }));
  } catch (e) {
    return roleErrorResponse(e);
  }
}
