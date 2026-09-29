import { butlerOverview } from "@/lib/server/butler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// 管家右栏「当前配置」+ `trellisctl overview`：只读，一次带齐各设置项的摘要。
export async function GET() {
  return Response.json(await butlerOverview());
}
