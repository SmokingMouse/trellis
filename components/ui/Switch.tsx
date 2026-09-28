"use client";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import type { ComponentProps } from "react";
import { cn } from "./cn";

// 开关（Radix）：即时生效的布尔设置。需要「保存」才生效的表单项用 Checkbox。
// 视觉 32×18；手机端用 after 伪元素把热区撑到 ≥44px，不改视觉尺寸。
export function Switch({ className, ...rest }: ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root
      className={cn(
        "relative inline-flex h-4.5 w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-line-strong transition-colors duration-100 data-[state=checked]:bg-accent disabled:cursor-not-allowed disabled:opacity-45 max-md:after:absolute max-md:after:-inset-x-1.5 max-md:after:-inset-y-3.5",
        className,
      )}
      {...rest}
    >
      <SwitchPrimitive.Thumb className="pointer-events-none block size-3.5 translate-x-0.5 rounded-full bg-accent-fg shadow-sm transition-transform duration-100 data-[state=checked]:translate-x-3.5" />
    </SwitchPrimitive.Root>
  );
}
