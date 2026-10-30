"use client";
import { useEffect, useState } from "react";
import { Clock, Moon, Play, Plus, Trash2, Undo2 } from "lucide-react";
import {
  Button,
  Checkbox,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  Pill,
  SegmentedControl,
  Select,
  Skeleton,
  Switch,
  Textarea,
  toast,
  useConfirm,
} from "@/components/ui";
import { RoleField } from "@/components/RoleFields";
import { useRoleExtrasStore } from "@/stores/roleExtrasStore";
import { useRoleStore } from "@/stores/roleStore";
import type { Role } from "@/lib/roles";
import { ROLE_CHANGE_LABEL, roleChangeTitle, type NightlyFrequency, type RoleNightlyState } from "@/lib/role-changes";
import {
  WEEKDAY_LABEL,
  routineCron,
  type RoleRoutine,
  type RoutineTrigger,
  type RoutineTriggerKind,
} from "@/lib/role-routines";
import { routineSubtitle } from "./RoleGlanceBlocks";

// 角色设置「例行」tab：内置的夜间整理（频率、立即整理、整理历史 + 撤销）+ 这个角色的例行
// （tasks.agent_id = 角色；开关、手动跑、删除、新建）。例行跑出来的结果落进角色的固定会话。

const FREQ_OPTIONS: { value: NightlyFrequency; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekly", label: "每周" },
  { value: "off", label: "关闭" },
];

const TRIGGER_OPTIONS: { value: RoutineTriggerKind; label: string }[] = [
  { value: "daily", label: "每天" },
  { value: "weekdays", label: "工作日" },
  { value: "weekly", label: "每周" },
  { value: "cron", label: "cron" },
];

const STATUS_TEXT: Record<NonNullable<RoleNightlyState["lastStatus"]>, string> = {
  ran: "出了提案",
  empty: "看过了，没什么要改",
  skipped: "跳过",
  error: "失败",
};

function when(ms: number | null): string {
  return ms
    ? new Date(ms).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
    : "";
}

export function RoleRoutinesTab({ role }: { role: Role }) {
  return (
    <div className="flex max-w-[760px] flex-col gap-6">
      <NightlySection role={role} />
      <RoutineList role={role} />
      <NewRoutineForm role={role} />
    </div>
  );
}

