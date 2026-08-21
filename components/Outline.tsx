"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { refIcon } from "@/lib/ref-icon";
import { buildNodeIndex } from "@/lib/node-index";
import { childrenIndex, isUnreadNode } from "@/lib/tree-panel";
import { ancestorsOf } from "@/lib/collapsed";
import type { ChatNode } from "@/lib/types";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";

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
  const childrenByParent = childrenIndex(nodes);
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

export function Outline({ variant = "rail" }: { variant?: "rail" | "drawer" }) {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const outlineOpen = useSessionStore((s) => s.outlineOpen);
  const setOutlineOpen = useSessionStore((s) => s.setOutlineOpen);
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
  const [hiddenOpen, setHiddenOpen] = useState<boolean | null>(null);

  const visibleForest = useMemo(
    () => forest.filter((t) => t.hiddenAt === null),
    [forest],
  );
  const hiddenForest = useMemo(
    () => forest.filter((t) => t.hiddenAt !== null),
    [forest],
  );
  const isHiddenExpanded =
    hiddenOpen ?? (visibleForest.length === 0);

  if (forest.length === 0) return null;

  const body = (
    <>
      <div className="flex items-center justify-between mb-1.5 px-2">
        <div className="text-ink-faint uppercase tracking-wider text-nano font-medium">
          思维树
        </div>
        <div className="flex items-center gap-1.5">
          {unreadCount > 0 && (
            <button
              onClick={() => setUnreadOnly((v) => !v)}
              className={`text-nano font-medium tabular-nums px-1.5 py-0.5 rounded transition-colors inline-flex items-center gap-1 ${
                unreadOnly
                  ? "bg-unread-muted text-unread-ink"
                  : "text-unread-ink hover:bg-unread-muted"
              }`}
              title={unreadOnly ? "显示全部" : "只看未读"}
            >
              <span className="w-1.5 h-1.5 rounded-full bg-unread" aria-hidden />
              {unreadCount} 未读
            </button>
          )}
          {variant === "drawer" && (
            <button
              onClick={() => setOutlineOpen(false)}
              aria-label="关闭"
              className="md:hidden w-6 h-6 -mr-1 flex items-center justify-center rounded text-ink-muted hover:bg-surface-muted"
            >
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden>
                <path d="M3 3 L9 9 M9 3 L3 9" />
              </svg>
            </button>
          )}
        </div>
      </div>
      {visibleForest.map((t, i) => (
        <div
          key={t.id}
          className={
            i > 0 ? "mt-1.5 pt-1.5 border-t border-line-faint" : undefined
          }
        >
          <TreeRow node={t} branchDepth={0} isBranch={false} indices={indices} unreadOnly={unreadOnly} />
        </div>
      ))}
      {hiddenForest.length > 0 && (
        <div
          className={
            visibleForest.length > 0
              ? "mt-1.5 pt-1.5 border-t border-line-faint"
              : ""
          }
        >
          <button
            type="button"
            onClick={() => setHiddenOpen(!isHiddenExpanded)}
            className="w-full px-2 py-1 flex items-center gap-1 rounded text-ink-faint hover:bg-surface-muted transition-colors"
          >
            <span
              className={`inline-block transition-transform ${
                isHiddenExpanded ? "rotate-90" : ""
              }`}
              aria-hidden
            >
              ▸
            </span>
            已隐藏 · {hiddenForest.length} 棵
          </button>
          {isHiddenExpanded &&
            hiddenForest.map((t) => (
              <div key={t.id} className="mt-1">
                <TreeRow
                  node={t}
                  branchDepth={0}
                  isBranch={false}
                  indices={indices}
                  unreadOnly={unreadOnly}
                />
              </div>
            ))}
        </div>
      )}
    </>
  );

  // Mobile drawer (mounted at page top-level so it survives fullscreen, where
  // the canvas — and the rail Outline inside it — is unmounted).
  if (variant === "drawer") {
    return (
      <>
        {outlineOpen && (
          <div
            className="md:hidden fixed inset-0 z-40 bg-scrim/40 ui-enter-fade"
            onClick={() => setOutlineOpen(false)}
            aria-hidden
          />
        )}
        <aside
          className={`md:hidden fixed z-50 inset-x-3 top-[60px] bottom-3 bg-surface/95 backdrop-blur border border-line rounded-lg p-2 text-xs shadow-overlay overflow-y-auto ${
            outlineOpen ? "block ui-enter-pop" : "hidden"
          }`}
        >
          {body}
        </aside>
      </>
    );
  }

  // Desktop rail (default): permanent left rail, hidden on mobile. Wave 4:
  // shift right of the explorer sidebar when it's open (var from page.tsx;
  // falls back to 0 so the rail sits at its original left-3 = 12px).
  return (
    <aside
      className="hidden md:block fixed top-[96px] w-60 bg-surface/90 backdrop-blur border border-line rounded-lg p-2 text-xs shadow-raise z-30 max-h-[calc(100vh-108px)] overflow-y-auto"
      style={{ left: "calc(var(--trellis-sb, 0px) + 12px)" }}
    >
      {body}
    </aside>
  );
}

