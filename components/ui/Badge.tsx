import type { HTMLAttributes } from "react";
import { cn } from "./cn";
import { StatusDot } from "./StatusDot";

// 徽标（W2）：默认中性（灰字 + 细描边）；语义 variant 只换描边色并在前面放一个
// 状态小圆点，不做大面积彩色填充——克制工具风里状态色只点到为止。
// 旧的 Pill（tint / solid 色块）保留兼容，新代码用 Badge。
//
// variant:
//   neutral  默认，计数 / 标签 / 元信息
//   accent   选中 / 当前（淡 accent 底，唯一带底色的档）
//   positive / warn / danger   状态
//   fork     分叉相关
//   unread   未读计数

export type BadgeVariant = "neutral" | "accent" | "positive" | "warn" | "danger" | "fork" | "unread";

const BORDER: Record<BadgeVariant, string> = {
  neutral: "border-line text-ink-muted",
  accent: "border-accent-line bg-accent-muted text-accent-ink",
  positive: "border-positive-line text-ink-muted",
  warn: "border-warn-line text-ink-muted",
  danger: "border-danger-line text-danger-ink",
  fork: "border-fork-line text-ink-muted",
  unread: "border-unread-line text-unread-ink",
};

const DOT: Partial<Record<BadgeVariant, "positive" | "warn" | "danger" | "fork" | "unread">> = {
  positive: "positive",
  warn: "warn",
  danger: "danger",
  fork: "fork",
  unread: "unread",
};

export function Badge({
  variant = "neutral",
  dot,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
  /** 语义 variant 默认带圆点；传 false 去掉（纯数字计数时） */
  dot?: boolean;
}) {
  const dotTone = DOT[variant];
  const showDot = dot ?? Boolean(dotTone);
  return (
    <span
      className={cn(
        "inline-flex h-5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-sm border px-1.5 text-label leading-none tabular-nums",
        BORDER[variant],
        className,
      )}
      {...rest}
    >
      {showDot && <StatusDot tone={dotTone ?? "neutral"} />}
      {children}
    </span>
  );
}
