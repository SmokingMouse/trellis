"use client";
import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  ArrowUpRight,
  CalendarClock,
  Check,
  Clock,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  SkipForward,
  Trash2,
  X,
} from "lucide-react";
import {
  Badge,
  Button,
  Checkbox,
  EmptyState,
  ErrorCallout,
  Icon,
  IconButton,
  Input,
  PageHeader,
  Select,
  Skeleton,
  StatusDot as UiStatusDot,
  Textarea,
  Tooltip,
  cn,
  toast,
  useConfirm,
} from "@/components/ui";
import { describeCron, nextFireAfter, parseCron } from "@/lib/cron";
import { WorkspaceField } from "@/components/run-config/WorkspaceField";
import { AGENT_DEFAULT_LABEL, contextModeOptions, workspaceRequired } from "@/lib/run-config";
import { DEFAULT_PROVIDER } from "@/lib/llm";

// 任务没有服务商（provider）选择器（tasks.model 那一列存的其实是 providerId，且没有 UI ——
// 见 console-ia-spec.md 批 6.1）。所以模式文案按默认 provider 取；等 tasks 真的能选
// provider 时，这里改成跟着任务的那一个。
const MODE_OPTIONS = contextModeOptions(DEFAULT_PROVIDER);

// S88: 自动化任务页。双栏 —— 左任务列表、右选中任务的详情 + 运行历史。
//
// 状态刻意**不进 stores/sessionStore.ts**（已 3000+ 行，且这是独立路由、独立数据）。
// 用页面本地 state + 自轮询，照 app/settings/page.tsx 的既有模式：有活时快、平时慢。
//
// 点一条 run → 深链回主 SPA 的那个节点。任务层因此不写一行渲染代码：用户看到的
// 是和自己手动提问完全一样的界面，还能就地分叉追问。

type Trigger = {
  id: string;
  kind: string;
  enabled: boolean;
  config: Record<string, unknown>;
};
type Run = {
  id: string;
  status: string;
  sessionId: string | null;
  nodeId: string | null;
  triggerKind: string;
  startedAt: number | null;
  endedAt: number | null;
  errorMessage: string | null;
  tokenInput: number;
  tokenOutput: number;
  createdAt: number;
};
type Task = {
  id: string;
  name: string;
  prompt: string;
  agentId: string | null;
  workspacePath: string | null;
  contextMode: string;
  enabled: boolean;
  notifyOn: string;
  // S89 补齐：以下四项服务端一直支持（lib/server/tasks.ts:34-52），此前只能由 API 改。
  timeoutMs: number;
  overlapPolicy: string;
  maxBudgetUsd: number | null;
  larkBotId: string | null;
  larkChatId: string | null;
  triggers: Trigger[];
  lastRun: Run | null;
};
type Agent = { id: string; name: string; slug: string };
type LarkTarget = {
  botId: string;
  botName: string;
  chatId: string;
  chatType: "p2p" | "group";
  title: string | null;
  workspacePath: string | null;
};

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "每天 09:00", expr: "0 9 * * *" },
  { label: "每个工作日 09:00", expr: "0 9 * * 1-5" },
  { label: "每小时", expr: "0 * * * *" },
  { label: "每 30 分钟", expr: "*/30 * * * *" },
  { label: "每周一 09:00", expr: "0 9 * * 1" },
  { label: "每月 1 号 09:00", expr: "0 9 1 * *" },
];

// Radix Select 不允许空串 value，「默认 Agent」「不落飞书」用哨兵值。
const DEFAULT_AGENT = "__default__";
const NO_LARK = "__none__";

