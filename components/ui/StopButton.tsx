"use client";
import { Square } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

// 「停止生成」统一形态：danger 描边 + 实心方块。三处手写停止按钮归一到此
// （Composer 整宽 / ChatNode footer / TurnCard reference）。
export function StopButton({
  label = "停止",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label?: string }) {
  return (
    <button
      className={cn(
        "inline-flex items-center justify-center gap-1.5 min-h-6.5 px-2.5 rounded-field text-ui border border-danger-line text-danger-ink hover:bg-danger-muted transition-colors duration-100",
        className,
      )}
      {...rest}
    >
      <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden className="shrink-0" />
      {label}
    </button>
  );
}
