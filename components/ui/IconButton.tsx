"use client";
import type { ButtonHTMLAttributes, ReactNode } from "react";

// 图标按钮原语——全项目最高频的按钮形态（Header 图标群/关闭 ✕/行内小动作）。
// label 必填：同时落 aria-label 与 title，杜绝无名图标按钮。

type Size = "sm" | "md";
type Tone = "neutral" | "danger";

const SIZE: Record<Size, string> = {
  sm: "p-1 text-sm",
  md: "p-1.5",
};

const TONE: Record<Tone, string> = {
  neutral: "text-ink-muted hover:text-ink-strong hover:bg-surface-muted",
  danger: "text-ink-faint hover:text-danger hover:bg-danger-muted",
};

export function IconButton({
  label,
  size = "md",
  tone = "neutral",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  size?: Size;
  tone?: Tone;
  children: ReactNode;
}) {
  return (
    <button
      aria-label={label}
      title={label}
      className={`shrink-0 inline-flex items-center justify-center rounded-md transition-colors ${SIZE[size]} ${TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </button>
  );
}
