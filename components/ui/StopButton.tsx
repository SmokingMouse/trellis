"use client";
import { Square } from "lucide-react";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "./cn";

// 「停止生成」统一形态：danger 描边胶囊 + 实心方块。三处手写停止按钮归一到此
// （Composer 整宽 / ChatNode footer / TurnCard reference）。
export function StopButton({
  label = "停止",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { label?: string }) {
  return (
    <button
      className={cn(
        "press relative inline-flex items-center justify-center gap-1.5 min-h-6.5 px-2.5 rounded-full text-ui border border-danger-line text-danger-ink hover:bg-danger-muted transition-colors duration-100",
        // 手机热区 ≥44px：视觉仍是 26px 的描边按钮（它常嵌在一行小字里，撑高会把整行顶开），
        // 用居中的透明伪元素把可点区域扩到 至少 44×44。
        "max-md:before:absolute max-md:before:left-1/2 max-md:before:top-1/2 max-md:before:h-11 max-md:before:w-[max(100%,2.75rem)] max-md:before:-translate-x-1/2 max-md:before:-translate-y-1/2 max-md:before:content-['']",
        className,
      )}
      {...rest}
    >
      <Square size={10} strokeWidth={0} fill="currentColor" aria-hidden className="shrink-0" />
      {label}
    </button>
  );
}
