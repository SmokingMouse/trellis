import "server-only";
import fs from "node:fs";
import { SQLiteError } from "bun:sqlite";
import { getDB } from "./sqlite";
import { createSessionWithRoot, createRootInSession, setNodeAgent } from "./repo";
import { resolveEnabledAgent } from "./agents";
import { resolveAgentSpawn } from "./agent-pack";
import { startRun, abortRun } from "./run-bus";
import { getProvider } from "@/lib/llm/server";
import { providerFamily, DEFAULT_PROVIDER, isProviderId } from "@/lib/llm";
import { sessionCwd } from "@/lib/paths";
import { publishTaskEvent } from "./task-events";
import { notify } from "./notify";
import { createWatchPool, type WatchPool } from "./fs-watch-pool";

// S88: 自动化任务的执行层。
//
// 三条设计纪律：
//  ① 复用 startRun，不造第二套执行链 —— run 与 HTTP 早就解耦了（SSE 只是订阅者），
//     所以「没有浏览器在场」对它不是新情况。
//  ② 执行落点是 session/nodes：每个任务一个常驻会话（kind='task'，从侧栏隐藏），
//     每次执行 = 一个平行根节点。Trellis 的全部渲染（流式、工具卡片、重连、搜索、
//     分叉追问）都长在这上面，另造一套等于重写整个 UI。
//  ③ 并发闸只管任务 run，**不看用户交互 run** —— 用户提问永远不该因为后台任务
//     在跑而被卡住；反过来用户开三个 tab 也不该把定时任务饿死。

/** 同时在跑的任务 run 上限。模块常量，不做配置项 —— 这台机器能同时跑几个
 * claude 是硬件问题，不是用户偏好。 */
const MAX_CONCURRENT_TASK_RUNS = 2;

export type TriggerKind = "cron" | "fs" | "git" | "session_done" | "lark";
export type TaskRunStatus =
  | "pending" | "running" | "done" | "error" | "timeout" | "skipped" | "aborted";

export type Task = {
  id: string;
  name: string;
  agentId: string | null;
  prompt: string;
  workspacePath: string | null;
  contextMode: string;
  model: string | null;
  enabled: boolean;
  homeSessionId: string | null;
  timeoutMs: number;
  overlapPolicy: string;
  notifyOn: "never" | "error" | "always";
  /** 成本闸（claude --max-budget-usd）。null = 不限。时间闸（timeoutMs）永远在，
   * 这个是第二道 —— 一个陷入循环的 agent 可能在 30 分钟里烧掉很多钱。 */
  maxBudgetUsd: number | null;
  createdAt: number;
  updatedAt: number;
};

export type TaskTrigger = {
  id: string;
  taskId: string;
  kind: TriggerKind;
  enabled: boolean;
  config: Record<string, unknown>;
  lastFiredAt: number | null;
  cursor: string | null;
  lastCheckedAt: number | null;
};

export type TaskRun = {
  id: string;
  taskId: string;
  triggerId: string | null;
  triggerKind: string;
  status: TaskRunStatus;
  sessionId: string | null;
  nodeId: string | null;
  scheduledFor: number;
  attempt: number;
  startedAt: number | null;
  endedAt: number | null;
  errorMessage: string | null;
  tokenInput: number;
  tokenOutput: number;
  createdAt: number;
};

const TASK_COLS = `id, name, agent_id, prompt, workspace_path, context_mode, model,
       enabled, home_session_id, timeout_ms, overlap_policy, notify_on,
       max_budget_usd, created_at, updated_at`;

type TaskRow = {
  id: string; name: string; agent_id: string | null; prompt: string;
  workspace_path: string | null; context_mode: string; model: string | null;
  enabled: number; home_session_id: string | null; timeout_ms: number;
  overlap_policy: string; notify_on: string; max_budget_usd: number | null;
  created_at: number; updated_at: number;
};

