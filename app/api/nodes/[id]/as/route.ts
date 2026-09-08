import { getNode, getSession } from "@/lib/server/repo";
import { resolveSessionBinding } from "@/lib/server/session-binding";
import { permissionProject, withNodeThread, projectTarget } from "@/lib/server/as-project";
import { PermissionSchema } from "@smokingmouse/agent-server/protocol";
import { getDB } from "@/lib/server/sqlite";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export async function GET(_req: Request, ctx: { params: Promise<{id:string}> }) {
  const { id } = await ctx.params;
  const node = getNode(id);
  if (!node) return Response.json({error:"node not found"}, {status:404});
  const binding = resolveSessionBinding(node.sessionId), turn = projectTarget(id);
  if (binding.type !== "thread" || !turn) return Response.json({ binding: binding.type, thread: null });
  try { return Response.json(await withNodeThread(id, async (client, threadId) => ({
    binding: "thread", turnId: turn.turn_id, thread: (await client.request("thread/read", {threadId})).thread,
    origin: getSession(node.sessionId)?.origin,
    resolved: JSON.parse((getDB().prepare("SELECT resolved_json FROM as_turns WHERE node_id=?").get(id) as {resolved_json:string|null})?.resolved_json ?? "[]"),
    permissionSet: client.initializeResult?.capabilities.engine?.permissionSet === true,
  }))); } catch (error) { return Response.json({ error: String(error) }, {status:503}); }
}
export async function POST(req: Request, ctx: { params: Promise<{id:string}> }) {
  const { id } = await ctx.params;
  let body;
  try { body = await req.json(); } catch { return Response.json({error:"invalid JSON"}, {status:400}); }
  const permission = PermissionSchema.safeParse(body.permission);
  if (!permission.success) return Response.json({error:"invalid permission"}, {status:400});
  try { return Response.json(await permissionProject(id, permission.data)); }
  catch (error) { return Response.json({error:String(error)}, {status:409}); }
}
