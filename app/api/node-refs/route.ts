import { listRefCandidates, listRefNodes } from "@/lib/server/node-refs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 输入框 `@` 引用其他会话 / 节点的候选（lib/node-refs.ts）。
// GET /api/node-refs?q=<查询>        → { sessions }：最近活跃会话，标题 / topic 模糊匹配 + 全文补充；
//                                      每个会话带默认引用节点（最新一个已完成节点）。
// GET /api/node-refs?sessionId=<id>  → { nodes }：该会话可引用的已完成节点（展开改选用）。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessionId = url.searchParams.get("sessionId");
  if (sessionId) {
    const nodes = listRefNodes(sessionId);
    if (!nodes) return Response.json({ error: "session not found" }, { status: 404 });
    return Response.json({ nodes });
  }
  const q = (url.searchParams.get("q") ?? "").slice(0, 100);
  return Response.json({ sessions: listRefCandidates(q, 20) });
}
