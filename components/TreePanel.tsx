"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { ancestorsOf } from "@/lib/collapsed";
import { layoutNodes } from "@/lib/layout";
import { refIcon } from "@/lib/ref-icon";
import {
  buildTreeEntries,
  childrenIndex,
  flattenTree,
  groupTrees,
  isUnreadNode,
  isWaitingNode,
  mdExcerpt,
  rootIdOf,
  treeLabel,
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

type Hover = { nodeId: string; top: number } | null;

function nodeRowLabel(n: ChatNode, max = 30): string {
  if (n.topicLabel) return n.topicLabel;
  const q = n.question.trim();
  if (!q && n.kind === "reference") return "参考材料";
  return q.length > max ? `${q.slice(0, max - 1)}…` : q || "（空）";
}

export function TreePanel() {
  const nodesMap = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setTreeHidden = useSessionStore((s) => s.setTreeHidden);
  const treeVisits = useSessionStore((s) => s.treeVisits);

  const view = useSessionStore((s) => s.treePanelView);
  const switchView = useSessionStore((s) => s.setTreePanelView);

  const [collapsed, setCollapsed] = useState(false);
  const [coldOpen, setColdOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // null = 过滤模式关闭；字符串（含空串）= 开启且为当前查询。
  const [filter, setFilter] = useState<string | null>(null);
  const [filterSel, setFilterSel] = useState(0);
  const [hover, setHover] = useState<Hover>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(
    () => buildTreeEntries(nodesMap, treeVisits),
    [nodesMap, treeVisits],
  );
  const indices = useMemo(() => buildNodeIndex(nodesMap), [nodesMap]);
  const activeRootId = useMemo(() => {
    const anchor = activeNodeId && nodesMap[activeNodeId] ? activeNodeId : null;
    return anchor ? rootIdOf(anchor, nodesMap) : entries[0]?.root.id ?? null;
  }, [activeNodeId, nodesMap, entries]);
  const groups = useMemo(
    () => groupTrees(entries, activeRootId),
    [entries, activeRootId],
  );
  const activeRows = useMemo(
    () => (activeRootId ? flattenTree(activeRootId, nodesMap) : []),
    [activeRootId, nodesMap],
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
    const byParent = childrenIndex(nodesMap);
    let cur = nodesMap[anchor];
    while (cur) {
      const child = byParent.get(cur.id)?.[0];
      if (!child) break;
      ids.add(child.id);
      cur = child;
    }
    return ids;
  }, [activeNodeId, nodesMap]);

  // 图形视图几何：当前树子树过 dagre compact 布局，投影进面板宽度。
  // 横向居中（纯链树所有点同 x，不居中会贴左边）。
  const graphGeometry = useMemo(() => {
    if (view !== "graph") return null;
    const entry = entries.find((e) => e.root.id === activeRootId);
    if (!entry) return null;
    const laidOut = layoutNodes(entry.nodes, undefined, { compact: true });
    const centers: Array<[string, { x: number; y: number }]> = [];
    for (const n of entry.nodes) {
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
    const scale = Math.min(
      (GRAPH_W - GRAPH_PAD * 2) / Math.max(1, maxX - minX),
      (GRAPH_MAX_H - GRAPH_PAD * 2) / Math.max(1, maxY - minY),
      1,
    );
    const spanX = (maxX - minX) * scale;
    const spanY = (maxY - minY) * scale;
    const height = Math.max(56, Math.round(spanY + GRAPH_PAD * 2));
    const offX = (GRAPH_W - spanX) / 2;
    const offY = (height - spanY) / 2;
    const points = new Map<string, { x: number; y: number }>();
    for (const [id, p] of centers) {
      points.set(id, {
        x: offX + (p.x - minX) * scale,
        y: offY + (p.y - minY) * scale,
      });
    }
    return { points, height };
  }, [view, entries, activeRootId]);

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

  // Guard against the hovered node being deleted out from under the card.
  const hoverNode = hover ? (nodesMap[hover.nodeId] ?? null) : null;

  if (entries.length === 0) return null;

  const totalNodes = Object.keys(nodesMap).length;
  const hiddenUnread = groups.hidden.reduce((s, e) => s + e.unreadCount, 0);

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
  const renderTreeRow = (entry: TreeEntry) => (
    <div
      key={entry.root.id}
      className="group flex items-center rounded hover:bg-surface-muted"
    >
      <button
        type="button"
        onClick={() => jumpToNode(entry.latestNodeId)}
        onMouseEnter={hoverRow(entry.root.id)}
        onMouseLeave={leaveRow(entry.root.id)}
        className={`flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1 text-left ${
          entry.hidden ? "text-ink-faint" : "text-ink-muted"
        }`}
        title={treeLabel(entry.root, 200)}
      >
        {entry.root.kind === "reference" && (
          <span className="shrink-0" aria-hidden>
            {refIcon(entry.root.reference)}
          </span>
        )}
        <span className="truncate">{treeLabel(entry.root)}</span>
        {/* 树级运行状态 rollup：等待输入 > 生成中（等输入更紧急）。折叠行
            看不见节点级的点，这里补一眼可扫的树级信号。 */}
        {entry.hasWaiting ? (
          <span className="shrink-0 text-[10px] animate-pulse" title="有节点在等你回答" aria-label="等待输入">
            🙋
          </span>
        ) : entry.hasStreaming ? (
          <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" title="生成中" aria-label="生成中" />
        ) : null}
        <span className="ml-auto shrink-0 font-mono text-nano text-ink-faint tabular-nums">
          {entry.count}
        </span>
        {entry.unreadCount > 0 && !entry.hidden && (
          <span className="shrink-0 inline-flex items-center gap-0.5 text-nano font-medium text-unread-ink tabular-nums">
            <span className="w-1.5 h-1.5 rounded-full bg-unread" aria-hidden />
            {entry.unreadCount}
          </span>
        )}
      </button>
      <button
        type="button"
        onClick={() => void setTreeHidden(entry.root.id, !entry.hidden)}
        className={`shrink-0 px-1.5 py-1 text-nano rounded transition-opacity ${
          entry.hidden
            ? "text-ink-muted hover:text-ink hover:bg-surface-muted"
            : "opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-ink-faint hover:text-ink hover:bg-surface-muted"
        }`}
        title={entry.hidden ? "恢复显示" : "隐藏这棵树（数据保留，可随时恢复）"}
        aria-label={entry.hidden ? "恢复显示" : "隐藏这棵树"}
      >
        {entry.hidden ? "恢复" : (
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        )}
      </button>
    </div>
  );

  // 当前树的图形视图：点 + 连线，点击跳转、悬停出预览卡（与列表行同一套
  // hover 机制——getBoundingClientRect 对 SVG <g> 一样工作）。状态着色与
  // 列表行同语义：等输入 warn / 生成中 accent（都带 pulse）/ 错误 danger /
  // 未读 unread；当前节点加大 + 外圈。
  const renderTreeGraph = (entry: TreeEntry) => {
    if (!graphGeometry) return null;
    const { points, height } = graphGeometry;
    return (
      <svg
        width={GRAPH_W}
        height={height}
        viewBox={`0 0 ${GRAPH_W} ${height}`}
        className="block mx-auto mt-0.5"
        aria-label="当前树图形视图"
      >
        {entry.nodes.map((n) => {
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
        {entry.nodes.map((n) => {
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
          return (
            <g
              key={n.id}
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
              onMouseEnter={hoverRow(n.id)}
              onMouseLeave={leaveRow(n.id)}
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
          );
        })}
      </svg>
    );
  };

  // 当前树：树头行 + 节点行（线性段平铺，真分叉缩进）。
  const activeEntry =
    groups.hot.find((e) => e.root.id === activeRootId) ??
    groups.hidden.find((e) => e.root.id === activeRootId) ??
    null;

  const renderActiveTree = (entry: TreeEntry) => (
    <div key={entry.root.id}>
      <div className="group flex items-center rounded bg-surface-muted/60">
        <div className="flex-1 min-w-0 flex items-center gap-1.5 px-2 py-1">
          {entry.root.kind === "reference" && (
            <span className="shrink-0" aria-hidden>
              {refIcon(entry.root.reference)}
            </span>
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
          onClick={() => void setTreeHidden(entry.root.id, true)}
          className="shrink-0 px-1.5 py-1 rounded text-ink-faint opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 hover:text-ink hover:bg-surface-muted transition-opacity"
          title="隐藏这棵树（数据保留，可随时恢复）"
          aria-label="隐藏这棵树"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
            <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94" />
            <path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19" />
            <line x1="1" y1="1" x2="23" y2="23" />
          </svg>
        </button>
      </div>
      {view === "graph" && graphGeometry ? (
        renderTreeGraph(entry)
      ) : (
      <div className="mt-0.5">
        {activeRows.map(({ node, depth, isBranch }) => {
          const isActive = node.id === activeNodeId;
          const unread = isUnreadNode(node);
          const offLineage =
            lineageIds.size > 0 && !lineageIds.has(node.id);
          return (
            <button
              key={node.id}
              type="button"
              onClick={() => jumpToNode(node.id)}
              onMouseEnter={hoverRow(node.id)}
              onMouseLeave={leaveRow(node.id)}
              style={{ paddingLeft: `${8 + depth * 10}px` }}
              className={`w-full min-w-0 flex items-center gap-1 pr-2 py-[3px] rounded text-left transition-colors ${
                isActive
                  ? "bg-accent-muted text-accent-ink font-medium"
                  : offLineage
                    ? "text-ink-faint hover:text-ink-muted hover:bg-surface-muted"
                    : "text-ink-muted hover:bg-surface-muted"
              }`}
              title={node.question || undefined}
            >
              {isBranch && <span className="shrink-0 text-ink-faint">↳</span>}
              <span className="shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                #{indices[node.id] ?? "?"}
              </span>
              {isWaitingNode(node) ? (
                <span className="shrink-0 text-[10px] animate-pulse" title="等你回答" aria-label="等待输入">
                  🙋
                </span>
              ) : node.status === "streaming" ? (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
              ) : null}
              {node.status === "error" && (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-danger" aria-hidden />
              )}
              {unread && (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-unread" aria-label="未读" />
              )}
              {node.kind === "reference" && (
                <span className="shrink-0" aria-hidden>
                  {refIcon(node.reference)}
                </span>
              )}
              <span className="truncate">{nodeRowLabel(node)}</span>
            </button>
          );
        })}
      </div>
      )}
    </div>
  );

  return (
    <div className="fixed right-3 bottom-24 z-40 text-xs">
      <div className="rounded-card border border-line/80 bg-surface/95 shadow-pop backdrop-blur">
        <div className="flex items-center">
          <button
            type="button"
            onClick={() => {
              setCollapsed((v) => !v);
              setHover(null);
            }}
            className="flex-1 px-3 py-2 flex items-center justify-between gap-3 text-ink-muted hover:bg-surface-muted rounded-t-card"
            title={collapsed ? "展开树面板" : "收起树面板"}
          >
            <span className="font-medium">树</span>
            <span className="text-ink-faint tabular-nums">
              {collapsed ? `${totalNodes} · ▴` : `${totalNodes} · ▾`}
            </span>
          </button>
          {!collapsed && (
            <button
              type="button"
              onClick={() => switchView(view === "list" ? "graph" : "list")}
              className="shrink-0 px-2 py-2 rounded-t-card text-ink-faint hover:text-ink hover:bg-surface-muted transition-colors"
              title={
                view === "list"
                  ? "当前树切为图形视图（看分叉形状）"
                  : "当前树切为列表视图"
              }
              aria-label={view === "list" ? "切为图形视图" : "切为列表视图"}
            >
              {view === "list" ? (
                /* git-branch：切到图形 */
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <circle cx="6" cy="5" r="2.5" />
                  <circle cx="6" cy="19" r="2.5" />
                  <circle cx="18" cy="12" r="2.5" />
                  <path d="M6 7.5v9" />
                  <path d="M6 12h9.5" />
                </svg>
              ) : (
                /* 列表：切回列表 */
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                  <line x1="4" y1="6" x2="20" y2="6" />
                  <line x1="4" y1="12" x2="20" y2="12" />
                  <line x1="4" y1="18" x2="20" y2="18" />
                </svg>
              )}
            </button>
          )}
          {!collapsed && (
            <button
              type="button"
              onClick={() => {
                if (filter === null) {
                  setFilter("");
                  setFilterSel(0);
                } else {
                  exitFilter();
                }
              }}
              className={`shrink-0 px-2.5 py-2 rounded-t-card transition-colors ${
                filter !== null
                  ? "text-accent bg-accent-muted"
                  : "text-ink-faint hover:text-ink hover:bg-surface-muted"
              }`}
              title="过滤跳转（⌘J）"
              aria-label="过滤跳转"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="7" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </button>
          )}
        </div>

        {!collapsed && (
          <div className="relative w-72 border-t border-line-faint">
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
                  className="w-full px-2 py-1.5 rounded-field border border-line bg-surface text-xs text-ink placeholder:text-ink-faint outline-none focus:border-accent-line"
                  aria-label="过滤节点"
                />
              </div>
            )}

            <div
              ref={bodyRef}
              className="p-1.5 max-h-[min(420px,55vh)] overflow-y-auto overscroll-contain"
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
                      className={`w-full min-w-0 flex items-center gap-1 px-2 py-1 rounded text-left ${
                        i === filterSel
                          ? "bg-accent-muted text-accent-ink"
                          : "text-ink-muted hover:bg-surface-muted"
                      }`}
                    >
                      <span className="shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                        #{indices[node.id] ?? "?"}
                      </span>
                      <span className="truncate">{nodeRowLabel(node)}</span>
                      <span className="ml-auto shrink-0 truncate max-w-[7rem] text-nano text-ink-faint">
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
                  {/* 当前树被雪藏时不在热区 —— 仍要展开显示，钉在热区下方 */}
                  {activeEntry?.hidden && renderActiveTree(activeEntry)}

                  {groups.cold.length > 0 && (
                    <div className="mt-1 pt-1 border-t border-line-faint">
                      <button
                        type="button"
                        onClick={() => setColdOpen((v) => !v)}
                        className="w-full px-2 py-1 flex items-center gap-1 rounded text-ink-faint hover:bg-surface-muted"
                      >
                        <span
                          className={`inline-block transition-transform ${coldOpen ? "rotate-90" : ""}`}
                          aria-hidden
                        >
                          ▸
                        </span>
                        更早 · {groups.cold.length} 棵
                      </button>
                      {coldOpen && groups.cold.map(renderTreeRow)}
                    </div>
                  )}

                  {groups.hidden.length > 0 && (
                    <div className="mt-1 pt-1 border-t border-line-faint">
                      <button
                        type="button"
                        onClick={() => setHiddenOpen((v) => !v)}
                        className="w-full px-2 py-1 flex items-center gap-1 rounded text-ink-faint hover:bg-surface-muted"
                      >
                        <span
                          className={`inline-block transition-transform ${hiddenOpen ? "rotate-90" : ""}`}
                          aria-hidden
                        >
                          ▸
                        </span>
                        已隐藏 · {groups.hidden.length} 棵
                        {hiddenUnread > 0 && (
                          <span className="ml-auto inline-flex items-center gap-0.5 text-nano text-ink-faint tabular-nums">
                            <span className="w-1 h-1 rounded-full bg-unread/60" aria-hidden />
                            {hiddenUnread}
                          </span>
                        )}
                      </button>
                      {hiddenOpen && groups.hidden.map(renderTreeRow)}
                    </div>
                  )}
                </>
              )}
            </div>

            {hoverNode && hover && (
              <div
                className={`pointer-events-none absolute right-full mr-2 ${PREVIEW_W} rounded-card border border-line bg-surface shadow-pop px-3 py-2.5 text-left`}
                style={{ top: hover.top, transform: "translateY(-50%)" }}
                aria-hidden
              >
                <div className="text-label text-ink-faint font-mono">
                  #{indices[hoverNode.id] ?? "?"} ·{" "}
                  {hoverNode.kind === "reference" ? "Reference" : "Turn"}
                </div>
                <div className="mt-1 text-xs font-semibold text-ink-strong line-clamp-2">
                  {hoverNode.topicLabel ?? mdExcerpt(hoverNode.question, 80)}
                </div>
                {(() => {
                  const body =
                    hoverNode.status === "error"
                      ? "生成失败"
                      : isWaitingNode(hoverNode)
                        ? "🙋 模型在等你回答"
                        : mdExcerpt(hoverNode.response, 160) ||
                          (hoverNode.status === "streaming" ? "生成中…" : "");
                  return body ? (
                    <div className="mt-1 text-xs leading-relaxed text-ink-muted line-clamp-4">
                      {body}
                    </div>
                  ) : null;
                })()}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
