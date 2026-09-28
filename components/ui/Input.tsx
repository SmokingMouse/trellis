"use client";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

// 单行输入。32px（sm 26px）+ 描边 + 聚焦时 accent 描边 & 2px 光晕。
// 手机端字号由 globals.css 的 16px 规则兜底（防 iOS 缩放），这里不再写。
//
// leading / trailing：框内两侧的图标或按钮（搜索框的放大镜、清除 ✕）。
// 有它们时外层是带边框的 div，input 本身无框。

const FIELD =
  "rounded-field border border-line-strong bg-surface text-ui text-ink transition-colors duration-100 placeholder:text-ink-faint disabled:cursor-not-allowed disabled:opacity-50";
const FOCUS =
  "outline-none focus-visible:outline-none focus:border-accent-line focus:ring-2 focus:ring-focus-ring";
const INVALID = "border-danger-line focus:border-danger-line";

const SIZE = { sm: "min-h-6.5 px-2", md: "min-h-8 px-2.5" } as const;

export type InputProps = Omit<ComponentProps<"input">, "size"> & {
  size?: keyof typeof SIZE;
  invalid?: boolean;
  leading?: ReactNode;
  trailing?: ReactNode;
  /** 有 leading/trailing 时作用于外层框 */
  wrapperClassName?: string;
};

export function Input({
  size = "md",
  invalid = false,
  leading,
  trailing,
  className,
  wrapperClassName,
  ...rest
}: InputProps) {
  if (!leading && !trailing) {
    return (
      <input
        aria-invalid={invalid || undefined}
        className={cn(FIELD, FOCUS, SIZE[size], "w-full min-w-0", invalid && INVALID, className)}
        {...rest}
      />
    );
  }
  return (
    <div
      className={cn(
        FIELD,
        SIZE[size],
        "flex w-full items-center gap-2 focus-within:border-accent-line focus-within:ring-2 focus-within:ring-focus-ring",
        invalid && "border-danger-line",
        wrapperClassName,
      )}
    >
      {leading && <span className="inline-flex shrink-0 text-ink-faint">{leading}</span>}
      <input
        aria-invalid={invalid || undefined}
        className={cn(
          "min-w-0 flex-1 self-stretch bg-transparent outline-none focus-visible:outline-none placeholder:text-ink-faint",
          className,
        )}
        {...rest}
      />
      {trailing && <span className="inline-flex shrink-0 text-ink-faint">{trailing}</span>}
    </div>
  );
}

export function Textarea({
  invalid = false,
  className,
  ...rest
}: ComponentProps<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea
      aria-invalid={invalid || undefined}
      className={cn(
        FIELD,
        FOCUS,
        "block w-full min-w-0 px-2.5 py-1.5 leading-relaxed",
        invalid && INVALID,
        className,
      )}
      {...rest}
    />
  );
}
