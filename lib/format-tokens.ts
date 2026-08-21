import type { ToolCall } from "./types";

// Compact token-count formatter used across all token displays so the
// header / cards / fullscreen meta line read consistently with high precision.
//
// Tiers:
//   - <1000      → exact integer ("820")
//   - 1k - 1M    → one decimal ("1.2k", "12.4k", "120.5k"; whole thousands strip ".0")
//   - 1M+        → up to two decimals ("1.25M", "1.2M", "1M")
//
// Negative inputs return "0"; non-finite returns "—".
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return "—";
  if (n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) {
    const v = (n / 1000).toFixed(1);
    return v.endsWith(".0") ? v.slice(0, -2) + "k" : v + "k";
  }
  const m = (n / 1_000_000).toFixed(2);
  return m.endsWith(".00")
    ? m.slice(0, -3) + "M"
    : m.endsWith("0")
      ? m.slice(0, -1) + "M"
      : m + "M";
}

/**
 * Compute total active wall-clock duration spent executing tools (merging overlapping intervals).
 * Only top-level tools are counted to avoid double counting nested sub-agents.
 */
export function computeToolActiveDuration(toolCalls?: ToolCall[]): number {
  if (!toolCalls || toolCalls.length === 0) return 0;
  const topLevel = toolCalls.filter((tc) => !tc.parentToolUseId);
  const intervals: [number, number][] = [];

  for (const tc of topLevel) {
    const start = tc.startedAt;
    const end = tc.endedAt ?? (tc.durationMs ? start + tc.durationMs : null);
    if (start && end && end >= start) {
      intervals.push([start, end]);
    } else if (tc.durationMs && tc.durationMs > 0) {
      intervals.push([0, tc.durationMs]);
    }
  }

  if (intervals.length === 0) return 0;
  intervals.sort((a, b) => a[0] - b[0]);

  let totalMs = 0;
  let currentStart = intervals[0][0];
  let currentEnd = intervals[0][1];

  for (let i = 1; i < intervals.length; i++) {
    const [start, end] = intervals[i];
    if (start <= currentEnd) {
      currentEnd = Math.max(currentEnd, end);
    } else {
      totalMs += currentEnd - currentStart;
      currentStart = start;
      currentEnd = end;
    }
  }
  totalMs += currentEnd - currentStart;

  return totalMs;
}
