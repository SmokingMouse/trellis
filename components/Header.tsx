"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { SessionPicker } from "./SessionPicker";
import { ExportMenu } from "./ExportMenu";
import { ModePicker } from "./ModePicker";
import { ThemeToggle } from "./ThemeToggle";
import { formatTokens } from "@/lib/format-tokens";

export function Header() {
  const session = useSessionStore((s) => s.session);
  const nodeCount = useSessionStore((s) => Object.keys(s.nodes).length);
  // Aggregate four buckets independently — total input vs total output vs
  // total cache leverage. Collapsed into one number obscures whether the
  // bill is from real prompts or cache replay.
  const totals = useSessionStore((s) =>
    Object.values(s.nodes).reduce(
      (acc, n) => {
        acc.input += n.tokenCount.input;
        acc.output += n.tokenCount.output;
        acc.cacheRead += n.tokenCount.cacheRead;
        acc.cacheCreation += n.tokenCount.cacheCreation;
        return acc;
      },
      { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
    ),
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
