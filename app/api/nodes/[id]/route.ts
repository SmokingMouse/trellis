import { deleteNodeSubtree, getNode, setNodeTopicLabel } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid_json" }, { status: 400 });
  }

  if (typeof body !== "object" || body === null) {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  const { topicLabel } = body as { topicLabel?: unknown };
  if (typeof topicLabel === "string") {
    const trimmed = topicLabel.trim();
    if (!trimmed) {
      return Response.json({ error: "empty_topic_label" }, { status: 400 });
    }
    const node = getNode(id);
    if (!node) {
      return Response.json({ error: "not_found" }, { status: 404 });
    }
    setNodeTopicLabel(id, trimmed);
    return Response.json({ ok: true, topicLabel: trimmed });
  }

  return Response.json({ error: "no_supported_fields" }, { status: 400 });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const result = deleteNodeSubtree(id);
  if (!result.ok) {
    const status =
      result.reason === "not_found"
        ? 404
        : result.reason === "is_session_root"
          ? 409
          : 409;
    return Response.json({ error: result.reason }, { status });
  }
  return Response.json({
    deletedNodeIds: result.deletedNodeIds,
    deletedNoteIds: result.deletedNoteIds,
  });
}
