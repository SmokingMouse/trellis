"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { refIcon } from "@/lib/ref-icon";
import {
  buildTreeEntries,
  flattenTree,
  groupTrees,
  isUnreadNode,
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

  const [collapsed, setCollapsed] = useState(false);
  const [coldOpen, setColdOpen] = useState(false);
  const [hiddenOpen, setHiddenOpen] = useState(false);
  // null = 过滤模式关闭；字符串（含空串）= 开启且为当前查询。
  const [filter, setFilter] = useState<string | null>(null);
  const [filterSel, setFilterSel] = useState(0);
  const [hover, setHover] = useState<Hover>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const filterInputRef = useRef<HTMLInputElement>(null);

  const entries = useMemo(() => buildTreeEntries(nodesMap), [nodesMap]);
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
      <div className="mt-0.5">
        {activeRows.map(({ node, depth, isBranch }) => {
          const isActive = node.id === activeNodeId;
          const unread = isUnreadNode(node);
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
                  : "text-ink-muted hover:bg-surface-muted"
              }`}
              title={node.question || undefined}
            >
              {isBranch && <span className="shrink-0 text-ink-faint">↳</span>}
              <span className="shrink-0 font-mono text-nano text-ink-faint tabular-nums">
                #{indices[node.id] ?? "?"}
              </span>
              {node.status === "streaming" && (
                <span className="shrink-0 w-1.5 h-1.5 rounded-full bg-accent animate-pulse" aria-hidden />
              )}
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
