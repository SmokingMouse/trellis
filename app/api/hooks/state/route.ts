import { createHash } from "node:crypto";
import { listHookSummaries } from "@/lib/server/agent-hooks/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hooks/state → 全部会话的 hook 状态，最近更新的在前。
export async function GET(req?: Request) {
  const body = JSON.stringify({ records: listHookSummaries() });
  const etag = `W/"${createHash("sha256").update(body).digest("hex")}"`;
  const headers = { ETag: etag, "Cache-Control": "private, no-cache" };
  if (req?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  return new Response(body, { headers: { ...headers, "Content-Type": "application/json" } });
}
