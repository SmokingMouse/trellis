import "server-only";
import { getDB } from "./sqlite";
import { parseCron, cronMatches } from "@/lib/cron";
import {
  claimSlot,
  drainPending,
  getTask,
  listTriggers,
  refreshFsWatches,
  setTriggerCursor,
  startTaskRun,
  type TaskTrigger,
} from "./tasks";
import { checkAuthAlerts } from "./auth-health";

// S88: 定时调度器。挂在 instrumentation.ts（进程唯一的启动钩子）。
//
// 设计要点，每条都对应一个具体的失败模式：
//
//  · **tick 前对齐整分钟**：不对齐的话，09:00:58 启动的进程 tick 落在 :58、
//    下一次 09:01:58，`0 9 * * *` 这一分钟永远踩不准，只能靠 catch-up 兜。
//  · **去重靠唯一索引抢槽**（claimSlot），不做进程租约 —— 索引已经保证正确性，
//    租约只换来日志干净，代价是多一张表 + 心跳 + 过期判定 + 一类新故障。
//  · **catch-up 只补窗口内最近一次**：不全补（`*/10` 挂一夜 → 开机瞬间 144 个
//    run 排队烧光 token），也不完全不补（崩溃退避重启和 make deploy 都是常态，
//    不补就是「今天的日报没了但没人知道」）。
//  · **两台实例不共享 DB**（BOE 是独立 $HOME，PROD_DB 各自解析），跨机器双触发
//    不存在。代价是任务定义不互通 —— 这是对的，workspace_path 本就是本机路径。

const TICK_MS = 60_000;
/** catch-up 窗口。日报类在 6h 内重启能补上；隔夜大停机不补 —— 那时候补也没意义
 * （数据早过期），用户早上自己点 ▶ 更好。模块常量，不做配置项。 */
const CATCHUP_WINDOW_MS = 6 * 60 * 60 * 1000;
/** git 触发器的默认轮询间隔。 */
const DEFAULT_GIT_POLL_MS = 5 * 60_000;

let started = false;
let timer: ReturnType<typeof setInterval> | null = null;

export function startTaskScheduler(): void {
  // ★ 部署闸。scripts/deploy.ts 的 smoke 阶段会 VACUUM 出一份**真数据快照**再起
  // 一个完整实例 —— 它会加载 instrumentation、看到真任务表、**真 spawn claude
  // 去跑**，花真钱动真 workspace。没有这道闸，每次部署都会误触发一遍到期任务。
  if (process.env.TRELLIS_SCHEDULER === "off") {
    console.log("[scheduler] TRELLIS_SCHEDULER=off，不启动");
    return;
  }
  if (started) return;
  started = true;

  void catchUp();
  refreshFsWatches();
  // S95: 启动即查一次授权健康（部署/重启后马上发现认证挂了，别再等有人开会话）。
  // 自兜异常 + 24h 去重都在 checkAuthAlerts 里。跟着 TRELLIS_SCHEDULER 闸走 ——
  // smoke 实例不该发真预警。
  void checkAuthAlerts();

  // 首次对齐到整分钟边界 +2s，之后每分钟一次。
  const now = new Date();
  const msToNextMinute = (60 - now.getSeconds()) * 1000 - now.getMilliseconds();
  setTimeout(() => {
    void tick();
    timer = setInterval(() => void tick(), TICK_MS);
  }, msToNextMinute + 2000);

  console.log("[scheduler] 已启动");
}

export function stopTaskScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
}

function readLastTick(): number | null {
  const r = getDB().query("SELECT last_tick_at FROM scheduler_state WHERE id = 1").get() as
    | { last_tick_at: number }
    | undefined;
  return r?.last_tick_at ?? null;
}

function writeLastTick(t: number): void {
  getDB()
    .prepare(
      `INSERT INTO scheduler_state (id, last_tick_at) VALUES (1, ?)
       ON CONFLICT(id) DO UPDATE SET last_tick_at = excluded.last_tick_at`,
    )
    .run(t);
}

/** 对齐到整分钟的槽位时间戳。**唯一索引能生效的前提** —— 写成 Date.now() 的话
 * 每次调用都是新值，约束形同虚设；叠加 server.ts 的崩溃退避反复重启 ×
 * 每次重启跑一次 catch-up，就从崩溃循环变成烧钱循环。 */
function slotOf(d: Date): number {
  const x = new Date(d.getTime());
  x.setSeconds(0, 0);
  return x.getTime();
}

function cronTriggers(): TaskTrigger[] {
  return listTriggers().filter((t) => t.enabled && t.kind === "cron");
}

