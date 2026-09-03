import type { RecentChain, RecentChainStatus, RecentSession } from "./types";

// 侧栏「最近」分组（S133）的纯数据层：把服务端算好的「叶子 = 链」行按会话
// 归组、截断、打标签。API 路由与测试共用；不 import 任何 server-only 模块。
//
// 设计要点：
//   - 链 = 根→叶子的一条 lineage（线性视图正在展示的那种）。叶子唯一标识
//     一条链，所以「最近的链」= 按活动时间排序的叶子。
//   - 活动时间 = 链上所有节点的 max(createdAt, readAt)：写过（长了新节点）
//     和读过（readAt）都算「用过」，与树面板热度同口径 —— 「最近」要回答的
//     是「我上次在哪」，不只是「最后写在哪」。
//   - 会话粒度的截断在服务端做（RECENT_SESSION_LIMIT），链粒度只截到
//     RECENT_CHAINS_PER_SESSION，客户端默认露前 RECENT_CHAINS_SHOWN 条、其余
//     点开 —— 一个几十根的会话不该把整块区域吃掉，但也不该藏得找不回。

export const RECENT_SESSION_LIMIT = 5;
/** 服务端每会话最多下发的链数 */
export const RECENT_CHAINS_PER_SESSION = 8;
/** 客户端默认展开的链数，其余折进「还有 N 条」 */
export const RECENT_CHAINS_SHOWN = 3;
/** 服务端扫描的叶子行上限 —— 按活动时间降序取前 N 行再归组 */
export const RECENT_ROW_SCAN = 200;

/** 服务端一行 = 一条链（叶子）+ 它的根 + 所属会话。真源 repo.listRecentChains。 */
export type RecentChainRow = {
  sessionId: string;
  sessionTitle: string;
  sessionMode: string;
  sessionWorkspacePath: string | null;
  tipId: string;
  rootId: string;
  nodeIds: string[];
  depth: number;
  activityAt: number;
  tipQuestion: string;
  tipTopicLabel: string | null;
  tipKind: string;
  tipRefTitle: string | null;
  hasError: boolean;
  hasUnread: boolean;
  rootQuestion: string;
  rootTopicLabel: string | null;
  rootKind: string;
  rootRefTitle: string | null;
};

/**
 * 节点展示标签：topicLabel 优先，reference 落材料标题，qa 落问题前缀。
 * 与 lib/tree-panel.treeLabel 同规则 —— 那边吃 ChatNode，这边吃裸列，
 * 不共用签名但语义必须一致（同一棵树在树面板和最近分组里叫同一个名）。
 */
export function nodeLabel(
  n: {
    question: string;
    topicLabel: string | null;
    kind: string;
    refTitle: string | null;
  },
  max = 40,
): string {
  if (n.topicLabel) return n.topicLabel;
  if (n.kind === "reference") return n.refTitle || "参考材料";
  // 多行问题折成一行：真库里贴进来的周报 / 列表带换行，单行 truncate 里
  // 换行只会变成一串空格（tree-panel 那边渲染在多行容器里，不需要折）。
  const q = n.question.replace(/\s+/g, " ").trim();
  return q.length > max ? `${q.slice(0, max - 1)}…` : q || "（空）";
}

/** DB 基线只保留终态；生成中 / 等输入由 /api/runs 的内存态实时覆盖。 */
export function chainStatus(
  row: Pick<RecentChainRow, "hasError" | "hasUnread">,
): RecentChainStatus {
  if (row.hasError) return "error";
  if (row.hasUnread) return "unread";
  return "done";
}

const STATUS_PRIORITY: Record<RecentChainStatus, number> = {
  done: 0,
  unread: 1,
  error: 2,
  streaming: 3,
  waiting: 4,
};

/** 整条 lineage 的实时态：等输入 > 生成中 > DB 的 error / unread / done。 */
export function deriveRecentChainStatus(
  chain: Pick<RecentChain, "nodeIds" | "status">,
  runningNodeIds: ReadonlySet<string>,
  waitingNodeIds: ReadonlySet<string>,
): RecentChainStatus {
  if (chain.nodeIds.some((id) => waitingNodeIds.has(id))) return "waiting";
  if (chain.nodeIds.some((id) => runningNodeIds.has(id))) return "streaming";
  return chain.status;
}

