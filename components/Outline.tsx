"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { refIcon } from "@/lib/ref-icon";
import { buildNodeIndex } from "@/lib/node-index";
import type { ChatNode } from "@/lib/types";

function isUnreadNode(n: ChatNode): boolean {
  return n.status === "done" && !n.readAt;
}

// Recursive: a tree node passes the "has any unread descendant or self" test
// when filtering — keeps the parent visible even if it's been read, so the
// hierarchy doesn't collapse into orphans.
function subtreeHasUnread(t: TreeNode): boolean {
  if (isUnreadNode(t)) return true;
  return t.children.some(subtreeHasUnread);
}

function countDescendants(t: TreeNode): number {
  let n = 0;
  for (const c of t.children) n += 1 + countDescendants(c);
  return n;
}

type TreeNode = ChatNode & { children: TreeNode[] };

// Build a forest: the qa root tree, then each floating reference as its own
// root (followed by any qa children branched off it).
function buildForest(
  nodes: Record<string, ChatNode>,
  qaRootId: string,
): TreeNode[] {
  const childrenByParent = new Map<string, ChatNode[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const arr = childrenByParent.get(n.parentId) ?? [];
    arr.push(n);
    childrenByParent.set(n.parentId, arr);
  }
  for (const arr of childrenByParent.values()) {
    arr.sort((a, b) => a.siblingIndex - b.siblingIndex);
  }
  const attach = (n: ChatNode): TreeNode => ({
    ...n,
    children: (childrenByParent.get(n.id) ?? []).map(attach),
  });

  const roots: TreeNode[] = [];
  const qaRoot = nodes[qaRootId];
  if (qaRoot) roots.push(attach(qaRoot));
  // Any other parentId=null node is a parallel root — both floating
  // reference cards and "新提问" qa roots created via the canvas FAB.
  const parallelRoots = Object.values(nodes)
    .filter((n) => n.parentId === null && n.id !== qaRootId)
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const r of parallelRoots) roots.push(attach(r));
  return roots;
}

export function Outline() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const forest = useMemo(
    () => (session ? buildForest(nodes, session.rootNodeId) : []),
    [session, nodes],
  );
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const unreadCount = useMemo(
    () => Object.values(nodes).filter(isUnreadNode).length,
    [nodes],
  );
  const [unreadOnly, setUnreadOnly] = useState(false);

  if (forest.length === 0) return null;

  return (
    <aside className="hidden md:block fixed left-3 top-[60px] w-60 bg-white/90 dark:bg-stone-900/90 backdrop-blur border border-stone-200 dark:border-stone-800 rounded-lg p-2 text-xs shadow-sm z-30 max-h-[calc(100vh-72px)] overflow-y-auto">
      <div className="flex items-center justify-between mb-1.5 px-2">
        <div className="text-stone-400 dark:text-stone-500 uppercase tracking-wider text-[10px] font-medium">
          思维树
        </div>
        {unreadCount > 0 && (
          <button
            onClick={() => setUnreadOnly((v) => !v)}
            className={`text-[10px] font-medium tabular-nums px-1.5 py-0.5 rounded transition-colors inline-flex items-center gap-1 ${
              unreadOnly
                ? "bg-amber-100 dark:bg-amber-950/60 text-amber-800 dark:text-amber-200"
                : "text-amber-700 dark:text-amber-400 hover:bg-amber-50 dark:hover:bg-amber-950/30"
            }`}
            title={unreadOnly ? "显示全部" : "只看未读"}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500" aria-hidden />
            {unreadCount} 未读
          </button>
        )}
      </div>
      {forest.map((t, i) => (
        <div
          key={t.id}
          className={
            i > 0 ? "mt-1.5 pt-1.5 border-t border-stone-100 dark:border-stone-800" : undefined
          }
        >
          <TreeRow
            node={t}
            depth={0}
            indices={indices}
            unreadOnly={unreadOnly}
          />
        </div>
      ))}
    </aside>
  );
}

function TreeRow({
  node,
  depth,
  indices,
  unreadOnly,
}: {
  node: TreeNode;
  depth: number;
  indices: Record<string, number>;
  unreadOnly: boolean;
}) {
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const collapsed = useSessionStore((s) => s.collapsedNodeIds.has(node.id));
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);
  const isActive = activeNodeId === node.id;
  const isReference = node.kind === "reference";
  const index = indices[node.id];
  const unread = isUnreadNode(node);
  const hasChildren = node.children.length > 0;
  // In "unread only" mode, hide read leaves entirely. A read row with at
  // least one unread descendant stays visible (rendered dim) so the
  // hierarchy doesn't lose context.
  if (unreadOnly && !unread && !node.children.some(subtreeHasUnread)) {
    return null;
  }
  const dimReadInUnreadMode = unreadOnly && !unread;
  const hiddenCount = collapsed ? countDescendants(node) : 0;

  return (
    <div>
      <div
        className={`group w-full rounded transition-colors flex items-center ${
          isActive
            ? "bg-indigo-50 dark:bg-indigo-950/50"
            : "hover:bg-stone-50 dark:hover:bg-stone-800/60"
        }`}
        style={{ paddingLeft: `${4 + depth * 12}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
            className="shrink-0 w-4 h-5 flex items-center justify-center text-stone-400 dark:text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
            title={collapsed ? "展开" : "折叠"}
            aria-label={collapsed ? "展开" : "折叠"}
          >
            <svg
              width="9"
              height="9"
              viewBox="0 0 12 12"
              className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
              fill="currentColor"
              aria-hidden
            >
              <path d="M3 2 L9 6 L3 10 Z" />
            </svg>
          </button>
        ) : (
          <span className="shrink-0 w-4 h-5" aria-hidden />
        )}
        <button
          onClick={() => setActiveNode(node.id)}
          className={`flex-1 min-w-0 text-left pr-2 py-1 text-[12px] truncate transition-colors flex items-center gap-1 ${
            isActive
              ? "text-indigo-900 dark:text-indigo-200 font-medium"
              : dimReadInUnreadMode
                ? "text-stone-400 dark:text-stone-600"
                : "text-stone-600 dark:text-stone-400"
          }`}
          title={
            isReference ? node.reference?.sourceUri ?? undefined : node.question
          }
        >
          {depth > 0 && (
            <span className="text-stone-400 dark:text-stone-500">↳</span>
          )}
          {index ? (
            <span className="font-mono text-[10.5px] text-stone-400 dark:text-stone-500 tabular-nums">
              #{index}
            </span>
          ) : null}
          {unread && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
              aria-label="未读"
            />
          )}
          {isReference && (
            <span className="shrink-0" aria-hidden>
              {refIcon(node.reference)}
            </span>
          )}
          <span className="truncate">
            {node.topicLabel ??
              (isReference ? "参考材料" : truncate(node.question, 32))}
          </span>
          {hiddenCount > 0 && (
            <span className="ml-auto shrink-0 font-mono text-[10px] text-stone-400 dark:text-stone-500 tabular-nums">
              ({hiddenCount})
            </span>
          )}
        </button>
      </div>
      {!collapsed &&
        node.children.map((c) => (
          <TreeRow
            key={c.id}
            node={c}
            depth={depth + 1}
            indices={indices}
            unreadOnly={unreadOnly}
          />
        ))}
    </div>
  );
}


function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