function rowToTask(r: TaskRow): Task {
  return {
    id: r.id, name: r.name, agentId: r.agent_id, prompt: r.prompt,
    workspacePath: r.workspace_path, contextMode: r.context_mode, model: r.model,
    enabled: r.enabled === 1, homeSessionId: r.home_session_id,
    timeoutMs: r.timeout_ms, overlapPolicy: r.overlap_policy,
    notifyOn: (r.notify_on as Task["notifyOn"]) ?? "error",
    maxBudgetUsd: r.max_budget_usd,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export function listTasks(): Task[] {
  return (
    getDB()
      .query(`SELECT ${TASK_COLS} FROM tasks ORDER BY created_at DESC`)
      .all() as TaskRow[]
  ).map(rowToTask);
}

export function getTask(id: string): Task | null {
  const r = getDB().query(`SELECT ${TASK_COLS} FROM tasks WHERE id = ?`).get(id) as
    | TaskRow
    | undefined;
  return r ? rowToTask(r) : null;
}

export type TaskInput = {
  name: string;
  prompt: string;
  agentId?: string | null;
  workspacePath?: string | null;
  contextMode?: string;
  model?: string | null;
  enabled?: boolean;
  timeoutMs?: number;
  notifyOn?: Task["notifyOn"];
  maxBudgetUsd?: number | null;
};

export function createTask(input: TaskInput): Task {
  const id = crypto.randomUUID();
  const now = Date.now();
  getDB()
    .prepare(
      `INSERT INTO tasks (id, name, agent_id, prompt, workspace_path, context_mode,
                          model, enabled, timeout_ms, notify_on, max_budget_usd,
                          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, input.name, input.agentId ?? null, input.prompt,
      input.workspacePath ?? null, input.contextMode ?? "project",
      input.model ?? null, input.enabled === false ? 0 : 1,
      input.timeoutMs ?? 1_800_000, input.notifyOn ?? "error",
      input.maxBudgetUsd ?? null, now, now,
    );
  return getTask(id)!;
}

export function updateTask(id: string, patch: Partial<TaskInput>): Task | null {
  if (!getTask(id)) return null;
  const sets: string[] = [];
  const vals: unknown[] = [];
  const put = (c: string, v: unknown) => { sets.push(`${c} = ?`); vals.push(v); };
  if (patch.name !== undefined) put("name", patch.name);
  if (patch.prompt !== undefined) put("prompt", patch.prompt);
  if (patch.agentId !== undefined) put("agent_id", patch.agentId);
  if (patch.workspacePath !== undefined) put("workspace_path", patch.workspacePath);
  if (patch.contextMode !== undefined) put("context_mode", patch.contextMode);
  if (patch.model !== undefined) put("model", patch.model);
  if (patch.enabled !== undefined) put("enabled", patch.enabled ? 1 : 0);
  if (patch.timeoutMs !== undefined) put("timeout_ms", patch.timeoutMs);
  if (patch.notifyOn !== undefined) put("notify_on", patch.notifyOn);
  if (patch.maxBudgetUsd !== undefined) put("max_budget_usd", patch.maxBudgetUsd);
  if (!sets.length) return getTask(id);
  put("updated_at", Date.now());
  vals.push(id);
  getDB().prepare(`UPDATE tasks SET ${sets.join(", ")} WHERE id = ?`).run(...(vals as never[]));
  return getTask(id);
}

export function deleteTask(id: string): boolean {
  // triggers / runs 走 ON DELETE CASCADE。任务会话**故意留着** —— 那是执行历史，
  // 删任务不该连坐删掉「它这几个月产出过什么」。
  const r = getDB().prepare("DELETE FROM tasks WHERE id = ?").run(id);
  return r.changes > 0;
}

// --- triggers ---

export function listTriggers(taskId?: string): TaskTrigger[] {
  const db = getDB();
  const rows = (
    taskId
      ? db.query("SELECT * FROM task_triggers WHERE task_id = ? ORDER BY created_at").all(taskId)
      : db.query("SELECT * FROM task_triggers ORDER BY created_at").all()
  ) as Record<string, never>[];
  return rows.map((r) => ({
    id: r.id as unknown as string,
    taskId: r.task_id as unknown as string,
    kind: r.kind as unknown as TriggerKind,
    enabled: (r.enabled as unknown as number) === 1,
    config: safeParse(r.config_json as unknown as string),
    lastFiredAt: r.last_fired_at as unknown as number | null,
    cursor: r.cursor as unknown as string | null,
    lastCheckedAt: r.last_checked_at as unknown as number | null,
  }));
}

function safeParse(raw: string): Record<string, unknown> {
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createTrigger(
  taskId: string,
  kind: TriggerKind,
  config: Record<string, unknown>,
): TaskTrigger | null {
  if (!getTask(taskId)) return null;
  const id = crypto.randomUUID();
  getDB()
    .prepare(
      `INSERT INTO task_triggers (id, task_id, kind, enabled, config_json, created_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, taskId, kind, JSON.stringify(config), Date.now());
  return listTriggers(taskId).find((t) => t.id === id) ?? null;
}

export function deleteTrigger(id: string): boolean {
  return getDB().prepare("DELETE FROM task_triggers WHERE id = ?").run(id).changes > 0;
}

export function setTriggerCursor(id: string, cursor: string | null, checkedAt: number): void {
  getDB()
    .prepare("UPDATE task_triggers SET cursor = ?, last_checked_at = ? WHERE id = ?")
    .run(cursor, checkedAt, id);
}

// --- runs ---

export function listRuns(taskId: string, limit = 30): TaskRun[] {
  return (
    getDB()
      .query(
        `SELECT * FROM task_runs WHERE task_id = ? ORDER BY created_at DESC LIMIT ?`,
      )
      .all(taskId, limit) as Record<string, never>[]
  ).map(rowToRun);
}

export function getRun(id: string): TaskRun | null {
  const r = getDB().query("SELECT * FROM task_runs WHERE id = ?").get(id) as
    | Record<string, never>
    | undefined;
  return r ? rowToRun(r) : null;
}

function rowToRun(r: Record<string, never>): TaskRun {
  return {
    id: r.id as unknown as string,
    taskId: r.task_id as unknown as string,
    triggerId: r.trigger_id as unknown as string | null,
    triggerKind: r.trigger_kind as unknown as string,
    status: r.status as unknown as TaskRunStatus,
    sessionId: r.session_id as unknown as string | null,
    nodeId: r.node_id as unknown as string | null,
    scheduledFor: r.scheduled_for as unknown as number,
    attempt: r.attempt as unknown as number,
    startedAt: r.started_at as unknown as number | null,
    endedAt: r.ended_at as unknown as number | null,
    errorMessage: r.error_message as unknown as string | null,
    tokenInput: r.token_input as unknown as number,
    tokenOutput: r.token_output as unknown as number,
    createdAt: r.created_at as unknown as number,
  };
}

/** 抢一个执行槽位。返回 runId；null = 这个槽已经被占（静默跳过）。
 *
 * ★ 唯一索引 task_runs_slot 才是正确性的来源 —— 多进程同 tick、重启后 catch-up
 * 重复计算，全撞在它上面。
 *
 * ⚠️ **必须精确区分唯一约束冲突与其它 DB 错误。** 图省事写成 `catch { return null }`
 * 的话，磁盘满 / 锁超时 / schema 不匹配全会被当成「已被占」吞掉 —— 症状是任务
 * **默默地再也不跑了，日志里一个字都没有**。这是整个调度层最难查的故障。 */
export function claimSlot(args: {
  taskId: string;
  triggerId: string | null;
  triggerKind: string;
  scheduledFor: number;
  attempt?: number;
  status?: TaskRunStatus;
}): string | null {
  const id = crypto.randomUUID();
  const task = getTask(args.taskId);
  try {
    getDB()
      .prepare(
        `INSERT INTO task_runs (id, task_id, trigger_id, trigger_kind, status,
                                scheduled_for, attempt, prompt_snapshot,
                                agent_id_snapshot, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id, args.taskId, args.triggerId, args.triggerKind,
        args.status ?? "pending", args.scheduledFor, args.attempt ?? 1,
        task?.prompt ?? null, task?.agentId ?? null, Date.now(),
      );
    return id;
  } catch (e) {
    // bun:sqlite 的 SQLiteError 带 .code；只有 SQLITE_CONSTRAINT* 才是「被占」。
    const code = e instanceof SQLiteError ? e.code : undefined;
    if (typeof code === "string" && code.startsWith("SQLITE_CONSTRAINT")) return null;
    throw e;
  }
}

function activeRunCount(): number {
  return (
    getDB().query("SELECT COUNT(*) AS n FROM task_runs WHERE status = 'running'").get() as {
      n: number;
    }
  ).n;
}

function hasActiveRunForTask(taskId: string): boolean {
  return (
    (
      getDB()
        .query(
          "SELECT COUNT(*) AS n FROM task_runs WHERE task_id = ? AND status IN ('running','pending')",
        )
        .get(taskId) as { n: number }
    ).n > 0
  );
}

/** 懒创建任务的常驻会话。第一次跑时建，之后复用。 */
function ensureTaskSession(task: Task, question: string, now: number): {
  sessionId: string;
  nodeId: string;
} {
  const nodeId = crypto.randomUUID();
  if (task.homeSessionId) {
    createRootInSession({
      sessionId: task.homeSessionId,
      nodeId,
      question,
      now,
      attachments: [],
    });
    return { sessionId: task.homeSessionId, nodeId };
  }
  const sessionId = crypto.randomUUID();
  createSessionWithRoot({
    sessionId,
    nodeId,
    title: `⏱ ${task.name}`,
    question,
    now,
    mode: task.contextMode,
    workspacePath: task.workspacePath,
    systemPrompt: null,
    model: task.model,
    agentId: task.agentId,
    attachments: [],
  });
  // kind='task' 把它从用户侧栏里隐掉。createSessionWithRoot 不认这个字段（它是
  // 任务层的概念，不该污染通用建会话路径），建完直接打标。
  getDB().prepare("UPDATE sessions SET kind = 'task' WHERE id = ?").run(sessionId);
  getDB().prepare("UPDATE tasks SET home_session_id = ? WHERE id = ?").run(sessionId, task.id);
  return { sessionId, nodeId };
}

/** 超时 timer 句柄。进程内即可 —— 进程没了 run 也没了，boot reap 会收尸。 */
const TIMEOUT_TIMERS = new Map<string, ReturnType<typeof setTimeout>>();

export type StartTaskRunResult =
  | { ok: true; runId: string; sessionId: string; nodeId: string }
  | { ok: false; reason: string; runId?: string };

/** 跑一次任务。手动触发与调度器共用这一条路径。 */
export function startTaskRun(args: {
  taskId: string;
  triggerId?: string | null;
  triggerKind?: string;
  /** 对齐到整分钟的槽位时间戳。手动触发传 Date.now() 即可（不进唯一索引）。 */
  scheduledFor?: number;
}): StartTaskRunResult {
  const task = getTask(args.taskId);
  if (!task) return { ok: false, reason: "task not found" };
  if (!task.enabled) return { ok: false, reason: "task disabled" };

  const triggerId = args.triggerId ?? null;
  const triggerKind = args.triggerKind ?? "manual";
  const scheduledFor = args.scheduledFor ?? Date.now();

  // overlap：上一次还没跑完。**必须写一条 skipped 留档** —— 不写的话用户看到的
  // 是「今天怎么没跑」的静默黑洞，比跑挂了更难查。
  if (task.overlapPolicy === "skip" && hasActiveRunForTask(task.id)) {
    const skipId = claimSlot({
      taskId: task.id, triggerId, triggerKind, scheduledFor, status: "skipped",
    });
    if (skipId) {
      getDB()
        .prepare(
          "UPDATE task_runs SET error_message = ?, ended_at = ? WHERE id = ?",
        )
        .run("上一次执行尚未结束（overlap_policy=skip）", Date.now(), skipId);
      publishTaskEvent({ type: "run_updated", taskId: task.id, runId: skipId });
    }
    return { ok: false, reason: "previous run still active", runId: skipId ?? undefined };
  }

  const runId = claimSlot({ taskId: task.id, triggerId, triggerKind, scheduledFor });
  if (!runId) return { ok: false, reason: "slot already claimed" };

  // 并发闸：超限就留在 pending，下一 tick 再捞。手动触发也守这条 —— 用户连点
  // 五个任务不该把机器打死。
  if (activeRunCount() >= MAX_CONCURRENT_TASK_RUNS) {
    return { ok: false, reason: "queued (concurrency limit)", runId };
  }

  return launch(task, runId);
}

/** 把一条 run 直接判死。spawn 前的失败走这里 —— 绝不能留在 running 上。
 *
 * **同样要发通知**：spawn 前失败（目录被删、provider 构造炸）对无人值守的任务
 * 恰恰是最需要被告知的一类 —— 它不是「跑出来结果不好」，是「压根没跑」，
 * 而界面上只会安静地多一条红点。 */
function failRun(task: Task, runId: string, message: string): StartTaskRunResult {
  const now = Date.now();
  getDB()
    .prepare(
      "UPDATE task_runs SET status = 'error', error_message = ?, ended_at = ? WHERE id = ?",
    )
    .run(message, now, runId);
  publishTaskEvent({ type: "run_finished", taskId: task.id, runId, status: "error" });
  if (task.notifyOn !== "never") {
    void notify({
      kind: "task_run_error",
      title: `任务「${task.name}」未能启动`,
      body: message,
      taskId: task.id,
      runId,
    });
    getDB().prepare("UPDATE task_runs SET notified_at = ? WHERE id = ?").run(now, runId);
  }
  return { ok: false, reason: message, runId };
}

/** 真正 spawn 的那一步。从 pending 队列捞起来的 run 也走这里。 */
export function launch(task: Task, runId: string): StartTaskRunResult {
  const now = Date.now();
  const question = task.prompt;

  // ★ spawn 前必须验工作目录存在。
  //
  // 实测（2026-07-31）：cwd 不存在时 `spawn claude` 抛的 ENOENT 是**异步的
  // uncaughtException**，逃得出 run-bus 的 try/catch —— 节点永远停在 streaming、
  // task_run 永远停在 running，而 overlap_policy='skip' 会因此把这个任务
  // **永久锁死**（后续每次触发都被判为「上一次还没跑完」）。
  //
  // 交互式会话里这种情况用户当场就能看见并重试；无人值守的定时任务不行 ——
  // 目录被删 / worktree 被回收是完全正常的事，必须在这里挡住并给出可读的原因。
  if (task.workspacePath && !fs.existsSync(task.workspacePath)) {
    return failRun(task, runId, `工作目录不存在：${task.workspacePath}`);
  }

  const { sessionId, nodeId } = ensureTaskSession(task, question, now);

  const providerId = isProviderId(task.model) ? task.model : DEFAULT_PROVIDER;
  const family = providerFamily(providerId);
  const llm = getProvider(providerId, { mode: task.contextMode as never });

  const agentRecord = family === "claude" ? resolveEnabledAgent(task.agentId) : null;
  const agentSpawn = agentRecord ? resolveAgentSpawn(agentRecord) : null;
  if (agentRecord) setNodeAgent(nodeId, agentRecord.id, "session");

  const spawnCwd = sessionCwd(task.contextMode as never, task.workspacePath);

  getDB()
    .prepare(
      "UPDATE task_runs SET status = 'running', started_at = ?, session_id = ?, node_id = ? WHERE id = ?",
    )
    .run(now, sessionId, nodeId, runId);
  publishTaskEvent({ type: "run_started", taskId: task.id, runId });

  // 时间闸。abortRun 会让 runLoop 的 finally 把节点收成 error/'aborted'，
  // onSettled 照常触发，finishTaskRun 据此把 status 记成 timeout。
  TIMEOUT_TIMERS.set(
    runId,
    setTimeout(() => {
      try {
        abortRun(nodeId);
      } catch {
        /* 已经结束了 */
      }
    }, task.timeoutMs),
  );

  try {
    startRun({
    nodeId,
    sessionIdTarget: task.contextMode === "project" ? "root" : "node",
    resumeFamily: family,
    interactive: false, // 无人值守：没人能回答权限卡，开了只会永久卡住
    factory: (signal) =>
      llm.stream({
        history: [],
        question,
        parentAnchor: null,
        signal,
        claudeSessionId: null,
        cwd: spawnCwd,
        systemPrompt: null,
        agent: agentSpawn,
        // 成本闸走 SDK 的 extraArgs 逃生舱 —— 从结构化 DB 字段派生，不接自由文本
        // （见 backend.ts 上 extraArgs 的约束注释）。
        extraArgs:
          task.maxBudgetUsd && family === "claude"
            ? ["--max-budget-usd", String(task.maxBudgetUsd)]
            : undefined,
        chatEnhanced: task.contextMode === "chat",
        attachments: [],
      }),
      onSettled: (r) => finishTaskRun(runId, r),
    });
  } catch (e) {
    // startRun 同步抛出（provider 构造失败等）时 run 已经被标成 running，
    // 不兜住就又是一条永远跑不完的僵尸。
    const t = TIMEOUT_TIMERS.get(runId);
    if (t) {
      clearTimeout(t);
      TIMEOUT_TIMERS.delete(runId);
    }
    return failRun(task, runId, e instanceof Error ? e.message : String(e));
  }

  return { ok: true, runId, sessionId, nodeId };
}

export function finishTaskRun(
  runId: string,
  r: {
    status: "done" | "error";
    errorMessage?: string | null;
    usage: { input: number; output: number };
  },
): void {
  const t = TIMEOUT_TIMERS.get(runId);
  if (t) {
    clearTimeout(t);
    TIMEOUT_TIMERS.delete(runId);
  }
  const run = getRun(runId);
  // 超时是我们自己 abort 出来的 error，语义上和「跑挂了」不同，单独记一档。
  const status: TaskRunStatus =
    r.status === "done"
      ? "done"
      : r.errorMessage === "aborted" && run?.status === "running"
        ? "timeout"
        : "error";
  getDB()
    .prepare(
      `UPDATE task_runs SET status = ?, ended_at = ?, error_message = ?,
              token_input = ?, token_output = ? WHERE id = ?`,
    )
    .run(status, Date.now(), r.errorMessage ?? null, r.usage.input, r.usage.output, runId);

  const task = run ? getTask(run.taskId) : null;
  publishTaskEvent({ type: "run_finished", taskId: run?.taskId ?? "", runId, status });

  // 通知节流：成功是常态，每次都推会让人一周内关掉通知 —— 那才是真正的失效。
  const want =
    task?.notifyOn === "always" || (task?.notifyOn === "error" && status !== "done");
  if (task && want) {
    void notify({
      kind: status === "done" ? "task_run_done" : "task_run_error",
      title: `任务「${task.name}」${status === "done" ? "完成" : status === "timeout" ? "超时" : "失败"}`,
      body: r.errorMessage ?? "",
      link: run?.sessionId ? `/?session=${run.sessionId}&node=${run.nodeId}` : undefined,
      taskId: task.id,
      runId,
    });
    getDB().prepare("UPDATE task_runs SET notified_at = ? WHERE id = ?").run(Date.now(), runId);
  }
}

/** 从 pending 队列捞起来跑。调度器每 tick 先调它，再处理新触发。 */
export function drainPending(): void {
  const free = MAX_CONCURRENT_TASK_RUNS - activeRunCount();
  if (free <= 0) return;
  const rows = getDB()
    .query(
      "SELECT id, task_id FROM task_runs WHERE status = 'pending' ORDER BY scheduled_for ASC LIMIT ?",
    )
    .all(free) as { id: string; task_id: string }[];
  for (const row of rows) {
    const task = getTask(row.task_id);
    if (!task || !task.enabled) {
      getDB()
        .prepare("UPDATE task_runs SET status = 'error', error_message = ?, ended_at = ? WHERE id = ?")
        .run("任务已删除或停用", Date.now(), row.id);
      continue;
    }
    try {
      launch(task, row.id);
    } catch (e) {
      console.error("[tasks] launch 失败", row.id, e);
      getDB()
        .prepare("UPDATE task_runs SET status = 'error', error_message = ?, ended_at = ? WHERE id = ?")
        .run(e instanceof Error ? e.message : String(e), Date.now(), row.id);
    }
  }
}

// ---------------------------------------------------------------------------
// session_done 触发器
// ---------------------------------------------------------------------------

/** 某个节点的 run 结束了。由 run-bus 在 finally 里 best-effort 调用。
 *
 * ⚠️ **必须防自触发**：任务自己的落点节点结束也会走这个钩子。若某任务监听的
 * 会话恰好就是它自己的任务会话，就是一个无限循环烧钱的闭环。两道防护：
 *   ① 任务产生的节点**从不**当事件源（下面第一行）；
 *   ② 建 trigger 时校验 sessionId != 该任务的 home_session_id（API 层）。 */
export function onNodeSettled(nodeId: string): void {
  const db = getDB();
  const isTaskNode = db
    .query("SELECT 1 FROM task_runs WHERE node_id = ? LIMIT 1")
    .get(nodeId);
  if (isTaskNode) return; // ← 防自触发，删掉这行就是烧钱循环

  const node = db.query("SELECT session_id FROM nodes WHERE id = ?").get(nodeId) as
    | { session_id: string }
    | undefined;
  if (!node) return;

  for (const t of listTriggers()) {
    if (!t.enabled || t.kind !== "session_done") continue;
    if (String(t.config.sessionId ?? "") !== node.session_id) continue;
    const task = getTask(t.taskId);
    if (!task?.enabled) continue;
    startTaskRun({
      taskId: t.taskId,
      triggerId: t.id,
      triggerKind: "session_done",
      scheduledFor: Date.now(),
    });
  }
}

// ---------------------------------------------------------------------------
// fs 触发器
// ---------------------------------------------------------------------------

let pool: WatchPool | null = null;

/** 按当前的 fs 触发器重建监听集合。增删触发器后调用；调度器每 tick 也调一次
 * （便宜，且省掉一套「谁负责通知我」的簿记）。 */
export function refreshFsWatches(): void {
  if (!pool) pool = createWatchPool("task-fs");
  const specs = listTriggers()
    .filter((t) => t.enabled && t.kind === "fs" && t.config.dir)
    .map((t) => {
      const ext = String(t.config.ext ?? "");
      return {
        key: t.id,
        dir: String(t.config.dir),
        debounceMs: Number(t.config.debounceMs ?? 3000),
        filter: ext ? (name: string) => name.endsWith(ext) : undefined,
        onChange: () => {
          const task = getTask(t.taskId);
          if (!task?.enabled) return;
          startTaskRun({
            taskId: t.taskId,
            triggerId: t.id,
            triggerKind: "fs",
            scheduledFor: Date.now(),
          });
        },
      };
    });
  pool.sync(specs);
}
