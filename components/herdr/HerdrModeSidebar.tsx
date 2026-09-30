"use client";

import { useCallback, useMemo, type ReactNode } from "react";
import { ChevronRight, LayoutGrid, SquareTerminal } from "lucide-react";
import { Icon, Spinner, StatusDot, cn } from "@/components/ui";
import { HerdrLaneDot } from "./HerdrPaneStrip";
import { HerdrPaneMenu } from "./HerdrPaneMenu";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { isStringArray, useSidebarPreference } from "@/hooks/useSidebarPreference";
import { HERDR_LANE_LABEL, herdrLaneCounts } from "@/lib/herdr-console";
import { buildHerdrModeGroups, herdrGroupName, type HerdrModeGroup, type HerdrModeRow } from "@/lib/herdr-mode";
import type { Session } from "@/lib/types";
import { useSessionStore } from "@/stores/sessionStore";

// 侧栏 Herdr 模式：按 Herdr 自己的结构排 —— 总览 → 置顶（只列 Herdr 会话）→
// workspace（组）→ 窗格（行）。组序 / 行标题的规则在 lib/herdr-mode.ts。
// 纯 shell 窗格弱化列在组末；离线会话不在这里（总览有「已离线」泳道）。

const ROW = "h-7 max-md:h-11";

