"use client";

import { useEffect, useRef } from "react";
import { Anchor } from "lucide-react";
import { Icon, Kbd, Spinner, StatusDot, cn } from "@/components/ui";
import { openHerdrConsolePane, useCurrentHerdrPane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { HERDR_LANE_LABEL, type HerdrConsolePane } from "@/lib/herdr-console";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

export const HERDR_FLASH_MS = 3_000;

export function HerdrLaneDot({ pane }: { pane: HerdrConsolePane }) {
  if (pane.lane === "need") return <StatusDot tone="warn" className="ring-3 ring-warn-muted" />;
  if (pane.lane === "run") return <Spinner size="sm" label={null} />;
  if (pane.lane === "off") return <StatusDot tone="neutral" />;
  return <StatusDot tone="idle" />;
}

// 会话页窗格切换条：当前会话是 Herdr 会话时出现在标签条下方，列出所有活着的 agent 窗格
// （需要你 → 在跑 → 空闲），⌥1-9 直达、⌥[ ⌥] 前后切、⌥J 下一个需要你（见 useHerdrShortcuts）。
export function HerdrPaneStrip() {
  const { panes, strip } = useHerdrConsole();
  const current = useCurrentHerdrPane(panes);
  const flash = useHerdrConsoleStore((s) => s.flash);
  const clearFlash = useHerdrConsoleStore((s) => s.clearFlash);
  const currentRef = useRef<HTMLButtonElement | null>(null);
  const scrollerRef = useRef<HTMLDivElement | null>(null);

  // 当前 chip 滚进可视区（等价 inline:"nearest"），只动 chip 行自己的 scrollLeft：
  // 标签在滚动容器外，天然不被挡；两侧各留 8px 余量，不贴边。
  useEffect(() => {
    const scroller = scrollerRef.current;
    const chip = currentRef.current;
    if (!scroller || !chip) return;
    const pad = 8;
    const left = chip.offsetLeft - scroller.offsetLeft;
    const right = left + chip.offsetWidth;
    if (left - pad < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - pad);
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

  // 发布切换条高度：跨窗格通知贴在它正下方（与 --trellis-sb / --trellis-rp 同一模式）。
  const visible = strip.length > 0;
  useEffect(() => {
    if (!visible) return;
    const root = document.documentElement;
    root.style.setProperty("--trellis-herdr-strip-h", "2.375rem");
    return () => {
      root.style.removeProperty("--trellis-herdr-strip-h");
    };
  }, [visible]);

  if (!visible) return null;
  return (
    // 「Herdr」标签和右侧提示放在滚动容器外，只有 chip 行横向滚动，标签永远不被截。
    <nav
      aria-label="Herdr 窗格"
      data-herdr-strip
      className="flex h-9.5 shrink-0 items-center border-b border-line bg-surface-canvas max-md:hidden"
    >
      <span data-herdr-strip-label className="inline-flex shrink-0 items-center gap-1.5 pl-3 pr-2 text-label text-ink-faint">
        <Icon icon={Anchor} size="sm" />
        Herdr
      </span>
      <div ref={scrollerRef} className="no-scrollbar flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto">
        {strip.map((pane, i) => {
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
              title={`${pane.workspaceLabel} · ${pane.tabLabel} · ${pane.title}（${HERDR_LANE_LABEL[pane.lane]}）`}
              onClick={() => openHerdrConsolePane(pane)}
              className={cn(
                "inline-flex h-6.5 max-w-[200px] shrink-0 items-center gap-1.5 rounded-md border px-2 text-label transition-colors",
                isCurrent
                  ? "border-line-strong bg-surface text-ink-strong"
                  : pane.lane === "need"
                    ? "border-transparent text-warn-ink hover:bg-surface-hover"
                    : "border-transparent text-ink-muted hover:bg-surface-hover hover:text-ink",
                flashing && !isCurrent && "animate-pulse bg-warn-muted motion-reduce:animate-none",
              )}
            >
              <HerdrLaneDot pane={pane} />
              <span className="shrink-0 text-ink-faint">{pane.workspaceLabel}</span>
              <span className="min-w-0 truncate">{pane.title}</span>
              {i < 9 && <Kbd>{i + 1}</Kbd>}
            </button>
          );
        })}
      </div>
      <span className="inline-flex shrink-0 items-center gap-2.5 border-l border-line-faint pl-3 pr-3 text-label text-ink-faint max-lg:hidden">
        <span className="inline-flex items-center gap-1"><Kbd keys={["⌥", "J"]} />下一个需要你</span>
        <span className="inline-flex items-center gap-1"><Kbd keys={["⌥", "["]} /><Kbd keys={["⌥", "]"]} /></span>
      </span>
    </nav>
  );
}
