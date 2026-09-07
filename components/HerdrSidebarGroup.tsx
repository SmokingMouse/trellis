"use client";

import { useMemo } from "react";
import { buildHerdrWorkspaceViews, type HerdrUiStatus } from "@/lib/herdr-ui";
import { useHerdrFleet } from "@/hooks/useHerdrFleet";
import { HerdrInteractionCard } from "@/components/HerdrInteractionCard";

const STATUS_STYLE: Record<HerdrUiStatus, string> = {
  working: "bg-accent animate-pulse",
  waiting: "bg-warn animate-pulse",
  blocked: "bg-danger animate-pulse",
  idle: "bg-line-strong",
  done: "bg-positive",
  unknown: "bg-line",
};

export function HerdrSidebarGroup({
  activeSessionId,
  onOpenSession,
}: {
  activeSessionId: string | null;
  onOpenSession: (sessionId: string) => void;
}) {
  const { fleet, hooks, loading, error } = useHerdrFleet();
  const workspaces = useMemo(
    () => buildHerdrWorkspaceViews(fleet, hooks),
    [fleet, hooks],
  );
  const available = Boolean(fleet?.available);
  const unavailableText = loading
    ? "正在连接 Herdr…"
    : !fleet?.enabled
      ? "Herdr 未启用"
      : fleet?.lastError || error || "Herdr 当前不可用";

  return (
    <section className="mb-3" data-herdr-group>
      <div className="mx-1 flex h-[26px] max-md:h-11 items-center gap-1.5 rounded-md px-1.5 text-ui font-semibold text-ink-strong">
        <span aria-hidden className="text-sm">⚓</span>
        <span>Herdr</span>
        {available && (
          <span className="ml-auto text-nano font-normal tabular-nums text-ink-faint">
            {workspaces.reduce((count, workspace) => count + workspace.panes.length, 0)}
          </span>
        )}
      </div>

      {!available ? (
        <div
          className="mx-1 min-h-[32px] max-md:min-h-11 rounded-md px-6 py-1.5 text-label text-ink-faint"
          data-herdr-unavailable
          title={unavailableText}
        >
          <span className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-line" />
          {unavailableText}
        </div>
      ) : workspaces.length === 0 ? (
        <div className="mx-1 min-h-[32px] max-md:min-h-11 px-6 py-1.5 text-label italic text-ink-faint">
          当前没有 agent pane
        </div>
      ) : (
        <div className="ml-[9px] border-l border-line">
          {workspaces.map((workspace) => (
            <div key={workspace.id} data-herdr-workspace={workspace.id}>
              <div className="flex h-[26px] max-md:h-11 items-center px-3 text-label font-medium text-ink-muted">
                <span className="truncate" title={workspace.label}>
                  {workspace.label}
                </span>
              </div>
              {workspace.panes.map((pane) => {
                const sessionId = pane.binding?.sessionId ?? null;
                const active = sessionId === activeSessionId;
                const urgent = pane.status === "waiting" || pane.status === "blocked";
                return (
                  <div key={pane.paneId}>
                    <button
                    type="button"
                    data-herdr-pane={pane.paneId}
                    data-herdr-status={pane.status}
                    data-mobile-target="herdr-pane-row"
                    disabled={!sessionId}
                    onClick={() => sessionId && onOpenSession(sessionId)}
                    className={`mx-1 flex h-[30px] max-md:h-11 w-[calc(100%-0.5rem)] touch-manipulation items-center gap-2 rounded-md pl-5 pr-2 text-left transition-colors disabled:cursor-wait disabled:opacity-60 ${
                      urgent
                        ? "bg-warn-muted font-medium text-warn-ink"
                        : active
                          ? "bg-accent-muted text-accent-ink"
                          : "text-ink-muted hover:bg-surface-muted"
                    }`}
                    title={`${pane.label} · ${pane.agentKind} · ${pane.status}${
                      sessionId ? "" : "\n会话 transcript 正在同步"
                    }`}
                    >
                      <span
                        className={`h-2 w-2 shrink-0 rounded-full ${STATUS_STYLE[pane.status]}`}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate text-ui">
                        {pane.label}
                      </span>
                      <span className="shrink-0 text-nano uppercase text-ink-faint">
                        {pane.agentKind}
                      </span>
                      <span className="shrink-0 text-nano">{pane.status}</span>
                      {urgent && (
                        <span className="sr-only">
                          {pane.status === "waiting" ? "等你回答" : "终端在等你"}
                        </span>
                      )}
                    </button>
                    {(pane.status === "waiting" ||
                      (pane.agentKind === "codex" && pane.status === "blocked")) && (
                      <HerdrInteractionCard pane={pane} compact />
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
