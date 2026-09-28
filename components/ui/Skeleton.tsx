import { cn } from "./cn";

// 骨架占位：列表 / 卡片首次加载时用，代替「加载中…」文字和各种手写 pulse。
// 尺寸由调用方给（h-4 w-32 …）；多行文字用 SkeletonText。
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cn("ui-skeleton rounded-md", className)} />;
}

export function SkeletonText({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div role="status" aria-label="加载中" className={cn("flex flex-col gap-2", className)}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-3.5", i === lines - 1 && lines > 1 ? "w-3/5" : "w-full")} />
      ))}
    </div>
  );
}
