import { readJsonBody, roleErrorResponse, writeRoleUserMd } from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** body { text } → { text }：整篇覆盖 USER.md。 */
export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  try {
    const body = (await readJsonBody(req)) as { text?: unknown } | null;
    return Response.json({ text: writeRoleUserMd(id, body?.text) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
