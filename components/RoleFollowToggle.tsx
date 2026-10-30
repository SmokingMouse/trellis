"use client";
import { useEffect, useState } from "react";
import { Switch, cn, toast } from "@/components/ui";
import type { RoleFollowStatus } from "@/lib/role-follow";

// 「跟进我的会话」开关（docs/roles-p2.md C / P4）：自包含，拉 / 写 /api/roles/[id]/follow。
// 设置页「例行」tab（包 A）和一览底部都挂这一个组件。全局只能一个角色开着：
// 别的角色开着时提示「现在由 X 跟进」，打开就接过来。

export function RoleFollowToggle({ roleId, roleName, className }: { roleId: string; roleName: string; className?: string }) {
  const [status, setStatus] = useState<RoleFollowStatus | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch(`/api/roles/${encodeURIComponent(roleId)}/follow`, { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<RoleFollowStatus>) : null))
      .then((s) => {
        if (alive && s) setStatus(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [roleId]);

  const toggle = async (enabled: boolean) => {
    setSaving(true);
    try {
      const r = await fetch(`/api/roles/${encodeURIComponent(roleId)}/follow`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const d = (await r.json().catch(() => ({}))) as RoleFollowStatus & { error?: string };
      if (!r.ok) throw new Error(d.error ?? `HTTP ${r.status}`);
      setStatus(d);
    } catch (e) {
      toast.error(`没能${enabled ? "打开" : "关掉"}跟进：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setSaving(false);
    }
  };

  const other = status && !status.enabled && status.activeRoleId ? status.activeRoleName : null;
  return (
    <label
      data-role-follow-toggle={roleId}
      className={cn("flex cursor-pointer items-start gap-2.5", (!status || saving) && "cursor-progress", className)}
    >
      <Switch
        checked={status?.enabled ?? false}
        disabled={!status || saving}
        onCheckedChange={(v) => void toggle(v)}
        aria-label="跟进我的会话"
        className="mt-0.5"
      />
      <span className="min-w-0 flex-1">
        <span className="block text-ui text-ink">跟进我的会话</span>
        <span className="block text-label leading-snug text-ink-muted">
          {status?.enabled
            ? `每 15 分钟看一眼；有会话新进入等你 / 卡住（${status.staleMinutes} 分钟没输出）/ 失败 / 完成，${roleName}才在这里出声`
            : other
              ? `现在由「${other}」跟进，打开就换成${roleName}`
              : "每 15 分钟看一眼你的会话，有新的等你 / 卡住 / 失败 / 完成才出声；同时只能一个角色开"}
        </span>
      </span>
    </label>
  );
}
