"use client";

import { LayoutGrid, LoaderCircle } from "lucide-react";
import { Icon, Spinner, StatusDot, cn } from "@/components/ui";
import { useHerdrConsole } from "@/hooks/useHerdrConsole";
import { herdrLaneCounts } from "@/lib/herdr-console";
import { useSessionStore } from "@/stores/sessionStore";

// 侧栏「Herdr」入口：置顶分组上方一行，带「需要你」数（warn 点）+ 在跑数，点击进 /herdr 总览。
// Herdr 不可用时照常显示（点进去是降级卡），只是不带计数。
export function HerdrSidebarEntry() {
  const { panes, available } = useHerdrConsole();
  const active = useSessionStore((s) => !s.session && s.herdrOpen);
  const counts = herdrLaneCounts(panes);
  return (
    <button
      type="button"
      data-sidebar-herdr
      data-mobile-target="drawer-herdr"
      aria-current={active ? "page" : undefined}
      onClick={() => {
        useSessionStore.getState().openHerdr();
      }}
      title={available ? `Herdr 总览 · ${counts.need} 个需要你 · ${counts.run} 个在跑` : "Herdr 总览"}
      className={cn(
        "mx-1 mb-1 flex h-7 w-[calc(100%-0.5rem)] items-center gap-1.5 rounded-md pl-1.5 pr-2 text-left text-ui transition-colors max-md:h-11",
        active ? "bg-accent-muted text-accent-ink" : "text-ink hover:bg-surface-hover",
      )}
    >
      <Icon icon={LayoutGrid} size="sm" className={active ? "text-accent-ink" : "text-ink-muted"} />
      <span className="min-w-0 flex-1 truncate font-medium">Herdr</span>
      {available && (
        <span className="flex shrink-0 items-center gap-2 text-label text-ink-faint">
          {counts.need > 0 && (
            <span className="inline-flex items-center gap-1 font-medium text-warn-ink" data-herdr-need-count>
              <StatusDot tone="warn" className="ring-3 ring-warn-muted" label={`${counts.need} 个需要你`} />
              {counts.need}
            </span>
          )}
          <span className="inline-flex items-center gap-1 tabular-nums" data-herdr-run-count title={`${counts.run} 个在跑`}>
            {counts.run ? <Spinner size="sm" label={null} /> : <Icon icon={LoaderCircle} size="sm" className="text-ink-faint" />}
            {counts.run}
          </span>
        </span>
      )}
    </button>
  );
}
