import { createLarkBot, listLarkBots } from "@/lib/server/lark/store";
import type { LarkBotInput } from "@/lib/lark-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({ bots: listLarkBots() });
}
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  if (typeof obj.name !== "string" || typeof obj.appId !== "string" || typeof obj.appSecret !== "string") {
    return Response.json({ error: "expected { name, appId, appSecret }" }, { status: 400 });
  }
  try {
    return Response.json({ bot: createLarkBot(obj as unknown as LarkBotInput) }, { status: 201 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userError =
      message.includes("不能为空") || message.includes("UNIQUE") || message.includes("取值无效");
    return Response.json(
      { error: message.includes("UNIQUE") ? "app_id 已登记" : message },
      { status: userError ? 400 : 500 },
    );
  }
}
