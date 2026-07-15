"use client";
import type { ButtonHTMLAttributes } from "react";

// 「停止生成」统一形态：danger 描边 + ⏹。三处手写停止按钮归一到此
// （Composer 整宽 / ChatNode footer / TurnCard reference）。
export function StopButton({
  label = "停止",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label?: string }) {
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 px-2.5 py-1 rounded-md text-ui border border-danger-line text-danger hover:bg-danger-muted transition-colors active:scale-[0.98] ${className}`}
      {...rest}
    >
      <span aria-hidden>⏹</span>
      {label}
    </button>
  );
}
