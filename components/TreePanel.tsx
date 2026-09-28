"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { isBoolean, useSidebarPreference } from "@/hooks/useSidebarPreference";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { ancestorsOf, hiddenByCollapse } from "@/lib/collapsed";
import { layoutNodes } from "@/lib/layout";
import {
  ChevronRight,
  CircleCheck,
  CircleDot,
  CornerDownRight,
  EyeOff,
  FileText,
  GitBranch,
  Link2,
  List,
  MessageCircleQuestion,
  Minimize2,
  Network,
  Pencil,
  Plus,
  Search,
  X,
} from "lucide-react";
import { Icon, IconButton, StatusDot } from "@/components/ui";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import {
  ContextMenu,
  useContextMenuWithTarget,
  type ContextMenuItem,
} from "@/components/ui/ContextMenu";
import {
  buildTreeEntries,
  childrenIndex,
  flattenTree,
  groupTrees,
  isUnreadNode,
  isWaitingNode,
  mdExcerpt,
  rootIdOf,
  subtreeRollup,
  treeLabel,
  type HiddenRollup,
  type TreeEntry,
} from "@/lib/tree-panel";
import type { ChatNode } from "@/lib/types";

// 线性视图右下角的「树面板」—— 点阵 minimap（ThreadMinimap）的接任者。
// 树级语义用文字行（topicLabel + 计数 + 未读角标），节点级用当前树的扁平
// 行列表；热度排序 + 排名制冷组 + 手动雪藏组；⌕/⌘J 过滤跳转。悬停行浮出
// S61 同款预览卡。设计讨论见 progress S65。

const PREVIEW_W = "w-64";

// 当前树的「图形」视图（列表 ↔ 图形可切换，用户找回分叉形状感）。
// 只画当前树 —— 全森林点阵正是 S65 退役 ThreadMinimap 的原因；树级
// 语义继续由文字行承担，图形只负责单树的结构直觉。偏好走 store
// treePanelView（sendKey 同款 localStorage 持久化）。
const GRAPH_W = 272;
const GRAPH_MAX_H = 300;
const GRAPH_PAD = 14;
// dagre compact 布局的节点尺寸（lib/layout 常量的镜像，仅用于取卡片中心）
const GRAPH_NODE_W = 280;
const GRAPH_NODE_H = 90;
// 缩放上限。dagre 的 rank 间距在原尺寸下是 126px —— 点少时（树本来就小，
// 或刚被折叠剩几个）不设限就会把两个点拉开一屏，折叠反而"越折越空"。
// 0.4 ≈ 50px 行距，与密树自然落到的 ~34px 同一量级；密树 scale 本就低于
// 此值，不受影响。
const GRAPH_MAX_SCALE = 0.4;
// 纵向缩放下限：层距不许小于 12px（点直径 7px + 呼吸空间）。长树因此会
// 超出 GRAPH_MAX_H —— 有意的：面板体本就 overflow-y-auto，超高就滚动，
// 比把 80 个点压成一串珠子强。12 / 126（dagre compact 层距）≈ 0.095。
const GRAPH_MIN_SCALE_Y = 12 / 126;

type Hover = { nodeId: string; top: number } | null;

// 参考卡的行首图标：粘贴文本 / 链接两类，lucide 线性图标（原平台 emoji 退役）。
function RefGlyph({ node }: { node: ChatNode }) {
  return (
    <Icon
      icon={node.reference?.sourceType === "paste" ? FileText : Link2}
      size="sm"
      className="text-ink-faint"
    />
  );
}

function WaitingGlyph({ title, label }: { title: string; label: string }) {
  return (
    <span className="shrink-0 inline-flex text-warn-ink" title={title} aria-label={label}>
      <Icon icon={MessageCircleQuestion} size="sm" />
    </span>
  );
}

function nodeRowLabel(n: ChatNode, max = 30): string {
  if (n.topicLabel) return n.topicLabel;
  const q = n.question.trim();
  if (!q && n.kind === "reference") return "参考材料";
  return q.length > max ? `${q.slice(0, max - 1)}…` : q || "（空）";
}

