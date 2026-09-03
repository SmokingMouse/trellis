import { countVisibleTrees, listRecentChains } from "@/lib/server/repo";
import { getActiveRuns } from "@/lib/server/run-bus";
import {
  RECENT_CHAINS_PER_SESSION,
  RECENT_ROW_SCAN,
  RECENT_SESSION_LIMIT,
  groupRecentChains,
} from "@/lib/recent";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/recent?sessions=<n>&chains=<n>
// S133：侧栏「最近」分组 —— 最近活动的会话，粒度到链（根→叶子 lineage）。
// 每会话下发最近的几条链（链尾节点 + 树名 + 活动时间 + 状态），点链跨会话
// 直接落到链尾。会话 / 每会话链数各有上限，见 lib/recent.ts 的常量。
//
// 与 /api/sessions 分开而不并进去：那条是流式期间 ~1.6 次/秒的热路径，而
// 这里要跑一遍递归 CTE；最近分组晚半秒刷新没人在意。
export async function GET(req: Request) {
  const url = new URL(req.url);
  const sessions = clampInt(
    url.searchParams.get("sessions"),
    RECENT_SESSION_LIMIT,
    1,
    20,
  );
  const chains = clampInt(
    url.searchParams.get("chains"),
    RECENT_CHAINS_PER_SESSION,
    1,
    20,
  );
  const rows = listRecentChains(RECENT_ROW_SCAN);
  const activeRuns = getActiveRuns();
  const runningNodeIds = new Set(
    activeRuns.filter((run) => !run.waiting).map((run) => run.nodeId),
  );
  const waitingNodeIds = new Set(
    activeRuns.filter((run) => run.waiting).map((run) => run.nodeId),
  );
  const treeCounts = countVisibleTrees([
    ...new Set(rows.map((r) => r.sessionId)),
  ]);
  return Response.json({
    sessions: groupRecentChains(rows, treeCounts, {
      sessions,
      chainsPerSession: chains,
      runningNodeIds,
      waitingNodeIds,
    }),
  });
}

function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw == null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
