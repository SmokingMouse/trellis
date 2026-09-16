import type { RecentChain, RecentChainStatus, RecentSession } from "./types";
export type { RecentChain, RecentChainStatus, RecentSession };

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
  tipStatus: string;
  tipReadAt: number | null;
  tipWaiting: boolean;
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

/** DB 基线只看链尾：等输入 > 生成中 > 出错 > 未读 > 普通。 */
export function chainStatus(
  row: Pick<RecentChainRow, "tipStatus" | "tipReadAt" | "tipWaiting">,
): RecentChainStatus {
  if (row.tipWaiting) return "waiting";
  if (row.tipStatus === "streaming") return "streaming";
  if (row.tipStatus === "error") return "error";
  if (row.tipStatus === "done" && row.tipReadAt == null) return "unread";
  return "done";
}

export const STATUS_PRIORITY: Record<RecentChainStatus, number> = {
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

/**
 * 会话行 = 链聚合与原 session 位图的较高优先级。
 * sessionRunning 包含轮询集合与当前会话本地 activeRunning，确保最近链截断或
 * 尚未拉到新 lineage 时，会话行不会比改造前更暗。
 */
export function recentSessionStatus(
  chains: readonly RecentChain[],
  runningNodeIds: ReadonlySet<string>,
  waitingNodeIds: ReadonlySet<string>,
  sessionState: { running: boolean; unread: boolean } = {
    running: false,
    unread: false,
  },
): RecentChainStatus {
  let best: RecentChainStatus = sessionState.running
    ? "streaming"
    : sessionState.unread
      ? "unread"
      : "done";
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

/** 只提升实时活跃链；error / unread 等 DB 基线不改变活动时间顺序。 */
export function orderRecentChains(
  chains: readonly RecentChain[],
  runningNodeIds: ReadonlySet<string>,
  waitingNodeIds: ReadonlySet<string>,
): RecentChain[] {
  return chains
    .map((chain, index) => ({
      chain,
      index,
      priority: chain.nodeIds.some((id) => waitingNodeIds.has(id))
        ? 2
        : chain.nodeIds.some((id) => runningNodeIds.has(id))
          ? 1
          : 0,
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

export type SessionTreeChain = {
  tipId: string;
  rootId: string;
  label: string;
  activityAt: number;
  status: RecentChainStatus;
  nodeIds: string[];
  depth: number;
};

export type SessionTree = {
  rootId: string;
  treeLabel: string;
  nodeCount: number;
  activityAt: number;
  status: RecentChainStatus;
  chains: SessionTreeChain[];
};

export type SessionStructure = {
  sessionId: string;
  trees: SessionTree[];
};

/**
 * 把按会话取出的链（叶子）行按树归组。
 * 树与链都按最近活动降序排序；树状态为该树下所有链最高紧急度。
 * 节点数为该树下所有链 nodeIds 的去重并集大小。
 */
export function groupSessionStructure(
  rows: RecentChainRow[],
  opts?: {
    runningNodeIds?: ReadonlySet<string>;
    waitingNodeIds?: ReadonlySet<string>;
  },
): SessionTree[] {
  const runningNodeIds = opts?.runningNodeIds ?? new Set<string>();
  const waitingNodeIds = opts?.waitingNodeIds ?? new Set<string>();

  const byRoot = new Map<
    string,
    {
      rootRow: RecentChainRow;
      chains: SessionTreeChain[];
      nodeIds: Set<string>;
    }
  >();

  for (const row of rows) {
    let entry = byRoot.get(row.rootId);
    if (!entry) {
      entry = {
        rootRow: row,
        chains: [],
        nodeIds: new Set<string>(),
      };
      byRoot.set(row.rootId, entry);
    }
    for (const nid of row.nodeIds) {
      entry.nodeIds.add(nid);
    }
    const chain: SessionTreeChain = {
      tipId: row.tipId,
      rootId: row.rootId,
      label: nodeLabel({
        question: row.tipQuestion,
        topicLabel: row.tipTopicLabel,
        kind: row.tipKind,
        refTitle: row.tipRefTitle,
      }),
      activityAt: row.activityAt,
      status: deriveRecentChainStatus(
        { nodeIds: row.nodeIds, status: chainStatus(row) },
        runningNodeIds,
        waitingNodeIds,
      ),
      nodeIds: row.nodeIds,
      depth: row.depth,
    };
    entry.chains.push(chain);
  }

  const trees: SessionTree[] = [];
  for (const entry of byRoot.values()) {
    // 链按最近活动降序排序
    entry.chains.sort((a, b) => b.activityAt - a.activityAt || a.tipId.localeCompare(b.tipId));

    // 树的最近活动时间 = 链中最大 activityAt
    const maxActivity = entry.chains.length > 0 ? entry.chains[0].activityAt : entry.rootRow.activityAt;

    // 树状态 = 聚合所有链的状态
    let treeStatus: RecentChainStatus = "done";
    for (const c of entry.chains) {
      if (STATUS_PRIORITY[c.status] > STATUS_PRIORITY[treeStatus]) {
        treeStatus = c.status;
      }
    }

    trees.push({
      rootId: entry.rootRow.rootId,
      treeLabel: nodeLabel({
        question: entry.rootRow.rootQuestion,
        topicLabel: entry.rootRow.rootTopicLabel,
        kind: entry.rootRow.rootKind,
        refTitle: entry.rootRow.rootRefTitle,
      }),
      nodeCount: entry.nodeIds.size,
      activityAt: maxActivity,
      status: treeStatus,
      chains: entry.chains,
    });
  }

  // 树列表按最近活动降序排序
  trees.sort((a, b) => b.activityAt - a.activityAt || a.rootId.localeCompare(b.rootId));

  return trees;
}

/**
 * 决定会话在侧栏的折叠状态（SN-1）：
 * - 显式折叠 key: `session:collapsed:${sessionId}` 或旧 key `session:${sessionId}`
 * - 显式展开 key: `session:expanded:${sessionId}`
 * - 默认状态由树数决定：多树会话（treeCount > 1）默认展开到树行（返回 false）；
 *   单树会话（treeCount <= 1）默认折叠（返回 true）。
 */
export function resolveSessionCollapsed(
  sessionId: string,
  treeCount: number,
  collapsedKeys: ReadonlySet<string>,
): boolean {
  if (
    collapsedKeys.has(`session:collapsed:${sessionId}`) ||
    collapsedKeys.has(`session:${sessionId}`)
  ) {
    return true;
  }
  if (collapsedKeys.has(`session:expanded:${sessionId}`)) {
    return false;
  }
  return treeCount <= 1;
}

/**
 * 决定树在会话下的展开状态（SN-1）：
 * - 显式展开 key: `tree:expanded:${sessionId}:${rootId}`
 * - 显式折叠 key: `tree:collapsed:${sessionId}:${rootId}` 或旧 key `tree:${sessionId}:${rootId}` 或 `tree:${rootId}`
 * - 树默认自身折叠（返回 false）
 */
export function resolveTreeExpanded(
  sessionId: string,
  rootId: string,
  collapsedKeys: ReadonlySet<string>,
): boolean {
  if (collapsedKeys.has(`tree:expanded:${sessionId}:${rootId}`)) {
    return true;
  }
  if (
    collapsedKeys.has(`tree:collapsed:${sessionId}:${rootId}`) ||
    collapsedKeys.has(`tree:${sessionId}:${rootId}`) ||
    collapsedKeys.has(`tree:${rootId}`)
  ) {
    return false;
  }
  return false;
}

/**
 * 切换会话折叠状态：
 * 从当前计算出的 currentCollapsed 翻转为 targetCollapsed = !currentCollapsed。
 * 显式存入 `session:collapsed:${sessionId}` 或 `session:expanded:${sessionId}`，
 * 并清理对立 key 与 legacy key。
 */
export function toggleSessionCollapsedState(
  sessionId: string,
  currentCollapsed: boolean,
  prevKeys: Iterable<string>,
): string[] {
  const nextSet = new Set(prevKeys);
  const targetCollapsed = !currentCollapsed;
  const colKey = `session:collapsed:${sessionId}`;
  const expKey = `session:expanded:${sessionId}`;
  const legKey = `session:${sessionId}`;

  nextSet.delete(colKey);
  nextSet.delete(expKey);
  nextSet.delete(legKey);

  if (targetCollapsed) {
    nextSet.add(colKey);
  } else {
    nextSet.add(expKey);
  }
  return [...nextSet];
}

/**
 * 切换树折叠状态：
 * 从当前计算出的 currentExpanded 翻转为 targetExpanded = !currentExpanded。
 * 显式存入 `tree:expanded:${sessionId}:${rootId}` 或 `tree:collapsed:${sessionId}:${rootId}`，
 * 并清理对立 key 与 legacy key。
 */
export function toggleTreeExpandedState(
  sessionId: string,
  rootId: string,
  currentExpanded: boolean,
  prevKeys: Iterable<string>,
): string[] {
  const nextSet = new Set(prevKeys);
  const targetExpanded = !currentExpanded;
  const expKey = `tree:expanded:${sessionId}:${rootId}`;
  const colKey = `tree:collapsed:${sessionId}:${rootId}`;
  const legKey1 = `tree:${sessionId}:${rootId}`;
  const legKey2 = `tree:${rootId}`;

  nextSet.delete(expKey);
  nextSet.delete(colKey);
  nextSet.delete(legKey1);
  nextSet.delete(legKey2);

  if (targetExpanded) {
    nextSet.add(expKey);
  } else {
    nextSet.add(colKey);
  }
  return [...nextSet];
}