export function TreePanel() {
  const isMobile = useIsMobile();
  const sessionId = useSessionStore((s) => s.session?.id);
  const nodesMap = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setTreeHidden = useSessionStore((s) => s.setTreeHidden);
  const renameTree = useSessionStore((s) => s.renameTree);
  const markNodeRead = useSessionStore((s) => s.markNodeRead);
  const markNodeUnread = useSessionStore((s) => s.markNodeUnread);
  const treeVisits = useSessionStore((s) => s.treeVisits);
  // 折叠子树与画布 / Outline 共用同一套 collapsedNodeIds —— 「这个子树折
  // 起来了」是树的状态而非某个视图的状态；持久化 / 新子自动展开 / 跳转自动
  // 展开祖先（setActiveNode → expandAncestors）全部免费继承。
  const collapsedNodeIds = useSessionStore((s) => s.collapsedNodeIds);
  const toggleCollapse = useSessionStore((s) => s.toggleCollapse);

  const view = useSessionStore((s) => s.treePanelView);
  const switchView = useSessionStore((s) => s.setTreePanelView);
  const setComposeRootOpen = useSessionStore((s) => s.setComposeRootOpen);
  const mobileOpen = useSessionStore((s) => s.mobileTreePanelOpen);
  const setMobileOpen = useSessionStore((s) => s.setMobileTreePanelOpen);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const sessionRootId = useSessionStore((s) => s.session?.rootNodeId);
  const toggleBookmark = useSessionStore((s) => s.toggleBookmark);
  const confirmDelete = useConfirmDelete();

  // 桌面端「收起为右下小圆点」—— 偏好持久化（localStorage），跨会话保留。
  const [collapsed, setCollapsed] = useSidebarPreference("tree-panel-collapsed", false, isBoolean);
  const [coldOpen, setColdOpen] = useSidebarPreference("tree-earlier-open", false, isBoolean);
  // 树重命名编辑态
  const [editingRootId, setEditingRootId] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState("");
  // null = 过滤模式关闭；字符串（含空串）= 开启且为当前查询。
  const [filter, setFilter] = useState<string | null>(null);
  const [filterSel, setFilterSel] = useState(0);
  const [hover, setHover] = useState<Hover>(null);

  const {
    target: menuTarget,
    bindTrigger,
    props: menuProps,
  } = useContextMenuWithTarget<
    | { type: "tree"; entry: TreeEntry }
    | { type: "node"; node: ChatNode }
  >();

  const bodyRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);
  const mobileCloseRef = useRef<HTMLButtonElement>(null);
  const mobileSessionRef = useRef(sessionId);

  useEffect(() => {
    if (mobileSessionRef.current !== sessionId) setMobileOpen(false);
    mobileSessionRef.current = sessionId;
  }, [sessionId, setMobileOpen]);

  useEffect(() => {
    if (!isMobile || !mobileOpen) return;
    mobileCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setMobileOpen(false);
      setViewMode("linear");
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isMobile, mobileOpen, setMobileOpen, setViewMode]);

  const entries = useMemo(
    () => buildTreeEntries(nodesMap, treeVisits),
    [nodesMap, treeVisits],
  );
  const indices = useMemo(() => buildNodeIndex(nodesMap), [nodesMap]);
  const byParent = useMemo(() => childrenIndex(nodesMap), [nodesMap]);
  const activeRootId = useMemo(() => {
    const anchor = activeNodeId && nodesMap[activeNodeId] ? activeNodeId : null;
    if (anchor) return rootIdOf(anchor, nodesMap);
    const firstVisible = entries.find((e) => !e.hidden);
    return firstVisible?.root.id ?? entries[0]?.root.id ?? null;
  }, [activeNodeId, nodesMap, entries]);
  const groups = useMemo(
    () => groupTrees(entries, activeRootId),
    [entries, activeRootId],
  );
  const activeRows = useMemo(
    () =>
      activeRootId ? flattenTree(activeRootId, nodesMap, collapsedNodeIds) : [],
    [activeRootId, nodesMap, collapsedNodeIds],
  );
  // 当前链（线性视图正在展示的 lineage：祖先 + 锚点 + 首子链）。链外的
  // 分支行淡显——树内的「冷」不是时间，是「不在你正读的这条线上」。
  const lineageIds = useMemo(() => {
    const ids = new Set<string>();
    const anchor =
      activeNodeId && nodesMap[activeNodeId] ? activeNodeId : null;
    if (!anchor) return ids;
    for (const id of ancestorsOf(anchor, nodesMap)) ids.add(id);
    ids.add(anchor);
    let cur = nodesMap[anchor];
    while (cur) {
      const child = byParent.get(cur.id)?.[0];
      if (!child) break;
      ids.add(child.id);
      cur = child;
    }
    return ids;
  }, [activeNodeId, nodesMap, byParent]);

  // 图形视图几何：当前树子树过 dagre compact 布局，投影进面板宽度。
  // 横向居中（纯链树所有点同 x，不居中会贴左边）。
  const graphGeometry = useMemo(() => {
    if (view !== "graph") return null;
    const entry = entries.find((e) => e.root.id === activeRootId);
    if (!entry) return null;
    // 折叠的子树整块退出布局 —— 折叠在图形视图的价值就是「腾地方」：点少了
    // scale 就大了，剩下的形状才看得清。折叠点自己留下，带 +N 角标。
    const hidden = hiddenByCollapse(collapsedNodeIds, nodesMap);
    const visible = entry.nodes.filter((n) => !hidden.has(n.id));
    if (visible.length === 0) return null;
    const laidOut = layoutNodes(visible, undefined, { compact: true });
    const centers: Array<[string, { x: number; y: number }]> = [];
    for (const n of visible) {
      const pos = laidOut.get(n.id);
      if (pos) {
        centers.push([
          n.id,
          { x: pos.x + GRAPH_NODE_W / 2, y: pos.y + GRAPH_NODE_H / 2 },
        ]);
      }
    }
    if (centers.length === 0) return null;
    const xs = centers.map(([, p]) => p.x);
    const ys = centers.map(([, p]) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    // 纵横分开缩放：横向永远贴合面板宽（不出横向滚动条），纵向优先整树
    // 塞进 GRAPH_MAX_H，塞不下（长链树）就守住最小层距、让高度溢出去滚动。
    // 点图不怕纵横比失真 —— 拓扑形状靠连线，不靠等比。
    const scaleX = Math.min(
      (GRAPH_W - GRAPH_PAD * 2) / Math.max(1, maxX - minX),
      GRAPH_MAX_SCALE,
    );
    const scaleY = Math.max(
      Math.min(
        scaleX,
        (GRAPH_MAX_H - GRAPH_PAD * 2) / Math.max(1, maxY - minY),
      ),
      GRAPH_MIN_SCALE_Y,
    );
    const spanX = (maxX - minX) * scaleX;
    const spanY = (maxY - minY) * scaleY;
    const height = Math.max(56, Math.round(spanY + GRAPH_PAD * 2));
    const offX = (GRAPH_W - spanX) / 2;
    const offY = (height - spanY) / 2;
    const points = new Map<string, { x: number; y: number }>();
    for (const [id, p] of centers) {
      points.set(id, {
        x: offX + (p.x - minX) * scaleX,
        y: offY + (p.y - minY) * scaleY,
      });
    }
    return { points, height, visible };
  }, [view, entries, activeRootId, collapsedNodeIds, nodesMap]);

  const filterResults = useMemo(() => {
    if (filter === null) return [];
    const q = filter.trim().toLowerCase();
    if (!q) return [];
    const out: { node: ChatNode; entry: TreeEntry }[] = [];
    for (const e of entries) {
      for (const n of e.nodes) {
        const hay = `${n.topicLabel ?? ""} ${n.question}`.toLowerCase();
        if (hay.includes(q)) {
          out.push({ node: n, entry: e });
          if (out.length >= 30) return out;
        }
      }
    }
    return out;
  }, [filter, entries]);

  // ⌘J：展开面板 + 进过滤模式 + 聚焦输入框。⌘P（全局搜索）管跨 session，
  // 这里只管当前 session 内的节点跳转。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "j" && e.key !== "J") return;
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      e.preventDefault();
      setCollapsed(false);
      setFilter("");
      setFilterSel(0);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (filter !== null) filterInputRef.current?.focus();
  }, [filter !== null]); // eslint-disable-line react-hooks/exhaustive-deps

  // 长树的图形高度会超出滚动体（GRAPH_MIN_SCALE_Y 保层距），锚点常在树底
  // —— 切图/跳转后把当前点滚进视口，否则看到的是树顶一屏灰点。
  useEffect(() => {
    if (view !== "graph") return;
    bodyRef.current
      ?.querySelector("[data-graph-active]")
      ?.scrollIntoView({ block: "nearest" });
  }, [view, activeNodeId, graphGeometry]);

  // Guard against the hovered node being deleted out from under the card.
  const hoverNode = hover ? (nodesMap[hover.nodeId] ?? null) : null;

  if (entries.length === 0) return null;

  const totalNodes = Object.keys(nodesMap).length;

  const hoverRow = (nodeId: string) => (e: React.MouseEvent) => {
    const body = bodyRef.current;
    if (!body) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const bodyRect = body.getBoundingClientRect();
    const top = rect.top - bodyRect.top + rect.height / 2;
    setHover({ nodeId, top: Math.min(Math.max(top, 36), bodyRect.height - 36) });
  };
  const leaveRow = (nodeId: string) => () =>
    setHover((h) => (h?.nodeId === nodeId ? null : h));

  const jumpToNode = (id: string) => {
    setActiveNode(id);
    setHover(null);
  };

  const exitFilter = () => {
    setFilter(null);
    setFilterSel(0);
  };

  const startEdit = (root: ChatNode) => {
    setEditingRootId(root.id);
    setEditingTitle(root.topicLabel ?? treeLabel(root));
    setHover(null);
  };

  const cancelEdit = () => {
    setEditingRootId(null);
    setEditingTitle("");
  };

  const commitEdit = (rootId: string) => {
    const next = editingTitle.trim();
    setEditingRootId(null);
    setEditingTitle("");
    if (next && next !== (nodesMap[rootId]?.topicLabel ?? "")) {
      void renameTree(rootId, next);
    }
  };

  const toggleTreeHidden = (entry: TreeEntry) => {
    const willHide = !entry.hidden;
    if (willHide) {
      if (entry.root.id === activeRootId) {
        const nextVisible = entries.find(
          (e) => !e.hidden && e.root.id !== entry.root.id,
        );
        if (nextVisible) {
          jumpToNode(nextVisible.latestNodeId);
        }
      }
    } else {
      const curActiveIsVisible = entries.some(
        (e) => !e.hidden && e.root.id === activeRootId,
      );
      if (!curActiveIsVisible) {
        jumpToNode(entry.latestNodeId);
      }
    }
    void setTreeHidden(entry.root.id, willHide);
  };

  const menuItems = useMemo<ContextMenuItem[]>(() => {
    if (!menuTarget) return [];
    if (menuTarget.type === "tree") {
      const entry = menuTarget.entry;
      const isSessionRoot = sessionRootId === entry.root.id;
      return [
        {
          label: "跳转到最新节点",
          onSelect: () => jumpToNode(entry.latestNodeId),
        },
        "separator",
        {
          label: "重命名这棵树",
          onSelect: () => startEdit(entry.root),
        },
        {
          label: entry.hidden ? "恢复显示" : "隐藏这棵树",
          onSelect: () => toggleTreeHidden(entry),
        },
        {
          label: "复制树名称",
          onSelect: () => {
            void navigator.clipboard?.writeText(treeLabel(entry.root));
          },
        },
        "separator",
        {
          label: "删除这棵树（含子树）",
          danger: true,
          disabled: isSessionRoot,
          hint: isSessionRoot ? "会话主根" : undefined,
          onSelect: () => confirmDelete(entry.root.id),
        },
      ];
    }

    const node = menuTarget.node;
    const isSessionRoot = sessionRootId === node.id;
    const hasChildren = (byParent.get(node.id)?.length ?? 0) > 0;
    const isCollapsed = hasChildren && collapsedNodeIds.has(node.id);
    const unread = isUnreadNode(node);
    const isBookmarked = node.bookmarkedAt !== null;

    const navItems: ContextMenuItem[] = [
      {
        label: "跳转到此节点",
        onSelect: () => jumpToNode(node.id),
      },
    ];
    if (hasChildren) {
      navItems.push({
        label: isCollapsed ? "展开子树" : "折叠子树",
        onSelect: () => {
          toggleCollapse(node.id);
          setHover(null);
        },
      });
    }

    const editItems: ContextMenuItem[] = [];
    if (node.status === "done") {
      editItems.push({
        label: unread ? "标为已读" : "标为未读",
        onSelect: () =>
          void (unread ? markNodeRead(node.id) : markNodeUnread(node.id)),
      });
    }
    editItems.push({
      label: isBookmarked ? "移出稍后再读" : "加入稍后再读",
      onSelect: () => void toggleBookmark(node.id),
    });
    if (node.question?.trim()) {
      editItems.push({
        label: "复制问题内容",
        onSelect: () => void navigator.clipboard?.writeText(node.question),
      });
    }
    if (!node.parentId) {
      const isHidden = node.hiddenAt !== null;
      editItems.push({
        label: isHidden ? "恢复显示" : "隐藏这棵树",
        onSelect: () => void setTreeHidden(node.id, !isHidden),
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
        onSelect: () => confirmDelete(node.id),
      },
    ];
  }, [
    menuTarget,
    sessionRootId,
    byParent,
    collapsedNodeIds,
    entries,
    activeRootId,
    toggleCollapse,
    markNodeRead,
    markNodeUnread,
    toggleBookmark,
    setTreeHidden,
    confirmDelete,
  ]);

  const onFilterKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      exitFilter();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setFilterSel((i) => Math.min(i + 1, filterResults.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setFilterSel((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const hit = filterResults[filterSel];
      if (hit) {
        jumpToNode(hit.node.id);
        exitFilter();
      }
    }
  };

  // ── 行渲染 ────────────────────────────────────────────────────────────
  // 注意：这里是普通渲染函数而非行内组件 —— 行内组件的 type 每次渲染都是新
  // 引用，React 会整段 remount，悬停一变 DOM 就重建，mouseenter 有重触发
  // 死循环风险。

  // 折叠态树行（热区非当前树 / 冷组 / 已隐藏组通用）。
  const renderTreeRow = (entry: TreeEntry) => {
    const isActive = entry.root.id === activeRootId;
    const isEditing = editingRootId === entry.root.id;

    if (isEditing) {
      return (
        <div
          key={entry.root.id}
          className="flex items-center rounded-field bg-surface-muted px-1.5 py-1"
        >
          <input
            autoFocus
            value={editingTitle}
            onChange={(e) => setEditingTitle(e.target.value)}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitEdit(entry.root.id);
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancelEdit();
              }
            }}
            onBlur={() => commitEdit(entry.root.id)}
            className="w-full px-1.5 py-0.5 rounded text-ui bg-surface border border-line-strong outline-none focus:border-accent text-ink-strong"
            placeholder="命名这棵树（回车保存 · Esc 取消）"
          />
        </div>
      );
    }

    return (
      <div
        key={entry.root.id}
        {...bindTrigger({ type: "tree", entry })}
        className={`group flex items-center rounded-field ${
          isActive ? "bg-surface-muted" : "hover:bg-surface-hover"
        }`}
      >
        <button
          type="button"
          onClick={() => jumpToNode(entry.latestNodeId)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            startEdit(entry.root);
          }}
          onMouseEnter={hoverRow(entry.root.id)}
          onMouseLeave={leaveRow(entry.root.id)}
          className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 text-left ${
            entry.hidden
              ? isActive
                ? "text-ink-muted"
                : "text-ink-faint"
              : isActive
                ? "text-ink font-medium"
                : "text-ink-muted"
          }`}
          title={`${treeLabel(entry.root, 200)}\n双击重命名`}
        >
          {entry.root.kind === "reference" && (
            <RefGlyph node={entry.root} />
          )}
          <span className="truncate">{treeLabel(entry.root)}</span>
          {/* 树级运行状态 rollup：等待输入 > 生成中（等输入更紧急）。折叠行
              看不见节点级的点，这里补一眼可扫的树级信号。 */}
          {entry.hasWaiting ? (
            <WaitingGlyph title="有节点在等你回答" label="等待输入" />
          ) : entry.hasStreaming ? (
            <StatusDot tone="live" label="生成中" />
          ) : null}
          <span className="ml-auto shrink-0 font-mono text-nano text-ink-faint tabular-nums">
            {entry.count}
          </span>
          {entry.unreadCount > 0 && !entry.hidden && (
            <span className="shrink-0 inline-flex items-center gap-0.5 text-nano font-medium text-unread-ink tabular-nums">
              <StatusDot tone="unread" />
              {entry.unreadCount}
            </span>
          )}
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            startEdit(entry.root);
          }}
          className="shrink-0 px-1.5 py-1 text-nano rounded transition-opacity opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 text-ink-faint hover:text-ink hover:bg-surface-hover"
          title="重命名这棵树"
          aria-label="重命名这棵树"
        >
          <Icon icon={Pencil} size="sm" />
        </button>
        <button
          type="button"
          onClick={() => {
            const willHide = !entry.hidden;
            if (willHide) {
              if (entry.root.id === activeRootId) {
                const nextVisible = entries.find(
                  (e) => !e.hidden && e.root.id !== entry.root.id,
                );
                if (nextVisible) {
                  jumpToNode(nextVisible.latestNodeId);
                }
              }
            } else {
              const curActiveIsVisible = entries.some(
                (e) => !e.hidden && e.root.id === activeRootId,
              );
              if (!curActiveIsVisible) {
                jumpToNode(entry.latestNodeId);
              }
            }
            void setTreeHidden(entry.root.id, willHide);
          }}
          className={`shrink-0 px-1.5 py-1 text-nano rounded transition-opacity ${
            entry.hidden
              ? "text-ink-muted hover:text-ink hover:bg-surface-hover"
              : "opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 text-ink-faint hover:text-ink hover:bg-surface-hover"
          }`}
          title={entry.hidden ? "恢复显示" : "隐藏这棵树（数据保留，可随时恢复）"}
          aria-label={entry.hidden ? "恢复显示" : "隐藏这棵树"}
        >
          {entry.hidden ? "恢复" : (
            <Icon icon={EyeOff} size="sm" />
          )}
        </button>
      </div>
    );
  };

  // 折叠角标（+N）的配色：藏起来的东西里等输入 > 生成中 > 未读 > 纯计数，
  // 与列表折叠行同一优先级 —— 折叠不该把状态一起藏掉。
  const rollupFill = (r: HiddenRollup) =>
    r.waiting
      ? "fill-warn animate-pulse"
      : r.streaming
        ? "fill-accent animate-pulse"
        : r.unread > 0
          ? "fill-unread-ink"
          : "fill-ink-faint";

  // 当前树的图形视图：点 + 连线，点击跳转、悬停出预览卡（与列表行同一套
  // hover 机制——getBoundingClientRect 对 SVG <g> 一样工作）。状态着色与
  // 列表行同语义：等输入 warn / 生成中 accent（都带 pulse）/ 错误 danger /
  // 未读 unread；当前节点加大 + 外圈。
  // 折叠：有子节点的点带一个 ⊖ 小按钮（悬停才显，否则纯链树上每个点都挂一
  // 个纽扣太吵；触摸设备无 hover，常显）；已折叠的点常显 ⊕ + 「+N」角标，
  // 否则折完就没有回头路了。按钮圆心落在点自己的 r=10 命中区内，鼠标从点
  // 移到按钮不会丢 hover（丢了按钮就闪没）。
  const renderTreeGraph = () => {
    if (!graphGeometry) return null;
    const { points, height, visible } = graphGeometry;
    return (
      <svg
        width={GRAPH_W}
        height={height}
        viewBox={`0 0 ${GRAPH_W} ${height}`}
        className="block mx-auto mt-0.5"
        aria-label="当前树图形视图"
      >
        {visible.map((n) => {
          if (!n.parentId) return null;
          const a = points.get(n.parentId);
          const b = points.get(n.id);
          if (!a || !b) return null;
          return (
            <line
              key={`e-${n.id}`}
              x1={a.x}
              y1={a.y}
              x2={b.x}
              y2={b.y}
              className="stroke-line-strong"
              strokeWidth="1"
            />
          );
        })}
        {visible.map((n) => {
          const p = points.get(n.id);
          if (!p) return null;
          const isActive = n.id === activeNodeId;
          const waiting = isWaitingNode(n);
          const fill = waiting
            ? "fill-warn"
            : n.status === "streaming"
              ? "fill-accent"
              : n.status === "error"
                ? "fill-danger"
                : isUnreadNode(n)
                  ? "fill-unread"
                  : isActive
                    ? "fill-accent"
                    : "fill-ink-faint";
          const pulse =
            waiting || n.status === "streaming" ? " animate-pulse" : "";
          const hasKids = (byParent.get(n.id)?.length ?? 0) > 0;
          const isCollapsed = hasKids && collapsedNodeIds.has(n.id);
          const roll = isCollapsed ? subtreeRollup(n.id, byParent) : null;
          // 贴右缘时按钮和角标翻到左侧 —— SVG viewport 默认裁剪溢出。
          const side = p.x > GRAPH_W - 36 ? -1 : 1;
          const hx = p.x + side * 9;
          const toggle = () => {
            toggleCollapse(n.id);
            setHover(null);
          };
          return (
            <g
              key={n.id}
              className="group"
              data-graph-node-id={n.id}
              data-graph-active={isActive ? "" : undefined}
              onMouseEnter={hoverRow(n.id)}
              onMouseLeave={leaveRow(n.id)}
              {...bindTrigger({ type: "node", node: n })}
            >
              <g
                role="button"
                tabIndex={0}
                aria-label={n.topicLabel ?? n.question}
                onClick={() => jumpToNode(n.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    jumpToNode(n.id);
                  }
                }}
                className="cursor-pointer outline-none"
              >
                {/* 透明放大命中区 —— 裸点太小，悬停/点击都难瞄（S61 教训） */}
                <circle cx={p.x} cy={p.y} r={10} fill="transparent" />
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={isActive ? 5 : 3.5}
                  className={`${fill} stroke-surface${pulse}`}
                  strokeWidth={isActive ? 2 : 1.5}
                />
                {isActive && (
                  <circle
                    cx={p.x}
                    cy={p.y}
                    r={8}
                    className="fill-none stroke-accent"
                    strokeWidth="1"
                    opacity="0.5"
                  />
                )}
              </g>
              {hasKids && (
                <g
                  role="button"
                  tabIndex={isCollapsed ? 0 : -1}
                  aria-label={
                    isCollapsed
                      ? `展开 ${roll?.count ?? 0} 个被折叠的节点`
                      : "折叠子树"
                  }
                  aria-expanded={!isCollapsed}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggle();
                  }}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      e.stopPropagation();
                      toggle();
                    }
                  }}
                  className={`cursor-pointer outline-none ${
                    isCollapsed
                      ? ""
                      : "opacity-0 pointer-events-none group-hover:opacity-100 group-hover:pointer-events-auto pointer-coarse:opacity-100 pointer-coarse:pointer-events-auto"
                  }`}
                >
                  <title>
                    {isCollapsed
                      ? `展开 ${roll?.count ?? 0} 个被折叠的节点`
                      : "折叠子树"}
                  </title>
                  <circle cx={hx} cy={p.y} r={6} fill="transparent" />
                  <circle
                    cx={hx}
                    cy={p.y}
                    r={4.5}
                    className="fill-surface stroke-line-strong hover:fill-surface-muted"
                    strokeWidth="1"
                  />
                  <line
                    x1={hx - 2.2}
                    y1={p.y}
                    x2={hx + 2.2}
                    y2={p.y}
                    className="stroke-ink-muted"
                    strokeWidth="1.2"
                    strokeLinecap="round"
                  />
                  {isCollapsed && (
                    <line
                      x1={hx}
                      y1={p.y - 2.2}
                      x2={hx}
                      y2={p.y + 2.2}
                      className="stroke-ink-muted"
                      strokeWidth="1.2"
                      strokeLinecap="round"
                    />
                  )}
                </g>
              )}
              {roll && (
                <text
                  x={p.x + side * 16}
                  y={p.y + 3}
                  textAnchor={side > 0 ? "start" : "end"}
                  fontSize="8"
                  className={`pointer-events-none font-mono tabular-nums ${rollupFill(roll)}`}
                >
                  +{roll.count}
                  {roll.unread > 0 ? ` ·${roll.unread}` : ""}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    );
  };

  // 当前树：树头行 + 节点行（线性段平铺，真分叉缩进）。
  const renderActiveTree = (entry: TreeEntry) => {
    const isEditing = editingRootId === entry.root.id;

    return (
      <div key={entry.root.id}>
        {isEditing ? (
          <div className="flex items-center rounded-field bg-surface-muted px-1.5 py-1">
            <input
              autoFocus
              value={editingTitle}
              onChange={(e) => setEditingTitle(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  commitEdit(entry.root.id);
                } else if (e.key === "Escape") {
                  e.preventDefault();
                  cancelEdit();
                }
              }}
              onBlur={() => commitEdit(entry.root.id)}
              className="w-full px-1.5 py-0.5 rounded text-ui bg-surface border border-line-strong outline-none focus:border-accent text-ink-strong"
              placeholder="命名这棵树（回车保存 · Esc 取消）"
            />
          </div>
        ) : (
          <div
            {...bindTrigger({ type: "tree", entry })}
            className="group flex items-center rounded-field bg-surface-muted"
          >
            <div
              className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 cursor-pointer"
              onDoubleClick={() => startEdit(entry.root)}
              title={`${treeLabel(entry.root, 200)}\n双击重命名`}
            >
              {entry.root.kind === "reference" && (
                <RefGlyph node={entry.root} />
              )}
              <span className="truncate font-medium text-ink-strong">
                {treeLabel(entry.root)}
              </span>
              <span className="ml-auto shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                {entry.count}
              </span>
            </div>
            <button
              type="button"
              onClick={() => startEdit(entry.root)}
              className="shrink-0 px-1.5 py-1 rounded text-ink-faint opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 hover:text-ink hover:bg-surface-hover transition-opacity"
              title="重命名这棵树"
              aria-label="重命名这棵树"
            >
              <Icon icon={Pencil} size="sm" />
            </button>
            <button
              type="button"
              onClick={() => {
                const nextVisible = entries.find(
                  (e) => !e.hidden && e.root.id !== entry.root.id,
                );
                if (nextVisible) {
                  jumpToNode(nextVisible.latestNodeId);
                }
                void setTreeHidden(entry.root.id, true);
              }}
              className="shrink-0 px-1.5 py-1 rounded text-ink-faint opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 hover:text-ink hover:bg-surface-hover transition-opacity"
              title="隐藏这棵树（数据保留，可随时恢复）"
              aria-label="隐藏这棵树"
            >
              <Icon icon={EyeOff} size="sm" />
            </button>
          </div>
        )}
        {view === "graph" && graphGeometry ? (
          renderTreeGraph()
        ) : (
      <div className="mt-0.5">
        {activeRows.map(({ node, depth, isBranch, hasChildren, collapsed, hiddenRollup }) => {
          const isActive = node.id === activeNodeId;
          const unread = isUnreadNode(node);
          const offLineage =
            lineageIds.size > 0 && !lineageIds.has(node.id);
          return (
            <div
              key={node.id}
              data-node-id={node.id}
              {...bindTrigger({ type: "node", node })}
              className={`group flex items-center rounded-field transition-colors ${
                isActive ? "bg-accent-muted" : "hover:bg-surface-hover"
              }`}
              style={{ paddingLeft: `${2 + depth * 10}px` }}
            >
              {hasChildren ? (
                <button
                  type="button"
                  onClick={() => toggleCollapse(node.id)}
                  className="shrink-0 w-4 self-stretch flex items-center justify-center text-ink-faint hover:text-ink-muted"
                  title={collapsed ? "展开子树" : "折叠子树"}
                  aria-label={collapsed ? "展开子树" : "折叠子树"}
                >
                  <Icon icon={ChevronRight} size="sm" className={`transition-transform ${collapsed ? "" : "rotate-90"}`} />
                </button>
              ) : (
                <span className="shrink-0 w-4" aria-hidden />
              )}
              <button
                type="button"
                onClick={() => jumpToNode(node.id)}
                onMouseEnter={hoverRow(node.id)}
                onMouseLeave={leaveRow(node.id)}
                className={`flex-1 min-w-0 flex items-center gap-1 pr-1 py-0.75 text-left transition-colors ${
                  isActive
                    ? "text-accent-ink font-medium"
                    : offLineage
                      ? "text-ink-faint hover:text-ink-muted"
                      : "text-ink-muted"
                }`}
                title={node.question || undefined}
              >
                {isBranch && <Icon icon={CornerDownRight} size="sm" className="text-fork" />}
                <span className="shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                  #{indices[node.id] ?? "?"}
                </span>
                {isWaitingNode(node) ? (
                  <WaitingGlyph title="等你回答" label="等待输入" />
                ) : node.status === "streaming" ? (
                  <StatusDot tone="live" />
                ) : null}
                {node.status === "error" && (
                  <StatusDot tone="danger" />
                )}
                {unread && (
                  <StatusDot tone="unread" label="未读" />
                )}
                {node.kind === "reference" && (
                  <RefGlyph node={node} />
                )}
                <span className="truncate">{nodeRowLabel(node)}</span>
                {/* 折叠行 rollup：藏起来的后代数量 + 运行/未读信号（折叠树
                    行同款语义：等输入 > 生成中）。折叠不该把状态一起藏掉。 */}
                {hiddenRollup && (
                  <>
                    {hiddenRollup.waiting ? (
                      <WaitingGlyph title="折叠的分支里有节点在等你回答" label="折叠分支等待输入" />
                    ) : hiddenRollup.streaming ? (
                      <StatusDot tone="live" label="折叠分支生成中" />
                    ) : null}
                    <span
                      className="shrink-0 font-mono text-nano text-ink-faint tabular-nums"
                      title={`已折叠 ${hiddenRollup.count} 个节点`}
                    >
                      +{hiddenRollup.count}
                    </span>
                    {hiddenRollup.unread > 0 && (
                      <span className="shrink-0 inline-flex items-center gap-0.5 text-nano font-medium text-unread-ink tabular-nums">
                        <StatusDot tone="unread" />
                        {hiddenRollup.unread}
                      </span>
                    )}
                  </>
                )}
              </button>
              {node.status === "done" && (
                <button
                  type="button"
                  onClick={() =>
                    unread
                      ? void markNodeRead(node.id)
                      : void markNodeUnread(node.id)
                  }
                  className={`shrink-0 px-1.5 py-1 rounded transition-opacity opacity-0 group-hover:opacity-100 pointer-coarse:opacity-100 hover:bg-surface-hover ${
                    unread
                      ? "text-ink-faint hover:text-ink"
                      : "text-ink-faint hover:text-unread-ink"
                  }`}
                  title={unread ? "标为已读" : "标为未读"}
                  aria-label={unread ? "标为已读" : "标为未读"}
                >
                  {unread ? (
                    <Icon icon={CircleCheck} size="sm" />
                  ) : (
                    <Icon icon={CircleDot} size="sm" />
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>
      )}
    </div>
  );
};

  // 给线性视图的正文 / composer 让出右侧安全区：LinearThreadView 用
  // `padding-right: var(--trellis-tree-safe, 0px)` 消费。展开 = 面板宽
  // （w-72 = 18rem）+ 右边距 0.75rem + 间隙 0.75rem；收起为圆点 = 3.5rem
  // （圆点 2.5rem + 右边距 0.75rem + 余量）。手机端是全屏 sheet，不占位。
  useEffect(() => {
    const root = document.documentElement;
    if (isMobile !== false) {
      root.style.removeProperty("--trellis-tree-safe");
      return;
    }
    root.style.setProperty("--trellis-tree-safe", collapsed ? "3.5rem" : "19.5rem");
    return () => {
      root.style.removeProperty("--trellis-tree-safe");
    };
  }, [isMobile, collapsed]);

  if (isMobile === null || (isMobile && !mobileOpen)) return null;

  const stackBottom = {
    bottom: "clamp(6rem, calc(var(--trellis-term-stack, 0px) + 0.5rem), 50vh)",
  };

  // 桌面收起态：右下角一个小圆点（节点数角标），一键展开。形态沿用
  // 「小浮窗 + 小点」（9/9 两次否决改形态），只是把原来的窄条换成圆点。
  if (!isMobile && collapsed) {
    return (
      <div className="fixed right-3 z-20 transition-all duration-150" style={stackBottom}>
        <IconButton
          label={`展开会话树（${totalNodes} 节点）`}
          tooltipSide="left"
          onClick={() => {
            setCollapsed(false);
            setHover(null);
          }}
          className="relative size-10 rounded-full border border-line bg-surface-raised shadow-pop"
        >
          <Icon icon={Network} />
          <span className="absolute -right-1 -top-1 min-w-4.5 rounded-full border border-line bg-surface-raised px-1 text-center font-mono text-nano leading-4 text-ink-muted tabular-nums">
            {totalNodes}
          </span>
          {entries.some((e) => e.hasWaiting) ? (
            <StatusDot tone="warn" label="有节点在等你回答" className="absolute bottom-0.5 right-0.5 ring-2 ring-surface-raised" />
          ) : entries.some((e) => e.unreadCount > 0 && !e.hidden) ? (
            <StatusDot tone="unread" label="有未读" className="absolute bottom-0.5 right-0.5 ring-2 ring-surface-raised" />
          ) : null}
        </IconButton>
      </div>
    );
  }

  const closeMobileSheet = () => {
    setMobileOpen(false);
    setViewMode("linear");
  };

  return (
    // 右下角是一条堆栈，终端在最底层（把手 / 浮层 / 底部分栏三态高度都由
    // TerminalPanel 发布成 --trellis-term-stack），树面板踩着它往上排。
    // 原来这里写死 bottom-24(96px)，而把手占 88~116px —— 差 8px 直接压在一起。
    // clamp 的上界是硬保证：终端被拖到 720px 高时也不许把树面板顶出视口，
    // 宁可被盖住（拖矮就回来），也不能让控件够不着。
    <div
      data-mobile-tree-sheet={isMobile ? "open" : undefined}
      role={isMobile ? "dialog" : undefined}
      aria-modal={isMobile ? true : undefined}
      aria-label={isMobile ? "思维树" : undefined}
      className={
        isMobile
          ? "fixed inset-0 z-50 text-label"
          : "fixed right-3 z-20 text-label transition-all duration-150"
      }
      style={
        isMobile
          ? {
              paddingTop: "var(--safe-top)",
              paddingBottom: "var(--safe-bottom)",
            }
          : stackBottom
      }
    >
      <div
        className={
          isMobile
            ? "flex h-full flex-col bg-surface"
            : "rounded-overlay border border-line bg-surface-raised shadow-pop"
        }
      >
        <div className="flex h-10 items-center gap-0.5 pl-3 pr-1.5 max-md:h-auto">
          <span className="font-medium text-ui text-ink">会话树</span>
          <span className="mr-auto ml-2 text-label text-ink-faint tabular-nums">
            {totalNodes} 节点
          </span>
          {sessionId && (
            <IconButton
              size="sm"
              type="button"
              data-mobile-target="new-tree-open"
              label="新树"
              title="新树：保留当前 session，只清空上下文（等价 /clear）"
              onClick={() => {
                if (isMobile) closeMobileSheet();
                setComposeRootOpen(true);
              }}
            >
              <Icon icon={Plus} size="sm" />
            </IconButton>
          )}
          <IconButton
            size="sm"
            type="button"
            onClick={() => switchView(view === "list" ? "graph" : "list")}
            label={view === "list" ? "切为图形视图" : "切为列表视图"}
            title={
              view === "list"
                ? "当前树切为图形视图（看分叉形状）"
                : "当前树切为列表视图"
            }
          >
            <Icon icon={view === "list" ? GitBranch : List} size="sm" />
          </IconButton>
          <IconButton
            size="sm"
            type="button"
            onClick={() => {
              if (filter === null) {
                setFilter("");
                setFilterSel(0);
              } else {
                exitFilter();
              }
            }}
            label="过滤跳转"
            shortcut="⌘J"
            aria-pressed={filter !== null}
            className={filter !== null ? "bg-accent-muted text-accent-ink" : undefined}
          >
            <Icon icon={Search} size="sm" />
          </IconButton>
          {isMobile ? (
            <IconButton
              ref={mobileCloseRef}
              type="button"
              data-mobile-target="tree-sheet-close"
              onClick={closeMobileSheet}
              label="关闭思维树"
              tooltip={false}
            >
              <Icon icon={X} />
            </IconButton>
          ) : (
            <IconButton
              size="sm"
              type="button"
              label="收起为圆点"
              onClick={() => {
                setCollapsed(true);
                setHover(null);
              }}
            >
              <Icon icon={Minimize2} size="sm" />
            </IconButton>
          )}
        </div>

        {(isMobile || !collapsed) && (
          <div
            className={
              isMobile
                ? "relative min-h-0 w-full flex-1 border-t border-line-faint"
                : "relative w-72 border-t border-line-faint"
            }
          >
            {filter !== null && (
              <div className="px-2 pt-2">
                <input
                  ref={filterInputRef}
                  value={filter}
                  onChange={(e) => {
                    setFilter(e.target.value);
                    setFilterSel(0);
                  }}
                  onKeyDown={onFilterKeyDown}
                  placeholder="过滤节点…（↑↓ 选择，↩ 跳转，Esc 退出）"
                  className="w-full px-2 py-1.5 rounded-field border border-line bg-surface text-label text-ink placeholder:text-ink-faint outline-none focus:border-accent-line"
                  aria-label="过滤节点"
                />
              </div>
            )}

            <div
              ref={bodyRef}
              className={
                isMobile
                  ? "h-full overflow-y-auto overscroll-contain p-1.5"
                  : "p-1.5 overflow-y-auto overscroll-contain"
              }
              style={isMobile ? undefined : { maxHeight: "min(420px, 55vh)" }}
              onScroll={() => setHover(null)}
            >
              {filter !== null && filter.trim() ? (
                filterResults.length === 0 ? (
                  <div className="px-2 py-3 text-center text-ink-faint">
                    没有匹配的节点
                  </div>
                ) : (
                  filterResults.map(({ node, entry }, i) => (
                    <button
                      key={node.id}
                      type="button"
                      onClick={() => {
                        jumpToNode(node.id);
                        exitFilter();
                      }}
                      onMouseEnter={hoverRow(node.id)}
                      onMouseLeave={leaveRow(node.id)}
                      className={`w-full min-w-0 flex items-center gap-1 px-2 py-1 rounded-field text-left ${
                        i === filterSel
                          ? "bg-accent-muted text-accent-ink"
                          : "text-ink-muted hover:bg-surface-hover"
                      }`}
                    >
                      <span className="shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                        #{indices[node.id] ?? "?"}
                      </span>
                      <span className="truncate">{nodeRowLabel(node)}</span>
                      <span className="ml-auto shrink-0 truncate max-w-28 text-nano text-ink-faint">
                        {entry.hidden ? "已隐藏 · " : ""}
                        {treeLabel(entry.root, 16)}
                      </span>
                    </button>
                  ))
                )
              ) : (
                <>
                  {groups.hot.map((e) =>
                    e.root.id === activeRootId
                      ? renderActiveTree(e)
                      : renderTreeRow(e),
                  )}

                  {groups.cold.length > 0 && (
                    <div className="mt-1 pt-1 border-t border-line-faint">
                      <button
                        type="button"
                        onClick={() => setColdOpen((v) => !v)}
                        className="w-full px-2 py-1 flex items-center gap-1 rounded-field text-ink-faint hover:bg-surface-hover"
                        aria-expanded={coldOpen}
                      >
                        <Icon
                          icon={ChevronRight}
                          size="sm"
                          className={`transition-transform ${coldOpen ? "rotate-90" : ""}`}
                        />
                        更早 · {groups.cold.length} 棵
                      </button>
                      {coldOpen && groups.cold.map(renderTreeRow)}
                    </div>
                  )}

                </>
              )}
            </div>

            {!isMobile && hoverNode && hover && (
              <div
                className={`pointer-events-none absolute right-full mr-2 ${PREVIEW_W} rounded-overlay border border-line bg-surface-raised shadow-pop px-3 py-2.5 text-left`}
                style={{ top: hover.top, transform: "translateY(-50%)" }}
                aria-hidden
              >
                <div className="text-label text-ink-faint font-mono">
                  #{indices[hoverNode.id] ?? "?"} ·{" "}
                  {hoverNode.kind === "reference" ? "参考材料" : "对话"}
                </div>
                <div className="mt-1 text-ui font-semibold text-ink-strong line-clamp-2">
                  {hoverNode.topicLabel ?? mdExcerpt(hoverNode.question, 80)}
                </div>
                {(() => {
                  const body =
                    hoverNode.status === "error"
                      ? "生成失败"
                      : isWaitingNode(hoverNode)
                        ? "模型在等你回答"
                        : mdExcerpt(hoverNode.response, 160) ||
                          (hoverNode.status === "streaming" ? "生成中…" : "");
                  return body ? (
                    <div className="mt-1 text-label leading-relaxed text-ink-muted line-clamp-4">
                      {body}
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>
        )}
      </div>
      <ContextMenu
        {...menuProps}
        label="结构面板上下文菜单"
        items={menuItems}
      />
    </div>
  );
}
