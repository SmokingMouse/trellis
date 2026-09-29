import {
  ChangeError,
  listChanges,
  proposeChange,
} from "@/lib/server/butler-changes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET ?sessionId=<sid>  → 该管家会话的全部提案（时间正序，卡片按 nodeId 挂到对应轮次下）
// GET ?recent=1&limit=N → 全局最近已应用 / 已撤销（右栏「变更记录」）
export async function GET(req: Request) {
  const q = new URL(req.url).searchParams;
  const limit = Math.min(Number(q.get("limit")) || 200, 500);
  if (q.get("recent") === "1") {
    return Response.json({ changes: listChanges({ decidedOnly: true, limit }) });
  }
  const sessionId = q.get("sessionId");
  if (!sessionId) return Response.json({ error: "缺 sessionId" }, { status: 400 });
  return Response.json({ changes: listChanges({ sessionId, limit }) });
}

// trellisctl 在平台内发配置写请求之前先打这里：
//   { proposed: false }            → 不是管家会话，调用方照常直连
//   201 { proposed: true, change } → 已存成待确认提案，调用方**不要**再直连
export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const { sessionId, nodeId, method, path } = body;
  if (typeof sessionId !== "string" || typeof method !== "string" || typeof path !== "string") {
    return Response.json({ error: "expected { sessionId, method, path, body? }" }, { status: 400 });
  }
  try {
    const change = proposeChange({
      sessionId,
      nodeId: typeof nodeId === "string" ? nodeId : null,
      method,
      path,
      body: body.body,
    });
    if (!change) return Response.json({ proposed: false });
    return Response.json({ proposed: true, change }, { status: 201 });
  } catch (e) {
    if (e instanceof ChangeError) return Response.json({ error: e.message }, { status: e.status });
    throw e;
  }
}