/** 会话行只做链状态聚合，沿用同一优先级。 */
export function recentSessionStatus(
  chains: readonly RecentChain[],
  runningNodeIds: ReadonlySet<string>,
  waitingNodeIds: ReadonlySet<string>,
): RecentChainStatus {
  let best: RecentChainStatus = "done";
  for (const chain of chains) {
    const status = deriveRecentChainStatus(
      chain,
      runningNodeIds,
      waitingNodeIds,
    );
    if (STATUS_PRIORITY[status] > STATUS_PRIORITY[best]) best = status;
  }
  return best;
}

/** 高优先级链提到可见区；同状态仍保持原来的活动时间顺序。 */
export function orderRecentChains(
  chains: readonly RecentChain[],
  runningNodeIds: ReadonlySet<string>,
  waitingNodeIds: ReadonlySet<string>,
): RecentChain[] {
  return chains
    .map((chain, index) => ({
      chain,
      index,
      priority:
        STATUS_PRIORITY[
          deriveRecentChainStatus(chain, runningNodeIds, waitingNodeIds)
        ],
    }))
    .sort((a, b) => b.priority - a.priority || a.index - b.index)
    .map(({ chain }) => chain);
}

export function rowToChain(row: RecentChainRow): RecentChain {
  return {
    tipId: row.tipId,
    rootId: row.rootId,
    nodeIds: row.nodeIds,
    label: nodeLabel({
      question: row.tipQuestion,
      topicLabel: row.tipTopicLabel,
      kind: row.tipKind,
      refTitle: row.tipRefTitle,
    }),
    treeLabel: nodeLabel({
      question: row.rootQuestion,
      topicLabel: row.rootTopicLabel,
      kind: row.rootKind,
      refTitle: row.rootRefTitle,
    }),
    depth: row.depth,
    activityAt: row.activityAt,
    status: chainStatus(row),
  };
}

/**
 * 行（已按 activityAt 降序）→ 会话分组。会话顺序 = 各自最热链的顺序（首次
 * 出现即最热，因为输入有序）；每会话链数截到 chainsPerSession，截掉的计入
 * moreChains。treeCounts 缺项按 1 处理（单树会话不带树名前缀）。
 */
export function groupRecentChains(
  rows: RecentChainRow[],
  treeCounts: ReadonlyMap<string, number>,
  opts?: {
    sessions?: number;
    chainsPerSession?: number;
    runningNodeIds?: ReadonlySet<string>;
    waitingNodeIds?: ReadonlySet<string>;
  },
): RecentSession[] {
  const maxSessions = opts?.sessions ?? RECENT_SESSION_LIMIT;
  const maxChains = opts?.chainsPerSession ?? RECENT_CHAINS_PER_SESSION;
  const bySession = new Map<
    string,
    {
      session: Omit<RecentSession, "chains" | "moreChains">;
      rows: RecentChainRow[];
    }
  >();
  for (const row of rows) {
    let entry = bySession.get(row.sessionId);
    if (!entry) {
      if (bySession.size >= maxSessions) continue;
      entry = {
        session: {
          id: row.sessionId,
          title: row.sessionTitle,
          mode: row.sessionMode,
          workspacePath: row.sessionWorkspacePath,
          activityAt: row.activityAt,
          treeCount: treeCounts.get(row.sessionId) ?? 1,
        },
        rows: [],
      };
      bySession.set(row.sessionId, entry);
    }
    entry.rows.push(row);
  }

  const runningNodeIds = opts?.runningNodeIds ?? new Set<string>();
  const waitingNodeIds = opts?.waitingNodeIds ?? new Set<string>();
  return [...bySession.values()].map(({ session, rows: sessionRows }) => {
    const allChains = orderRecentChains(
      sessionRows.map(rowToChain),
      runningNodeIds,
      waitingNodeIds,
    );
    return {
      ...session,
      chains: allChains.slice(0, maxChains),
      moreChains: Math.max(0, allChains.length - maxChains),
    };
  });
}
