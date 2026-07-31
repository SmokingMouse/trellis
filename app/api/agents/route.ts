import { listAgents, createAgent, type AgentInput } from "@/lib/server/agents";

// S88: 自定义 Agent 的增查。改/删走 ./[id]/route.ts。
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const url = new URL(req.url);
  // picker 只要能用的；管理页要全部（含停用的）。
  const enabledOnly = url.searchParams.get("all") !== "1";
  return Response.json({ agents: listAgents({ enabledOnly }) });
}

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  if (typeof obj.slug !== "string" || typeof obj.name !== "string") {
    return Response.json({ error: "expected { slug, name }" }, { status: 400 });
  }
  try {
    const agent = createAgent(obj as unknown as AgentInput);
    return Response.json({ agent }, { status: 201 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // slug UNIQUE 冲突和 slug 格式非法都是用户输入问题，回 400 而不是 500。
    const isUserError = msg.includes("invalid slug") || msg.includes("UNIQUE");
    return Response.json(
      { error: msg.includes("UNIQUE") ? `slug 已被占用：${obj.slug}` : msg },
      { status: isUserError ? 400 : 500 },
    );
  }
}
