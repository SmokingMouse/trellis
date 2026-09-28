import type { HTMLAttributes } from "react";
import { cn } from "./cn";

// 键帽：快捷键提示（Tooltip / 菜单项右侧 / KeyboardHelp）。一个键一个 Kbd，
// 组合键写成 <Kbd>⌘</Kbd><Kbd>K</Kbd> 或 keys={["⌘", "K"]}。
export function Kbd({
  keys,
  className,
  children,
  ...rest
}: HTMLAttributes<HTMLElement> & { keys?: string[] }) {
  if (keys && keys.length > 0) {
    return (
      <span className={cn("inline-flex items-center gap-0.5", className)} {...rest}>
        {keys.map((k, i) => (
          <Kbd key={`${k}-${i}`}>{k}</Kbd>
        ))}
      </span>
    );
  }
  return (
    <kbd
      className={cn(
        "inline-flex h-4.5 min-w-4.5 items-center justify-center rounded-sm border border-line bg-surface px-1 font-mono text-nano leading-none text-ink-faint",
        className,
      )}
      {...rest}
    >
      {children}
    </kbd>
  );
}
