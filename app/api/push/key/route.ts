import { getVapidKeys } from "@/lib/server/push";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/push/key → { publicKey }。VAPID 公钥（applicationServerKey），首次调用时
// 在 ~/.trellis/push-vapid.json 生成密钥对。私钥永不出这个进程。
export async function GET() {
  try {
    return Response.json({ publicKey: getVapidKeys().publicKey });
  } catch (err) {
    console.error("[push] VAPID 密钥读取/生成失败：", err);
    return Response.json({ error: "推送密钥不可用" }, { status: 500 });
  }
}
