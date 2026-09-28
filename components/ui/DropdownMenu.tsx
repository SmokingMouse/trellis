"use client";
import * as MenuPrimitive from "@radix-ui/react-dropdown-menu";
import { Check, ChevronRight, Dot } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";
import { useLayerContainer } from "./Layer";

// 下拉菜单（Radix DropdownMenu）：点一个按钮弹出「动作列表」。
// 与 Popover 的分工：菜单项是动作 / 单选 / 多选 → DropdownMenu（自带方向键、
// typeahead、roving focus）；面板里是表单 / 搜索 / 自由内容 → Popover。
// 右键 / 长按菜单仍用 ContextMenu。
//
// 默认 modal={false}：打开时外面照样能点（点别的按钮一次就切过去），和
// Popover / ContextMenu 手感一致。

export function DropdownMenu({ modal = false, ...rest }: ComponentProps<typeof MenuPrimitive.Root>) {
  return <MenuPrimitive.Root modal={modal} {...rest} />;
}
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;
export const DropdownMenuSub = MenuPrimitive.Sub;

const PANEL =
  "ui-layer z-50 min-w-40 overflow-hidden rounded-overlay border border-line bg-surface-raised p-1 text-ui text-ink shadow-pop outline-none";

export function DropdownMenuContent({
  className,
  sideOffset = 6,
  align = "start",
  ...rest
}: ComponentProps<typeof MenuPrimitive.Content>) {
  const container = useLayerContainer();
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.Content
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={cn(PANEL, className)}
        {...rest}
      />
    </MenuPrimitive.Portal>
  );
}

const ITEM =
  "relative flex min-h-8 cursor-default select-none items-center gap-2 rounded-md px-2 outline-none data-[highlighted]:bg-surface-hover data-[disabled]:pointer-events-none data-[disabled]:opacity-45 max-md:min-h-11";

export function DropdownMenuItem({
  className,
  icon,
  shortcut,
  danger = false,
  children,
  ...rest
}: ComponentProps<typeof MenuPrimitive.Item> & {
  /** 左侧图标（lucide 组件实例，建议 size 16） */
  icon?: ReactNode;
  /** 右侧灰字：快捷键或补充说明 */
  shortcut?: ReactNode;
  danger?: boolean;
}) {
  return (
    <MenuPrimitive.Item
      className={cn(ITEM, danger ? "text-danger-ink" : "text-ink", className)}
      {...rest}
    >
      {icon && (
        <span className={cn("inline-flex shrink-0", danger ? "text-danger-ink" : "text-ink-muted")}>
          {icon}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut && <span className="shrink-0 text-label text-ink-faint">{shortcut}</span>}
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(ITEM, "pl-7", className)} {...rest}>
      <MenuPrimitive.ItemIndicator className="absolute left-2 inline-flex text-accent-ink">
        <Check size={14} strokeWidth={2} />
      </MenuPrimitive.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...rest
}: ComponentProps<typeof MenuPrimitive.RadioItem>) {
  return (
    <MenuPrimitive.RadioItem className={cn(ITEM, "pl-7", className)} {...rest}>
      <MenuPrimitive.ItemIndicator className="absolute left-1 inline-flex text-accent-ink">
        <Dot size={22} strokeWidth={4} />
      </MenuPrimitive.ItemIndicator>
      <span className="min-w-0 flex-1 truncate">{children}</span>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({ className, ...rest }: ComponentProps<typeof MenuPrimitive.Label>) {
  return (
    <MenuPrimitive.Label className={cn("px-2 pb-1 pt-1.5 text-label text-ink-faint", className)} {...rest} />
  );
}

export function DropdownMenuSeparator({
  className,
  ...rest
}: ComponentProps<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn("-mx-1 my-1 h-px bg-line", className)} {...rest} />;
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...rest
}: ComponentProps<typeof MenuPrimitive.SubTrigger>) {
  return (
    <MenuPrimitive.SubTrigger
      className={cn(ITEM, "data-[state=open]:bg-surface-hover", className)}
      {...rest}
    >
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight size={14} strokeWidth={1.75} className="shrink-0 text-ink-faint" />
    </MenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...rest
}: ComponentProps<typeof MenuPrimitive.SubContent>) {
  const container = useLayerContainer();
  return (
    <MenuPrimitive.Portal container={container}>
      <MenuPrimitive.SubContent collisionPadding={8} className={cn(PANEL, className)} {...rest} />
    </MenuPrimitive.Portal>
  );
}