function NightlySection({ role }: { role: Role }) {
  const state = useRoleExtrasStore((s) => s.nightly[role.id]);
  const history = useRoleExtrasStore((s) => s.history[role.id] ?? null);
  const { loadNightly, setFrequency, runNightly, loadHistory, act } = useRoleExtrasStore.getState();
  const busy = useRoleExtrasStore((s) => s.busy);

  useEffect(() => {
    void loadNightly(role.id);
    void loadHistory(role.id);
  }, [role.id, loadNightly, loadHistory]);

  const changeFreq = async (f: NightlyFrequency) => {
    const err = await setFrequency(role.id, f);
    if (err) toast.error("没改成", { description: err });
  };
  const runNow = async () => {
    const r = await runNightly(role.id);
    if (typeof r === "string") return toast.error("整理没跑起来", { description: r });
    if (r.status === "ran") toast.success("整理好了", { description: "提案卡已经放进对话里，去逐条确认" });
    else if (r.status === "empty") toast.success("看过了，没什么要改的");
    else if (r.status === "skipped") toast(`跳过：${r.reason ?? ""}`);
    else if (r.status === "busy") toast("正在整理中");
    else toast.error("整理失败", { description: r.error });
    void loadHistory(role.id);
  };
  const revert = async (c: NonNullable<typeof history>[number]) => {
    const err = await act(role.id, c, "revert");
    if (err) toast.error("没能撤销", { description: err });
    else {
      toast.success("已撤销");
      void useRoleStore.getState().loadMemories(role.id);
    }
  };

  return (
    <section className="flex flex-col gap-3" id="nightly">
      <h2 className="flex items-center gap-1.5 text-ui font-semibold text-ink-strong">
        <Icon icon={Moon} size="sm" className="text-fork" />
        夜间整理
      </h2>
      <div className="flex flex-col gap-3 rounded-card bg-surface-raised p-4 shadow-raise">
        <p className="text-label text-ink-muted">
          03:30 回看自上次以来的新对话，提出记忆的新增 / 合并 / 删除和技能，放进对话里一张卡等你确认。没有新对话就跳过、不调模型。
        </p>
        {!role.memoryEnabled && <p className="text-label text-warn-ink">记忆关着，夜间整理不会跑。</p>}
        {!state ? (
          <Skeleton className="h-8 w-1/2" />
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <SegmentedControl
                aria-label="整理频率"
                value={state.frequency}
                onValueChange={(v) => void changeFreq(v)}
                options={FREQ_OPTIONS}
              />
              <span className="flex-1" />
              <Button
                size="sm"
                onClick={() => void runNow()}
                loading={state.running}
                disabled={!role.memoryEnabled || state.running}
                data-role-nightly-run
              >
                <Icon icon={Play} size="sm" />
                立即整理{state.pendingNodes ? `（${state.pendingNodes} 轮新对话）` : ""}
              </Button>
            </div>
            <div className="text-label text-ink-faint">
              {state.lastRunAt
                ? `上次 ${when(state.lastRunAt)} · ${state.lastStatus ? STATUS_TEXT[state.lastStatus] : ""}${
                    state.lastError && state.lastStatus !== "ran" ? `（${state.lastError}）` : ""
                  }`
                : "还没整理过"}
            </div>
          </>
        )}
      </div>

      <h3 className="text-label font-medium text-ink-muted" id="nightly-history">
        整理历史
      </h3>
      {history === null ? (
        <Skeleton className="h-12 w-full" />
      ) : history.length === 0 ? (
        <p className="text-label text-ink-faint">还没有接受过的整理改动。</p>
      ) : (
        <div className="overflow-hidden rounded-card bg-surface-raised shadow-raise">
          {history.map((c) => (
            <div key={c.id} className="flex items-center gap-2.5 px-3.5 py-2 [&+&]:border-t [&+&]:border-line">
              <Pill tone={c.kind === "add" ? "positive" : c.kind === "merge" ? "accent" : c.kind === "skill" ? "fork" : "neutral"}>
                {ROLE_CHANGE_LABEL[c.kind]}
              </Pill>
              <div className="min-w-0 flex-1">
                <div className={`truncate text-ui text-ink ${c.status === "reverted" ? "line-through opacity-60" : ""}`}>
                  {roleChangeTitle(c.payload)}
                </div>
                <div className="text-nano text-ink-faint">
                  {c.status === "reverted" ? `已撤销 · ${when(c.revertedAt)}` : `已接受 · ${when(c.decidedAt)}`}
                </div>
              </div>
              {c.revertible && (
                <Button size="sm" variant="ghost" disabled={!!busy[c.id]} onClick={() => void revert(c)}>
                  <Icon icon={Undo2} size="sm" />
                  撤销
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function RoutineList({ role }: { role: Role }) {
  const routines = useRoleExtrasStore((s) => s.routines[role.id] ?? null);
  const { loadRoutines, updateRoutine, deleteRoutine, runRoutine } = useRoleExtrasStore.getState();
  const confirm = useConfirm();
  useEffect(() => {
    void loadRoutines(role.id);
  }, [role.id, loadRoutines]);

  const toggle = async (r: RoleRoutine, on: boolean) => {
    const err = await updateRoutine(role.id, r.taskId, { enabled: on });
    if (err) toast.error("没改成", { description: err });
  };
  const quiet = async (r: RoleRoutine, on: boolean) => {
    const err = await updateRoutine(role.id, r.taskId, { quiet: on });
    if (err) toast.error("没改成", { description: err });
  };
  const run = async (r: RoleRoutine) => {
    const err = await runRoutine(r.taskId);
    if (err) toast.error("没跑起来", { description: err });
    else toast.success(`「${r.name}」开始跑了`, { description: "结果会出现在和它的对话里" });
  };
  const remove = async (r: RoleRoutine) => {
    const ok = await confirm({
      title: `删除例行「${r.name}」？`,
      description: "之后不会再自动跑；已经跑出来的结果还留在对话里。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    const err = await deleteRoutine(role.id, r.taskId);
    if (err) toast.error("没删掉", { description: err });
  };

  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-1.5 text-ui font-semibold text-ink-strong">
        <Icon icon={Clock} size="sm" className="text-ink-faint" />
        例行
        <span className="text-label font-normal text-ink-faint tabular-nums">{routines?.length ?? ""}</span>
      </h2>
      {routines === null ? (
        <Skeleton className="h-12 w-full" />
      ) : routines.length === 0 ? (
        <p className="text-label text-ink-faint">还没有例行。下面建一个，让它按时做一件事，结果放进和它的对话里。</p>
      ) : (
        <div className="overflow-hidden rounded-card bg-surface-raised shadow-raise" data-role-routines>
          {routines.map((r) => (
            <div key={r.taskId} className="flex items-center gap-3 px-3.5 py-2.5 [&+&]:border-t [&+&]:border-line">
              <div className="min-w-0 flex-1">
                <div className="truncate text-ui font-medium text-ink" title={r.prompt}>
                  {r.name}
                </div>
                <div className="truncate text-label text-ink-muted">
                  {routineSubtitle(r)}
                  {r.lastRun ? ` · 上次 ${when(r.lastRun.at)} ${r.lastRun.status}` : ""}
                </div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-label text-ink-muted max-md:hidden">
                <Checkbox checked={r.quiet} onCheckedChange={(v) => void quiet(r, v === true)} />
                没发现不出声
              </label>
              <IconButton label="现在跑一次" onClick={() => void run(r)} disabled={!r.enabled}>
                <Icon icon={Play} size="sm" />
              </IconButton>
              <IconButton label="删除例行" tone="danger" onClick={() => void remove(r)}>
                <Icon icon={Trash2} size="sm" />
              </IconButton>
              <Switch aria-label={`${r.name} 开关`} checked={r.enabled} onCheckedChange={(v) => void toggle(r, v)} />
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function NewRoutineForm({ role }: { role: Role }) {
  const createRoutine = useRoleExtrasStore((s) => s.createRoutine);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [kind, setKind] = useState<RoutineTriggerKind>("weekdays");
  const [time, setTime] = useState("09:00");
  const [day, setDay] = useState("1");
  const [expr, setExpr] = useState("");
  const [quiet, setQuiet] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const trigger: RoutineTrigger =
    kind === "cron"
      ? { kind, expr }
      : kind === "weekly"
        ? { kind, day: Number(day), time }
        : { kind, time };
  const cron = routineCron(trigger);
  const valid = name.trim() && prompt.trim() && cron;

  const submit = async () => {
    setSaving(true);
    setError(null);
    const r = await createRoutine(role.id, { name: name.trim(), prompt: prompt.trim(), trigger, quiet });
    setSaving(false);
    if (typeof r === "string") return setError(r);
    toast.success(`建好了「${r.name}」`);
    setName("");
    setPrompt("");
  };

  return (
    <form
      className="flex flex-col gap-4 rounded-card bg-surface-raised p-4 shadow-raise"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) void submit();
      }}
      data-role-routine-form
    >
      <h2 className="flex items-center gap-1.5 text-ui font-semibold text-ink-strong">
        <Icon icon={Plus} size="sm" className="text-ink-faint" />
        新建例行
      </h2>
      <RoleField label="名字">
        {({ id }) => (
          <Input id={id} value={name} onChange={(e) => setName(e.target.value)} maxLength={60} placeholder="巡检新合并的 PR" autoComplete="off" />
        )}
      </RoleField>
      <RoleField label="要它做什么" hint="每次触发时原样发给它；别写「每天早上」这类时间词，时间在下面选">
        {({ id, describedBy }) => (
          <Textarea
            id={id}
            aria-describedby={describedBy}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            className="resize-y"
            placeholder="看看今天合进 main 的 PR，有没有能复现的回归。有就列出来，每条带复现步骤。"
          />
        )}
      </RoleField>
      <div className="flex flex-col gap-1">
        <span className="text-ui font-medium text-ink">什么时候</span>
        <div className="flex flex-wrap items-center gap-2">
          <SegmentedControl aria-label="触发方式" value={kind} onValueChange={setKind} options={TRIGGER_OPTIONS} />
          {kind === "weekly" && (
            <Select
              aria-label="星期几"
              value={day}
              onValueChange={setDay}
              className="w-24"
              options={WEEKDAY_LABEL.map((l, i) => ({ value: String(i), label: l }))}
            />
          )}
          {kind === "cron" ? (
            <Input
              aria-label="cron 表达式"
              value={expr}
              onChange={(e) => setExpr(e.target.value)}
              className="w-48 font-mono"
              placeholder="0 9 * * 1-5"
              spellCheck={false}
            />
          ) : (
            <Input aria-label="时间" type="time" value={time} onChange={(e) => setTime(e.target.value)} className="w-32 tabular-nums" />
          )}
        </div>
        {kind === "cron" && expr && !cron && <span className="text-label text-danger-ink">cron 表达式不完整</span>}
      </div>
      <label className="flex cursor-pointer items-start gap-2.5">
        <Checkbox checked={quiet} onCheckedChange={(v) => setQuiet(v === true)} className="mt-0.5" />
        <span className="text-ui text-ink">
          没发现就不出声
          <span className="block text-label text-ink-muted">没有值得说的，这一轮就收起来，不在对话里冒一条「一切正常」</span>
        </span>
      </label>
      {error && <ErrorCallout compact error={error} title="没建成" />}
      <div>
        <Button type="submit" variant="primary" loading={saving} disabled={!valid}>
          建例行
        </Button>
      </div>
    </form>
  );
}
