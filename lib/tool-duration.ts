import type { ToolCall } from "./types";

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
