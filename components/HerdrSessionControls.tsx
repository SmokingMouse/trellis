"use client";

import type { HerdrPaneView } from "@/lib/herdr-ui";
import { herdrStatusLabel } from "@/lib/herdr-console";
import { useHerdrReopen } from "@/hooks/useHerdrReopen";
import { Anchor } from "lucide-react";
import { Icon } from "@/components/ui";

// 输入框已并入 ComposerShell 外壳（components/HerdrComposer.tsx）；旧入口保留转出。
export { HerdrComposer } from "./HerdrComposer";

export function HerdrSessionBadge({
  pane,
  loading,
}: {
  pane: HerdrPaneView | null;
  loading: boolean;
}) {
  return (
    <div
      data-herdr-badge
      className="flex min-w-0 items-center gap-1.5 text-label text-ink-faint"
      title={
        pane
          ? `${pane.workspaceLabel} · 窗格 ${pane.paneId} · ${pane.agentKind} · ${herdrStatusLabel(pane.status, pane.alive)}`
          : "Herdr 会话"
      }
    >
      <span className="inline-flex shrink-0 items-center gap-1 rounded-sm border border-line px-1.5 py-0.5 font-medium text-ink-muted">
        <Icon icon={Anchor} size="sm" />
        Herdr
      </span>
      {pane ? (
        <span className="min-w-0 truncate">
          {pane.workspaceLabel} · {pane.paneId} · {pane.agentKind} · {herdrStatusLabel(pane.status, pane.alive)}
        </span>
      ) : (
        <span>{loading ? "正在读取窗格…" : "窗格已离线"}</span>
      )}
    </div>
  );
}

export function HerdrOfflineBanner({
  sessionId,
  pane,
  loading,
}: {
  sessionId: string;
  pane: HerdrPaneView | null;
  loading: boolean;
}) {
  const { state, reopen, label } = useHerdrReopen(sessionId);
  if (loading || pane?.alive) return null;

  return (
    <div
      data-herdr-readonly
      className="flex flex-col gap-3 rounded-card border border-warn-line bg-warn-muted px-4 py-3 text-sm text-warn-ink sm:flex-row sm:items-center"
    >
      <div className="min-w-0 flex-1">
        <div className="font-semibold">这个 Herdr 窗格已离线，会话现为只读</div>
        <div className="mt-0.5 text-label opacity-80">
          历史记录仍可阅读；Trellis 不会接管这个 agent 进程。
        </div>
      </div>
      <button
        type="button"
        data-mobile-target="herdr-reopen"
        data-herdr-reopen
        onClick={reopen}
        disabled={state === "busy" || state === "done"}
        className="min-h-8 shrink-0 rounded-field border border-warn-line bg-surface px-3 text-ui font-medium text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 max-md:min-h-11"
      >
        {label}
      </button>
    </div>
  );
}
