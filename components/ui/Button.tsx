"use client";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ComponentProps } from "react";
import { cn } from "./cn";
import { Spinner } from "./Spinner";

// 全局按钮原语（W2 重做，docs/ui-redesign/primitives.md）。
//
// variant:
//   primary      — accent 实色（发送 / 提交 / 确认），一屏最多一个
//   secondary    — 描边 + surface（次要动作，默认）
//   ghost        — 无框（取消 / 工具条里的低调动作）
//   danger       — 描边红字（删除入口 / 破坏性动作的第一步）
//   danger-solid — 实心红：只给 ConfirmDialog 的最终确认按钮
//   link         — 行内文字链接样式
// size: sm = 26px（表格行内次级）· md = 32px（默认，全站控件基线）· icon = 32px 方块
//
// 高度用 min-h 而不是 h：调用方加 py / h-11 放大时不会被夹住。
// 手机端（max-md）统一 ≥44px 热区，mobile-verify 依赖它。
// 不再有 active:scale 按压缩放——克制工具风只用颜色反馈。

export const buttonVariants = cva(
  "inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-field font-medium select-none transition-colors duration-100 disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-11 max-md:min-w-11",
  {
    variants: {
      variant: {
        primary: "bg-accent text-accent-fg hover:bg-accent-strong",
        secondary: "border border-line-strong bg-surface text-ink hover:bg-surface-hover",
        ghost: "text-ink-muted hover:bg-surface-hover hover:text-ink",
        danger: "border border-danger-line text-danger-ink hover:bg-danger-muted",
        "danger-solid": "bg-danger text-accent-fg hover:bg-danger-strong",
        link: "text-accent-ink underline-offset-2 hover:underline",
      },
      size: {
        sm: "min-h-6.5 px-2 text-label",
        md: "min-h-8 px-3 text-ui",
        icon: "min-h-8 min-w-8 px-0 text-ui",
      },
    },
    compoundVariants: [
      // link 不占控件高度，贴着文字走
      { variant: "link", className: "min-h-0 px-0 max-md:min-h-0 max-md:min-w-0" },
    ],
    defaultVariants: { variant: "secondary", size: "md" },
  },
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>["variant"]>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>["size"]>;

export type ButtonProps = ComponentProps<"button"> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** 进行中：显示 Spinner 并禁用；文字保持不变（别改成「加载中…」） */
  loading?: boolean;
  /** 把样式套到唯一子元素上（如 <a> / next/link），Radix Slot */
  asChild?: boolean;
};

export function Button({
  variant,
  size,
  loading = false,
  asChild = false,
  className,
  disabled,
  children,
  ...rest
}: ButtonProps) {
  const cls = cn(buttonVariants({ variant, size }), className);
  if (asChild) {
    return (
      <Slot className={cls} aria-disabled={disabled || undefined} {...rest}>
        {children}
      </Slot>
    );
  }
  return (
    <button
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cls}
      {...rest}
    >
      {loading && <Spinner size="sm" label={null} className="text-current" />}
      {children}
    </button>
  );
}
