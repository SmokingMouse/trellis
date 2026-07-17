import type { ChatNode } from "./types";

// 树面板（TreePanel）的纯数据层：把 session 的森林（多根）整理成
// 热区 / 冷组 / 已隐藏 三组树条目，外加当前树的扁平化行列表。
// 设计要点（见 progress S65 讨论）：
//   - 树级语义用文字（topicLabel），节点级结构用列表行 —— 点阵 minimap 退役。
//   - 热度 = 子树内 max(createdAt, readAt)（「最近长过新节点或读过新内容」的
//     v1 代理；真·最近访问需要 lastVisitedAt，被绊到再加）。
//   - 排名制而非时间阈值：前 HOT_TREE_LIMIT 棵进热区，其余进「更早」。
//     时间制在休假回来后会全场皆冷，排名制永远有东西可见。
//   - 手动雪藏（root.hiddenAt）= 强制冷藏，不参与热度排名；其未读也不再
//     计入面板的全局未读感知（藏的意义之一就是别再烦我）。

export const HOT_TREE_LIMIT = 5;

export type TreeEntry = {
  root: ChatNode;
  /** 子树全体（含根） */
  nodes: ChatNode[];
  count: number;
  unreadCount: number;
  /** max(createdAt, readAt ?? 0) over subtree */
  heat: number;
  /** 子树内 createdAt 最大的节点 —— 切树时的落点（回到最新工作处） */
  latestNodeId: string;
  hidden: boolean;
};

export type TreeGroups = {
  hot: TreeEntry[];
  cold: TreeEntry[];
  hidden: TreeEntry[];
};

export type TreeRowItem = {
  node: ChatNode;
  /** 缩进 = 祖先真分叉（>1 子）个数；线性段平铺（与 Outline 同规则） */
  depth: number;
  /** 是否分叉子（父节点 >1 子）—— 决定 ↳ 标记 */
  isBranch: boolean;
};

export function isUnreadNode(n: ChatNode): boolean {
  return n.status === "done" && !n.readAt;
}

function nodeSort(a: ChatNode, b: ChatNode) {
  return (
    a.siblingIndex - b.siblingIndex ||
    a.createdAt - b.createdAt ||
    a.id.localeCompare(b.id)
  );
}

export function childrenIndex(
  nodes: Record<string, ChatNode>,
): Map<string, ChatNode[]> {
  const byParent = new Map<string, ChatNode[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const arr = byParent.get(n.parentId) ?? [];
    arr.push(n);
    byParent.set(n.parentId, arr);
  }
  for (const arr of byParent.values()) arr.sort(nodeSort);
  return byParent;
}

/** 走到 nodeId 所在树的根。断链（父节点缺失）时返回可达的最高祖先。 */
export function rootIdOf(
  nodeId: string,
  nodes: Record<string, ChatNode>,
): string | null {
  let cur = nodes[nodeId];
  if (!cur) return null;
  for (let i = 0; i < 1000 && cur.parentId; i++) {
    const parent = nodes[cur.parentId];
    if (!parent) break;
    cur = parent;
  }
  return cur.id;
}

/** 树的展示标签：topicLabel 优先，reference 根落「参考材料」，qa 根落问题前缀。 */
export function treeLabel(root: ChatNode, max = 40): string {
  if (root.topicLabel) return root.topicLabel;
  if (root.kind === "reference") {
    return root.reference?.meta?.title || "参考材料";
  }
  const q = root.question.trim();
  return q.length > max ? `${q.slice(0, max - 1)}…` : q || "（空）";
}

/** 整座森林 → 树条目列表，热度降序。 */
export function buildTreeEntries(
  nodes: Record<string, ChatNode>,
): TreeEntry[] {
  const byParent = childrenIndex(nodes);
  const roots = Object.values(nodes)
    .filter((n) => !n.parentId)
    .sort((a, b) => a.createdAt - b.createdAt);

  const entries: TreeEntry[] = [];
  for (const root of roots) {
    const members: ChatNode[] = [];
    const stack = [root];
    while (stack.length) {
      const cur = stack.pop()!;
      members.push(cur);
      const kids = byParent.get(cur.id);
      if (kids) stack.push(...kids);
    }
    let heat = 0;
    let unreadCount = 0;
    let latest = root;
    for (const n of members) {
      heat = Math.max(heat, n.createdAt, n.readAt ?? 0);
      if (isUnreadNode(n)) unreadCount++;
      if (n.createdAt > latest.createdAt) latest = n;
    }
    entries.push({
      root,
      nodes: members,
      count: members.length,
      unreadCount,
      heat,
      latestNodeId: latest.id,
      hidden: root.hiddenAt !== null,
    });
  }
  entries.sort((a, b) => b.heat - a.heat || a.root.id.localeCompare(b.root.id));
  return entries;
}

/**
 * 分组：热区 = 未隐藏里热度前 K（当前树未隐藏时强制在热区，挤掉末位）；
 * 冷组 = 其余未隐藏；已隐藏 = 手动雪藏的树（热度降序）。
 */
export function groupTrees(
  entries: TreeEntry[],
  activeRootId: string | null,
  limit = HOT_TREE_LIMIT,
): TreeGroups {
  const visible = entries.filter((e) => !e.hidden);
  const hidden = entries.filter((e) => e.hidden);
  let hot = visible.slice(0, limit);
  const cold = visible.slice(limit);
  if (activeRootId) {
    const idx = cold.findIndex((e) => e.root.id === activeRootId);
    if (idx !== -1) {
      // 当前树落在冷组 → 换进热区末位，被挤出的那棵回冷组原位。
      const active = cold[idx];
      const evicted = hot[hot.length - 1];
      hot = [...hot.slice(0, -1), active];
      cold.splice(idx, 1, evicted);
    }
  }
  return { hot, cold, hidden };
}

/** 当前树扁平化为面板行：线性段平铺，仅真分叉处缩进一级（与 Outline 同规）。 */
export function flattenTree(
  rootId: string,
  nodes: Record<string, ChatNode>,
): TreeRowItem[] {
  const byParent = childrenIndex(nodes);
  const rows: TreeRowItem[] = [];
  const walk = (n: ChatNode, depth: number, isBranch: boolean) => {
    rows.push({ node: n, depth, isBranch });
    const kids = byParent.get(n.id) ?? [];
    const fork = kids.length > 1;
    for (const k of kids) walk(k, depth + (fork ? 1 : 0), fork);
  };
  const root = nodes[rootId];
  if (root) walk(root, 0, false);
  return rows;
}

// Markdown → 纯文本摘要（悬停预览卡用）。有损：代码块/图片在这个尺寸下
// 没有可扫读信号，直接丢弃。（自退役的 ThreadMinimap 迁入。）
export function mdExcerpt(md: string, max: number): string {
  const text = md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/(\*{1,3}|_{1,3}|~~)([^*_~]+)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
