import { deleteNodeSubtree } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