/** 补跑：窗口内每个 cron trigger **只补最近一次**。 */
async function catchUp(): Promise<void> {
  try {
    const now = Date.now();
    const last = readLastTick();
    if (last === null) {
      // 首次启动（或 schema 刚建）：没有「漏跑」的概念，只记个基准。
      writeLastTick(now);
      return;
    }
    const from = Math.max(last, now - CATCHUP_WINDOW_MS);
    if (from >= now) return;

    const triggers = cronTriggers();
    if (!triggers.length) {
      writeLastTick(now);
      return;
    }
    // 逐分钟回扫，每个 trigger 只留**最大**的那个匹配时刻。
    const latest = new Map<string, number>();
    const cursor = new Date(from);
    cursor.setSeconds(0, 0);
    cursor.setMinutes(cursor.getMinutes() + 1);
    while (cursor.getTime() <= now) {
      for (const t of triggers) {
        const f = parseCron(String(t.config.expr ?? ""));
        if (f && cronMatches(f, cursor)) latest.set(t.id, cursor.getTime());
      }
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    for (const [triggerId, slot] of latest) {
      const t = triggers.find((x) => x.id === triggerId)!;
      const task = getTask(t.taskId);
      if (!task?.enabled) continue;
      const runId = claimSlot({
        taskId: t.taskId,
        triggerId,
        triggerKind: "cron",
        scheduledFor: slot,
      });
      if (runId) {
        console.log(
          `[scheduler] catch-up 补跑「${task.name}」（漏跑槽位 ${new Date(slot).toLocaleString()}）`,
        );
      }
    }
    writeLastTick(now);
    drainPending();
  } catch (e) {
    console.error("[scheduler] catchUp 失败：", e);
  }
}

async function tick(): Promise<void> {
  try {
    const now = new Date();
    const slot = slotOf(now);

    // 先捞 pending 队列（并发闸放行的补位），再处理新触发 —— 排队的比刚到点的先来。
    drainPending();
    // fs 监听跟着 tick 刷 —— 比给「增删触发器」各挂一个通知回调便宜得多，
    // 代价只是新建的 fs 触发器最多晚一分钟生效。
    refreshFsWatches();

    for (const t of cronTriggers()) {
      const f = parseCron(String(t.config.expr ?? ""));
      if (!f || !cronMatches(f, now)) continue;
      const task = getTask(t.taskId);
      if (!task?.enabled) continue;
      const r = startTaskRun({
        taskId: t.taskId,
        triggerId: t.id,
        triggerKind: "cron",
        scheduledFor: slot,
      });
      if (r.ok || r.runId) {
        getDB()
          .prepare("UPDATE task_triggers SET last_fired_at = ? WHERE id = ?")
          .run(slot, t.id);
      }
    }

    await pollGitTriggers(now.getTime());
    // S95: 每小时（:07，避开整点的 cron 高峰）复查授权健康。
    if (now.getMinutes() === 7) void checkAuthAlerts();
    writeLastTick(now.getTime());
  } catch (e) {
    console.error("[scheduler] tick 失败：", e);
  }
}

// ---------------------------------------------------------------------------
// git 触发器：轮询 `git ls-remote`
// ---------------------------------------------------------------------------
//
// 不用 git hook：要写进被监听 repo 的 .git/hooks/，侵入别人的仓库、clone 不带、
// 随时被别的工具覆盖；语义也不对 —— 用户想要的是「**远端**有新提交了」，而
// post-receive 只在服务端、pre-push 只在本机 push 时。
//
// ls-remote 比 fetch 轻得多（不落地任何 object），但要走网络 + 认证，所以超时
// 必须设，且**失败只 warn 不动 cursor** —— 动了就会在网络恢复后误触发一次。

async function pollGitTriggers(now: number): Promise<void> {
  for (const t of listTriggers()) {
    if (!t.enabled || t.kind !== "git") continue;
    const pollMs = Number(t.config.pollMs ?? DEFAULT_GIT_POLL_MS);
    if (t.lastCheckedAt && now - t.lastCheckedAt < pollMs) continue;
    const repoPath = String(t.config.repoPath ?? "");
    const branch = String(t.config.branch ?? "HEAD");
    if (!repoPath) continue;

    const sha = await gitLsRemote(repoPath, branch);
    if (!sha) {
      // 只更新「检查过了」，**不动 cursor** —— 见上方注释。
      setTriggerCursor(t.id, t.cursor, now);
      continue;
    }
    if (t.cursor && sha !== t.cursor) {
      const task = getTask(t.taskId);
      if (task?.enabled) {
        startTaskRun({
          taskId: t.taskId,
          triggerId: t.id,
          triggerKind: "git",
          scheduledFor: slotOf(new Date(now)),
        });
      }
    }
    setTriggerCursor(t.id, sha, now);
  }
}

async function gitLsRemote(repoPath: string, branch: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["git", "ls-remote", "origin", branch], {
      cwd: repoPath,
      stdout: "pipe",
      stderr: "ignore",
    });
    const timer = setTimeout(() => proc.kill(), 10_000);
    const out = await new Response(proc.stdout).text();
    await proc.exited;
    clearTimeout(timer);
    if (proc.exitCode !== 0) return null;
    const sha = out.trim().split(/\s+/)[0];
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch (e) {
    console.warn(`[scheduler] git ls-remote 失败（${repoPath}）：`, e);
    return null;
  }
}
