"use client";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import { Check, Minus } from "lucide-react";
import type { ComponentProps } from "react";
import { cn } from "./cn";

// 复选框（Radix）。checked 可为 "indeterminate"（批量选择的半选态）。
// 文字标签用外层 <label> 包住即可点选；手机端热区同 Switch 用伪元素撑大。
export function Checkbox({ className, ...rest }: ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      className={cn(
        "peer relative inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-line-strong bg-surface text-accent-fg transition-colors duration-100 data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent disabled:cursor-not-allowed disabled:opacity-45 max-md:after:absolute max-md:after:-inset-3.5",
        className,
      )}
      {...rest}
    >
      <CheckboxPrimitive.Indicator className="group flex items-center justify-center">
        <Check size={12} strokeWidth={2.5} className="group-data-[state=indeterminate]:hidden" />
        <Minus size={12} strokeWidth={2.5} className="hidden group-data-[state=indeterminate]:block" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}
