import { getActiveRuns } from "@/lib/server/run-bus";
import { getNode } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs
// Session ids stay for the existing tabs/sidebar consumers. Node refs preserve
// the chain-level identity and split waiting from generating for RecentChain.
export async function GET() {
  const runs = getActiveRuns();
  const sessionIds = new Set<string>();
  const runningNodes: Array<{ nodeId: string; sessionId: string }> = [];
  const waitingNodes: Array<{ nodeId: string; sessionId: string }> = [];
  for (const { nodeId, waiting } of runs) {
    const node = getNode(nodeId);
    if (!node) continue;
    sessionIds.add(node.sessionId);
    const ref = { nodeId, sessionId: node.sessionId };
    if (waiting) waitingNodes.push(ref);
    else runningNodes.push(ref);
  }
  return Response.json({
    runningSessionIds: [...sessionIds],
    runningNodes,
    waitingNodes,
  });
}
