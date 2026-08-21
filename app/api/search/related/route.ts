import { findRelated } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/search/related?q=<draft question>
// 体验 A：首屏发问时的相似会话检测。⌘P 是 pull 式（要先想起来去搜），这条
// 是 push 式 —— 正要新开树的那一刻旁路查一把，聊过就提示。召回策略与
// /api/search 的差别见 repo.findRelated 注释。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const { related, totalTerms } = findRelated(q);
  return Response.json({ related, totalTerms });
}
