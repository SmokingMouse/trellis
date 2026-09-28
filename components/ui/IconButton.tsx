"use client";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { Tooltip } from "./Tooltip";

// 图标按钮原语——全项目最高频的按钮形态（Header 图标群 / 关闭 ✕ / 行内小动作）。
// label 必填（a11y 硬约束）：落 aria-label，并默认作为 Tooltip 文案显示；
// 不再写原生 title（和 Tooltip 双重弹出）。调用方传的 title 视为「更长的
// tooltip 文案」，优先于 label 显示。
//
// size: sm = 26px · md = 32px（默认）。min-* 而非固定宽高：带计数的图标按钮
// （图标 + 数字）照样能撑开。手机端 ≥44px 热区。

type Size = "sm" | "md";
type Tone = "neutral" | "danger";

const SIZE: Record<Size, string> = {
  sm: "min-h-6.5 min-w-6.5 p-1 text-sm",
  md: "min-h-8 min-w-8 p-1.5",
};

const TONE: Record<Tone, string> = {
  neutral:
    "text-ink-muted hover:bg-surface-hover hover:text-ink aria-expanded:bg-surface-hover aria-expanded:text-ink",
  danger: "text-ink-faint hover:bg-danger-muted hover:text-danger-ink",
};

export function IconButton({
  label,
  size = "md",
  tone = "neutral",
  shortcut,
  tooltip = true,
  tooltipSide,
  title,
  className,
  children,
  ...rest
}: ComponentProps<"button"> & {
  label: string;
  size?: Size;
  tone?: Tone;
  /** Tooltip 右侧的键帽，如 "⌘K" */
  shortcut?: string | string[];
  /** false = 不包 Tooltip（例如本身就在 tooltip / 菜单里） */
  tooltip?: boolean;
  tooltipSide?: "top" | "right" | "bottom" | "left";
  children: ReactNode;
}) {
  const button = (
    <button
      aria-label={label}
      title={tooltip ? undefined : (title ?? label)}
      className={cn(
        "shrink-0 inline-flex items-center justify-center rounded-field transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-11 max-md:min-w-11",
        SIZE[size],
        TONE[tone],
        className,
      )}
      {...rest}
    >
      {children}
    </button>
  );
  if (!tooltip) return button;
  return (
    <Tooltip content={title ?? label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
}
