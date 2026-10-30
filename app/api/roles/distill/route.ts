import { distillRole } from "@/lib/server/role-distill";
import { RoleError, readJsonBody, roleErrorResponse } from "@/lib/server/roles";

// 从会话提炼角色草稿（docs/roles-p2.md C）。POST { sessionId } → RoleDraft（不落库，前端预填表单）。
// 一次 headless claude 调用，十几秒到一两分钟；客户端显示进行中。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function POST(req: Request) {
  try {
    const body = (await readJsonBody(req)) as { sessionId?: unknown } | null;
    const sessionId = body && typeof body.sessionId === "string" ? body.sessionId : "";
    if (!sessionId) throw new RoleError("sessionId 必填", 400);
    return Response.json({ draft: await distillRole(sessionId) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
