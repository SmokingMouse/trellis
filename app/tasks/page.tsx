"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { describeCron, nextFireAfter, parseCron } from "@/lib/cron";

// S88: 自动化任务页。双栏 —— 左任务列表、右选中任务的运行历史。
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
  triggers: Trigger[];
  lastRun: Run | null;
};
type Agent = { id: string; name: string; slug: string };

const CRON_PRESETS: { label: string; expr: string }[] = [
  { label: "每天 09:00", expr: "0 9 * * *" },
  { label: "每个工作日 09:00", expr: "0 9 * * 1-5" },
  { label: "每小时", expr: "0 * * * *" },
  { label: "每 30 分钟", expr: "*/30 * * * *" },
  { label: "每周一 09:00", expr: "0 9 * * 1" },
  { label: "每月 1 号 09:00", expr: "0 9 1 * *" },
];

export default function TasksPage() {
  const router = useRouter();
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [editing, setEditing] = useState<Partial<Task> | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [cronExpr, setCronExpr] = useState("0 9 * * *");

  const load = useCallback(async () => {
    try {
      const d = await (await fetch("/api/tasks")).json();
      setTasks(d.tasks ?? []);
    } catch {
      /* 轮询失败静默 —— 下一轮会补上 */
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
  }, [load]);

  // 有 run 在跑时快轮询，否则慢 —— 与 settings 页同一套节奏。
  const anyRunning = tasks.some(
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

  const selected = tasks.find((t) => t.id === selectedId) ?? null;

  const runNow = async (id: string) => {
    setMsg(null);
    const r = await fetch(`/api/tasks/${id}/run`, { method: "POST" });
    const d = await r.json().catch(() => ({}));
    if (r.status === 202) setMsg(d.error ?? "已排队");
    else if (!r.ok) setMsg(d.error ?? "启动失败");
    else setMsg("已开始执行");
    void load();
    if (selectedId === id) void loadRuns(id);
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
      setMsg(d.error ?? "保存失败");
      return;
    }
    setEditing(null);
    setMsg("已保存");
    await load();
  };

  const addCron = async (taskId: string, expr: string) => {
    const r = await fetch(`/api/tasks/${taskId}/triggers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "cron", config: { expr } }),
    });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) setMsg(d.error ?? "添加失败");
    await load();
  };

  const delTrigger = async (taskId: string, triggerId: string) => {
    await fetch(`/api/tasks/${taskId}/triggers?triggerId=${triggerId}`, {
      method: "DELETE",
    });
    await load();
  };

  return (
    // globals.css 把 html/body 焊成 overflow:hidden（SPA canvas 要的），
    // 独立整页必须自带滚动容器。
    <div className="h-dvh overflow-y-auto bg-canvas text-ink">
      <header className="sticky top-0 z-10 border-b border-line bg-canvas px-4 py-3 flex items-center gap-3">
        <Link href="/" className="text-ui text-ink-muted hover:text-ink">
          ← 返回
        </Link>
        <h1 className="text-lg font-semibold">自动化任务</h1>
        <Link
          href="/settings/agents"
          className="text-ui text-ink-faint hover:text-ink ml-auto"
        >
          🎭 Agent 管理 →
        </Link>
      </header>

      {msg && (
        <div className="px-4 py-2 text-ui text-ink-muted border-b border-line">{msg}</div>
      )}

      <div className="flex flex-col md:flex-row gap-4 p-4 max-w-[1200px] mx-auto">
        {/* 左：任务列表 */}
        <div className="md:w-[380px] shrink-0 flex flex-col gap-2">
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={() =>
              setEditing({ name: "", prompt: "", contextMode: "project", notifyOn: "error" })
            }
          >
            + 新建任务
          </Button>
          {!tasks.length && (
            <div className="text-ui text-ink-faint py-4">
              还没有任务。一个任务 = 「用哪个 Agent + 跑什么 prompt + 在哪个目录」，
              建好后可以手动点 ▶，也可以挂个定时。
            </div>
          )}
          {tasks.map((t) => (
            <div
              key={t.id}
              className={`px-3 py-2 rounded-lg border ${
                selectedId === t.id ? "border-accent bg-surface-muted" : "border-line bg-surface"
              } ${t.enabled ? "" : "opacity-50"}`}
            >
              <button
                type="button"
                onClick={() => setSelectedId(t.id)}
                className="text-left w-full"
              >
                <div className="text-ui font-medium flex items-center gap-1.5">
                  <StatusDot status={t.lastRun?.status} />
                  {t.name}
                </div>
                <div className="text-label text-ink-faint truncate">
                  {agents.find((a) => a.id === t.agentId)?.name ?? "默认 Agent"}
                  {t.workspacePath ? ` · ${t.workspacePath}` : ""}
                </div>
                <div className="text-label text-ink-faint">{nextFireText(t.triggers)}</div>
              </button>
              <div className="flex items-center gap-1.5 mt-2">
                <Button type="button" variant="ghost" size="sm" onClick={() => void runNow(t.id)}>
                  ▶ 立即运行
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setEditing(t);
                    setSelectedId(t.id);
                  }}
                >
                  编辑
                </Button>
              </div>
            </div>
          ))}
        </div>

        {/* 右：编辑器 or 运行历史 */}
        <div className="flex-1 min-w-0">
          {editing ? (
            <div className="flex flex-col gap-3">
              <h2 className="text-ui font-medium">{editing.id ? "编辑任务" : "新建任务"}</h2>
              <input
                className={INPUT}
                placeholder="任务名，例如：每日 git 变更摘要"
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
              />
              <textarea
                className={`${INPUT} resize-y`}
                rows={6}
                placeholder="要跑的 prompt —— 它会作为这次执行的提问发出去"
                value={editing.prompt ?? ""}
                onChange={(e) => setEditing({ ...editing, prompt: e.target.value })}
              />
              <input
                className={`${INPUT} font-mono`}
                placeholder="工作目录绝对路径（project 模式必填）"
                value={editing.workspacePath ?? ""}
                onChange={(e) =>
                  setEditing({ ...editing, workspacePath: e.target.value || null })
                }
              />
              <div className="flex flex-wrap gap-3">
                <label className="text-ui flex items-center gap-2">
                  Agent
                  <select
                    className={SELECT}
                    value={editing.agentId ?? ""}
                    onChange={(e) =>
                      setEditing({ ...editing, agentId: e.target.value || null })
                    }
                  >
                    <option value="">默认 Agent</option>
                    {agents.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="text-ui flex items-center gap-2">
                  模式
                  <select
                    className={SELECT}
                    value={editing.contextMode ?? "project"}
                    onChange={(e) => setEditing({ ...editing, contextMode: e.target.value })}
                  >
                    <option value="project">project（有文件工具）</option>
                    <option value="chat">chat（纯对话）</option>
                  </select>
                </label>
                <label className="text-ui flex items-center gap-2">
                  通知
                  <select
                    className={SELECT}
                    value={editing.notifyOn ?? "error"}
                    onChange={(e) => setEditing({ ...editing, notifyOn: e.target.value })}
                  >
                    <option value="error">只在失败时</option>
                    <option value="always">每次都通知</option>
                    <option value="never">从不</option>
                  </select>
                </label>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="primary" size="sm" onClick={() => void save()}>
                  保存
                </Button>
                <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}>
                  取消
                </Button>
                {editing.id && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={async () => {
                      if (!confirm(`删除任务「${editing.name}」？执行历史会话会保留。`)) return;
                      await fetch(`/api/tasks/${editing.id}`, { method: "DELETE" });
                      setEditing(null);
                      setSelectedId(null);
                      await load();
                    }}
                  >
                    删除
                  </Button>
                )}
              </div>
            </div>
          ) : selected ? (
            <div className="flex flex-col gap-4">
              {/* 触发器 */}
              <div>
                <div className="text-ui font-medium mb-1">定时触发</div>
                <div className="text-label text-ink-faint mb-2">
                  按服务器本地时间。没有触发器 = 只能手动点 ▶ —— 那也是合法的用法。
                </div>
                <div className="flex flex-col gap-1.5 mb-2">
                  {selected.triggers.map((tr) => (
                    <div
                      key={tr.id}
                      className="flex items-center gap-2 text-ui px-2 py-1 rounded border border-line bg-surface"
                    >
                      <span className="font-mono text-label">{String(tr.config.expr ?? tr.kind)}</span>
                      <span className="text-ink-faint text-label">
                        {tr.kind === "cron" ? describeCron(String(tr.config.expr ?? "")) : tr.kind}
                      </span>
                      <button
                        type="button"
                        onClick={() => void delTrigger(selected.id, tr.id)}
                        className="ml-auto text-label text-ink-faint hover:text-ink"
                      >
                        移除
                      </button>
                    </div>
                  ))}
                  {!selected.triggers.length && (
                    <div className="text-label text-ink-faint">（无，仅手动运行）</div>
                  )}
                </div>
                <div className="flex flex-wrap items-center gap-1.5">
                  <select
                    className={SELECT}
                    value={CRON_PRESETS.some((p) => p.expr === cronExpr) ? cronExpr : "custom"}
                    onChange={(e) => {
                      if (e.target.value !== "custom") setCronExpr(e.target.value);
                    }}
                  >
                    {CRON_PRESETS.map((p) => (
                      <option key={p.expr} value={p.expr}>
                        {p.label}
                      </option>
                    ))}
                    <option value="custom">自定义…</option>
                  </select>
                  <input
                    className={`${INPUT} font-mono w-[180px]`}
                    value={cronExpr}
                    onChange={(e) => setCronExpr(e.target.value)}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => void addCron(selected.id, cronExpr)}
                    disabled={!parseCron(cronExpr)}
                  >
                    添加
                  </Button>
                </div>
                {/* ★ 双回显。裸 cron 串的问题不是难写，是写错了不知道。 */}
                <div className="text-label text-ink-faint mt-1">
                  {describeCron(cronExpr)}
                  {parseCron(cronExpr) && ` · 下次：${fmtNext(cronExpr)}`}
                </div>
              </div>

              {/* 运行历史 */}
              <div>
                <div className="text-ui font-medium mb-2">运行历史</div>
                <div className="flex flex-col gap-1.5">
                  {!runs.length && (
                    <div className="text-label text-ink-faint">还没有执行过</div>
                  )}
                  {runs.map((r) => (
                    <button
                      key={r.id}
                      type="button"
                      disabled={!r.sessionId}
                      onClick={() =>
                        router.push(`/?session=${r.sessionId}&node=${r.nodeId}`)
                      }
                      className="text-left px-3 py-2 rounded-lg border border-line bg-surface hover:border-line-strong disabled:opacity-60"
                    >
                      <div className="text-ui flex items-center gap-2">
                        <StatusDot status={r.status} />
                        <span>{statusText(r)}</span>
                        <span className="text-ink-faint text-label">{r.triggerKind}</span>
                        <span className="ml-auto text-label text-ink-faint">
                          {new Date(r.createdAt).toLocaleString()}
                        </span>
                      </div>
                      {r.errorMessage && (
                        <div className="text-label text-ink-faint truncate">
                          {r.errorMessage}
                        </div>
                      )}
                      {(r.tokenInput > 0 || r.tokenOutput > 0) && (
                        <div className="text-label text-ink-faint">
                          ↑{r.tokenInput} ↓{r.tokenOutput}
                          {r.startedAt && r.endedAt
                            ? ` · ${Math.round((r.endedAt - r.startedAt) / 1000)}s`
                            : ""}
                        </div>
                      )}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-ui text-ink-faint py-8">左边选一个任务，或新建一个。</div>
          )}
        </div>
      </div>
    </div>
  );
}

const INPUT =
  "px-3 py-2 rounded-field border border-line bg-surface-muted text-ui text-ink placeholder:text-ink-faint outline-none focus:border-accent-line w-full";
const SELECT =
  "px-2 py-1 rounded-field border border-line bg-surface-muted text-ui text-ink outline-none";

/** 'interrupted' 是服务器重启把 run 收尸留下的，不是任务本身失败 —— 渲染成灰色
 * 「中断」而非红色「失败」，否则一次例行部署就让整页变红。 */
function StatusDot({ status }: { status?: string }) {
  const color =
    status === "done"
      ? "bg-ok"
      : status === "running" || status === "pending"
        ? "bg-accent animate-pulse"
        : status === "skipped"
          ? "bg-ink-faint"
          : status
            ? "bg-danger"
            : "bg-line";
  return <span className={`inline-block w-2 h-2 rounded-full ${color}`} />;
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
