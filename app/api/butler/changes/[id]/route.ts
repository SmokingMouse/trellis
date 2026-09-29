import {
  ChangeError,
  applyChange,
  getChange,
  rejectChange,
  revertChange,
} from "@/lib/server/butler-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const change = getChange(id);
  if (!change) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ change });
}

// 用户在卡片上的三个动作。apply 失败（路由校验不过）不抛错：提案落 failed 并带
// 错误原文返回 200，卡片据此展示 —— 失败是提案的一个结局，不是这次请求的故障。
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: { action?: string; confirm?: string } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    /* 空 body */
  }
  // 「确认 / 撤销」只收浏览器发来的请求：Sec-Fetch-Mode 是浏览器强制附带、
  // 页面脚本改不了的头；trellisctl / curl 默认不带。管家能提案，但不能自己批自己的提案
  // —— 这是减速带不是密码学闸（非浏览器客户端可以伪造），配合人设纪律。
  if ((body.action === "apply" || body.action === "revert") && !req.headers.get("sec-fetch-mode")) {
    return Response.json({ error: "改动只能由用户在管家页的卡片上确认 / 撤销" }, { status: 403 });
  }
  try {
    switch (body.action) {
      case "apply":
        return Response.json({ change: await applyChange(id, { confirm: body.confirm }) });
      case "reject":
        return Response.json({ change: rejectChange(id) });
      case "revert":
        return Response.json({ change: await revertChange(id) });
      default:
        return Response.json({ error: "action 只能是 apply / reject / revert" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ChangeError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
