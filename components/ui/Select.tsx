"use client";
import * as SelectPrimitive from "@radix-ui/react-select";
import { Check, ChevronDown } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { useLayerContainer } from "./Layer";

// 下拉选择（Radix Select）。两种用法：
//
// 1) 简单：<Select value={v} onValueChange={setV} options={[{ value, label }]} />
// 2) 组合：SelectRoot / SelectTrigger / SelectContent / SelectItem / SelectGroup /
//    SelectLabel / SelectSeparator 自己拼（分组、带描述的选项）。
//
// 注意：Radix 不允许 value 为空串 —— 「不选 / 默认」请用 "default" 之类的哨兵值。
// 原生 <select> 仍可在手机端极简场景使用，但新代码优先用本原语。

export const SelectRoot = SelectPrimitive.Root;
export const SelectGroup = SelectPrimitive.Group;
export const SelectValue = SelectPrimitive.Value;

const TRIGGER_SIZE = { sm: "min-h-6.5 px-2 text-label", md: "min-h-8 px-2.5 text-ui" } as const;

export function SelectTrigger({
  size = "md",
  className,
  children,
  ...rest
}: ComponentProps<typeof SelectPrimitive.Trigger> & { size?: keyof typeof TRIGGER_SIZE }) {
  return (
    <SelectPrimitive.Trigger
      className={cn(
        "inline-flex w-full min-w-0 items-center justify-between gap-2 rounded-field border border-line-strong bg-surface text-ink transition-colors duration-100 hover:bg-surface-hover outline-none focus-visible:outline-none focus:border-accent-line focus:ring-2 focus:ring-focus-ring data-[placeholder]:text-ink-faint disabled:cursor-not-allowed disabled:opacity-50 max-md:min-h-11",
        TRIGGER_SIZE[size],
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 truncate text-left">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDown size={14} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

export function SelectContent({
  className,
  children,
  position = "popper",
  ...rest
}: ComponentProps<typeof SelectPrimitive.Content>) {
  const container = useLayerContainer();
  return (
    <SelectPrimitive.Portal container={container}>
      <SelectPrimitive.Content
        position={position}
        sideOffset={4}
        collisionPadding={8}
        className={cn(
          "ui-layer z-50 min-w-(--radix-select-trigger-width) max-h-(--radix-select-content-available-height) overflow-hidden rounded-overlay border border-line bg-surface-raised text-ui text-ink shadow-pop",
          className,
        )}
        {...rest}
      >
        <SelectPrimitive.Viewport className="p-1">{children}</SelectPrimitive.Viewport>
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

export function SelectItem({
  className,
  children,
  description,
  ...rest
}: ComponentProps<typeof SelectPrimitive.Item> & { description?: ReactNode }) {
  return (
    <SelectPrimitive.Item
      className={cn(
        "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md py-1 pl-2 pr-7 outline-none data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45 max-md:min-h-11",
        className,
      )}
      {...rest}
    >
      <span className="min-w-0 flex-1">
        <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
        {description && <span className="block text-label text-ink-faint">{description}</span>}
      </span>
      <SelectPrimitive.ItemIndicator className="absolute right-2 inline-flex text-accent-ink">
        <Check size={14} strokeWidth={2} />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

export function SelectLabel({ className, ...rest }: ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      className={cn("px-2 pb-1 pt-1.5 text-label text-ink-faint", className)}
      {...rest}
    />
  );
}

export function SelectSeparator({ className, ...rest }: ComponentProps<typeof SelectPrimitive.Separator>) {
  return <SelectPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...rest} />;
}

export type SelectOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
};

export function Select<T extends string = string>({
  value,
  defaultValue,
  onValueChange,
  options,
  placeholder,
  size = "md",
  disabled,
  name,
  id,
  className,
  contentClassName,
  "aria-label": ariaLabel,
}: {
  value?: T;
  defaultValue?: T;
  onValueChange?: (value: T) => void;
  options: ReadonlyArray<SelectOption<T>>;
  placeholder?: string;
  size?: keyof typeof TRIGGER_SIZE;
  disabled?: boolean;
  name?: string;
  id?: string;
  className?: string;
  contentClassName?: string;
  "aria-label"?: string;
}) {
  return (
    <SelectRoot
      value={value}
      defaultValue={defaultValue}
      onValueChange={onValueChange as ((v: string) => void) | undefined}
      disabled={disabled}
      name={name}
    >
      <SelectTrigger id={id} size={size} aria-label={ariaLabel} className={className}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className={contentClassName}>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value} disabled={o.disabled} description={o.description}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </SelectRoot>
  );
}
