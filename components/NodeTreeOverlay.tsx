"use client";
import { useEffect, useMemo, useRef } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { refIcon } from "@/lib/ref-icon";
import type { ChatNode } from "@/lib/types";

type TreeNode = ChatNode & { children: TreeNode[] };

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

export function NodeTreeOverlay({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);

  const forest = useMemo(
    () => (session ? buildForest(nodes, session.rootNodeId) : []),
    [session, nodes],
  );

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Auto-scroll active node into view when overlay opens
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      scrollRef.current
        ?.querySelector("[data-active-node='true']")
        ?.scrollIntoView({ block: "center", behavior: "auto" });
    }, 50);
    return () => window.clearTimeout(t);
  }, [open]);

  if (forest.length === 0) return null;

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      {/* backdrop — strong dim on mobile (focus), light on desktop side-drawer */}
      <div
        onClick={onClose}
        className={`absolute inset-0 bg-black/40 sm:bg-black/15 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      {/* sheet — bottom-up on mobile (60vh), right-side drawer on desktop */}
      <div
        className={`absolute bg-white dark:bg-stone-900 shadow-2xl flex flex-col overflow-hidden transition-transform duration-200
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl
          sm:inset-x-auto sm:right-2 sm:top-14 sm:bottom-2 sm:w-[320px] sm:h-auto sm:rounded-xl
          ${
            open
              ? "translate-y-0 sm:translate-x-0"
              : "translate-y-full sm:translate-y-0 sm:translate-x-[calc(100%+0.5rem)]"
          }`}
      >
        <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800 flex items-center gap-2 shrink-0">
          <div className="text-stone-400 dark:text-stone-500 uppercase tracking-wider text-[10px] font-medium">
            思维树
          </div>
          <div className="text-stone-400 dark:text-stone-500 text-xs">
            · {Object.keys(nodes).length} 节点
          </div>
          <button
            onClick={onClose}
            className="ml-auto text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 text-sm px-2 py-0.5"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div ref={scrollRef} className="flex-1 overflow-y-auto py-2">
          {forest.map((t, i) => (
            <div
              key={t.id}
              className={
                i > 0 ? "mt-2 pt-2 border-t border-stone-100 dark:border-stone-800" : undefined
              }
            >
              <TreeRow
                node={t}
                depth={0}
                activeId={activeNodeId}
                onPick={(id) => {
                  setActiveNode(id);
                  onClose();
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function TreeRow({
  node,
  depth,
  activeId,
  onPick,
}: {
  node: TreeNode;
  depth: number;
  activeId: string | null;
  onPick: (id: string) => void;
}) {
  const isActive = activeId === node.id;
  const isError = node.status === "error";
  const isStreaming = node.status === "streaming";
  const isReference = node.kind === "reference";
  return (
    <div>
      <button
        data-active-node={isActive ? "true" : undefined}
        onClick={() => onPick(node.id)}
        className={`w-full text-left px-3 py-2 text-[13px] active:scale-[0.99] transition-transform flex items-start gap-1.5 ${
          isActive
            ? "bg-indigo-50 dark:bg-indigo-950/50 text-indigo-900 dark:text-indigo-200"
            : "text-stone-700 dark:text-stone-300 hover:bg-stone-50 dark:hover:bg-stone-800/60"
        }`}
        style={{ paddingLeft: `${12 + depth * 14}px` }}
      >
        {depth > 0 && <span className="text-stone-400 dark:text-stone-500 shrink-0">↳</span>}
        {isReference && (
          <span className="shrink-0" aria-hidden>
            {refIcon(node.reference)}
          </span>
        )}
        <span className="flex-1 min-w-0">
          <span className={isActive ? "font-medium" : ""}>
            {node.topicLabel ??
              (isReference ? "参考材料" : truncate(node.question, 50))}
          </span>
          {isError && !isReference && (
            <span className="ml-1.5 text-rose-500 text-[10px]">·失败</span>
          )}
          {isStreaming && (
            <span className="ml-1.5 text-emerald-500 text-[10px]">·流中</span>
          )}
        </span>
      </button>
      {node.children.map((c) => (
        <TreeRow
          key={c.id}
          node={c}
          depth={depth + 1}
          activeId={activeId}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

