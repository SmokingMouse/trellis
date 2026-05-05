import { deleteNote } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// DELETE /api/notes/<id> — hard delete (per design, no soft-delete).
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ok = deleteNote(id);
  if (!ok) {
    return Response.json({ error: "note not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