export function HerdrModeSidebar({
  sessions,
  pinned,
  onNavigate,
}: {
  /** 用来给「Claude Code」这类默认终端标题兜底取会话标题 */
  sessions: Session[];
  /** 置顶区（SessionSidebar 渲染，已只含 Herdr 会话） */
  pinned: ReactNode;
  /** 手机抽屉里点了行要收起抽屉 */
  onNavigate: () => void;
}) {
  const hc = useHerdrConsole();
  const titles = useMemo(() => new Map(sessions.map((s) => [s.id, s.title])), [sessions]);
  const sessionTitle = useCallback((id: string) => titles.get(id) ?? null, [titles]);
  const groups = useMemo(() => buildHerdrModeGroups(hc.fleet, hc.panes, sessionTitle), [hc.fleet, hc.panes, sessionTitle]);
  const current = useCurrentHerdrPane(hc.panes);
  const overviewActive = useSessionStore((s) => !s.session && s.herdrOpen);
  const counts = herdrLaneCounts(hc.panes);
  const [collapsedIds, setCollapsedIds] = useSidebarPreference("herdr-collapsed", [] as string[], isStringArray);
  const collapsed = useMemo(() => new Set(collapsedIds), [collapsedIds]);
  const toggle = (id: string) =>
    setCollapsedIds((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));

  const open = (row: HerdrModeRow) => {
    onNavigate();
    openHerdrConsolePane(row.pane);
  };

  return (
    <div data-herdr-sidebar>
      {!hc.available && (
        <div data-herdr-unavailable className="mx-2 mb-2 rounded-md border border-line bg-surface px-3 py-2 text-label text-ink-muted">
          {hc.unavailableText}
          <p className="mt-1 text-nano text-ink-faint">仍可阅读已同步的会话。启动 Herdr 后会自动恢复状态。</p>
        </div>
      )}
      <button
        type="button"
        data-herdr-sidebar-overview
        aria-current={overviewActive ? "page" : undefined}
        onClick={() => {
          onNavigate();
          useSessionStore.getState().openHerdr();
        }}
        title={hc.available ? `Herdr 总览 · ${counts.need} 个需要你 · ${counts.run} 个在跑` : "Herdr 总览"}
        className={cn(
          ROW,
          "relative mx-1 mb-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md pl-1.5 pr-2 text-left text-ui transition-colors",
          overviewActive ? "bg-accent-muted text-ink-strong" : "text-ink hover:bg-surface-hover",
        )}
      >
        {overviewActive && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
        <Icon icon={LayoutGrid} size="sm" className="text-ink-muted" />
        <span className="min-w-0 flex-1 truncate font-medium">总览</span>
        {hc.available && (
          <span className="flex shrink-0 items-center gap-2 text-label text-ink-faint">
            {counts.run > 0 && (
              <span className="inline-flex items-center gap-1 tabular-nums" title={`${counts.run} 个在跑`}>
                <Spinner size="sm" label={null} />
                {counts.run}
              </span>
            )}
          </span>
        )}
      </button>
      {pinned}
      {groups.map((g) => (
        <WorkspaceGroup
          key={g.id}
          group={g}
          collapsed={collapsed.has(g.id)}
          onToggle={() => toggle(g.id)}
          currentKey={current?.key ?? null}
          onOpen={open}
          readOnly={hc.readOnly}
          available={hc.available}
        />
      ))}
      {hc.available && groups.length === 0 && (
        <div className="px-3 py-6 text-center text-label text-ink-faint">Herdr 里还没有窗格</div>
      )}
    </div>
  );
}

function WorkspaceGroup({
  group: g,
  collapsed,
  onToggle,
  currentKey,
  onOpen,
  readOnly,
  available,
}: {
  group: HerdrModeGroup;
  collapsed: boolean;
  onToggle: () => void;
  currentKey: string | null;
  onOpen: (row: HerdrModeRow) => void;
  readOnly: boolean;
  available: boolean;
}) {
  return (
    <div data-herdr-sidebar-group={g.id} className="mb-1.5">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={!collapsed}
        title={`${herdrGroupName(g)}${g.branch ? `\n分支：${g.branch}` : ""}${g.path ? `\n${g.path}` : ""}${g.number != null ? `\nHerdr 工作区 #${g.number}` : ""}`}
        className={cn(ROW, "mx-1 flex w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md pl-1.5 pr-2 text-left text-ui hover:bg-surface-hover")}
      >
        <Icon
          icon={ChevronRight}
          size="sm"
          className={cn("-mr-0.5 shrink-0 text-ink-faint transition-transform duration-150", !collapsed && "rotate-90")}
        />
        <span className="min-w-0 shrink truncate font-medium text-ink-strong">{g.label}</span>
        {g.hint && <span className="shrink-0 truncate text-label text-ink-faint">{g.hint}</span>}
        <span className="min-w-0 flex-1" />
        {g.branch && (
          <span className="min-w-0 max-w-20 truncate font-mono text-nano text-ink-faint" title={`分支：${g.branch}`}>
            {g.branch}
          </span>
        )}
        {g.need > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-label font-medium text-warn-ink" title={`${g.need} 个需要你`}>
            <StatusDot tone="warn" className="ring-3 ring-warn-muted" label={`${g.need} 个需要你`} />
            {g.need}
          </span>
        )}
        {g.need === 0 && g.run > 0 && (
          <span className="inline-flex shrink-0 items-center gap-1 text-label tabular-nums text-ink-faint" title={`${g.run} 个在跑`}>
            <Spinner size="sm" label={null} />
            {g.run}
          </span>
        )}
      </button>
      {!collapsed && (
        <div className="relative">
          <span aria-hidden className="absolute inset-y-0 w-px bg-line" style={{ left: 15 }} />
          {g.rows.map((row) => (
            <PaneRow key={row.pane.key} row={row} active={row.pane.key === currentKey} onOpen={onOpen} readOnly={readOnly} available={available} />
          ))}
          {g.shells.map((row) => (
            <PaneRow key={row.pane.key} row={row} active={false} onOpen={onOpen} readOnly={readOnly} available={available} />
          ))}
        </div>
      )}
    </div>
  );
}

function PaneRow({
  row,
  active,
  onOpen,
  readOnly,
  available,
}: {
  row: HerdrModeRow;
  active: boolean;
  onOpen: (row: HerdrModeRow) => void;
  readOnly: boolean;
  available: boolean;
}) {
  const { pane } = row;
  return (
    <div
      role="button"
      tabIndex={0}
      data-herdr-sidebar-row={pane.paneId}
      data-herdr-lane={pane.lane}
      aria-current={active ? "true" : undefined}
      onClick={() => onOpen(row)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(row);
        }
      }}
      title={`${row.title}\n${pane.tabLabel} · ${row.shell ? "shell" : HERDR_LANE_LABEL[pane.lane]}${pane.cwd ? `\n${pane.cwd}` : ""}`}
      style={{ paddingLeft: 22 }}
      className={cn(
        ROW,
        "group relative mx-1 flex cursor-pointer items-center gap-1.5 rounded-md pr-1 text-ui transition-colors",
        active ? "bg-accent-muted text-ink-strong" : "hover:bg-surface-hover",
        row.shell ? "text-ink-faint" : pane.lane === "need" ? "text-warn-ink" : !active && "text-ink",
      )}
    >
      {active && <span className="absolute inset-y-1 left-0 w-0.5 rounded-full bg-accent" aria-hidden />}
      <span className="flex w-3.5 shrink-0 items-center justify-center">
        {row.shell ? <Icon icon={SquareTerminal} size="sm" className="text-ink-faint" /> : <HerdrLaneDot pane={pane} />}
      </span>
      <span className={cn("min-w-0 flex-1 truncate", row.shell && "text-label")}>{row.title}</span>
      {pane.queued > 0 && (
        <span className="shrink-0 text-nano tabular-nums text-ink-faint" title={`${pane.queued} 条输入排队中`}>
          +{pane.queued}
        </span>
      )}
      <span className="shrink-0 text-nano text-ink-faint transition-opacity md:group-hover:opacity-0 md:group-focus-within:opacity-0">
        {pane.tabLabel}
      </span>
      <span className="absolute inset-y-0 right-1 hidden items-center md:group-hover:flex md:group-focus-within:flex md:has-[[aria-expanded=true]]:flex max-md:!hidden">
        <HerdrPaneMenu pane={pane} readOnly={readOnly} available={available} className={active ? "bg-accent-muted" : "bg-surface-hover"} />
      </span>
    </div>
  );
}
