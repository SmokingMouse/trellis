"use client";
import { CircleAlert } from "lucide-react";
import type { ReactNode } from "react";
import { describeError } from "@/lib/error-copy";
import { Button } from "./Button";
import { cn } from "./cn";

// 错误卡：别再把 e.message 直接摆给用户。
// 第一行「发生了什么」，第二行「可以怎么办」，原始错误折叠在「详情」里。
// 文案默认由 lib/error-copy.ts 按错误类型推断；调用方知道得更多就用 title/hint 覆盖。
export function ErrorCallout({
  error,
  title,
  hint,
  onRetry,
  retryLabel = "重试",
  action,
  compact = false,
  className,
}: {
  error: unknown;
  /** 覆盖「发生了什么」，如「保存 bot 失败」 */
  title?: ReactNode;
  /** 覆盖「可以怎么办」 */
  hint?: ReactNode;
  onRetry?: () => void;
  retryLabel?: string;
  /** 额外动作（放在重试旁边） */
  action?: ReactNode;
  compact?: boolean;
  className?: string;
}) {
  const copy = describeError(error);
  return (
    <div
      role="alert"
      className={cn(
        "flex items-start gap-2.5 rounded-card border border-danger-line bg-surface text-ui",
        compact ? "px-3 py-2" : "px-3.5 py-3",
        className,
      )}
    >
      <CircleAlert size={16} strokeWidth={1.75} aria-hidden className="mt-0.5 shrink-0 text-danger" />
      <div className="min-w-0 flex-1">
        <div className="font-medium text-ink-strong">{title ?? copy.what}</div>
        <div className="mt-0.5 text-ink-muted">{hint ?? copy.hint}</div>
        {copy.raw && (
          <details className="mt-1.5 text-label text-ink-faint">
            <summary className="cursor-pointer select-none hover:text-ink-muted">详情</summary>
            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-surface-muted px-2 py-1.5 font-mono text-nano text-ink-muted">
              {copy.raw}
            </pre>
          </details>
        )}
        {(onRetry || action) && (
          <div className="mt-2 flex items-center gap-2">
            {onRetry && (
              <Button size="sm" onClick={onRetry}>
                {retryLabel}
              </Button>
            )}
            {action}
          </div>
        )}
      </div>
    </div>
  );
}
