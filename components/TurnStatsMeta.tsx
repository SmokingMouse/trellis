"use client";
import { useEffect, useState } from "react";
import { formatDuration } from "@/lib/format-duration";
import { formatTokens, computeToolActiveDuration } from "@/lib/format-tokens";
import type { ChatNode, ToolCall } from "@/lib/types";

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

  const baseCls = "tabular-nums whitespace-nowrap";
  const sizeCls = variant === "compact" ? "text-nano" : "text-label";

  if (!isStreaming && !hasTokens && !effectiveDuration) {
    return (
      <span className={`shrink-0 ${sizeCls} ${baseCls} text-ink-faint ${className}`}>
        —
      </span>
    );
  }

  const tokenTooltip = hasTokens
    ? `输入 ${input.toLocaleString()} · 输出 ${output.toLocaleString()} · 缓存读取 ${cacheRead.toLocaleString()}${
        cacheCreation > 0 ? ` · 缓存写入 ${cacheCreation.toLocaleString()}` : ""
      } · 累计 ${totalTokens.toLocaleString()} tokens`
    : undefined;

  const durationTooltip = effectiveDuration
    ? isStreaming
      ? `已耗时 ${formatDuration(effectiveDuration)}（生成中…）`
      : toolDuration > 0
        ? `本轮总耗时 ${formatDuration(effectiveDuration)}（模型生成 ${formatDuration(llmDuration)} + 工具调用 ${formatDuration(toolDuration)}）`
        : `本轮耗时 ${formatDuration(effectiveDuration)}`
    : undefined;

  const tpsTooltip = tps !== null
    ? toolDuration > 0
      ? `模型输出速率：${tps.toFixed(1)} tokens/s（模型实际耗时 ${formatDuration(llmDuration)}，已扣除工具执行 ${formatDuration(toolDuration)}；共 ${output.toLocaleString()} 输出 tokens）`
      : `模型输出速率：${tps.toFixed(1)} tokens/s（${output.toLocaleString()} 输出 tokens / ${formatDuration(effectiveDuration!)}）`
    : undefined;

  return (
    <span
      className={`shrink-0 inline-flex items-center gap-1.5 ${sizeCls} ${baseCls} text-ink-muted ${className}`}
    >
      {effectiveDuration !== null && effectiveDuration > 0 && (
        <span
          className="inline-flex items-center gap-0.5 text-ink-muted"
          title={durationTooltip}
        >
          <span className="opacity-70 text-[0.9em]">⏱</span>
          <span>{formatDuration(effectiveDuration)}</span>
        </span>
      )}

      {effectiveDuration !== null && effectiveDuration > 0 && hasTokens && (
        <span className="text-line-strong select-none">·</span>
      )}

      {hasTokens && (
        <span
          className="inline-flex items-center gap-1"
          title={tokenTooltip}
        >
          <span>↑{formatTokens(input)}</span>
          <span>↓{formatTokens(output)}</span>
          {(cacheRead > 0 || cacheCreation > 0) && (
            <span className="text-positive">
              ⚡{formatTokens(cacheRead)}
              {cacheCreation > 0 ? `+${formatTokens(cacheCreation)}` : ""}
            </span>
          )}
        </span>
      )}

      {tps !== null && (
        <>
          <span className="text-line-strong select-none">·</span>
          <span
            className="font-mono text-ink-muted"
            title={tpsTooltip}
          >
            {tps.toFixed(1)} tps
          </span>
        </>
      )}
    </span>
  );
}
