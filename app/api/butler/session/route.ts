import { latestButlerSessionId } from "@/lib/server/butler";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// /butler 入口据此决定是打开已有的管家会话，还是落到「新管家对话」草稿。
export async function GET() {
  return Response.json({ sessionId: latestButlerSessionId() });
}
