import "server-only";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

// S1 P2：workspace 的实时 git 状态（分支 / 脏文件数 / 能不能回收）。
//
// 刻意**不进** listProjectTree：那个函数是同步的，且挂在 /api/sessions 上，
// 而侧栏的 fetch 依赖里有 sessionsRevision —— cli-sync 的 600ms 合并窗口
// 会让它在流式期间达到 ~1.6 次/秒。在那里 spawn git 会把 SSE 拖垮。
// 这里全程 execFile 的 promise 版（现存 git helper 都是 spawnSync，
// 10 个 workspace × ~30ms = 300ms 阻塞事件循环，那是不能接受的）。

export type WorkspaceGitStatus = {
  id: string;
  /** detached HEAD / 非 git → null */
  branch: string | null;
  /** 改动 + 未跟踪的文件数（不含被 .gitignore 忽略的） */
  dirty: number;
  /** 分支已并入主干且工作区干净 —— 可以安全回收了 */
  reclaimable: boolean;
};

const TTL_MS = 10_000;
type CacheEntry = { at: number; value: WorkspaceGitStatus };
const cache = new Map<string, CacheEntry>();

/**
 * 让缓存立刻作废。
 *
 * 缓存必须可失效 —— `fba0d28` 修的就是「ttyd 探测失败被永久缓存」，
 * 一次瞬时结果焊死到进程重启。同一个坑不踩两次。
 */
export function invalidateGitStatus(id?: string): void {
  if (id) cache.delete(id);
  else cache.clear();
}

async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      timeout: 10_000,
      env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
    });
    return stdout.trim();
  } catch {
    // 非零退出在这里是常态（rev-parse --verify 探不到分支、非 git 目录…），
    // 一律当「没有」处理。状态是锦上添花，绝不该把接口带崩。
    return null;
  }
}

/**
 * 这个 repo 的主干分支名。
 *
 * `origin/HEAD` 是最可靠的来源，而且它是**本地引用**、不走网络。
 * 实测本机两个 repo 给出的答案不同（trellis → main，~/.claude → master），
 * 所以写死 "main" 会让后者的所有判断全错。
 *
 * 绝不降级到 `git remote show origin` —— 那会发起网络请求，一次断网
 * 就能让整个侧栏卡住。探不到就返回 null，宁可不判也不瞎判。
 */
async function defaultBranch(cwd: string): Promise<string | null> {
  const head = await git(cwd, [
    "symbolic-ref",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  if (head) return head.replace(/^origin\//, "");
  for (const b of ["main", "master", "trunk"]) {
    if (await git(cwd, ["rev-parse", "--verify", "--quiet", b])) return b;
  }
  return null;
}

/**
 * 这条分支是不是已经并入主干了。
 *
 * 判据 = **分支 tip 是某个 merge commit 的第二父**（`--ancestry-path` 限定
 * 只看 tip 到主干这条线上的合并）。
 *
 * 为什么不用 `git merge-base --is-ancestor`：实测它对「刚建出来还没提交的
 * worktree」和「真做完已合并的分支」返回**同一个值**（都是 0）——
 * 因为前者的 tip 就等于主干的 tip，天然是自己的祖先。用它做判据会建议你
 * 删掉正在用的工作区，而刚建的 worktree 恰恰是干净的、dirty 闸兜不住。
 *
 * 为什么基准用**本地**主干而不是 `origin/main`：实测 `origin/main` 常常
 * 领先本地 main（`git fetch` 一跑就发生），拿它当基准会让「tip != 基准 tip」
 * 对正在用的工作区成立，同样误判。而 `--no-ff` 合并本来就是先落本地。
 *
 * 已知漏报：squash / rebase 合并下 tip 不在主干的可达集里，这里会返回 false
 * （该提示回收却不提示）。方向是安全的 —— 宁可漏报也不能误报。
 */
async function isMergedInto(
  cwd: string,
  tip: string,
  base: string,
): Promise<boolean> {
  const out = await git(cwd, [
    "rev-list",
    "--merges",
    "--parents",
    "--ancestry-path",
    `${tip}..${base}`,
  ]);
  if (!out) return false;
  // 每行形如 "<merge> <parent1> <parent2> …"，跳过第一列（merge 自己）
  return out
    .split("\n")
    .some((line) => line.trim().split(/\s+/).slice(1).includes(tip));
}

async function statusOf(row: {
  id: string;
  path: string;
  kind: string;
}): Promise<WorkspaceGitStatus> {
  const empty: WorkspaceGitStatus = {
    id: row.id,
    branch: null,
    dirty: 0,
    reclaimable: false,
  };

  // 一条命令同时拿到分支名与脏文件 —— `# ` 开头的是 header 行，其余是变更。
  const st = await git(row.path, ["status", "--porcelain=v2", "--branch"]);
  if (st === null) return empty;

  const lines = st.split("\n").filter(Boolean);
  const headLine = lines.find((l) => l.startsWith("# branch.head "));
  const head = headLine?.slice("# branch.head ".length).trim() ?? null;
  // git 对 detached HEAD 输出的字面量就是 "(detached)"
  const branch = head && head !== "(detached)" ? head : null;
  const dirty = lines.filter((l) => !l.startsWith("# ")).length;

  // 主 checkout 恒不可回收：它满足任何纯 git 判据（自己合并进自己），
  // 但删掉它等于删掉整个仓库。删除接口那边也有一道 kind 闸，
  // 但角标不能先撒谎、等用户点了才被拒。
  if (row.kind !== "worktree" || !branch || dirty > 0) {
    return { id: row.id, branch, dirty, reclaimable: false };
  }

  const base = await defaultBranch(row.path);
  if (!base || base === branch) {
    return { id: row.id, branch, dirty, reclaimable: false };
  }
  const tip = await git(row.path, ["rev-parse", branch]);
  if (!tip) return { id: row.id, branch, dirty, reclaimable: false };

  return {
    id: row.id,
    branch,
    dirty,
    reclaimable: await isMergedInto(row.path, tip, base),
  };
}

/**
 * 批量取状态。只碰 git 工作区且目录还在的行 —— 实测 13 个 workspace 里
 * 有 6 个是 plain（scratch / 家目录 / tmp），给它们 spawn git 是纯浪费。
 */
export async function collectGitStatus(
  rows: { id: string; path: string; kind: string }[],
): Promise<WorkspaceGitStatus[]> {
  const now = Date.now();
  const todo: typeof rows = [];
  const out: WorkspaceGitStatus[] = [];

  for (const row of rows) {
    if (row.kind !== "main" && row.kind !== "worktree") continue;
    if (!fs.existsSync(row.path)) continue;
    const hit = cache.get(row.id);
    if (hit && now - hit.at < TTL_MS) out.push(hit.value);
    else todo.push(row);
  }

  const fresh = await Promise.all(
    todo.map((row) =>
      statusOf(row).catch(() => ({
        id: row.id,
        branch: null,
        dirty: 0,
        reclaimable: false,
      })),
    ),
  );
  for (const value of fresh) {
    cache.set(value.id, { at: now, value });
    out.push(value);
  }
  return out;
}
