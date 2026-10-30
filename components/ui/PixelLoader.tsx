import { cn } from "./cn";

// 像素格 loader（beautifului.dev Loading State · Drive，MIT）：3×3 方格，
// 斜向波前 650ms 一圈，比扫描周期短，所以总有两道波前在走。
// 样式在 globals.css .ui-pixels；reduced-motion 下定格为半透明。
// 用在「长时间运行」的语境（正在运行卡、运行中的轮次、任务行）；
// 按钮里的短加载仍用 Spinner。

// 每格的波前序号：左上 → 右下的斜向距离
const WAVE = [0, 1, 2, 1, 2, 3, 2, 3, 4];

export function PixelLoader({
  size = "md",
  round = false,
  label = "运行中",
  className,
}: {
  size?: "sm" | "md";
  /** 圆点格（bui Dots 变体） */
  round?: boolean;
  /** 读屏文案；旁边已有同义文字时传 null */
  label?: string | null;
  className?: string;
}) {
  return (
    <span
      role={label ? "status" : undefined}
      aria-label={label ?? undefined}
      aria-hidden={label ? undefined : true}
      data-size={size === "sm" ? "sm" : undefined}
      data-round={round || undefined}
      className={cn("ui-pixels text-ink", className)}
    >
      {WAVE.map((d, i) => (
        <i key={i} style={{ animationDelay: `${d * 90}ms` }} />
      ))}
    </span>
  );
}
