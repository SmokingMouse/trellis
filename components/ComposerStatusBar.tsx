"use client";
import { useState } from "react";
import { ChevronDown, Clock3, Gauge, TerminalSquare } from "lucide-react";
import { Button, Icon, Popover } from "@/components/ui";
import { formatTokens } from "@/lib/format-tokens";
import {
  CONTEXT_PILL_MIN_PERCENT,
  formatContextPercent,
  type ComposerStatusPill,
} from "@/lib/composer-status";
import type { ContextUsage } from "@/lib/context-usage";

// 输入框上方的紧凑状态条（参考 Codex 手机端）：排队数 · 上下文用量 · 本轮后台任务。
// 内容由 lib/composer-status.ts 决定；没有 pill 时调用方根本不渲染它（不占高度）。
//   - 排队 pill：点开 / 收起卡片上方的排队列表（ComposerShell 的 queueOpen）；
//   - 上下文 pill：点开浮层看占用明细，可一键开新话题；
//   - 后台任务 pill：只读提示。
// 手机端可点的 pill 都是 44px 热区（max-md:min-h-11）；一行放不下就横向滚动，不换行。

const TONE = {
  neutral: "border-transparent bg-surface-raised text-ink-muted shadow-btn hover:bg-surface-hover hover:text-ink",
  warn: "border-warn-line bg-warn-muted text-warn-ink hover:bg-warn-muted",
} as const;

const PILL =
  "inline-flex h-7 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 text-label tabular-nums transition-colors duration-100 max-md:h-11 max-md:px-3";

export function ComposerStatusBar({
  pills,
  queueOpen,
  onToggleQueue,
  context,
  onStartFresh,
}: {
  pills: ComposerStatusPill[];
  queueOpen: boolean;
  onToggleQueue: () => void;
  context: ContextUsage | null;
  onStartFresh: () => void;
}) {
  const [ctxOpen, setCtxOpen] = useState(false);
  if (pills.length === 0) return null;
  return (
    <div
      data-composer-status=""
      // py-0.5：横向滚动容器会把 shadow-btn 的上下边裁掉
      className="mb-1 flex items-center gap-1.5 overflow-x-auto px-0.5 py-0.5 [scrollbar-width:none]"
    >
      {pills.map((pill) => {
        if (pill.kind === "queue") {
          return (
            <button
              key="queue"
              type="button"
              data-composer-status-pill="queue"
              aria-label={pill.ariaLabel}
              aria-expanded={queueOpen}
              onClick={onToggleQueue}
              className={`${PILL} ${TONE[pill.tone]}`}
            >
              <Icon icon={Clock3} size="sm" />
              <span className="tabular-nums">{pill.label}</span>
              <ChevronDown
                size={12}
                aria-hidden
                className={`transition-transform duration-100 ${queueOpen ? "rotate-180" : ""}`}
              />
            </button>
          );
        }
        if (pill.kind === "context") {
          return (
            <Popover
              key="context"
              open={ctxOpen}
              onClose={() => setCtxOpen(false)}
              align="start"
              wrapperClassName="shrink-0"
              panelClassName="w-72 p-3"
              trigger={
                <button
                  type="button"
                  data-composer-status-pill="context"
                  aria-label={pill.ariaLabel}
                  aria-expanded={ctxOpen}
                  onClick={() => setCtxOpen((v) => !v)}
                  className={`${PILL} ${TONE[pill.tone]}`}
                >
                  <Icon icon={Gauge} size="sm" />
                  <span className="tabular-nums">{pill.label}</span>
                </button>
              }
            >
              {context && (
                <div data-composer-context-detail="">
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-ui font-medium text-ink-strong">上下文占用</span>
                    <span className="font-mono text-ui tabular-nums text-ink">
                      {formatContextPercent(context.percent)}%
                    </span>
                  </div>
                  <div className="mt-1.5 text-label leading-relaxed text-ink-muted">
                    当前话题已用 {formatTokens(context.tokens)} / {formatTokens(context.contextWindow)} tokens。
                    占用越高，模型越慢、缓存越难增长。
                  </div>
                  {context.percent >= CONTEXT_PILL_MIN_PERCENT && (
                    <Button
                      variant="primary"
                      className="mt-2.5 w-full"
                      onClick={() => {
                        setCtxOpen(false);
                        onStartFresh();
                      }}
                    >
                      开新话题（清空上下文）
                    </Button>
                  )}
                </div>
              )}
            </Popover>
          );
        }
        return (
          <span
            key="background"
            role="status"
            data-composer-status-pill="background"
            aria-label={pill.ariaLabel}
            className={`${PILL} border-transparent bg-surface-raised text-ink-muted shadow-btn max-md:h-8`}
          >
            <Icon icon={TerminalSquare} size="sm" />
            <span className="relative inline-flex size-1.5" aria-hidden>
              <span className="absolute inset-0 animate-ping rounded-full bg-positive opacity-60 motion-reduce:animate-none" />
              <span className="relative size-1.5 rounded-full bg-positive" />
            </span>
            <span className="tabular-nums">{pill.label}</span>
          </span>
        );
      })}
    </div>
  );
}
