"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Search, SquareTerminal } from "lucide-react";
import { Icon, Kbd, Modal, cn } from "@/components/ui";
import { HerdrLaneDot } from "./HerdrPaneStrip";
import { openHerdrConsolePane, useHerdrConsole } from "@/hooks/useHerdrConsole";
import { HERDR_LANE_LABEL, matchHerdrPanes } from "@/lib/herdr-console";
import { formatRelativeTimeShort } from "@/lib/relative-time";
import { useHerdrConsoleStore } from "@/stores/herdrConsoleStore";

// 跳到窗格（⌥K，全局）：按工作区 / tab / 任务名搜 Herdr 窗格，↵ 打开会话（纯 shell 开终端抽屉）。
// 现有 ⌘P 是全文检索、⌘K 是选区分叉，都不是命令面板，所以独立成一个跳转面板。
export function HerdrJumpPalette() {
  const open = useHerdrConsoleStore((s) => s.paletteOpen);
  if (!open) return null;
  return <PaletteBody onClose={() => useHerdrConsoleStore.getState().setPaletteOpen(false)} />;
}

function PaletteBody({ onClose }: { onClose: () => void }) {
  const { panes, available, unavailableText } = useHerdrConsole();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const items = useMemo(() => matchHerdrPanes(panes, query), [panes, query]);
  const sel = Math.min(cursor, Math.max(0, items.length - 1));
  const [now] = useState(() => Date.now());

  useEffect(() => {
    listRef.current?.querySelector(`[data-cursor="${sel}"]`)?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const choose = (index: number) => {
    const pane = items[index];
    if (!pane) return;
    onClose();
    openHerdrConsolePane(pane);
  };

  return (
    <Modal onClose={onClose} size="lg" closeOnEsc={false} title="跳到 Herdr 窗格" panelClassName="flex max-h-[70vh] flex-col">
      <div className="flex min-h-12 items-center gap-2.5 border-b border-line px-4">
        <Icon icon={Search} className="text-ink-faint" />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setCursor(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            } else if (e.key === "ArrowDown") {
              e.preventDefault();
              setCursor(Math.min(sel + 1, items.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setCursor(Math.max(sel - 1, 0));
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              choose(sel);
            }
          }}
          placeholder="跳到窗格：工作区 / 任务名…"
          aria-label="搜索 Herdr 窗格"
          className="min-w-0 flex-1 bg-transparent text-body text-ink-strong outline-none placeholder:text-ink-faint"
        />
        <Kbd>Esc</Kbd>
      </div>
      <ul ref={listRef} role="listbox" aria-label="Herdr 窗格" className="flex-1 overflow-y-auto p-1.5">
        {!available && <li className="px-2.5 py-2 text-ui text-ink-faint">{unavailableText}</li>}
        {available && items.length === 0 && <li className="px-2.5 py-2 text-ui text-ink-faint">没有匹配的窗格</li>}
        {items.map((pane, i) => {
          const last = pane.activityAt ? formatRelativeTimeShort(pane.activityAt, now) : null;
          return (
            <li
              key={pane.key}
              role="option"
              aria-selected={i === sel}
              data-cursor={i}
              data-herdr-palette-item={pane.key}
              onMouseEnter={() => setCursor(i)}
              onClick={() => choose(i)}
              className={cn(
                "flex h-8.5 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-ui max-md:h-11",
                i === sel && "bg-surface-hover",
              )}
            >
              {pane.lane === "shell" ? <Icon icon={SquareTerminal} size="sm" className="text-ink-faint" /> : <HerdrLaneDot pane={pane} />}
              <span className="w-32 shrink-0 truncate text-label text-ink-faint">{pane.workspaceLabel} · {pane.tabLabel}</span>
              <span className={cn("min-w-0 flex-1 truncate", pane.lane === "off" || pane.lane === "shell" ? "text-ink-muted" : "text-ink")}>{pane.title}</span>
              <span className="shrink-0 text-label text-ink-faint">{HERDR_LANE_LABEL[pane.lane]}{last ? ` · ${last}` : ""}</span>
            </li>
          );
        })}
      </ul>
      <div className="flex items-center gap-3 border-t border-line-faint px-4 py-2 text-label text-ink-faint">
        <span className="inline-flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd>选择</span>
        <span className="inline-flex items-center gap-1"><Kbd>↵</Kbd>打开会话</span>
        <span className="inline-flex items-center gap-1"><Kbd keys={["⌥", "J"]} />下一个需要你的</span>
        <span className="inline-flex items-center gap-1"><Kbd>esc</Kbd>关闭</span>
      </div>
    </Modal>
  );
}
