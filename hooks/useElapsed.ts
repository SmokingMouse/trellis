"use client";
import { useEffect, useState } from "react";

// Ticking elapsed time for a running call. task_progress only lands between
// tool calls, so leaning on its duration_ms leaves the counter frozen through
// a long Bash — the one moment the user most wants to see it moving.
// Returns null when not running (callers fall back to the recorded duration).
//
// 住在 hooks/ 而不是 ToolRow 里：Workflow 的表头（ToolRow 渲染）和它的面板
// （views/ 渲染）都要走秒表，两边互相 import 会成环。
export function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [startedAt]);
  if (startedAt === null) return null;
  return Math.max(0, now - startedAt);
}