const NOTIFY_OPTIONS = [
  { value: "error", label: "只在失败时" },
  { value: "always", label: "每次都通知" },
  { value: "never", label: "从不" },
];
const TIMEOUT_OPTIONS = [
  { value: String(5 * 60_000), label: "5 分钟" },
  { value: String(15 * 60_000), label: "15 分钟" },
  { value: String(30 * 60_000), label: "30 分钟" },
  { value: String(60 * 60_000), label: "1 小时" },
  { value: String(3 * 60 * 60_000), label: "3 小时" },
];
const OVERLAP_OPTIONS = [
  { value: "skip", label: "跳过这次", description: "上一次还在跑就不再触发（默认）" },
  { value: "queue", label: "排队", description: "等上一次跑完再执行" },
];
const TRIGGER_KIND_TEXT: Record<string, string> = { cron: "定时", manual: "手动" };

export default function TasksPage() {
  const router = useRouter();
  const confirm = useConfirm();
  // null = 首次加载中（骨架）。
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [larkTargets, setLarkTargets] = useState<LarkTarget[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [cronExpr, setCronExpr] = useState("0 9 * * *");

  const load = useCallback(async () => {
    try {
      const r = await fetch("/api/tasks");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = await r.json();
      setTasks(d.tasks ?? []);
      setLoadError(null);
    } catch (e) {
      // 轮询失败：已有列表时静默（下一轮会补上）；首次就失败才亮错误卡。
      setLoadError(e);
    }
  }, []);

  const loadRuns = useCallback(async (id: string) => {
    try {
      const d = await (await fetch(`/api/tasks/${id}/runs`)).json();
      setRuns(d.runs ?? []);
    } catch {
      /* 同上 */
    }
  }, []);

  useEffect(() => {
    void load();
    fetch("/api/agents")
      .then((r) => r.json())
      .then((d) => setAgents(d.agents ?? []))
      .catch(() => {});
    fetch("/api/lark-bots")
      .then((r) => r.json())
      .then(async (d) => {
        const bots = (d.bots ?? []).filter((bot: { enabled?: boolean }) => bot.enabled);
        const groups = await Promise.all(
          bots.map(async (bot: { id: string; name: string; workspacePath: string | null }) => {
            const response = await fetch(`/api/lark-bots/${bot.id}/chats`);
            if (!response.ok) return [];
            const payload = await response.json();
            return (payload.chats ?? []).map((chat: {
              chatId: string;
              chatType: "p2p" | "group";
              title: string | null;
            }) => ({
              botId: bot.id,
              botName: bot.name,
              chatId: chat.chatId,
              chatType: chat.chatType,
              title: chat.title,
              workspacePath: bot.workspacePath,
            }));
          }),
        );
        setLarkTargets(groups.flat());
      })
      .catch(() => {});
  }, [load]);

  const taskList = tasks ?? [];

  // 有 run 在跑时快轮询，否则慢 —— 与 settings 页同一套节奏。
  const anyRunning = taskList.some(
    (t) => t.lastRun?.status === "running" || t.lastRun?.status === "pending",
  );
  useEffect(() => {
    const id = setInterval(
      () => {
        void load();
        if (selectedId) void loadRuns(selectedId);
      },
      anyRunning ? 3000 : 20000,
    );
    return () => clearInterval(id);
  }, [anyRunning, load, loadRuns, selectedId]);

  useEffect(() => {
    if (selectedId) void loadRuns(selectedId);
  }, [selectedId, loadRuns]);

  const refresh = () => {
    setRefreshing(true);
    void Promise.all([load(), selectedId ? loadRuns(selectedId) : null]).finally(() =>
      setRefreshing(false),
    );
  };

  const selected = taskList.find((t) => t.id === selectedId) ?? null;
  const selectedLarkTarget = larkTargets.find(
    (target) =>
      target.botId === editing?.larkBotId && target.chatId === editing?.larkChatId,
  ) ?? null;

  const runNow = async (id: string) => {
    const r = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 202) toast.info(d.error ?? "已排队");
    else if (!r.ok) toast.error("启动失败", { description: d.error ?? "服务端没有给出原因" });
    else toast.success("已开始执行");
    void load();
    if (selectedId === id) void loadRuns(id);
  };

  const abortRun = async (runId: string) => {
    const r = await fetch(`/api/task-runs/${runId}/abort`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.ok) toast.success("已中止");
    else toast.error("中止失败", { description: d.error ?? "服务端没有给出原因" });
    void load();
    if (selectedId) void loadRuns(selectedId);
  };

  const save = async () => {
    if (!editing?.name || !editing?.prompt) return;
    const isNew = !editing.id;
    const r = await fetch(isNew ? "/api/tasks" : `/api/tasks/${editing.id}`, {
      method: isNew ? "POST" : "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(editing),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) {
      toast.error("保存失败", { description: d.error ?? "服务端没有给出原因" });
      return;
    }
    setEditing(null);
    toast.success("已保存");
    await load();
  };

  const remove = async (task: Partial<Task>) => {
    const ok = await confirm({
      title: `删除任务「${task.name}」？`,
      description: "任务定义与它的触发器会一起删除；已经跑出来的会话保留在工作台里。",
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await fetch(`/api/tasks/${task.id}`, { method: "DELETE" });
    setEditing(null);
    setSelectedId(null);
    toast.success("任务已删除");
    await load();
  };

  const addCron = async (taskId: string, expr: string) => {
    const r = await fetch(`/api/tasks/${taskId}/triggers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cron", config: { expr } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) toast.error("添加触发器失败", { description: d.error ?? "服务端没有给出原因" });
    await load();
  };

  const delTrigger = async (taskId: string, triggerId: string) => {
    await fetch(`/api/tasks/${taskId}/triggers?triggerId=${triggerId}`, {
      method: "DELETE",
    });
    await load();
  };

  const startNew = () =>
    setEditing({
      name: "",
      prompt: "",
      contextMode: "project",
      notifyOn: "error",
      larkBotId: null,
      larkChatId: null,
    });

  const cronEnabledCount = taskList.filter((t) =>
    t.enabled && t.triggers.some((tr) => tr.enabled && tr.kind === "cron"),
  ).length;
  const runningCount = taskList.filter(
    (t) => t.lastRun?.status === "running" || t.lastRun?.status === "pending",
  ).length;

  const larkValue =
    editing?.larkBotId && editing?.larkChatId
      ? JSON.stringify([editing.larkBotId, editing.larkChatId])
      : NO_LARK;
  const larkMissing =
    !!editing?.larkBotId &&
    !!editing?.larkChatId &&
    !larkTargets.some(
      (target) => target.botId === editing.larkBotId && target.chatId === editing.larkChatId,
    );

  return (
    // S89: 滚动容器与外壳由 app/settings/layout.tsx 接管，这里只剩内容。
    // W4：操作反馈统一走 toast（原来是内容区顶上的一条灰卡片）。
    <div className="flex flex-col gap-5">
      <PageHeader
        title="自动化任务"
        count={tasks ? taskList.length : undefined}
        countUnit="个任务"
        subtitle={
          tasks
            ? `${cronEnabledCount} 个启用定时${runningCount ? ` · ${runningCount} 个正在执行` : ""}`
            : undefined
        }
        actions={
          <>
            <IconButton label="刷新" onClick={refresh} disabled={refreshing}>
              <Icon icon={RefreshCw} className={refreshing ? "animate-spin" : undefined} />
            </IconButton>
            <Button variant="primary" onClick={startNew}>
              <Icon icon={Plus} />
              新建任务
            </Button>
          </>
        }
      />

      {tasks === null && loadError !== null ? (
        <ErrorCallout error={loadError} title="任务列表加载失败" onRetry={refresh} />
      ) : tasks === null ? (
        <div role="status" aria-label="加载中" className="flex flex-col md:flex-row gap-6">
          <div className="md:w-[300px] shrink-0 rounded-card border border-line bg-surface divide-y divide-line-faint">
            {[60, 45, 55].map((w) => (
              <div key={w} className="flex gap-2.5 px-3.5 py-3">
                <Skeleton className="mt-1 size-2 rounded-full" />
                <div className="flex-1 flex flex-col gap-2">
                  <Skeleton className="h-3.5" />
                  <Skeleton className="h-3 w-4/5" />
                </div>
              </div>
            ))}
          </div>
          <div className="flex-1 flex flex-col gap-3">
            <Skeleton className="h-4.5 w-36" />
            <Skeleton className="h-3 w-3/4" />
            <Skeleton className="h-3 w-1/2" />
            <Skeleton className="h-3 w-5/6" />
          </div>
        </div>
      ) : !taskList.length && !editing ? (
        <EmptyState
          icon={CalendarClock}
          title="还没有自动化任务"
          description="一个任务 = 用哪个 Agent + 跑什么提示词 + 在哪个目录。建好后可以手动运行，也可以挂个定时。"
          action={
            <Button variant="primary" onClick={startNew}>
              <Icon icon={Plus} />
              新建任务
            </Button>
          }
          className="rounded-card border border-line"
        />
      ) : (
      <div className="flex flex-col md:flex-row gap-6">
        {/* 左：任务列表 */}
        {taskList.length > 0 && (
        <div className="md:w-[300px] shrink-0 self-start w-full overflow-hidden rounded-card border border-line bg-surface divide-y divide-line-faint">
          {taskList.map((t) => {
            const active = selectedId === t.id;
            return (
              <button
                key={t.id}
                type="button"
                aria-current={active ? "true" : undefined}
                onClick={() => {
                  setSelectedId(t.id);
                  if (editing && editing.id !== t.id) setEditing(null);
                }}
                className={cn(
                  "relative flex w-full items-start gap-2.5 px-3.5 py-3 text-left transition-colors duration-100 max-md:min-h-11",
                  active ? "bg-accent-muted" : "hover:bg-surface-hover",
                  !t.enabled && "opacity-60",
                )}
              >
                {active && (
                  <span aria-hidden className="absolute left-0 top-2.5 bottom-2.5 w-0.5 rounded-full bg-accent" />
                )}
                <span className="mt-1.5">
                  <StatusDot run={t.lastRun} />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-ui font-medium text-ink-strong">{t.name}</span>
                  <span className="block truncate text-label text-ink-muted">
                    {agents.find((a) => a.id === t.agentId)?.name ?? AGENT_DEFAULT_LABEL}
                    {t.workspacePath ? ` · ${t.workspacePath}` : ""}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-label text-ink-faint">
                    <Icon icon={Clock} size="sm" />
                    {nextFireText(t.triggers)}
                    {!t.enabled && " · 已停用"}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        )}

        {/* 右：编辑器 or 详情 + 运行历史 */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-4">
              <h2 className="text-body font-semibold text-ink-strong">{editing.id ? "编辑任务" : "新建任务"}</h2>
              <Field label="任务名">
                <Input
                  placeholder="例如：每日 git 变更摘要"
                  value={editing.name ?? ""}
                  onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                />
              </Field>
              <Field label="提示词">
                <Textarea
                  className="resize-y"
                  rows={6}
                  placeholder="要跑的提示词 —— 它会作为这次执行的提问发出去"
                  value={editing.prompt ?? ""}
                  onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
                />
              </Field>
              {/* S89: 原来这里是一个**裸的绝对路径 input** —— 不接 workspaces 表、
                  不校验目录存不存在、不能建 worktree/scratch，用户得先去别处把路径复制
                  出来。换成与新会话完全同一个的 WorkspaceField（内含 WorkspacePicker）。 */}
              <Field label="工作目录">
                <WorkspaceField
                  value={editing.workspacePath ?? null}
                  onChange={(p) => setEditing({ ...editing, workspacePath: p })}
                  required={workspaceRequired(editing.contextMode ?? "project")}
                  placeholder="选择工作目录"
                  className="max-w-[20rem]"
                />
              </Field>
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="Agent">
                  {/* 文案走 lib/run-config.ts —— 此前这里叫「默认 Agent」、
                      新会话那边叫「默认助手」，同一个东西两个名字。 */}
                  <Select
                    aria-label="Agent"
                    value={editing.agentId ?? DEFAULT_AGENT}
                    onValueChange={(v) =>
                      setEditing({ ...editing, agentId: v === DEFAULT_AGENT ? null : v })
                    }
                    options={[
                      { value: DEFAULT_AGENT, label: AGENT_DEFAULT_LABEL },
                      ...agents.map((a) => ({ value: a.id, label: a.name })),
                    ]}
                  />
                </Field>
                <Field label="模式">
                  {/* 选项与说明同样来自 lib/run-config.ts。原来是另手写的
                      「project（有文件工具）」，与 ModePicker 的长说明各说各话。 */}
                  <Select
                    aria-label="模式"
                    value={editing.contextMode ?? "project"}
                    onValueChange={(v) => setEditing({ ...editing, contextMode: v })}
                    options={MODE_OPTIONS.map((o) => ({
                      value: o.id,
                      label: o.label,
                      description: o.short,
                    }))}
                  />
                </Field>
                <Field label="通知">
                  <Select
                    aria-label="通知"
                    value={editing.notifyOn ?? "error"}
                    onValueChange={(v) => setEditing({ ...editing, notifyOn: v })}
                    options={NOTIFY_OPTIONS}
                  />
                </Field>
              </div>

              <Field
                label="飞书落点"
                hint={
                  <>
                    每次运行会在该会话里新建一棵树，并把结果推送过去。追问在该机器人的工作目录中执行：
                    <span className="font-mono">{selectedLarkTarget?.workspacePath || "未设置"}</span>
                  </>
                }
              >
                <Select
                  aria-label="飞书落点"
                  className="sm:max-w-[26rem]"
                  value={larkValue}
                  onValueChange={(v) => {
                    if (v === NO_LARK) {
                      setEditing({ ...editing, larkBotId: null, larkChatId: null });
                      return;
                    }
                    const [larkBotId, larkChatId] = JSON.parse(v) as [string, string];
                    setEditing({ ...editing, larkBotId, larkChatId });
                  }}
                  options={[
                    { value: NO_LARK, label: "不落飞书" },
                    ...(larkMissing
                      ? [
                          {
                            value: larkValue,
                            label: "当前落点不可用（可改为其它落点）",
                            disabled: true,
                          },
                        ]
                      : []),
                    ...larkTargets.map((target) => ({
                      value: JSON.stringify([target.botId, target.chatId]),
                      label: `${target.botName} · ${target.title || target.chatId}（${
                        target.chatType === "group" ? "群聊" : "私聊"
                      }）`,
                    })),
                  ]}
                />
              </Field>

              {/* S89 补齐的四项。它们服务端一直生效、此前只能由 API 改 —— 而其中三项是
                  **闸门**（超时 / 并发 / 成本），无人值守的任务恰恰最需要它们可见可调。 */}
              <div className="grid gap-4 sm:grid-cols-3">
                <Field label="超时" hint="超过这个时长强制中止，是兜底的那一道闸。">
                  <Select
                    aria-label="超时"
                    value={String(editing.timeoutMs ?? 30 * 60_000)}
                    onValueChange={(v) => setEditing({ ...editing, timeoutMs: Number(v) })}
                    options={
                      TIMEOUT_OPTIONS.some(
                        (o) => o.value === String(editing.timeoutMs ?? 30 * 60_000),
                      )
                        ? TIMEOUT_OPTIONS
                        : [
                            ...TIMEOUT_OPTIONS,
                            {
                              value: String(editing.timeoutMs),
                              label: `${Math.round((editing.timeoutMs ?? 0) / 60_000)} 分钟`,
                            },
                          ]
                    }
                  />
                </Field>
                <Field label="重叠" hint="上一次还在跑时又被触发怎么办。">
                  <Select
                    aria-label="重叠"
                    value={editing.overlapPolicy ?? "skip"}
                    onValueChange={(v) => setEditing({ ...editing, overlapPolicy: v })}
                    options={OVERLAP_OPTIONS}
                  />
                </Field>
                <Field
                  label="成本上限（美元）"
                  hint="超时之外的第二道闸：陷入循环的 Agent 可能半小时烧掉很多钱。留空 = 不限。"
                >
                  <Input
                    type="number"
                    step="0.5"
                    min="0"
                    placeholder="不限"
                    value={editing.maxBudgetUsd ?? ""}
                    onChange={(e) =>
                      setEditing({
                        ...editing,
                        maxBudgetUsd: e.target.value === "" ? null : Number(e.target.value),
                      })
                    }
                  />
                </Field>
              </div>
              <label className="inline-flex items-center gap-2 text-ui text-ink self-start">
                <Checkbox
                  checked={editing.enabled ?? true}
                  onCheckedChange={(v) => setEditing({ ...editing, enabled: v === true })}
                />
                启用
                <span className="text-label text-ink-faint">停用后触发器不再触发，手动运行仍可用</span>
              </label>
              <div className="flex items-center gap-2 pt-1">
                <Button
                  type="button"
                  variant="primary"
                  onClick={() => void save()}
                  disabled={!editing.name || !editing.prompt}
                >
                  保存
                </Button>
                <Button type="button" variant="ghost" onClick={() => setEditing(null)}>
                  取消
                </Button>
                {editing.id && (
                  <Button
                    type="button"
                    variant="danger"
                    className="ml-auto"
                    onClick={() => void remove(editing)}
                  >
                    <Icon icon={Trash2} />
                    删除任务
                  </Button>
                )}
              </div>
            </div>
          ) : selected ? (
            <div className="flex flex-col gap-6">
              {/* 详情头：名称 + 动作 */}
              <div className="flex flex-wrap items-center gap-2">
                <h2 className="min-w-0 truncate text-body font-semibold text-ink-strong">{selected.name}</h2>
                {!selected.enabled && <Badge>已停用</Badge>}
                <div className="ml-auto flex items-center gap-1.5">
                  <Button type="button" onClick={() => void runNow(selected.id)}>
                    <Icon icon={Play} />
                    立即运行
                  </Button>
                  <Button type="button" variant="ghost" onClick={() => setEditing(selected)}>
                    <Icon icon={Pencil} />
                    编辑
                  </Button>
                </div>
              </div>

              {/* 触发器 */}
              <section>
                <div className="mb-2 flex items-baseline gap-2">
                  <h3 className="text-ui font-semibold text-ink-strong">定时触发</h3>
                  <span className="text-label text-ink-muted">
                    按服务器本地时间；没有触发器 = 只能手动运行，那也是合法的用法
                  </span>
                </div>
                <div className="rounded-card border border-line bg-surface divide-y divide-line-faint">
                  {selected.triggers.map((tr) => (
                    <div key={tr.id} className="flex items-center gap-2.5 px-3.5 py-2 text-ui">
                      <code className="rounded-md bg-surface-muted px-1.5 py-0.5 font-mono text-label">
                        {String(tr.config.expr ?? tr.kind)}
                      </code>
                      <span className="text-ink">
                        {tr.kind === "cron" ? describeCron(String(tr.config.expr ?? "")) : tr.kind}
                      </span>
                      <IconButton
                        label="移除触发器"
                        size="sm"
                        className="ml-auto"
                        onClick={() => void delTrigger(selected.id, tr.id)}
                      >
                        <Icon icon={X} size="sm" />
                      </IconButton>
                    </div>
                  ))}
                  {!selected.triggers.length && (
                    <div className="px-3.5 py-2.5 text-label text-ink-faint">没有触发器，仅手动运行</div>
                  )}
                  <div className="flex flex-wrap items-center gap-1.5 px-3.5 py-2.5">
                    <Select
                      aria-label="常用定时"
                      size="sm"
                      className="w-40"
                      value={CRON_PRESETS.some((p) => p.expr === cronExpr) ? cronExpr : "custom"}
                      onValueChange={(v) => {
                        if (v !== "custom") setCronExpr(v);
                      }}
                      options={[
                        ...CRON_PRESETS.map((p) => ({ value: p.expr, label: p.label })),
                        { value: "custom", label: "自定义…" },
                      ]}
                    />
                    <Input
                      size="sm"
                      aria-label="cron 表达式"
                      className="font-mono w-[180px]"
                      value={cronExpr}
                      onChange={(e) => setCronExpr(e.target.value)}
                      invalid={!parseCron(cronExpr)}
                    />
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => void addCron(selected.id, cronExpr)}
                      disabled={!parseCron(cronExpr)}
                    >
                      <Icon icon={Plus} size="sm" />
                      添加触发器
                    </Button>
                  </div>
                  {/* ★ 双回显。裸 cron 串的问题不是难写，是写错了不知道。 */}
                  <div className="px-3.5 pb-2.5 -mt-1.5 text-label text-ink-faint">
                    {describeCron(cronExpr)}
                    {parseCron(cronExpr) && ` · 下次：${fmtNext(cronExpr)}`}
                  </div>
                </div>
              </section>

              {/* 运行历史 */}
              <section>
                <h3 className="mb-2 text-ui font-semibold text-ink-strong">运行记录</h3>
                {!runs.length ? (
                  <EmptyState
                    compact
                    icon={Play}
                    title="还没有执行过"
                    description="点上面的「立即运行」试一次，或等定时触发。"
                    className="rounded-card border border-line"
                  />
                ) : (
                  <div className="rounded-card border border-line bg-surface divide-y divide-line-faint">
                    {/* S89: 行从一整个 <button> 拆成 div + 两个子按钮 —— 中止按钮嵌不进
                        button 里。深链仍是主动作（点一条 run 回主 SPA 看完整渲染）。 */}
                    {runs.map((r) => {
                      const live = r.status === "running" || r.status === "pending";
                      const interrupted = isInterrupted(r);
                      return (
                        <div key={r.id} className="px-3.5 py-2.5 flex flex-col gap-1">
                          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-ui">
                            <RunStatus run={r} />
                            <span className="font-mono text-label text-ink-muted tabular-nums">
                              {new Date(r.createdAt).toLocaleString()}
                            </span>
                            {r.startedAt && r.endedAt ? (
                              <span className="font-mono text-label text-ink-muted tabular-nums">
                                {Math.round((r.endedAt - r.startedAt) / 1000)}s
                              </span>
                            ) : null}
                            <span className="text-label text-ink-muted">
                              {TRIGGER_KIND_TEXT[r.triggerKind] ?? r.triggerKind}
                            </span>
                            {(r.tokenInput > 0 || r.tokenOutput > 0) && (
                              <span className="text-label text-ink-faint tabular-nums">
                                输入 {r.tokenInput} · 输出 {r.tokenOutput} token
                              </span>
                            )}
                            <span className="ml-auto flex items-center gap-1">
                              {r.sessionId && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() =>
                                    router.push(`/?session=${r.sessionId}&node=${r.nodeId}`)
                                  }
                                >
                                  打开会话
                                  <Icon icon={ArrowUpRight} size="sm" />
                                </Button>
                              )}
                              {/* /api/task-runs/[id]/abort 从 S88 起就存在，但**页面上一直没有
                                  任何按钮调它** —— 一个跑飞的无人值守任务只能等超时。 */}
                              {live && (
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => void abortRun(r.id)}
                                >
                                  中止
                                </Button>
                              )}
                            </span>
                          </div>
                          {r.errorMessage && !interrupted && (
                            <div
                              className={cn(
                                "border-l-2 pl-2.5 text-label break-words",
                                r.status === "skipped"
                                  ? "border-line text-ink-faint"
                                  : "border-danger-line text-ink-muted",
                              )}
                            >
                              {r.errorMessage}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          ) : (
            <EmptyState
              compact
              title="选一个任务看详情"
              description="左边选一个任务查看触发器和运行记录，或在右上角新建一个。"
            />
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-label text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-label text-ink-faint">{hint}</span>}
    </div>
  );
}

/** 'interrupted' 是服务器重启把 run 收尸留下的，不是任务本身失败 —— 渲染成灰色
 * 「中断（服务重启）」而非红色「失败」，否则一次例行部署就让整页变红。
 * （research-2026-09-28「不能动的东西」第一条：这里的灰色不许变红。） */
function isInterrupted(r: Pick<Run, "status" | "errorMessage">): boolean {
  return r.status === "error" && r.errorMessage === "interrupted";
}

function StatusDot({ run }: { run?: Run | null }) {
  const status = run?.status;
  if (!run || !status) return <UiStatusDot tone="idle" label="还没运行过" />;
  if (status === "running" || status === "pending")
    return <UiStatusDot tone="live" label={statusText(run)} />;
  if (status === "done") return <UiStatusDot tone="positive" label="完成" />;
  // interrupted / skipped / aborted：灰，不是红。
  if (status === "skipped" || status === "aborted" || isInterrupted(run))
    return <UiStatusDot tone="neutral" label={statusText(run)} />;
  return <UiStatusDot tone="danger" label={statusText(run)} />;
}

/** 运行记录行首：状态图标 + 文案。中断（服务重启）整行灰色，带说明提示。 */
function RunStatus({ run }: { run: Run }) {
  const text = statusText(run);
  if (isInterrupted(run)) {
    return (
      <Tooltip content="服务器重启时被收尾，不是任务本身失败">
        <span tabIndex={0} className="inline-flex min-w-[8.5rem] items-center gap-1.5 text-ink-muted">
          <StatusDot run={run} />
          {text}
        </span>
      </Tooltip>
    );
  }
  if (run.status === "done")
    return (
      <span className="inline-flex min-w-[8.5rem] items-center gap-1.5 text-ink">
        <Icon icon={Check} size="sm" className="text-ink-muted" />
        {text}
      </span>
    );
  if (run.status === "skipped")
    return (
      <span className="inline-flex min-w-[8.5rem] items-center gap-1.5 text-ink-muted">
        <Icon icon={SkipForward} size="sm" />
        {text}
      </span>
    );
  const failed = !(run.status === "running" || run.status === "pending" || run.status === "aborted");
  return (
    <span
      className={cn(
        "inline-flex min-w-[8.5rem] items-center gap-1.5",
        failed ? "text-danger-ink" : run.status === "aborted" ? "text-ink-muted" : "text-ink",
      )}
    >
      <StatusDot run={run} />
      {text}
    </span>
  );
}

function statusText(r: Run): string {
  if (r.status === "error" && r.errorMessage === "interrupted") return "中断（服务重启）";
  return (
    {
      done: "完成",
      running: "执行中",
      pending: "排队中",
      error: "失败",
      timeout: "超时",
      skipped: "跳过",
      aborted: "已中止",
    }[r.status] ?? r.status
  );
}

function nextFireText(triggers: Trigger[]): string {
  const crons = triggers.filter((t) => t.enabled && t.kind === "cron");
  if (!crons.length) return "仅手动运行";
  const times = crons
    .map((t) => {
      const f = parseCron(String(t.config.expr ?? ""));
      return f ? nextFireAfter(f, new Date()) : null;
    })
    .filter((x): x is number => x !== null);
  if (!times.length) return "触发器无效";
  return `下次：${new Date(Math.min(...times)).toLocaleString()}`;
}

function fmtNext(expr: string): string {
  const f = parseCron(expr);
  if (!f) return "—";
  const t = nextFireAfter(f, new Date());
  return t ? new Date(t).toLocaleString() : "永不";
}
