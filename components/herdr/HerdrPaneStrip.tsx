"use client";

import { useEffect, useMemo, useRef } from "react";
import { LayoutGrid } from "lucide-react";
import { Icon, Kbd, Spinner, StatusDot, cn } from "@/components/ui";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { HERDR_LANE_LABEL, type HerdrConsolePane } from "@/lib/herdr-console";
import { herdrGroupName } from "@/lib/herdr-mode";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";
import { useSessionStore } from "@/stores/sessionStore";

export const HERDR_FLASH_MS = 3_000;

export function HerdrLaneDot({ pane }: { pane: HerdrConsolePane }) {
  if (pane.lane === "need") return <StatusDot tone="warn" className="ring-3 ring-warn-muted" />;
  if (pane.lane === "run") return <Spinner size="sm" label={null} />;
  if (pane.lane === "off") return <StatusDot tone="neutral" />;
  return <StatusDot tone="idle" />;
}

// Herdr 模式的标签行：整行替换普通会话标签（SessionTabs 在 Herdr 模式下只渲染它）。
// 同一行里按 workspace 分组：组名（sticky，横向滚动时贴左不被截）+ 该组的窗格 chip。
// 组序 / 编号与侧栏一致（lib/herdr-mode.ts）：⌥1-9 直达、⌥[ ⌥] 前后切、⌥J 下一个需要你。
// 窄屏（< xl，右侧还挂着会话动作槽）有当前窗格时只显示当前组。
export function HerdrPaneStrip() {
  const { panes, strip, groups } = useHerdrConsole();
  const current = useCurrentHerdrPane(panes);
  const overviewActive = useSessionStore((s) => !s.session && s.herdrOpen);
  const flash = useHerdrConsoleStore((s) => s.flash);
  const clearFlash = useHerdrConsoleStore((s) => s.clearFlash);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const index = useMemo(() => new Map(strip.map((p, i) => [p.key, i])), [strip]);

  // 当前 chip 滚进可视区，只动 chip 行自己的 scrollLeft；左侧让出 sticky 组名的宽度。
  useEffect(() => {
    const scroller = scrollerRef.current;
    const chip = currentRef.current;
    if (!scroller || !chip) return;
    const label = chip.closest("[data-herdr-strip-group]")?.querySelector<HTMLElement>("[data-herdr-strip-glabel]");
    const pad = 8;
    const left = chip.offsetLeft;
    const right = left + chip.offsetWidth;
    const covered = (label?.offsetWidth ?? 0) + pad;
    if (left - covered < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - covered);
    else if (right + pad > scroller.scrollLeft + scroller.clientWidth) scroller.scrollLeft = right + pad - scroller.clientWidth;
  }, [current?.key, strip.length]);

  // 闪烁只持续几秒；过期后清掉，下次卡住才会再闪。
  useEffect(() => {
    const keys = Object.keys(flash);
    if (!keys.length) return;
    const timers = keys.map((key) =>
      setTimeout(() => clearFlash(key), Math.max(0, flash[key] + HERDR_FLASH_MS - Date.now())),
    );
    return () => timers.forEach(clearTimeout);
  }, [flash, clearFlash]);

  return (
    <nav aria-label="Herdr 窗格" data-herdr-strip className="flex h-full min-w-0 flex-1 items-center">
      <button
        type="button"
        data-herdr-strip-overview
        aria-current={overviewActive ? "page" : undefined}
        onClick={() => useSessionStore.getState().openHerdr()}
        title="Herdr 总览"
        className={cn(
          "ml-2 mr-1 inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-ui transition-colors",
          overviewActive ? "bg-surface-muted text-ink-strong" : "text-ink-muted hover:bg-surface-hover hover:text-ink",
        )}
      >
        <Icon icon={LayoutGrid} size="sm" />
        总览
      </button>
      <div ref={scrollerRef} className="no-scrollbar relative flex h-full min-w-0 flex-1 items-center overflow-x-auto">
        {groups.length === 0 && <span className="pl-2 text-label text-ink-faint">没有活着的 agent 窗格</span>}
        {groups.map((g) => {
          if (g.rows.length === 0) return null;
          const hasCurrent = g.rows.some((r) => r.pane.key === current?.key);
          return (
            <div
              key={g.id}
              data-herdr-strip-group={g.id}
              className={cn(
                "flex h-full shrink-0 items-center gap-0.5 border-l border-line-faint pr-1.5",
                current && !hasCurrent && "max-xl:hidden",
              )}
            >
              <span
                data-herdr-strip-glabel
                title={`${herdrGroupName(g)}${g.branch ? ` · ${g.branch}` : ""}${g.path ? `\n${g.path}` : ""}`}
                className="sticky left-0 z-10 inline-flex h-full shrink-0 items-center gap-1 whitespace-nowrap bg-surface-canvas pl-2.5 pr-1.5 text-label font-medium text-ink-muted"
              >
                {g.need > 0 && <StatusDot tone="warn" label={`${g.need} 个需要你`} />}
                {g.label}
                {g.hint && <span className="font-normal text-ink-faint">{g.hint}</span>}
                {g.branch && <span className="font-mono text-nano font-normal text-ink-faint">{g.branch}</span>}
              </span>
              {g.rows.map(({ pane, title }) => {
                const i = index.get(pane.key) ?? -1;
                const isCurrent = pane.key === current?.key;
                const flashing = pane.key in flash;
                return (
                  <button
                    key={pane.key}
                    ref={isCurrent ? currentRef : undefined}
                    type="button"
                    data-herdr-chip={pane.paneId}
                    data-flash={flashing || undefined}
                    aria-current={isCurrent ? "true" : undefined}
                    title={`${herdrGroupName(g)} · ${pane.tabLabel} · ${title}（${HERDR_LANE_LABEL[pane.lane]}）`}
                    onClick={() => openHerdrConsolePane(pane)}
                    className={cn(
                      "relative inline-flex h-7 max-w-[13rem] shrink-0 items-center gap-1.5 rounded-md px-2 text-ui transition-colors",
                      isCurrent
                        ? "bg-surface-muted text-ink-strong"
                        : pane.lane === "need"
                          ? "text-warn-ink hover:bg-surface-hover"
                          : "text-ink-muted hover:bg-surface-hover hover:text-ink",
                      flashing && !isCurrent && "animate-pulse bg-warn-muted motion-reduce:animate-none",
                    )}
                  >
                    <HerdrLaneDot pane={pane} />
                    <span className="min-w-0 truncate">{title}</span>
                    {i >= 0 && i < 9 && <Kbd>{i + 1}</Kbd>}
                    {isCurrent && <span aria-hidden className="absolute inset-x-2 -top-1 h-0.5 rounded-full bg-accent" />}
                  </button>
                );
              })}
            </div>
          );
        })}
      </div>
      <span className="inline-flex shrink-0 items-center gap-2.5 border-l border-line-faint pl-3 text-label text-ink-faint max-2xl:hidden">
        <span className="inline-flex items-center gap-1"><Kbd keys={["⌥", "J"]} />下一个需要你</span>
        <span className="inline-flex items-center gap-1"><Kbd keys={["⌥", "["]} /><Kbd keys={["⌥", "]"]} /></span>
      </span>
    </nav>
  );
}
