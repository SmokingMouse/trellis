"use client";
import type { HTMLAttributes } from "react";

// 小徽标/pill 原语：模式徽章、未读计数、状态角标的统一外壳。
// tone 对应语义 hue；solid=实色填充（默认淡色 tint + 描边）。

type Tone =
  | "neutral"
  | "accent"
  | "warn"
  | "danger"
  | "positive"
  | "unread"
  | "fork";

const TINT: Record<Tone, string> = {
  neutral: "bg-surface-muted text-ink-muted border-line",
  accent: "bg-accent-muted text-accent-ink border-accent-line",
  warn: "bg-warn-muted text-warn-ink border-warn-line",
  danger: "bg-danger-muted text-danger-ink border-danger-line",
  positive: "bg-positive-muted text-positive-ink border-positive-line",
  unread: "bg-unread-muted text-unread-ink border-unread-line",
  fork: "bg-fork-muted text-fork-ink border-fork-line",
};

const SOLID: Record<Tone, string> = {
  neutral: "bg-ink-muted text-ink-inverse border-transparent",
  accent: "bg-accent text-ink-inverse border-transparent",
  warn: "bg-warn text-ink-inverse border-transparent",
  danger: "bg-danger text-ink-inverse border-transparent",
  positive: "bg-positive text-ink-inverse border-transparent",
  unread: "bg-unread text-ink-inverse border-transparent",
  fork: "bg-fork text-ink-inverse border-transparent",
};

export function Pill({
  tone = "neutral",
  solid = false,
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLSpanElement> & { tone?: Tone; solid?: boolean }) {
  return (
    <span
      className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-nano font-medium ${
        solid ? SOLID[tone] : TINT[tone]
      } ${className}`}
      {...rest}
    >
      {children}
    </span>
  );
}
