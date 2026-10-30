import {
  deleteRoleMemory,
  parseMemoryInput,
  readJsonBody,
  roleErrorResponse,
  writeRoleMemory,
} from "@/lib/server/roles";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string; file: string }> };

/** body { name, description, type, body } → { memory }；写文件并重建 MEMORY.md。
 * [file] 必须匹配 ^[a-z0-9][a-z0-9._-]{0,80}\.md$（校验在 lib/server/roles.ts）。 */
export async function PUT(req: Request, ctx: Ctx) {
  const { id, file } = await ctx.params;
  try {
    const input = parseMemoryInput(await readJsonBody(req));
    return Response.json({ memory: writeRoleMemory(id, decodeURIComponent(file), input) });
  } catch (e) {
    return roleErrorResponse(e);
  }
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id, file } = await ctx.params;
  try {
    deleteRoleMemory(id, decodeURIComponent(file));
    return Response.json({ ok: true });
  } catch (e) {
    return roleErrorResponse(e);
  }
}
