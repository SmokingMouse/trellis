import "server-only";
import { ID_RE, MACHINE_NAME_RE } from "@/lib/hub-dispatch";
import { relayToHub } from "@/lib/server/hub-relay-route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/hub/dispatch/<machine>/<sessionId>/<nodeId> → hub /__gw/relay/dispatch/...
// `trellisctl dispatch-status` / `dispatch --wait`：取派出去那一轮的状态与回答。
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ machine: string; sessionId: string; nodeId: string }> },
) {
  const { machine, sessionId, nodeId } = await ctx.params;
  if (!MACHINE_NAME_RE.test(machine) || !ID_RE.test(sessionId) || !ID_RE.test(nodeId)) {
    return Response.json({ error: "机器名或 id 格式不对" }, { status: 400 });
  }
  return relayToHub("GET", `/__gw/relay/dispatch/${machine}/${sessionId}/${nodeId}`);
}
