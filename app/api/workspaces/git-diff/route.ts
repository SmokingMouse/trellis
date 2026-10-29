import fs from "node:fs";
import path from "node:path";
import {
  DIFF_SCOPES,
  git,
  resolveBaseRef,
  resolveDiffTarget,
  type DiffScope,
} from "@/lib/server/workspace-git-diff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type ChangedFile = {
  path: string;
  status: "M" | "A" | "D" | "R" | "??";
  staged: boolean;
  additions: number;
  deletions: number;
};

// GET /api/workspaces/git-diff?workspaceId=… | sessionId=… [&scope=all|unstaged|staged|base]
//
// scope（审阅层的过滤）：
//   all      = git diff HEAD（暂存 + 未暂存）+ 未跟踪文件     ← 默认
//   unstaged = git diff（工作区 vs 暂存区）+ 未跟踪文件
//   staged   = git diff --cached
//   base     = git diff <merge-base(HEAD, 默认分支)>（含工作区改动）+ 未跟踪文件
// diff 字段是原始统一 diff（不再夹带「# 暂存区改动」标题），客户端 lib/unified-diff 解析。
// files 字段仍是 porcelain 状态清单（侧栏角标 / 总数口径），与 scope 无关。
//
// 认证由 proxy.ts 统一拦 /api/*。路径只从 DB 取，不接受客户端传路径。

const MAX_DIFF = 2_000_000;
const MAX_UNTRACKED_FILES = 50;
const MAX_UNTRACKED_BYTES = 256 * 1024;

