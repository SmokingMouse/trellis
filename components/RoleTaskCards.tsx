"use client";
import { Play } from "lucide-react";
import { Button, Icon, Pill, StatusDot } from "@/components/ui";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import type { RoleBackgroundTask } from "@/lib/role-routines";

// 后台任务卡（原型 s-role 的 .task-card）：角色在这一轮里用 trellisctl ask --new 开的普通会话。
// 挂在开它的那一轮下面；点「打开」进那条会话看全过程。数据由 LinearThreadView 的
// useRoleBackgroundTasks 拉取并在有进行中的任务时轮询。

const EMPTY: RoleBackgroundTask[] = [];

export function bgTaskHref(t: Pick<RoleBackgroundTask, "sessionId" | "nodeId">): string {
  return `/?session=${encodeURIComponent(t.sessionId)}&node=${encodeURIComponent(t.nodeId)}`;
}

export function bgTaskStatusLabel(t: RoleBackgroundTask): string {
  return t.status === "streaming" ? "进行中" : t.status === "error" ? "出错了" : "已完成";
}

function minutes(t: RoleBackgroundTask): string | null {
  return t.durationMs !== null && t.status !== "streaming" ? `用时 ${Math.max(1, Math.round(t.durationMs / 60_000))} 分` : null;
}

/** 「用时 11 分 · 已完成」（一览行用）。 */
export function bgTaskStatusText(t: RoleBackgroundTask): string {
  return [minutes(t), bgTaskStatusLabel(t)].filter(Boolean).join(" · ");
}

export function RoleTaskCards({ roleId, nodeId }: { roleId: string; nodeId: string }) {
  const all = useRoleExtrasStore((s) => s.bgTasks[roleId] ?? EMPTY);
  const mine = all.filter((t) => t.originNodeId === nodeId);
  if (!mine.length) return null;
  return (
    <div data-role-task-cards className="mt-2.5 flex flex-col gap-2">
      {mine.map((t) => (
        <div
          key={t.sessionId}
          data-role-task-card={t.sessionId}
          className="flex max-w-[560px] items-center gap-3 rounded-card bg-surface-raised px-3 py-2.5 shadow-raise"
        >
          <span className="grid size-7.5 shrink-0 place-items-center rounded-field bg-surface-canvas text-ink-muted shadow-hairline">
            <Icon icon={Play} size="sm" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-ui font-medium text-ink">{t.title}</div>
            <div className="text-[11.5px] text-ink-faint">
              {["后台任务", minutes(t), t.turns > 1 ? `${t.turns} 轮` : null].filter(Boolean).join(" · ")}
            </div>
          </div>
          <Pill tone={t.status === "error" ? "danger" : t.status === "streaming" ? "accent" : "positive"} className="shrink-0">
            <StatusDot tone={t.status === "error" ? "danger" : t.status === "streaming" ? "live" : "positive"} />
            {bgTaskStatusLabel(t)}
          </Pill>
          <Button asChild size="sm">
            <a href={bgTaskHref(t)}>打开</a>
          </Button>
        </div>
      ))}
    </div>
  );
}
