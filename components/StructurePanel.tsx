"use client";
import { createPortal } from "react-dom";
import { CANVAS_MAP } from "@/lib/canvas-map";
import { CanvasMap } from "./CanvasMap";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { useConfirmDelete } from "@/hooks/useConfirmDelete";
import { buildNodeIndex } from "@/lib/node-index";
import { isUnreadNode, isWaitingNode, treeLabel } from "@/lib/tree-panel";
import { buildStructure, DEFAULT_STRUCTURE_PREFERENCE, readStructurePreference, writeStructurePreference, structureKey, type StructureNode, type StructureRow } from "@/lib/structure-panel";

/** One page-level navigation surface shared by linear/canvas and desktop/sheet.
 * Desktop floats above the composer without reserving a content column.
 * Keep the sheet outside the thread's stacking context (mobile-shell M2).
 */
export function StructurePanel({ isMobile }: { isMobile: boolean }) {
  const sessionId = useSessionStore(s => s.session?.id);
  const [mapSession, setMapSession] = useState<string | null>(null);
  const mobileOpen = useSessionStore(s => s.mobileTreePanelOpen);
  const setMobileOpen = useSessionStore(s => s.setMobileTreePanelOpen);
  const setViewMode = useSessionStore(s => s.setViewMode);
  // Home mounts this after hydration, so expansion can restore on first paint.
  const [preference, setPreference] = useState(() => {
    try { return readStructurePreference(localStorage); } catch { return DEFAULT_STRUCTURE_PREFERENCE; }
  });
  const closeRef = useRef<HTMLButtonElement>(null);
  const railRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousSession = useRef(sessionId);
  const open = isMobile ? mobileOpen : preference.expanded;
  const update = (patch: Partial<typeof preference>) => setPreference(old => {
    const next = { ...old, ...patch };
    try { writeStructurePreference(localStorage, next); } catch { /* storage access denied */ }
    return next;
  });
  useEffect(() => {
    if (previousSession.current !== sessionId) setMobileOpen(false);
    previousSession.current = sessionId;
  }, [sessionId, setMobileOpen]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, [open]);
  const close = () => {
    if (isMobile) { setMobileOpen(false); setViewMode("linear"); }
    else { update({ expanded: false }); requestAnimationFrame(() => railRef.current?.focus()); }
  };
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== "j") return;
      e.preventDefault();
      if (isMobile) setMobileOpen(true);
      else setPreference(old => { const next = { ...old, expanded: true }; try { writeStructurePreference(localStorage, next); } catch { /* storage access denied */ } return next; });
      requestAnimationFrame(() => panelRef.current?.querySelector<HTMLButtonElement>('[aria-label="过滤跳转"]')?.click());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isMobile, setMobileOpen]);

  const nodes = useSessionStore(s => s.nodes);
  const activeId = useSessionStore(s => s.activeNodeId);
  const primaryRoot = useSessionStore(s => s.session?.rootNodeId);
  const model = useMemo(() => buildStructure(nodes, activeId, primaryRoot), [nodes, activeId, primaryRoot]);
  if (isMobile && !open) return null;
  return <aside ref={panelRef} data-structure-panel={open ? "expanded" : "collapsed"}
    data-mobile-tree-sheet={isMobile ? "open" : undefined} data-keys-yield
    role={isMobile ? "dialog" : "complementary"} aria-modal={isMobile || undefined} aria-label="结构"
    tabIndex={-1}
    className={isMobile ? "fixed inset-0 z-50 bg-surface text-xs flex flex-col" : "fixed right-3 z-40 rounded-card border border-line/80 bg-surface/95 shadow-pop backdrop-blur text-xs flex flex-col"}
    style={isMobile ? { paddingTop: "var(--safe-top)", paddingBottom: "var(--safe-bottom)" } : {
      width: open ? "290px" : undefined,
      maxWidth: "calc(100vw - 24px)",
      maxHeight: "45dvh",
      bottom: "max(calc(var(--trellis-term-h, 0px) + 6rem), calc(var(--trellis-term-stack, 0px) + 0.5rem))",
    }}
    onKeyDown={e => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(); }
      if (isMobile && e.key === "Tab") {
        const items = [...(panelRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]):not([tabindex="-1"]), input, summary, [tabindex="0"]') ?? [])].filter(el => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }}>
    {!open ? <button ref={railRef} aria-label="展开结构" title={`${model.forest.length} 话题 · ${model.branchCount} 分支`} onClick={() => update({ expanded: true })}
      className="flex items-center gap-2 rounded-card px-3 py-2 text-ink-muted hover:bg-surface-muted">
      <span aria-hidden>▸</span><span>结构</span>
      <span data-structure-topic-count className="rounded bg-surface-muted px-1 tabular-nums" aria-label={`${model.forest.length} 话题`}>{model.forest.length}</span>
      <span data-structure-unread-count className="rounded bg-unread-muted px-1 text-unread-ink tabular-nums" aria-label={`${Object.values(nodes).filter(isUnreadNode).length} 未读`}>{Object.values(nodes).filter(isUnreadNode).length} 未读</span>
    </button> : <>
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1">
        <strong className="text-ink">结构</strong><span className="flex-1 text-ink-faint">{model.forest.length > 1 ? `${model.forest.length} 话题 · ` : ""}{Object.keys(nodes).length} 节点</span>
        <button ref={closeRef} data-mobile-target={isMobile ? "tree-sheet-close" : undefined} aria-label={isMobile ? "关闭结构" : "收起结构"} onClick={close} className="min-h-7 min-w-7 max-md:min-h-11 max-md:min-w-11 text-lg text-ink-muted hover:bg-surface-muted">{isMobile ? "×" : "▾"}</button>
      </div>
      <StructureContent key={sessionId} model={model} isMobile={isMobile} close={close} />
      {CANVAS_MAP && <button data-map-open onClick={() => setMapSession(sessionId ?? null)} className="min-h-11 shrink-0 border-t border-line px-3 py-2 text-left font-medium text-accent-ink hover:bg-accent-muted">🗺 地图</button>}
    </>}
    {CANVAS_MAP && mapSession && mapSession === sessionId && createPortal(<CanvasMap mobile={isMobile} close={() => setMapSession(null)} />, document.body)}
  </aside>;
}

