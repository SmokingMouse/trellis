import { startRegistration } from "@/lib/server/lark/register";
import type { LarkRegisterRequest } from "@/lib/lark-types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }

  const obj = (body ?? {}) as Record<string, unknown>;
  if (obj.mode !== "create" && obj.mode !== "update") {
    return Response.json(
      { error: "expected mode to be 'create' or 'update'" },
      { status: 400 },
    );
  }

  if (obj.mode === "create") {
    if (typeof obj.name !== "string" || !obj.name.trim()) {
      return Response.json(
        { error: "name 不能为空" },
        { status: 400 },
      );
    }
  } else if (obj.mode === "update") {
    if (typeof obj.botId !== "string" || !obj.botId.trim()) {
      return Response.json(
        { error: "botId 不能为空" },
        { status: 400 },
      );
    }
  }

  try {
    const result = await startRegistration(obj as unknown as LarkRegisterRequest);
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isClientError =
      message.includes("不能为空") ||
      message.includes("找不到要更新的机器人") ||
      message.includes("未知的注册模式");
    return Response.json({ error: message }, { status: isClientError ? 400 : 500 });
  }
}
