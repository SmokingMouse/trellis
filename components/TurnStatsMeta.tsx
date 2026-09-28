"use client";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens, computeToolActiveDuration } from "@/lib/format-tokens";
import type { ChatNode, ToolCall } from "@/lib/types";
import { Tooltip } from "@/components/ui";

export { computeToolActiveDuration };

export function useElapsed(startedAt: number | null, active: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active || startedAt === null) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [startedAt, active]);
  if (!active || startedAt === null) return null;
  return Math.max(0, now - startedAt);
}

export function TurnStatsMeta({
  tokenCount,
  durationMs,
  createdAt,
  toolCalls,
  isStreaming = false,
  variant = "full",
  className = "",
}: {
  tokenCount?: ChatNode["tokenCount"];
  durationMs?: number | null;
  createdAt?: number | null;
  toolCalls?: ToolCall[];
  isStreaming?: boolean;
  variant?: "compact" | "full";
  className?: string;
}) {
  const liveElapsed = useElapsed(createdAt ?? null, isStreaming);
  const effectiveDuration = isStreaming
    ? liveElapsed
    : (durationMs ?? null);

  const input = tokenCount?.input ?? 0;
  const output = tokenCount?.output ?? 0;
  const cacheRead = tokenCount?.cacheRead ?? 0;
  const cacheCreation = tokenCount?.cacheCreation ?? 0;
  const hasTokens = input > 0 || output > 0 || cacheRead > 0 || cacheCreation > 0;
  const totalTokens = input + output + cacheRead + cacheCreation;

  // Deduct tool execution time to compute pure Model API generation duration
  const toolDuration = computeToolActiveDuration(toolCalls);
  const rawLlmDuration = effectiveDuration !== null ? Math.max(0, effectiveDuration - toolDuration) : 0;
  // Guard against near-zero division (e.g. clock jitter): ensure at least 100ms if turn finished
  const llmDuration = Math.max(rawLlmDuration, toolDuration > 0 && effectiveDuration ? 100 : effectiveDuration ?? 0);

  // Model token generation rate (TPS) based strictly on model generation time
  const llmDurationSec = llmDuration / 1000;
  const tps = !isStreaming && llmDurationSec > 0 && output > 0
    ? output / llmDurationSec
    : null;

  const baseCls = "tabular-nums whitespace-nowrap font-mono";
  const sizeCls = variant === "compact" ? "text-nano" : "text-label";

  if (!isStreaming && !hasTokens && !effectiveDuration) {
    return (
      <span className={`shrink-0 ${sizeCls} ${baseCls} text-ink-faint ${className}`}>
        —
      </span>
    );
  }

  // 可见的只留一行弱化 meta：「耗时 · 速率」（没有速率就退到输出 token 数）；
  // token 明细 / 耗时拆分 / 速率口径一律收进 Tooltip，不再用 ⏱ ↑↓ ⚡ 符号堆一行。
  const detail: string[] = [];
  if (effectiveDuration) {
    detail.push(
      isStreaming
        ? `已耗时 ${formatDuration(effectiveDuration)}（生成中）`
        : toolDuration > 0
          ? `总耗时 ${formatDuration(effectiveDuration)}（模型 ${formatDuration(llmDuration)} + 工具 ${formatDuration(toolDuration)}）`
          : `耗时 ${formatDuration(effectiveDuration)}`,
    );
  }
  if (hasTokens) {
    detail.push(
      `输入 ${formatTokens(input)} · 输出 ${formatTokens(output)} · 缓存读取 ${formatTokens(cacheRead)}${
        cacheCreation > 0 ? ` · 缓存写入 ${formatTokens(cacheCreation)}` : ""
      }（累计 ${totalTokens.toLocaleString()} tokens）`,
    );
  }
  if (tps !== null) {
    detail.push(
      `输出速率 ${tps.toFixed(1)} tok/s${toolDuration > 0 ? "（已扣除工具执行时间）" : ""}`,
    );
  }

  const parts: string[] = [];
  if (effectiveDuration !== null && effectiveDuration > 0) {
    parts.push(formatDuration(effectiveDuration));
  }
  if (tps !== null) parts.push(`${Math.round(tps)} tok/s`);
  else if (output > 0) parts.push(`${formatTokens(output)} tok`);

  const text = (
    <span
      tabIndex={detail.length > 0 && !isStreaming ? 0 : undefined}
      data-turn-stats=""
      className={`shrink-0 inline-flex items-center ${sizeCls} ${baseCls} text-ink-faint ${className}`}
    >
      {parts.join(" · ")}
    </span>
  );
  if (isStreaming || detail.length === 0) return text;
  return (
    <Tooltip content={<span className="whitespace-pre-line">{detail.join("\n")}</span>} side="top">
      {text}
    </Tooltip>
  );
}
