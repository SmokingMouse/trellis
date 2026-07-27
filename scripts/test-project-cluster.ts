// S1 P0-b 回归：项目聚类的两半 —— 纯函数 normalizeRemote，以及要真跑 git 的
// clusterPath。后者在临时目录里现造 repo / worktree / 裸目录，所以不依赖本机
// 恰好存在哪些仓库，任何机器上都能跑。
//
//   bun --conditions react-server scripts/test-project-cluster.ts
//
// `--conditions react-server` 是必须的：project-cluster.ts 有 `import
// "server-only"`，默认解析会走到那个「只准在 Server Component 里用」的抛错桩。

import { mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import {
  clusterPath,
  listSiblingWorktrees,
  normalizeRemote,
} from "@/lib/server/project-cluster";

let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = actual === expected;
  if (!ok) failed++;
  console.log(
    `${ok ? "  ✓" : "  ✗"} ${label}${ok ? "" : `\n      expected ${JSON.stringify(expected)}\n      actual   ${JSON.stringify(actual)}`}`,
  );
}

// tmp 在 macOS 上是 /private/tmp 的 symlink，而 clusterPath 内部 realpath，
// 所以基准目录也得先 realpath，否则期望值对不上。
const ROOT = path.join(
  realpathSync(os.tmpdir()),
  `trellis-cluster-test-${process.pid}`,
);
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", args, { cwd, encoding: "utf8" });

function setup() {
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true });

  // 带 remote 的 repo + 一个 worktree —— 这是本 skill 的核心场景（trellis /
  // sole / trevally 三目录路径无公共前缀，只能靠 git 认亲）。
  const withRemote = path.join(ROOT, "withremote");
  mkdirSync(withRemote);
  git(withRemote, "init", "-q", "-b", "main");
  git(withRemote, "remote", "add", "origin", "git@github.com:Acme/Widget.git");
  writeFileSync(path.join(withRemote, "f.txt"), "x");
  git(withRemote, "add", ".");
  git(withRemote, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i");
  git(withRemote, "worktree", "add", "-q", "-b", "feat", path.join(ROOT, "wt-feat"));

  // 无 remote 的本地 repo + worktree —— 走 gitdir: 档
  const noRemote = path.join(ROOT, "noremote");
  mkdirSync(noRemote);
  git(noRemote, "init", "-q", "-b", "main");
  writeFileSync(path.join(noRemote, "f.txt"), "x");
  git(noRemote, "add", ".");
  git(noRemote, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "i");
  git(noRemote, "worktree", "add", "-q", "-b", "side", path.join(ROOT, "nr-side"));

  mkdirSync(path.join(ROOT, "plainA"));
  mkdirSync(path.join(ROOT, "plainB"));
}

console.log("=== normalizeRemote ===");
for (const [input, want] of [
  ["git@github.com:Acme/Widget.git", "github.com/acme/widget"],
  ["https://github.com/Acme/Widget.git", "github.com/acme/widget"],
  ["ssh://git@github.com/Acme/Widget", "github.com/acme/widget"],
  ["https://github.com/Acme/Widget/", "github.com/acme/widget"],
] as const) {
  check(input, normalizeRemote(input), want);
}

setup();
try {
  console.log("\n=== 有 remote：main + worktree 必须同键 ===");
  const main = clusterPath(path.join(ROOT, "withremote"))!;
  const wt = clusterPath(path.join(ROOT, "wt-feat"))!;
  check("main.kind", main.kind, "main");
  check("worktree.kind", wt.kind, "worktree");
  check("同一个 clusterKey", wt.clusterKey, main.clusterKey);
  check("clusterKey 用归一化 remote", main.clusterKey, "remote:github.com/acme/widget");
  check("projectName 取仓库名", main.projectName, "widget");
  // 名字用目录名而非分支名 —— 分支随时会切，workspace 是「这个目录」。
  // 这里目录名(wt-feat) 与分支名(feat) 刻意不同，好把两者区分开。
  check("workspaceName 用目录名", wt.workspaceName, "wt-feat");
  check("gitBranch 单独存分支", wt.gitBranch, "feat");

  console.log("\n=== 无 remote：退到 gitdir: 档，仍要同键 ===");
  const nr = clusterPath(path.join(ROOT, "noremote"))!;
  const nrSide = clusterPath(path.join(ROOT, "nr-side"))!;
  check("同一个 clusterKey", nrSide.clusterKey, nr.clusterKey);
  check("走 gitdir 档", nr.clusterKey.startsWith("gitdir:"), true);
  check("projectName 是主 checkout 目录名而非 .git", nr.projectName, "noremote");
  check("gitRemote 为 null", nr.gitRemote, null);
  check("与有 remote 的项目不同键", nr.clusterKey === main.clusterKey, false);

  console.log("\n=== 非 git：父目录当键 ===");
  const pa = clusterPath(path.join(ROOT, "plainA"))!;
  const pb = clusterPath(path.join(ROOT, "plainB"))!;
  check("kind=plain", pa.kind, "plain");
  check("同父目录 → 同键", pb.clusterKey, pa.clusterKey);
  check("键是 dir:<父目录>", pa.clusterKey, `dir:${ROOT}`);

  console.log("\n=== 兄弟 worktree 扫描 ===");
  // 造一个 Claude Code 式的 subagent 隔离 worktree，必须被滤掉：真机上
  // `git worktree list` 会列出 <repo>/.claude/worktrees/agent-<hash>，
  // 那是机器生成、用完即删的，登记进侧栏只会堆一地死行。
  const wr = path.join(ROOT, "withremote");
  git(wr, "worktree", "add", "-q", "-b", "eph", path.join(wr, ".claude/worktrees/agent-deadbeef"));
  const sibs = listSiblingWorktrees(wr);
  check("扫到主 checkout", sibs.includes(wr), true);
  check("扫到兄弟 worktree", sibs.includes(path.join(ROOT, "wt-feat")), true);
  check(
    "滤掉 .claude/worktrees/ 下的 subagent 临时 worktree",
    sibs.some((p) => p.includes(".claude")),
    false,
  );
  check("非 git 目录 → 空数组", listSiblingWorktrees(path.join(ROOT, "plainA")).length, 0);

  console.log("\n=== 特判与边界 ===");
  check("家目录自成一档", clusterPath(os.homedir())!.clusterKey, "trellis:home");
  check(
    "暂存区聚一起",
    clusterPath(path.join(os.homedir(), ".trellis", "chat-scratch"))?.clusterKey ??
      "trellis:scratch",
    "trellis:scratch",
  );
  check("不存在的路径 → null", clusterPath(path.join(ROOT, "nope")), null);
  check("相对路径 → null", clusterPath("relative/path"), null);
} finally {
  rmSync(ROOT, { recursive: true, force: true });
}

console.log(failed === 0 ? "\nALL PASS" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
