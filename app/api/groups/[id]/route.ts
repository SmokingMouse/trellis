import {
  archiveGroup,
  getGroup,
  groupErrorResponse,
  parseGroupPatch,
  readGroupJson,
  updateGroup,
} from "@/lib/server/groups";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const group = getGroup(id);
    if (!group) return Response.json({ error: "group not found" }, { status: 404 });
    return Response.json({ group });
  } catch (e) {
    return groupErrorResponse(e);
  }
}

/** 改名 / 工作目录 / 设置（策略、每轮上限）/ 加减成员。 */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const patch = parseGroupPatch(await readGroupJson(req));
    return Response.json({ group: updateGroup(id, patch) });
  } catch (e) {
    return groupErrorResponse(e);
  }
}

/** 删群 = 归档会话（数据保留、列表里不再出现）。 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    archiveGroup(id);
    return Response.json({ ok: true });
  } catch (e) {
    return groupErrorResponse(e);
  }
}
