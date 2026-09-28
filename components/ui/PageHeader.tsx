import type { ReactNode } from "react";
import { cn } from "./cn";

// 管理页页头：标题 + 带实时计数的副标题 + 右侧动作区（依次「刷新」→ 主操作）。
// 计数写进副标题而不是标题：「12 个 bot · 3 个在线」。
export function PageHeader({
  title,
  count,
  countUnit = "项",
  subtitle,
  actions,
  className,
}: {
  title: ReactNode;
  /** 实时计数；给了就在副标题开头显示「{count} {countUnit}」 */
  count?: number;
  countUnit?: string;
  subtitle?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  const hasCount = typeof count === "number";
  return (
    <header className={cn("flex items-start gap-3", className)}>
      <div className="min-w-0 flex-1">
        <h1 className="truncate text-title font-semibold text-ink-strong">{title}</h1>
        {(hasCount || subtitle) && (
          <p className="mt-0.5 text-ui text-ink-muted">
            {hasCount && (
              <span className="tabular-nums">
                {count} {countUnit}
              </span>
            )}
            {hasCount && subtitle && <span className="px-1.5 text-ink-faint">·</span>}
            {subtitle}
          </p>
        )}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
