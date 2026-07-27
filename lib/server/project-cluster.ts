import "server-only";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

// S1（progress/project-workspace-layer.md）：把一个绝对路径归到某个「项目」下。
//
// 聚类的核心是 `git rev-parse --git-common-dir` —— 同一个 repo 的所有 worktree
// 共享同一个 common dir，这是把 trellis / sole / trevally 三个目录认成一个项目的
// 唯一可靠依据（它们路径无公共前缀、basename 也毫不相干）。
//
// 去重键分三档降级，越靠前越稳：
//   1. 归一化的 remote URL —— 跨机器、跨 clone 位置都同值
//   2. common dir 路径     —— 纯本地 repo（无 remote）也能把 worktree 聚起来
//   3. 父目录路径          —— 非 git 目录的兜底，至少同一个上级目录能聚一起

export type WorkspaceKind = "main" | "worktree" | "plain";

export interface ClusterResult {
  /** projects.cluster_key —— 去重键，见上面三档 */
  clusterKey: string;
  /** projects.name 的默认值，用户可改 */
  projectName: string;
  /** projects.git_remote —— 只存真实 remote 供显示，非 git 为 null */
  gitRemote: string | null;
  /** workspaces.name 的默认值 */
  workspaceName: string;
  kind: WorkspaceKind;
  /** workspaces.git_branch，非 git 或 detached 为 null */
  gitBranch: string | null;
}

const SCRATCH_ROOT = path.join(os.homedir(), ".trellis");

function git(cwd: string, args: string[]): string | null {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 5000,
    // git 不该继承 clash 的代理变量：remote get-url 是纯本地读 config，
    // 但 http_proxy 污染会让某些 git 子命令莫名变慢/报错。
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
  if (r.error || r.status !== 0) return null;
  const out = r.stdout.trim();
  return out === "" ? null : out;
}

/**
 * 归一化 remote URL，让同一个 repo 的不同写法收敛成一个键：
 *   git@github.com:Foo/bar.git      → github.com/Foo/bar
 *   https://github.com/Foo/bar.git  → github.com/Foo/bar
 *   ssh://git@github.com/Foo/bar    → github.com/Foo/bar
 */
