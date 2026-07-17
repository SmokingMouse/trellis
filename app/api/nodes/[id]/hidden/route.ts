import { setTreeHidden } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 树面板雪藏：把 id 所在的整棵树标为隐藏 / 恢复（标记落在树根行）。
// body: { hidden: boolean }。幂等；接受树内任意节点 id，服务端自行走到根。
export async function POST(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let hidden: unknown;
  try {
    ({ hidden } = (await req.json()) as { hidden?: unknown });
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (typeof hidden !== "boolean") {
    return Response.json(
      { error: "body must be { hidden: boolean }" },
      { status: 400 },
    );
  }
  const result = setTreeHidden(id, hidden, Date.now());
  if (!result) {
    return Response.json({ error: "node not found" }, { status: 404 });
  }
  return Response.json(result);
}
