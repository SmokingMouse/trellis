import {
  getAgent,
  updateAgent,
  deleteAgent,
  type AgentInput,
} from "@/lib/server/agents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const agent = getAgent(id);
  if (!agent) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json({ agent });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const agent = updateAgent(id, (body ?? {}) as Partial<AgentInput>);
    if (!agent) return Response.json({ error: "not found" }, { status: 404 });
    return Response.json({ agent });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const isUserError = msg.includes("invalid slug") || msg.includes("UNIQUE");
    return Response.json(
      { error: msg.includes("UNIQUE") ? "slug 已被占用" : msg },
      { status: isUserError ? 400 : 500 },
    );
  }
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const r = deleteAgent(id);
  if (!r.ok) {
    // 内置 agent 拒删是「你不该这么做」而不是「找不到」，用 409 区分开。
    return Response.json({ error: r.reason }, { status: r.reason === "not found" ? 404 : 409 });
  }
  return Response.json({ ok: true });
}
