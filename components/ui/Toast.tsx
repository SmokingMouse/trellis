"use client";
import type { HTMLAttributes } from "react";

// Toast 视觉外壳：tone 四档 + 统一圆角/阴影/进场动画。
// 定位容器（bottom-right 堆叠 / bottom-center）与自动消失计时语义各不相同，
// 留在消费方（DoneToast / AbortToast / StreamAlertToast）。

type Tone = "neutral" | "positive" | "warn" | "danger";

const TONE: Record<Tone, string> = {
  neutral: "bg-surface-raised border-line-strong text-ink-muted",
  positive: "bg-surface border-positive-line",
  warn: "bg-warn-muted border-warn-line text-warn-ink",
  danger: "bg-danger-muted border-danger-line text-danger-ink",
};

export function ToastShell({
  tone = "neutral",
  className = "",
  children,
  ...rest
}: HTMLAttributes<HTMLDivElement> & { tone?: Tone }) {
  return (
    <div
      className={`pointer-events-auto border rounded-lg shadow-overlay ui-enter-slide-up ${TONE[tone]} ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}
