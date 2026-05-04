"use client";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { refIcon } from "@/lib/ref-icon";
import type { ChatNode } from "@/lib/types";

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
  const floatingRefs = Object.values(nodes)
    .filter(
      (n) =>
        n.parentId === null && n.id !== qaRootId && n.kind === "reference",
    )
    .sort((a, b) => a.createdAt - b.createdAt);
  for (const r of floatingRefs) roots.push(attach(r));
  return roots;
}

export function Outline() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const forest = useMemo(
    () => (session ? buildForest(nodes, session.rootNodeId) : []),
    [session, nodes],
  );

  if (forest.length === 0) return null;

  return (
    <aside className="hidden md:block fixed left-3 top-[60px] w-60 bg-white/90 dark:bg-stone-900/90 backdrop-blur border border-stone-200 dark:border-stone-800 rounded-lg p-2 text-xs shadow-sm z-30 max-h-[calc(100vh-72px)] overflow-y-auto">
      <div className="text-stone-400 dark:text-stone-500 uppercase tracking-wider text-[10px] mb-1.5 px-2 font-medium">
        思维树
      </div>
      {forest.map((t, i) => (
        <div
          key={t.id}
          className={
            i > 0 ? "mt-1.5 pt-1.5 border-t border-stone-100 dark:border-stone-800" : undefined
          }
        >
          <TreeRow node={t} depth={0} />
        </div>
      ))}
    </aside>
  );
}

function TreeRow({ node, depth }: { node: TreeNode; depth: number }) {
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const isActive = activeNodeId === node.id;
  const isReference = node.kind === "reference";

  return (
    <div>
      <button
        onClick={() => setActiveNode(node.id)}
        className={`w-full text-left px-2 py-1 rounded text-[12px] truncate transition-colors ${
          isActive
            ? "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200 font-medium"
            : "text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800/60"
        }`}
        style={{ paddingLeft: `${8 + depth * 12}px` }}
        title={isReference ? node.reference?.sourceUri ?? undefined : node.question}
      >
        {depth > 0 && <span className="text-stone-400 dark:text-stone-500 mr-1">↳</span>}
        {isReference && (
          <span className="mr-1" aria-hidden>
            {refIcon(node.reference)}
          </span>
        )}
        {node.topicLabel ?? (isReference ? "参考材料" : truncate(node.question, 32))}
      </button>
      {node.children.map((c) => (
        <TreeRow key={c.id} node={c} depth={depth + 1} />
      ))}
    </div>
  );
}


function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
