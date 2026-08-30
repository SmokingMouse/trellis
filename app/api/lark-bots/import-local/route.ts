import { importLocalLarkBot } from "@/lib/server/lark/discover";

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
  if (typeof obj.appId !== "string" || !obj.appId.trim()) {
    return Response.json({ error: "expected { appId }" }, { status: 400 });
  }

  try {
    const result = await importLocalLarkBot({
      appId: obj.appId.trim(),
      name: typeof obj.name === "string" ? obj.name : undefined,
      agentId: typeof obj.agentId === "string" ? obj.agentId : null,
      workspacePath: typeof obj.workspacePath === "string" ? obj.workspacePath : null,
    });
    return Response.json(result, { status: 200 });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const userError = message.includes("未在本地找到") || message.includes("不能为空") || message.includes("飞书未返回");
    return Response.json({ error: message }, { status: userError ? 400 : 500 });
  }
}
