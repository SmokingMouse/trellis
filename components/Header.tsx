"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { SessionPicker } from "./SessionPicker";
import { ExportMenu } from "./ExportMenu";
import { ModePicker } from "./ModePicker";
import { ThemeToggle } from "./ThemeToggle";

export function Header() {
  const session = useSessionStore((s) => s.session);
  const nodeCount = useSessionStore((s) => Object.keys(s.nodes).length);
  const totalTokens = useSessionStore((s) =>
    Object.values(s.nodes).reduce(
      (sum, n) => sum + n.tokenCount.input + n.tokenCount.output,
      0,
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
            <span className="hidden md:inline">{totalTokens} tokens</span>
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
