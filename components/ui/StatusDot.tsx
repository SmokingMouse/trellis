import { cn } from "./cn";

// 6px 状态圆点——状态色在界面上的主要出场方式（另一种是 Badge 的细描边）。
// live = accent 呼吸（运行中）；idle = 空心灰圈（未开始 / 离线）。
// 圆点本身不带文字，必须配文字或传 label（读屏）。

export type StatusTone =
  | "neutral"
  | "accent"
  | "positive"
  | "warn"
  | "danger"
  | "unread"
  | "fork"
  | "project"
  | "chat"
  | "idle"
  | "live";

const TONE: Record<StatusTone, string> = {
  neutral: "bg-ink-faint",
  accent: "bg-accent",
  positive: "bg-positive",
  warn: "bg-warn",
  danger: "bg-danger",
  unread: "bg-unread",
  fork: "bg-fork",
  project: "bg-mode-project",
  chat: "bg-mode-chat",
  idle: "bg-transparent ring-1 ring-inset ring-ink-faint",
  live: "bg-accent animate-pulse motion-reduce:animate-none",
};

export function StatusDot({
  tone = "neutral",
  label,
  className,
}: {
  tone?: StatusTone;
  /** 读屏文案；旁边已有同义文字时省略 */
  label?: string;
  className?: string;
}) {
  return (
    <span
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      className={cn("inline-block size-1.5 shrink-0 rounded-full", TONE[tone], className)}
    />
  );
}
