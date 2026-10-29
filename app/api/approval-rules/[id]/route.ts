import { revokeApprovalRule } from "@/lib/server/approval-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/approval-rules/[id] → 撤销一条规则。立即生效：下一次同键工具调用
// 重新弹卡（规则在发起审批前现查，不做进程内缓存）。404 = 已不存在。
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!revokeApprovalRule(id)) {
    return Response.json({ error: "rule not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
