import { listApprovalRules } from "@/lib/server/approval-rules";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/approval-rules → { rules: ApprovalRuleListItem[] }
// 审批三档作用域里落了库的两档（本会话 / 所有会话）。设置页「已授权规则」用。
// 规则只能在审批卡上产生（POST /api/nodes/[id]/respond 带 scope），这里不提供新建。
export async function GET() {
  return Response.json({ rules: listApprovalRules() });
}
