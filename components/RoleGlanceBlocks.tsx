"use client";
import { useEffect } from "react";
import { ChevronRight, Clock, Link2, Play } from "lucide-react";
import { Icon, Skeleton, Switch, toast } from "@/components/ui";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import { roleAvatarBackground, type Role } from "@/lib/roles";
import { NIGHTLY_FREQUENCY_LABEL } from "@/lib/role-changes";
import { describeRoutineCron, type RoleBackgroundTask, type RoleRoutine } from "@/lib/role-routines";
import { dayDividerLabel } from "@/lib/role-timeline";
import type { LarkBot } from "@/lib/lark-types";
import { bgTaskHref, bgTaskStatusText } from "./RoleTaskCards";

// 一览面板 P2 的三块（原型 s-role .glance 的 例行 / 渠道 / 后台任务）。Section 外壳由
// RoleGlancePanel 传进来，这里只管数据与行。

type SectionComp = (p: {
  icon: typeof Clock;
  title: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) => React.ReactNode;

const ROW = "flex items-center gap-2.5 px-3 py-2 text-ui text-ink [&+&]:border-t [&+&]:border-line";
const EMPTY_ROUTINES: RoleRoutine[] = [];
const EMPTY_TASKS: RoleBackgroundTask[] = [];

export function routineSubtitle(r: RoleRoutine): string {
  const when = r.cron ? describeRoutineCron(r.cron) : "只能手动跑";
  return r.quiet ? `${when} · 没发现就不出声` : when;
}

export function botStatusText(b: LarkBot): string {
  const conn = !b.enabled ? "已停用" : b.lastError ? "连接出错" : b.lastConnectedAt ? "已连接" : "未连接";
  const trig = b.groupTrigger === "mention" ? "群里 @ 才回" : b.groupTrigger === "all" ? "群里每条都回" : `群里以 ${b.triggerPrefix ?? "前缀"} 开头才回`;
  return `${conn} · ${trig}`;
}

export function RoleGlanceBlocks({ role, Section, settingsHref }: { role: Role; Section: SectionComp; settingsHref: (tab: string) => string }) {
  const nightly = useRoleExtrasStore((s) => s.nightly[role.id]);
  const routines = useRoleExtrasStore((s) => s.routines[role.id] ?? null);
  const bots = useRoleExtrasStore((s) => s.bots);
  const tasks = useRoleExtrasStore((s) => s.bgTasks[role.id] ?? EMPTY_TASKS);
  const { loadNightly, loadRoutines, loadBots, setFrequency, updateRoutine } = useRoleExtrasStore.getState();

  useEffect(() => {
    void loadNightly(role.id);
    void loadRoutines(role.id);
    void loadBots();
  }, [role.id, loadNightly, loadRoutines, loadBots]);

  const mine = bots?.filter((b) => b.agentId === role.id) ?? null;
  const toggleNightly = async (on: boolean) => {
    const err = await setFrequency(role.id, on ? "daily" : "off");
    if (err) toast.error("没改成", { description: err });
  };
  const toggleRoutine = async (r: RoleRoutine, on: boolean) => {
    const err = await updateRoutine(role.id, r.taskId, { enabled: on });
    if (err) toast.error("没改成", { description: err });
  };

  return (
    <>
      <Section
        icon={Clock}
        title="例行"
        action={
          <a href={settingsHref("routines")} className="text-label text-ink-faint hover:text-ink">
            管理
          </a>
        }
      >
        <div data-role-glance-routines>
          <div className={ROW}>
            <div className="min-w-0 flex-1">
              <div className="truncate">夜间整理</div>
              <div className="truncate text-nano text-ink-faint">
                {!nightly
                  ? "…"
                  : nightly.frequency === "off"
                    ? "已关闭"
                    : `${NIGHTLY_FREQUENCY_LABEL[nightly.frequency]} · 没新对话就跳过`}
              </div>
            </div>
            <Switch
              aria-label="夜间整理"
              checked={nightly ? nightly.frequency !== "off" : false}
              disabled={!nightly || !role.memoryEnabled}
              onCheckedChange={(v) => void toggleNightly(v)}
            />
          </div>
          {routines === null ? (
            <div className={ROW}>
              <Skeleton className="h-3 w-full" />
            </div>
          ) : (
            (routines ?? EMPTY_ROUTINES).map((r) => (
              <div key={r.taskId} className={ROW}>
                <div className="min-w-0 flex-1">
                  <div className="truncate" title={r.prompt}>
                    {r.name}
                  </div>
                  <div className="truncate text-nano text-ink-faint">{routineSubtitle(r)}</div>
                </div>
                <Switch aria-label={r.name} checked={r.enabled} onCheckedChange={(v) => void toggleRoutine(r, v)} />
              </div>
            ))
          )}
        </div>
      </Section>

      <Section
        icon={Link2}
        title="渠道"
        action={
          <a href={settingsHref("channels")} className="text-label text-ink-faint hover:text-ink">
            管理
          </a>
        }
      >
        <div data-role-glance-channels>
          {mine === null ? (
            <div className={ROW}>
              <Skeleton className="h-3 w-full" />
            </div>
          ) : mine.length === 0 ? (
            <div className="px-3 py-2.5 text-label text-ink-faint">还没绑飞书机器人，在「管理」里绑一个，就能在飞书里找它</div>
          ) : (
            mine.map((b) => (
              <div key={b.id} className={ROW}>
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full text-[10px] font-semibold text-ink-inverse"
                  style={{ background: roleAvatarBackground(200) }}
                >
                  飞
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate">飞书机器人「{b.name}」</div>
                  <div className="truncate text-nano text-ink-faint">{botStatusText(b)}</div>
                </div>
              </div>
            ))
          )}
        </div>
      </Section>

      <Section icon={Play} title="后台任务">
        <div data-role-glance-tasks>
          {tasks.length === 0 ? (
            <div className="px-3 py-2.5 text-label text-ink-faint">大活它会开后台任务慢慢跑，开过的列在这里</div>
          ) : (
            tasks.slice(0, 5).map((t) => (
              <a
                key={t.sessionId}
                href={bgTaskHref(t)}
                className={`${ROW} transition-colors duration-100 hover:bg-surface-hover`}
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate">{t.title}</div>
                  <div className="truncate text-nano text-ink-faint">
                    {dayDividerLabel(t.createdAt)} · {bgTaskStatusText(t)}
                  </div>
                </div>
                <Icon icon={ChevronRight} size="sm" className="shrink-0 text-ink-faint" />
              </a>
            ))
          )}
        </div>
      </Section>
    </>
  );
}
