import { LoaderCircle } from "lucide-react";
import { cn } from "./cn";
import { ICON_SIZE, type IconSize } from "./Icon";

// 全站唯一的「加载中」转圈。别再手写 animate-spin 的 svg / 边框环 / 「加载中…」
// 纯文字。流式生成的三点跳动是另一种语义，仍用 Dots。
export function Spinner({
  size = "md",
  label = "加载中",
  className,
}: {
  size?: IconSize;
  /** 读屏文案；装饰性（旁边已有文字）时传 null */
  label?: string | null;
  className?: string;
}) {
  return (
    <LoaderCircle
      size={ICON_SIZE[size]}
      strokeWidth={2}
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      className={cn("shrink-0 animate-spin text-ink-faint motion-reduce:animate-none", className)}
    />
  );
}
