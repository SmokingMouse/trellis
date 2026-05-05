import {
  getSession,
  getSessionNodes,
  deleteSession,
  renameSession,
  listNotesBySession,
} from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const session = getSession(id);
  if (!session) return Response.json({ error: "not found" }, { status: 404 });
  const nodes = getSessionNodes(id);
  const notes = listNotesBySession(id);
  return Response.json({ session, nodes, notes });
}

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const obj = (body ?? {}) as Record<string, unknown>;
  const title = obj.title;
  if (typeof title !== "string") {
    return Response.json(
      { error: "expected { title: string }" },
      { status: 400 },
    );
  }
  if (!title.trim()) {
    return Response.json({ error: "title cannot be empty" }, { status: 400 });
  }
  const session = renameSession(id, title, Date.now());
  if (!session) {
    return Response.json({ error: "not found" }, { status: 404 });
  }
  return Response.json({ session });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  deleteSession(id);
  return Response.json({ ok: true });
}
