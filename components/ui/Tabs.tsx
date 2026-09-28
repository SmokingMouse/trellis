"use client";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import type { LucideIcon } from "lucide-react";
import { useRef, type ComponentProps, type KeyboardEvent, type ReactNode } from "react";
import { cn } from "./cn";
import { Icon } from "./Icon";

// ── Tabs（Radix）：切换「同一位置的不同面板」，有 TabsContent。
// 视觉是下划线式：选中项 ink + 2px accent 底线，其余 ink-muted。
export const Tabs = TabsPrimitive.Root;

export function TabsList({ className, ...rest }: ComponentProps<typeof TabsPrimitive.List>) {
  return (
    <TabsPrimitive.List
      className={cn("flex items-center gap-4 border-b border-line", className)}
      {...rest}
    />
  );
}

export function TabsTrigger({ className, ...rest }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return (
    <TabsPrimitive.Trigger
      className={cn(
        "relative -mb-px inline-flex min-h-8 items-center gap-1.5 border-b-2 border-transparent px-0.5 text-ui text-ink-muted transition-colors duration-100 hover:text-ink data-[state=active]:border-accent data-[state=active]:text-ink disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-11",
        className,
      )}
      {...rest}
    />
  );
}

export function TabsContent({ className, ...rest }: ComponentProps<typeof TabsPrimitive.Content>) {
  return <TabsPrimitive.Content className={cn("outline-none", className)} {...rest} />;
}

// ── SegmentedControl：同一份数据的几种视图 / 排序（侧栏「按项目 / 按时间」），
// 没有对应面板，所以不走 Tabs，语义是 radiogroup。方向键在选项间移动并选中。
export type SegmentOption<T extends string = string> = {
  value: T;
  label: ReactNode;
  icon?: LucideIcon;
  /** 只显示图标时的名字（同时作 aria-label / title） */
  title?: string;
  disabled?: boolean;
};

const SEG_SIZE = {
  sm: "min-h-5.5 px-2 text-label",
  md: "min-h-6.5 px-2.5 text-ui",
} as const;

export function SegmentedControl<T extends string = string>({
  value,
  onValueChange,
  options,
  size = "md",
  fullWidth = false,
  className,
  "aria-label": ariaLabel,
}: {
  value: T;
  onValueChange: (value: T) => void;
  options: ReadonlyArray<SegmentOption<T>>;
  size?: keyof typeof SEG_SIZE;
  fullWidth?: boolean;
  className?: string;
  "aria-label": string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step =
      e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const enabled = options.filter((o) => !o.disabled);
    const cur = enabled.findIndex((o) => o.value === value);
    const next = enabled[(cur + step + enabled.length) % enabled.length];
    if (!next) return;
    onValueChange(next.value);
    ref.current
      ?.querySelector<HTMLButtonElement>(`[data-value="${CSS.escape(next.value)}"]`)
      ?.focus();
  };
  return (
    <div
      ref={ref}
      role="radiogroup"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        "inline-flex items-center gap-0.5 rounded-field bg-surface-muted p-0.5",
        fullWidth && "flex w-full",
        className,
      )}
    >
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={o.title}
            title={o.title}
            data-value={o.value}
            data-state={selected ? "on" : "off"}
            tabIndex={selected ? 0 : -1}
            disabled={o.disabled}
            onClick={() => onValueChange(o.value)}
            className={cn(
              "inline-flex items-center justify-center gap-1.5 rounded-sm text-ink-muted transition-colors duration-100 hover:text-ink disabled:cursor-not-allowed disabled:opacity-45 max-md:min-h-11",
              SEG_SIZE[size],
              fullWidth && "flex-1",
              selected && "bg-surface text-ink ring-1 ring-line",
            )}
          >
            {o.icon && <Icon icon={o.icon} size="sm" selected={selected} />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
