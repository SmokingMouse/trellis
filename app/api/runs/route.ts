import { getActiveRuns } from "@/lib/server/run-bus";
import { getNode } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/runs
// Wave 1 / A2: report which sessions currently have at least one node
// streaming, so the tab bar can render a live "busy" pulse. run-bus owns
// the authoritative per-node RUNS map (already multi-session); we map each
// active nodeId → its sessionId via a cheap indexed lookup and dedup.
// Polled ~every 3s by SessionTabs; kept a thin shell like /api/search.
export async function GET() {
  const runs = getActiveRuns();
  const sessionIds = new Set<string>();
  for (const { nodeId } of runs) {
    const node = getNode(nodeId);
    if (node) sessionIds.add(node.sessionId);
  }
  return Response.json({ runningSessionIds: [...sessionIds] });
}
