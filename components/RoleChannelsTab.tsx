"use client";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowUpRight, MessagesSquare, Unlink } from "lucide-react";
import { Button, EmptyState, Icon, Select, Skeleton, toast, useConfirm } from "@/components/ui";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import { roleAvatarBackground, type Role } from "@/lib/roles";
import { botStatusText } from "./RoleGlanceBlocks";

// 角色设置「渠道」tab：把已有的飞书机器人绑给这个角色（lark_bots.agent_id = 角色）。
// 绑上之后飞书里发给这个机器人的消息由角色作答。新建机器人仍在设置 → 飞书机器人。

const NONE = "__none__";

export function RoleChannelsTab({ role }: { role: Role }) {
  const bots = useRoleExtrasStore((s) => s.bots);
  const loadBots = useRoleExtrasStore((s) => s.loadBots);
  const bindBot = useRoleExtrasStore((s) => s.bindBot);
  const confirm = useConfirm();
  const [pick, setPick] = useState(NONE);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void loadBots();
  }, [loadBots]);

  if (bots === null) {
    return (
      <div role="status" aria-label="加载中" className="flex max-w-[760px] flex-col gap-3">
        <Skeleton className="h-14 w-full" />
        <Skeleton className="h-8 w-1/2" />
      </div>
    );
  }

  const mine = bots.filter((b) => b.agentId === role.id);
  const others = bots.filter((b) => b.agentId !== role.id);

  const bind = async () => {
    if (pick === NONE) return;
    const bot = others.find((b) => b.id === pick);
    if (bot?.agentId) {
      const ok = await confirm({
        title: `把「${bot.name}」改绑给${role.name}？`,
        description: "它现在绑着别的 Agent / 角色，改绑后飞书里的消息改由这个角色作答。",
        confirmLabel: "改绑",
      });
      if (!ok) return;
    }
    setBusy(pick);
    const err = await bindBot(pick, role.id);
    setBusy(null);
    if (err) toast.error("绑定失败", { description: err });
    else {
      setPick(NONE);
      toast.success("飞书机器人已绑定");
    }
  };

  const unbind = async (botId: string, name: string) => {
    const ok = await confirm({
      title: `解绑机器人「${name}」？`,
      description: "解绑后这个机器人退回默认助手作答；机器人本身和它的会话都保留，随时可以再绑回来。",
      confirmLabel: "解绑",
      danger: true,
    });
    if (!ok) return;
    setBusy(botId);
    const err = await bindBot(botId, null);
    setBusy(null);
    if (err) toast.error("解绑失败", { description: err });
    else toast.success("已解绑");
  };

  return (
    <div className="flex max-w-[760px] flex-col gap-5">
      <p className="text-label text-ink-muted">
        绑上的飞书机器人收到消息时，由{role.name}用它的人设、记忆和模型作答。
      </p>

      {mine.length === 0 ? (
        <EmptyState
          icon={MessagesSquare}
          title="还没绑飞书机器人"
          description="从下面选一个已经接入的机器人绑给它。"
          className="rounded-card bg-surface-raised shadow-raise"
        />
      ) : (
        <div className="overflow-hidden rounded-card bg-surface-raised shadow-raise" data-role-channels>
          {mine.map((b) => (
            <div key={b.id} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:border-t [&+&]:border-line">
              <span
                aria-hidden
                className="grid size-7 shrink-0 place-items-center rounded-full text-label font-semibold text-ink-inverse"
                style={{ background: roleAvatarBackground(200) }}
              >
                飞
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui font-medium text-ink">飞书机器人「{b.name}」</div>
                <div className="truncate text-label text-ink-muted">{botStatusText(b)}</div>
              </div>
              <Button size="sm" variant="ghost" loading={busy === b.id} onClick={() => void unbind(b.id, b.name)}>
                <Icon icon={Unlink} size="sm" />
                解绑
              </Button>
            </div>
          ))}
        </div>
      )}

      <section className="flex flex-col gap-2 rounded-card bg-surface-raised p-4 shadow-raise">
        <h2 className="text-ui font-semibold text-ink-strong">绑一个机器人</h2>
        {others.length === 0 ? (
          <p className="text-label text-ink-muted">没有别的机器人可绑了。</p>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            <Select
              aria-label="选择飞书机器人"
              value={pick}
              onValueChange={setPick}
              className="min-w-60"
              options={[
                { value: NONE, label: "选择机器人", disabled: true },
                ...others.map((b) => ({
                  value: b.id,
                  label: b.name,
                  description: b.agentId ? "现在绑着别的 Agent / 角色" : "未绑定",
                })),
              ]}
            />
            <Button variant="primary" disabled={pick === NONE} loading={busy === pick} onClick={() => void bind()}>
              绑定
            </Button>
          </div>
        )}
        <Link
          href="/settings/bots"
          className="inline-flex items-center gap-1 self-start text-label text-ink-muted hover:text-ink"
        >
          新接入一个飞书机器人
          <Icon icon={ArrowUpRight} size="sm" />
        </Link>
      </section>
    </div>
  );
}