export function normalizeRemote(url: string): string {
  let s = url.trim();
  // scp 式 `git@host:path`（注意要排掉 `C:\...` 这种盘符，故要求 host 含点或斜杠前有多字符）
  const scp = /^(?:[\w.-]+@)?([\w.-]+\.[\w.-]+):(.+)$/.exec(s);
  if (scp) {
    s = `${scp[1]}/${scp[2]}`;
  } else {
    s = s.replace(/^[a-z+]+:\/\//i, ""); // 剥 scheme
    s = s.replace(/^[^/@]+@/, ""); // 剥 user@
  }
  s = s.replace(/\.git$/i, "");
  s = s.replace(/\/+$/, "");
  return s.toLowerCase();
}

/** 从归一化 remote 派生项目名：取最后一段（仓库名） */
function projectNameFromRemote(normalized: string): string {
  const seg = normalized.split("/").filter(Boolean);
  return seg[seg.length - 1] || normalized;
}

/**
 * 工具自动生成的临时 worktree —— 不是用户的工作区，别登记。
 *
 * 实测（本机 trellis repo）：`git worktree list` 会列出
 * `<repo>/.claude/worktrees/agent-<hash>` —— 那是 Claude Code 给
 * `isolation: "worktree"` 的 subagent 开的隔离目录，机器生成、任务完成即删。
 * 登记它们只会在侧栏堆一地看不懂的哈希，且很快变成指向已删目录的死行。
 */
function isEphemeralWorktree(p: string): boolean {
  const parts = p.split(path.sep);
  const i = parts.indexOf(".claude");
  return i >= 0 && parts[i + 1] === "worktrees";
}

/**
 * 列出与给定路径同属一个 repo 的所有 worktree 的绝对路径（含主 checkout 自己）。
 *
 * 存在的理由：光靠「有 session 的目录」发现不了 worktree —— 一个还没在 trellis
 * 里开过会话的 worktree 永远不会出现在侧栏，用户也就永远不会想到去用它。
 * 主动扫一遍，让「这个项目有哪几条并行分支」一眼可见。
 *
 * 非 git / 无 worktree / git 不可用 → 返回空数组。
 */
export function listSiblingWorktrees(absPath: string): string[] {
  const out = git(absPath, ["worktree", "list", "--porcelain"]);
  if (!out) return [];
  const paths: string[] = [];
  for (const line of out.split("\n")) {
    if (!line.startsWith("worktree ")) continue;
    const p = line.slice("worktree ".length).trim();
    if (!p) continue;
    if (isEphemeralWorktree(p)) continue;
    // prunable/bare 的条目路径可能已不存在，交给 clusterPath 的 statSync 去挡
    paths.push(p);
  }
  return paths;
}

/**
 * 把一个绝对路径归类。路径不存在返回 null（调用方跳过 —— 存量 DB 里有
 * 已被删掉的目录，`/api/workspaces/recent` 同样用 existsSync 过滤）。
 */
export function clusterPath(absPath: string): ClusterResult | null {
  if (!absPath || !path.isAbsolute(absPath)) return null;
  let real: string;
  try {
    if (!fs.statSync(absPath).isDirectory()) return null;
    real = fs.realpathSync(absPath);
  } catch {
    return null;
  }

  const base = path.basename(real);

  // 家目录特判：走通用「父目录当键」会把 ~ 归成一个叫 "Users" 的项目（键
  // dir:/Users），荒谬。家目录自成一档。
  if (real === fs.realpathSync(os.homedir())) {
    return {
      clusterKey: "trellis:home",
      projectName: "主目录",
      gitRemote: null,
      workspaceName: base,
      kind: "plain",
      gitBranch: null,
    };
  }

  // 暂存区特判：~/.trellis/scratch/* 与 ~/.trellis/chat-scratch 都是 trellis 自己
  // 生成的一次性目录，聚成一个「暂存区」项目，别按父目录当真项目对待。
  if (real === SCRATCH_ROOT || real.startsWith(SCRATCH_ROOT + path.sep)) {
    return {
      clusterKey: "trellis:scratch",
      projectName: "暂存区",
      gitRemote: null,
      workspaceName: base,
      kind: "plain",
      gitBranch: null,
    };
  }

  // --path-format=absolute 让 main repo 也返回绝对路径（否则 common-dir 会是
  // 相对的 ".git"，两个不同 repo 的 main checkout 会撞成同一个键）。
  const dirs = git(real, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
    "--git-dir",
  ]);

  if (!dirs) {
    // 非 git（或没装 git）：父目录当键。至少 /python/learning 下的散目录能聚一起。
    const parent = path.dirname(real);
    return {
      clusterKey: `dir:${parent}`,
      projectName: path.basename(parent) || parent,
      gitRemote: null,
      workspaceName: base,
      kind: "plain",
      gitBranch: null,
    };
  }

  const [commonDir, gitDir] = dirs.split("\n").map((l) => l.trim());
  // main repo：git-dir === common-dir。linked worktree：git-dir 是
  // <main>/.git/worktrees/<name>，common-dir 仍是 <main>/.git。
  const kind: WorkspaceKind = gitDir === commonDir ? "main" : "worktree";
  const gitBranch = git(real, ["branch", "--show-current"]);

  const rawRemote =
    git(real, ["remote", "get-url", "origin"]) ??
    (() => {
      const first = git(real, ["remote"])?.split("\n")[0]?.trim();
      return first ? git(real, ["remote", "get-url", first]) : null;
    })();

  if (rawRemote) {
    const normalized = normalizeRemote(rawRemote);
    return {
      clusterKey: `remote:${normalized}`,
      projectName: projectNameFromRemote(normalized),
      gitRemote: rawRemote,
      // 名字用目录名而非分支名：分支随时会切，而 workspace 是「这个目录」。
      // 分支单独存在 gitBranch 里，由 UI 作为状态另行显示（P2）。
      workspaceName: base,
      kind,
      gitBranch,
    };
  }

  // 有 git 无 remote：用 common dir 当键 —— 纯本地 repo 的 worktree 也能聚起来。
  // 项目名取 common dir 的上一级（即主 checkout 的目录名），而不是 ".git"。
  const repoRoot = path.basename(path.dirname(commonDir));
  return {
    clusterKey: `gitdir:${commonDir}`,
    projectName: repoRoot || base,
    gitRemote: null,
    workspaceName: gitBranch || base,
    kind,
    gitBranch,
  };
}
