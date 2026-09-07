import { listHookRecords } from "@/lib/server/agent-hooks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hooks/state → 全部会话的 hook 状态，最近更新的在前。
export async function GET() {
  return Response.json({ records: listHookRecords() });
}