function TreeRow({
  node,
  branchDepth,
  isBranch,
  indices,
  unreadOnly,
}: {
  node: TreeNode;
  // 缩进按「祖先分叉点个数」而非「轮数」——线性段全部平铺(branchDepth 不变)，
  // 只有真分叉(父节点 >1 子)才让子代缩进一级。避免线性长聊变成跑出面板的楼梯。
  branchDepth: number;
  // 本节点是否是分叉子(父节点有多个子)——决定是否画 ↳ 标记。
  isBranch: boolean;
  indices: Record<string, number>;
  unreadOnly: boolean;
}) {
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setOutlineOpen = useSessionStore((s) => s.setOutlineOpen);
  const collapsed = useSessionStore((s) => s.collapsedNodeIds.has(node.id));
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);
  const setTreeHidden = useSessionStore((s) => s.setTreeHidden);
  const sessionRootId = useSessionStore((s) => s.session?.rootNodeId);
  const confirmDelete = useConfirmDelete();
  const isActive = activeNodeId === node.id;
  const isReference = node.kind === "reference";
  const index = indices[node.id];
  const unread = isUnreadNode(node);
  const hasChildren = node.children.length > 0;
  const canDelete = sessionRootId !== node.id;
  const isRoot = !node.parentId;
  const isHiddenRoot = isRoot && node.hiddenAt !== null;
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
            ? "bg-accent-muted"
            : "hover:bg-surface-muted"
        }`}
        style={{ paddingLeft: `${4 + branchDepth * 12}px` }}
      >
        {hasChildren ? (
          <button
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapse(node.id);
            }}
            className="shrink-0 w-4 h-5 flex items-center justify-center text-ink-faint hover:text-ink-muted"
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
          onClick={() => {
            setActiveNode(node.id);
            // Mobile drawer: close after navigating. No-op on desktop rail
            // (outlineOpen stays false there).
            setOutlineOpen(false);
          }}
          className={`flex-1 min-w-0 text-left pr-2 py-1 text-ui truncate transition-colors flex items-center gap-1 ${
            isActive
              ? "text-accent-ink font-medium"
              : dimReadInUnreadMode || isHiddenRoot
                ? "text-ink-faint"
                : "text-ink-muted"
          }`}
          title={
            isReference ? node.reference?.sourceUri ?? undefined : node.question
          }
        >
          {isBranch && (
            <span className="text-ink-faint">↳</span>
          )}
          {index ? (
            <span className="font-mono text-nano text-ink-faint tabular-nums">
              #{index}
            </span>
          ) : null}
          {unread && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-unread shrink-0"
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
          {isHiddenRoot && (
            <span className="shrink-0 px-1 rounded bg-surface-muted text-nano text-ink-faint">
              已隐藏
            </span>
          )}
          {hiddenCount > 0 && (
            <span className="ml-auto shrink-0 font-mono text-nano text-ink-faint tabular-nums">
              ({hiddenCount})
            </span>
          )}
        </button>
        {isRoot && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              const willHide = !isHiddenRoot;
              if (willHide) {
                const curActive = activeNodeId;
                if (
                  curActive === node.id ||
                  (curActive &&
                    ancestorsOf(curActive, useSessionStore.getState().nodes).includes(node.id))
                ) {
                  const allNodes = useSessionStore.getState().nodes;
                  const allRoots = Object.values(allNodes).filter((n) => !n.parentId);
                  const nextVisibleRoot = allRoots.find(
                    (r) => r.id !== node.id && r.hiddenAt === null,
                  );
                  if (nextVisibleRoot) {
                    setActiveNode(nextVisibleRoot.id);
                  }
                }
              }
              void setTreeHidden(node.id, willHide);
            }}
            className={`shrink-0 px-1.5 py-1 text-nano rounded transition-opacity ${
              isHiddenRoot
                ? "text-ink-muted hover:text-ink hover:bg-surface-muted"
                : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-ink-faint hover:text-ink hover:bg-surface-muted"
            }`}
            title={isHiddenRoot ? "恢复显示" : "隐藏这棵树（数据保留，可随时恢复）"}
            aria-label={isHiddenRoot ? "恢复显示" : "隐藏这棵树"}
          >
            {isHiddenRoot ? "恢复" : (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
                <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
                <line x1="1" y1="1" x2="23" y2="23" />
              </svg>
            )}
          </button>
        )}
        {canDelete && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              confirmDelete(node.id);
            }}
            title="删除节点（含子树）"
            aria-label="删除节点"
            className="shrink-0 w-5 h-5 mr-0.5 flex items-center justify-center rounded text-ink-faint opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:bg-danger-muted hover:text-danger transition-opacity"
          >
            <svg
              width="10"
              height="10"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              aria-hidden
            >
              <path d="M3 3 L9 9 M9 3 L3 9" />
            </svg>
          </button>
        )}
      </div>
      {!collapsed &&
        node.children.map((c) => (
          <TreeRow
            key={c.id}
            node={c}
            // 只有当前节点是真分叉(>1 子)时子代才缩进一级；线性单子保持同级平铺。
            branchDepth={branchDepth + (node.children.length > 1 ? 1 : 0)}
            isBranch={node.children.length > 1}
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
