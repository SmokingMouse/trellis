import { sendPush } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST /api/push/test { endpoint? } → SendReport。发一条测试推送：带 endpoint 只发给
// 这个浏览器，不带就发给全部订阅。不看开关 / 前台 / 去重 —— 测试就是要看到它。
export async function POST(req: Request) {
  let body: { endpoint?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    /* 空 body = 发给全部 */
  }
  const endpoint = typeof body.endpoint === "string" && body.endpoint ? body.endpoint : undefined;
  const report = await sendPush(
    {
      kind: "test",
      title: "Trellis 测试推送",
      body: "能看到这条，说明手机推送已经通了",
      tag: "trellis:test",
      url: "/settings/prefs",
      sessionId: null,
      nodeId: null,
    },
    { endpoint },
  );
  return Response.json(report);
}
