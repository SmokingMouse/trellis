"use client";
import type { ButtonHTMLAttributes } from "react";

// 全局按钮原语。主按钮裁决（2026-07-15）：提交/发送类动作统一 primary =
// accent 填充（旧黑底按钮身份废除）——accent 已是焦点/流式/选中的既定
// 强调身份，且随主题换肤。
//
// variant:
//   primary   — accent 实色填充（发送/提交/确认）
//   secondary — 描边 + surface（次要动作）
//   ghost     — 无边框纯文字（取消/低调动作）
//   danger    — danger 实色填充（删除等破坏性确认）
// size: sm = 行内小按钮；md = 表单/底栏默认

type Variant = "primary" | "secondary" | "ghost" | "danger";
type Size = "sm" | "md";

const VARIANT: Record<Variant, string> = {
  primary:
    "bg-accent hover:bg-accent-strong text-ink-inverse font-medium",
  secondary:
    "border border-line-strong bg-surface text-ink-muted hover:text-ink-strong hover:bg-surface-muted",
  ghost: "text-ink-muted hover:text-ink-strong hover:bg-surface-muted",
  danger: "bg-danger hover:bg-danger-strong text-ink-inverse font-medium",
};

const SIZE: Record<Size, string> = {
  sm: "px-2.5 py-1 text-ui rounded-md",
  md: "px-4 py-1.5 text-sm rounded-field",
};

export function Button({
  variant = "secondary",
  size = "md",
  loading = false,
  className = "",
  disabled,
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
  loading?: boolean;
}) {
  return (
    <button
      disabled={disabled || loading}
      className={`inline-flex items-center justify-center gap-1.5 transition-colors active:scale-[0.98] disabled:opacity-40 disabled:cursor-not-allowed disabled:active:scale-100 ${VARIANT[variant]} ${SIZE[size]} ${className}`}
      {...rest}
    >
      {loading && (
        <span className="trellis-dots" aria-hidden>
          <span />
          <span />
          <span />
        </span>
      )}
      {children}
    </button>
  );
}
