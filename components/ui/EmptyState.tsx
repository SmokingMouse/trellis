import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

// 空状态：图标 + 标题 + 描述 + 可选动作。
// 文案句式：标题「还没有 X」（还没有笔记 / 还没有定时任务），描述一句说清
// 「X 是什么 / 怎么产生」，动作是创建 X 的主按钮（没有就不放）。
export function EmptyState({
  icon,
  title,
  description,
  action,
  compact = false,
  className,
}: {
  icon?: LucideIcon;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  /** 抽屉 / 下拉里的小号版本 */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        compact ? "gap-1.5 px-4 py-6" : "gap-2 px-6 py-12",
        className,
      )}
    >
      {icon && (
        <div className="mb-1 grid size-9 place-items-center rounded-card border border-line text-ink-faint">
          <Icon icon={icon} />
        </div>
      )}
      <div className="text-ui font-medium text-ink">{title}</div>
      {description && <p className="max-w-sm text-label text-ink-muted">{description}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}
