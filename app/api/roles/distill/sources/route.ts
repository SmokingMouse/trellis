import { listDistillSources } from "@/lib/server/role-distill";
import { roleErrorResponse } from "@/lib/server/roles";

// 「从会话提炼」的来源会话：GET ?q=<标题关键词> → { sources: DistillSource[] }（最近 50 个普通会话）。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const q = (new URL(req.url).searchParams.get("q") ?? "").slice(0, 100);
    return Response.json({ sources: listDistillSources(q) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
