import {
  getSession,
  getSessionNodes,
  deleteSession,
  renameSession,
  setSessionArchived,
  setSessionModel,
  listNotesBySession,
} from "@/lib/server/repo";
import { isProviderId } from "@/lib/llm";

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

  // Archive toggle (B2): { archived: boolean }. Mutually exclusive with the
  // rename path below — a single PATCH carries one intent.
  if ("archived" in obj) {
    if (typeof obj.archived !== "boolean") {
      return Response.json(
        { error: "expected { archived: boolean }" },
        { status: 400 },
      );
    }
    const session = setSessionArchived(id, obj.archived, Date.now());
    if (!session) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ session });
  }

  // Per-session model lock: { model: ProviderId }. Persists the session's own
  // model so switching away and back restores it instead of inheriting the
  // global picker. Validated against the ProviderId allowlist.
  if ("model" in obj) {
    if (!isProviderId(obj.model)) {
      return Response.json(
        { error: "expected { model: ProviderId }" },
        { status: 400 },
      );
    }
    const session = setSessionModel(id, obj.model);
    if (!session) {
      return Response.json({ error: "not found" }, { status: 404 });
    }
    return Response.json({ session });
  }

  const title = obj.title;
  if (typeof title !== "string") {
    return Response.json(
      { error: "expected { title: string } or { archived: boolean }" },
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
