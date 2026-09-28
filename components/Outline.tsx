"use client";
import { useMemo, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ChevronRight, CornerDownRight, EyeOff, FileText, Link2, X } from "lucide-react";
import { Icon, StatusDot } from "@/components/ui";
import { buildNodeIndex } from "@/lib/node-index";
import { childrenIndex, isUnreadNode } from "@/lib/tree-panel";
import { ancestorsOf } from "@/lib/collapsed";
import type { ChatNode } from "@/lib/types";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import {
  ContextMenu,
  useContextMenuWithTarget,
  type ContextMenuItem,
  type ContextMenuTriggerBindings,
} from "@/components/ui/ContextMenu";

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

export function Outline() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const sessionRootId = useSessionStore((s) => s.session?.rootNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setOutlineOpen = useSessionStore((s) => s.setOutlineOpen);
  const collapsedNodeIds = useSessionStore((s) => s.collapsedNodeIds);
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);
  const setTreeHidden = useSessionStore((s) => s.setTreeHidden);
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const markNodeUnread = useSessionStore((s) => s.markNodeUnread);
  const toggleBookmark = useSessionStore((s) => s.toggleBookmark);
  const confirmDelete = useConfirmDelete();

  const {
    target: menuTarget,
    bindTrigger,
    props: menuProps,
  } = useContextMenuWithTarget<TreeNode>();

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

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuTarget) return [];
    const isSessionRoot = sessionRootId === menuTarget.id;
    const hasChildren = menuTarget.children.length > 0;
    const isCollapsed = hasChildren && collapsedNodeIds.has(menuTarget.id);
    const unread = isUnreadNode(menuTarget);
    const isBookmarked = menuTarget.bookmarkedAt !== null;

    const navItems: ContextMenuItem[] = [
      {
        label: "跳转到此节点",
        onSelect: () => {
          setActiveNode(menuTarget.id);
          setOutlineOpen(false);
        },
      },
    ];
    if (hasChildren) {
      navItems.push({
        label: isCollapsed ? "展开子树" : "折叠子树",
        onSelect: () => toggleCollapse(menuTarget.id),
      });
    }

    const editItems: ContextMenuItem[] = [];
    if (menuTarget.status === "done") {
      editItems.push({
        label: unread ? "标为已读" : "标为未读",
        onSelect: () =>
          void (unread ? markNodeRead(menuTarget.id) : markNodeUnread(menuTarget.id)),
      });
    }
    editItems.push({
      label: isBookmarked ? "移出稍后再读" : "加入稍后再读",
      onSelect: () => void toggleBookmark(menuTarget.id),
    });
    if (menuTarget.question?.trim()) {
      editItems.push({
        label: "复制问题内容",
        onSelect: () => void navigator.clipboard?.writeText(menuTarget.question),
      });
    }
    if (!menuTarget.parentId) {
      const isHidden = menuTarget.hiddenAt !== null;
      editItems.push({
        label: isHidden ? "恢复显示" : "隐藏这棵树",
        onSelect: () => void setTreeHidden(menuTarget.id, !isHidden),
      });
    }

    return [
      ...navItems,
      "separator",
      ...editItems,
      "separator",
      {
        label: "删除节点（含子树）",
        danger: true,
        disabled: isSessionRoot,
        hint: isSessionRoot ? "会话主根" : undefined,
        onSelect: () => confirmDelete(menuTarget.id),
      },
    ];
  }, [
    menuTarget,
    sessionRootId,
    collapsedNodeIds,
    setActiveNode,
    setOutlineOpen,
    toggleCollapse,
    markNodeRead,
    markNodeUnread,
    toggleBookmark,
    setTreeHidden,
    confirmDelete,
  ]);

  const visibleForest = useMemo(
    () => forest.filter((t) => t.hiddenAt === null),
    [forest],
  );
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
              <StatusDot tone="unread" />
              {unreadCount} 未读
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
          <TreeRow
            node={t}
            branchDepth={0}
            isBranch={false}
            indices={indices}
            unreadOnly={unreadOnly}
            bindTrigger={bindTrigger}
          />
        </div>
      ))}
    </>
  );

  // Desktop rail (default): permanent left rail, hidden on mobile. Wave 4:
  // shift right of the explorer sidebar when it's open (var from page.tsx;
  // falls back to 0 so the rail sits at its original left-3 = 12px).
  return (
    <>
      <aside
        className="hidden md:block fixed top-24 w-60 bg-surface-raised border border-line rounded-card p-2 text-label shadow-pop z-20 overflow-y-auto"
        // 左缘跟随侧栏宽度变量、高度扣掉头部 —— 都是运行时变量算式，走 style。
        style={{ left: "calc(var(--trellis-sb, 0px) + 12px)", maxHeight: "calc(100dvh - 108px)" }}
      >
        {body}
      </aside>
      <ContextMenu
        {...menuProps}
        label="大纲节点菜单"
        items={menuItems}
      />
    </>
  );
}

function TreeRow({
  node,
  branchDepth,
  isBranch,
  indices,
  unreadOnly,
  bindTrigger,
}: {
  node: TreeNode;
  // 缩进按「祖先分叉点个数」而非「轮数」——线性段全部平铺(branchDepth 不变)，
  // 只有真分叉(父节点 >1 子)才让子代缩进一级。避免线性长聊变成跑出面板的楼梯。
  branchDepth: number;
  // 本节点是否是分叉子(父节点有多个子)——决定是否画 ↳ 标记。
  isBranch: boolean;
  indices: Record<string, number>;
  unreadOnly: boolean;
  bindTrigger: (node: TreeNode) => ContextMenuTriggerBindings;
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
        data-outline-node-id={node.id}
        {...bindTrigger(node)}
        className={`group w-full rounded transition-colors flex items-center ${
          isActive
            ? "bg-accent-muted"
            : "hover:bg-surface-hover"
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
            <Icon
              icon={ChevronRight}
              size="sm"
              className={`transition-transform ${collapsed ? "" : "rotate-90"}`}
            />
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
            <Icon icon={CornerDownRight} size="sm" className="text-fork" />
          )}
          {index ? (
            <span className="font-mono text-nano text-ink-faint tabular-nums">
              #{index}
            </span>
          ) : null}
          {unread && (
            <StatusDot tone="unread" label="未读" />
          )}
          {isReference && (
            <Icon
              icon={node.reference?.sourceType === "paste" ? FileText : Link2}
              size="sm"
              className="text-ink-faint"
            />
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
                ? "text-ink-muted hover:text-ink hover:bg-surface-hover"
                : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 text-ink-faint hover:text-ink hover:bg-surface-hover"
            }`}
            title={isHiddenRoot ? "恢复显示" : "隐藏这棵树（数据保留，可随时恢复）"}
            aria-label={isHiddenRoot ? "恢复显示" : "隐藏这棵树"}
          >
            {isHiddenRoot ? "恢复" : (
              <Icon icon={EyeOff} size="sm" />
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
            className="shrink-0 size-5 mr-0.5 flex items-center justify-center rounded-field text-ink-faint opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-danger-muted hover:text-danger-ink transition-opacity"
          >
            <Icon icon={X} size="sm" />
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
            bindTrigger={bindTrigger}
          />
        ))}
    </div>
  );
}


function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