function StructureContent({ model, isMobile, close }: { model: ReturnType<typeof buildStructure>; isMobile: boolean; close: () => void }) {
  const nodes = useSessionStore(s => s.nodes);
  const activeId = useSessionStore(s => s.activeNodeId);
  const setActive = useSessionStore(s => s.setActiveNode);
  const setViewMode = useSessionStore(s => s.setViewMode);
  const setComposeRootOpen = useSessionStore(s => s.setComposeRootOpen);
  const collapsed = useSessionStore(s => s.collapsedNodeIds);
  const toggleCollapse = useSessionStore(s => s.toggleCollapse);
  const renameTree = useSessionStore(s => s.renameTree);
  const markRead = useSessionStore(s => s.markNodeRead);
  const markUnread = useSessionStore(s => s.markNodeUnread);
  const setHidden = useSessionStore(s => s.setTreeHidden);
  const primaryRoot = useSessionStore(s => s.session?.rootNodeId);
  const confirmDelete = useConfirmDelete();
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);
  const [expandedTopics, setExpandedTopics] = useState<Set<string>>(new Set());
  const [closedTopics, setClosedTopics] = useState<Set<string>>(new Set());
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [filter, setFilter] = useState<string | null>(null);
  const [filterIndex, setFilterIndex] = useState(0);
  const [focused, setFocused] = useState<string | null>(activeId);
  const [readingPosition, setReadingPosition] = useState(activeId);
  const [editing, setEditing] = useState<string | null>(null);
  const [title, setTitle] = useState("");
  const treeRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const filterOpen = filter !== null;
  useEffect(() => { if (filterOpen) inputRef.current?.focus(); }, [filterOpen]);
  if (readingPosition !== activeId) {
    setReadingPosition(activeId);
    setClosedTopics(new Set());
    setFocused(activeId);
  }
  useEffect(() => {
    if (activeId) treeRef.current?.querySelector<HTMLElement>(`[data-structure-node="${CSS.escape(activeId)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [activeId]);
  const jump = (id: string) => { setActive(id); if (isMobile) close(); };
  const topicOpen = (t: StructureNode) => !closedTopics.has(t.node.id) && (t === model.current || expandedTopics.has(t.node.id) || model.forest.length === 1);
  const toggleTopic = (id: string) => {
    const t = model.forest.find(t => t.node.id === id)!;
    if (topicOpen(t)) setClosedTopics(old => new Set(old).add(id));
    else { setClosedTopics(old => { const next = new Set(old); next.delete(id); return next; }); setExpandedTopics(old => new Set(old).add(id)); }
  };
  const hasUnread = (t: StructureNode): boolean => isUnreadNode(t.node) || t.children.some(hasUnread);
  const rows: (StructureRow & { t: StructureNode; depth: number; topic: boolean; level: number })[] = [];
  const visit = (t: StructureNode, depth: number, level: number, topic: boolean, parentId: string | null) => {
    if (unreadOnly && !hasUnread(t)) return;
    const expanded = t.children.length ? (topic ? topicOpen(t) : !collapsed.has(t.node.id)) : undefined;
    rows.push({ id: t.node.id, parentId, expanded, t, depth, topic, level });
    if (expanded) t.children.forEach(c => visit(c, depth + (t.children.length > 1 ? 1 : 0), level + 1, false, t.node.id));
  };
  model.forest.filter(t => showHidden || t.node.hiddenAt === null || t === model.current).forEach(t => visit(t, 0, 1, true, null));
  const results = Object.values(nodes).filter(n => `${n.topicLabel ?? ""} ${n.question}`.toLocaleLowerCase().includes((filter ?? "").trim().toLocaleLowerCase()));
  const focusRow = (id?: string) => { if (!id) return; setFocused(id); requestAnimationFrame(() => treeRef.current?.querySelector<HTMLElement>(`[data-structure-node="${CSS.escape(id)}"]`)?.focus()); };
  const onTreeKey = (e: KeyboardEvent) => {
    if (!(e.target as HTMLElement).matches('[role="treeitem"]')) return;
    const action = structureKey(e.key, rows, focused);
    if (!Object.keys(action).length) return;
    e.preventDefault(); e.stopPropagation();
    if (action.focus) focusRow(action.focus);
    if (action.toggle) { const row = rows.find(r => r.id === action.toggle)!; if (row.topic) toggleTopic(row.id); else toggleCollapse(row.id); }
    if (action.jump) jump(action.jump);
    if (action.close) close();
  };
  const otherBranches = model.otherBranches.length > 0 && <div className="my-2 border-y border-line-faint py-1">
    <button aria-expanded={branchesOpen} className="w-full p-2 text-left text-ink-muted max-md:min-h-11" onClick={() => setBranchesOpen(v => !v)}>{branchesOpen ? "▾" : "▸"} 其它分支 {model.otherBranches.length} 条</button>
    {branchesOpen && model.otherBranches.map(n => <button key={n.id} data-structure-branch={n.id} className="flex w-full gap-1 rounded p-2 pl-5 text-left text-ink-muted hover:bg-surface-muted max-md:min-h-11" onClick={() => jump(n.id)}><span className="text-ink-faint">↳ #{indices[n.id]}</span><span className="truncate">{treeLabel(n, 80)}</span></button>)}
  </div>;
  let topicId: string | undefined;
  return <>
    <div className="flex shrink-0 flex-wrap gap-1 border-b border-line-faint p-2 text-ink-muted">
      <button data-mobile-target="new-tree-open" className="rounded px-2 py-1 max-md:min-h-11 hover:bg-accent-muted text-accent-ink" onClick={() => { if (isMobile) close(); setComposeRootOpen(true); }}>＋ 新话题</button>
      <button aria-label="过滤跳转" title="过滤跳转（⌘J）" className="rounded px-2 py-1 max-md:min-h-11 hover:bg-surface-muted" onClick={() => setFilter(old => old === null ? "" : null)}>⌕ 过滤</button>
      {!CANVAS_MAP && <button className="rounded px-2 py-1 max-md:min-h-11 hover:bg-surface-muted" onClick={() => { if (isMobile) close(); setViewMode("canvas"); }}>画布</button>}
      <button aria-pressed={unreadOnly} className="rounded px-2 py-1 max-md:min-h-11 hover:bg-surface-muted" onClick={() => setUnreadOnly(v => !v)}>{unreadOnly ? "全部节点" : "只看未读"}</button>
    </div>
    {filter !== null && <div className="p-2"><input ref={inputRef} aria-label="过滤节点" placeholder="过滤节点…" className="w-full rounded border border-line bg-surface px-2 py-2 text-base md:text-xs" value={filter}
      onChange={e => { setFilter(e.target.value); setFilterIndex(0); }} onKeyDown={e => {
        if (["ArrowDown", "ArrowUp", "Enter"].includes(e.key)) { e.preventDefault(); e.stopPropagation(); }
        if (e.key === "ArrowDown") setFilterIndex(i => Math.min(results.length - 1, i + 1));
        if (e.key === "ArrowUp") setFilterIndex(i => Math.max(0, i - 1));
        if (e.key === "Enter" && results[filterIndex]) { jump(results[filterIndex].id); setFilter(null); }
      }} /></div>}
    <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
      {filter?.trim() ? <div aria-label="过滤结果">{results.length ? results.map((n, i) => <button key={n.id} className={`block w-full truncate rounded p-2 text-left ${i === filterIndex ? "bg-accent-muted text-accent-ink" : "text-ink-muted"}`} onClick={() => { jump(n.id); setFilter(null); }}>#{indices[n.id]} {treeLabel(n)}</button>) : <p className="p-2 text-ink-faint">没有匹配的节点</p>}</div> : <>
        <div ref={treeRef} role="tree" aria-label="会话话题与阅读位置" onKeyDown={onTreeKey}>
          {rows.map((row, index) => {
            if (row.topic) topicId = row.id;
            const endOfCurrentTopic = topicId === model.current?.node.id && (!rows[index + 1] || rows[index + 1].topic);
            return <div key={row.id} className="group" style={{ paddingLeft: Math.min(row.depth, 8) * 12 }}>
            <div className={`flex items-center rounded border-l-2 ${activeId === row.id ? "border-accent bg-accent-muted text-accent-ink" : model.chain.has(row.id) ? "border-transparent bg-surface-muted text-ink" : "border-transparent text-ink-muted"}`}>
              {row.expanded !== undefined ? <button tabIndex={-1} aria-label={row.expanded ? "折叠" : "展开"} className="w-5 shrink-0 py-2 md:py-1 max-md:min-h-11" onClick={() => row.topic ? toggleTopic(row.id) : toggleCollapse(row.id)}>{row.expanded ? "▾" : "▸"}</button> : <span className="w-5 shrink-0" />}
              <button role="treeitem" aria-level={row.level} aria-expanded={row.expanded} aria-selected={activeId === row.id} aria-current={activeId === row.id ? "location" : undefined}
                data-structure-node={row.id} data-current-chain={model.chain.has(row.id)} tabIndex={row.id === (rows.some(r => r.id === focused) ? focused : rows[0]?.id) ? 0 : -1}
                onFocus={() => setFocused(row.id)} onClick={() => jump(row.id)} title={row.t.node.question}
                className="flex min-w-0 flex-1 items-center gap-1 py-1 pr-1 text-left focus-visible:outline focus-visible:outline-accent max-md:min-h-11">
                <span aria-label={isWaitingNode(row.t.node) ? "等待处理" : isUnreadNode(row.t.node) ? "未读" : "已读"} className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: isWaitingNode(row.t.node) ? "#d97706" : isUnreadNode(row.t.node) ? "#2563eb" : "var(--color-ink-faint)" }} />
                <span className="shrink-0 text-nano text-ink-faint">#{indices[row.id]}</span>
                <span className={`truncate ${row.topic ? "font-semibold" : ""}`}>{treeLabel(row.t.node, 80)}</span>
                {row.topic && <span className="ml-auto text-nano text-ink-faint">{row.t.count}</span>}
              </button>
              <details data-node-actions className="relative shrink-0">
                <summary aria-label={`${treeLabel(row.t.node, 16)}操作`} className="cursor-pointer list-none px-1 py-2 md:py-1 max-md:min-h-11 text-ink-faint">⋯</summary>
                <div className="absolute right-0 top-full z-10 w-36 rounded border border-line bg-surface p-1 shadow-pop" onClick={e => { e.currentTarget.parentElement?.removeAttribute("open"); }}>
                  <button className="block w-full p-2 text-left" onClick={() => isUnreadNode(row.t.node) ? markRead(row.id) : markUnread(row.id)}>{isUnreadNode(row.t.node) ? "标为已读" : "标为未读"}</button>
                  {row.topic && <><button className="block w-full p-2 text-left" onClick={() => { setEditing(row.id); setTitle(row.t.node.topicLabel ?? ""); }}>重命名话题</button>
                    <button className="block w-full p-2 text-left" onClick={() => void setHidden(row.id, row.t.node.hiddenAt === null)}>{row.t.node.hiddenAt === null ? "隐藏话题" : "恢复话题"}</button></>}
                  {row.id !== primaryRoot && <button className="block w-full p-2 text-left text-danger" onClick={() => confirmDelete(row.id)}>删除节点</button>}
                </div>
              </details>
            </div>
            {editing === row.id && <form className="flex gap-1 py-1" onSubmit={e => { e.preventDefault(); void renameTree(row.id, title.trim()); setEditing(null); }}><input autoFocus aria-label="话题名称" className="min-w-0 flex-1 border border-line bg-surface p-1 text-base md:text-xs" value={title} onChange={e => setTitle(e.target.value)} /><button>保存</button><button type="button" onClick={() => setEditing(null)}>取消</button></form>}
            {endOfCurrentTopic && otherBranches}
          </div>; })}
        </div>
        {model.forest.some(t => t.node.hiddenAt !== null) && <button className="mt-2 w-full p-2 text-left text-ink-faint" onClick={() => setShowHidden(v => !v)}>{showHidden ? "收起已隐藏话题" : "显示已隐藏话题"}</button>}
        {!rows.length && <p className="p-2 text-ink-faint">{unreadOnly ? "没有未读节点" : "还没有话题"}</p>}
      </>}
    </div>
  </>;
}