const DIFF_FLAGS = ["--no-color", "--no-ext-diff", "-M"];

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = resolveDiffTarget(url.searchParams);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });
  const { target } = resolved;
  const cwd = target.path;
  const scopeParam = url.searchParams.get("scope") as DiffScope | null;
  const scope: DiffScope = scopeParam && DIFF_SCOPES.includes(scopeParam) ? scopeParam : "all";

  const base = {
    workspaceId: target.workspaceId,
    sessionId: target.sessionId,
    name: target.name,
    path: target.path,
    scope,
  };

  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.code !== 0) {
    return Response.json({
      ...base,
      isGit: false,
      root: null,
      prefix: "",
      branch: null,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      untracked: [],
      diff: "",
      truncated: false,
      baseRef: null,
      dirtyCount: 0,
    });
  }

  const [top, prefixR, branchStatus, unstagedNum, stagedNum, statusShort, headR] = await Promise.all([
    git(cwd, ["rev-parse", "--show-toplevel"]),
    git(cwd, ["rev-parse", "--show-prefix"]),
    git(cwd, ["status", "--porcelain=v2", "--branch"]),
    git(cwd, ["diff", "--numstat"]),
    git(cwd, ["diff", "--cached", "--numstat"]),
    git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
    git(cwd, ["rev-parse", "--verify", "--quiet", "HEAD"]),
  ]);
  const root = top.stdout.trim() || cwd;
  const prefix = prefixR.stdout.trim();
  const hasHead = headR.code === 0;

  // 1. branch / upstream
  let branchName: string | null = null;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  for (const line of branchStatus.code === 0 ? branchStatus.stdout.split("\n") : []) {
    if (line.startsWith("# branch.head ")) {
      const h = line.slice("# branch.head ".length).trim();
      if (h && h !== "(detached)") branchName = h;
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length).trim() || null;
    } else if (line.startsWith("# branch.ab ")) {
      const parts = line.slice("# branch.ab ".length).trim().split(/\s+/);
      ahead = parseInt(parts[0], 10) || 0;
      behind = parseInt(parts[1], 10) || 0;
    }
  }

  // 2. porcelain 清单 + numstat（files 字段口径保持旧版）
  const numstatMap = new Map<string, { additions: number; deletions: number }>();
  for (const r of [unstagedNum, stagedNum]) {
    if (r.code !== 0) continue;
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const [add, del, file] = l.split(/\t/);
      if (!file) continue;
      const prev = numstatMap.get(file) || { additions: 0, deletions: 0 };
      numstatMap.set(file, {
        additions: prev.additions + (parseInt(add, 10) || 0),
        deletions: prev.deletions + (parseInt(del, 10) || 0),
      });
    }
  }
  const files: ChangedFile[] = [];
  const untracked: string[] = [];
  if (statusShort.code === 0) {
    // -z：路径不加引号不转义；重命名记录是「XY 新路径\0旧路径\0」
    const records = statusShort.stdout.split("\0");
    for (let i = 0; i < records.length; i++) {
      const line = records[i];
      if (line.length < 4) continue;
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3);
      if (indexStatus === "R" || indexStatus === "C") i++; // 跳过旧路径
      const isUntracked = indexStatus === "?" && workTreeStatus === "?";
      const isStaged = indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!";
      let statusKind: ChangedFile["status"] = "M";
      if (isUntracked) statusKind = "??";
      else if (indexStatus === "A" || workTreeStatus === "A") statusKind = "A";
      else if (indexStatus === "D" || workTreeStatus === "D") statusKind = "D";
      else if (indexStatus === "R" || workTreeStatus === "R") statusKind = "R";
      if (isUntracked) untracked.push(filePath);
      const stats = numstatMap.get(filePath) || { additions: 0, deletions: 0 };
      files.push({ path: filePath, status: statusKind, staged: isStaged, ...stats });
    }
  }

  // 3. 按 scope 取统一 diff（在仓库根跑，路径统一是根相对）
  let baseRef: string | null = null;
  let baseError: string | null = null;
  let diffArgs: string[] | null;
  if (scope === "staged") diffArgs = ["diff", "--cached", ...DIFF_FLAGS];
  else if (scope === "unstaged") diffArgs = ["diff", ...DIFF_FLAGS];
  else if (scope === "base") {
    baseRef = await resolveBaseRef(root);
    const mb = baseRef && hasHead ? await git(root, ["merge-base", "HEAD", baseRef]) : null;
    if (!baseRef) {
      baseError = "找不到默认分支（origin/HEAD、main、master 都不存在）";
      diffArgs = null;
    } else if (!mb || mb.code !== 0 || !mb.stdout.trim()) {
      baseError = `当前分支与 ${baseRef} 没有共同祖先`;
      diffArgs = null;
    } else {
      diffArgs = ["diff", ...DIFF_FLAGS, mb.stdout.trim()];
    }
  } else {
    // 没有任何提交的新仓库：没有 HEAD，退回「暂存区相对空树」
    diffArgs = hasHead ? ["diff", ...DIFF_FLAGS, "HEAD"] : ["diff", "--cached", ...DIFF_FLAGS];
  }

  let diff = "";
  if (diffArgs) {
    const r = await git(root, diffArgs);
    diff = r.stdout;
  }

  // 未跟踪文件不在 git diff 里：用 --no-index 对 /dev/null 合成新增 diff（有上限）
  if (scope !== "staged" && !baseError) {
    // porcelain 的路径本来就是仓库根相对（与 cwd 是否子目录无关）
    let budget = MAX_UNTRACKED_FILES;
    for (const rel of untracked) {
      if (budget-- <= 0 || diff.length > MAX_DIFF) break;
      const abs = path.join(root, rel);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(abs);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > MAX_UNTRACKED_BYTES) {
        diff += `diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary files /dev/null and b/${rel} differ\n`;
        continue;
      }
      const r = await git(root, ["diff", "--no-color", "--no-ext-diff", "--no-index", "--", "/dev/null", rel]);
      if (r.stdout) diff += (diff && !diff.endsWith("\n") ? "\n" : "") + r.stdout;
    }
  }

  let truncated = false;
  if (diff.length > MAX_DIFF) {
    diff = diff.slice(0, MAX_DIFF);
    truncated = true;
  }

  return Response.json({
    ...base,
    isGit: true,
    root,
    prefix,
    branch: branchName,
    upstream,
    ahead,
    behind,
    files,
    untracked,
    diff,
    truncated,
    baseRef,
    baseError,
    dirtyCount: files.length,
  });
}
