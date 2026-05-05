"use client";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { SessionPicker } from "./SessionPicker";
import { ExportMenu } from "./ExportMenu";
import { ModePicker } from "./ModePicker";
import { ThemeToggle } from "./ThemeToggle";
import { formatTokens } from "@/lib/format-tokens";

export function Header() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const noteCount = useSessionStore((s) => s.notes.length);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const nodeCount = Object.keys(nodes).length;
  // Aggregate four buckets independently — total input vs total output vs
  // total cache leverage. Computed via useMemo (NOT inside the Zustand
  // selector) because returning a fresh object from a selector defeats
  // its referential-equality bail-out and triggers an infinite render
  // loop ("getSnapshot should be cached"). The selector returns the
  // stable nodes map; useMemo only recomputes when that ref changes.
  const totals = useMemo(
    () =>
      Object.values(nodes).reduce(
        (acc, n) => {
          acc.input += n.tokenCount.input;
          acc.output += n.tokenCount.output;
          acc.cacheRead += n.tokenCount.cacheRead;
          acc.cacheCreation += n.tokenCount.cacheCreation;
          return acc;
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      ),
    [nodes],
  );

  return (
    <header className="fixed top-0 inset-x-0 h-12 bg-white/85 dark:bg-stone-950/85 backdrop-blur border-b border-stone-200 dark:border-stone-800 flex items-center px-3 sm:px-4 z-40 gap-2 sm:gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-6 h-6 rounded bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400" />
        <span className="font-semibold tracking-tight hidden sm:inline">Trellis</span>
        <span className="text-stone-300 dark:text-stone-600 hidden sm:inline">/</span>
      </div>
      <div className="flex-1 min-w-0">
        <SessionPicker />
      </div>
      <div className="flex items-center gap-2 sm:gap-3 text-xs text-stone-500 dark:text-stone-400 shrink-0">
        {session && (
          <>
            <span className="hidden md:inline">{nodeCount} 节点</span>
            <span className="hidden md:inline text-stone-300 dark:text-stone-600">·</span>
            <span
              className="hidden md:inline-flex items-center gap-1.5 tabular-nums"
              title={`输入 ${totals.input} · 输出 ${totals.output} · 缓存命中 ${totals.cacheRead}${
                totals.cacheCreation > 0
                  ? ` · 缓存写入 ${totals.cacheCreation}`
                  : ""
              }`}
            >
              <span>↑{formatTokens(totals.input)}</span>
              <span>↓{formatTokens(totals.output)}</span>
              {(totals.cacheRead > 0 || totals.cacheCreation > 0) && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ⚡{formatTokens(totals.cacheRead)}
                  {totals.cacheCreation > 0
                    ? `+${formatTokens(totals.cacheCreation)}`
                    : ""}
                </span>
              )}
            </span>
            <button
              onClick={() => setNotesOpen(true)}
              title="笔记"
              aria-label="笔记"
              className="px-2 py-1 rounded text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center gap-1.5"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {noteCount > 0 && (
                <span className="tabular-nums text-[11px]">
                  {noteCount}
                </span>
              )}
            </button>
            <ExportMenu />
          </>
        )}
        <ModePicker />
        <ModelPicker />
        <ThemeToggle />
      </div>
    </header>
  );
}
