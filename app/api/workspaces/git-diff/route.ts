import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { getDB } from "@/lib/server/sqlite";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function git(cwd: string, args: string[]) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024, // 10MB
    timeout: 30_000,
    env: { ...process.env, http_proxy: "", https_proxy: "", ALL_PROXY: "" },
  });
}

export type ChangedFile = {
  path: string;
  status: "M" | "A" | "D" | "R" | "??";
  staged: boolean;
  additions: number;
  deletions: number;
};

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspaceId = url.searchParams.get("workspaceId");
  if (!workspaceId) {
    return Response.json({ error: "workspaceId 必填" }, { status: 400 });
  }

  const db = getDB();
  const ws = db
    .prepare("SELECT id, name, path, kind, git_branch FROM workspaces WHERE id = ?")
    .get(workspaceId) as
    | { id: string; name: string; path: string; kind: string; git_branch: string | null }
    | undefined;

  if (!ws) {
    return Response.json({ error: "工作区未找到" }, { status: 404 });
  }

  if (!fs.existsSync(ws.path)) {
    return Response.json({ error: `目录不存在：${ws.path}` }, { status: 404 });
  }

  // 检查是否为 git 仓库
  const isGit = git(ws.path, ["rev-parse", "--is-inside-work-tree"]).status === 0;
  if (!isGit) {
    return Response.json({
      workspaceId: ws.id,
      name: ws.name,
      path: ws.path,
      isGit: false,
      branch: null,
      files: [],
      diff: "",
      dirtyCount: 0,
    });
  }

  // 1. 获取 branch 与 upstream 信息
  const branchStatus = git(ws.path, ["status", "--porcelain=v2", "--branch"]);
  const branchLines = branchStatus.status === 0 ? branchStatus.stdout.split("\n") : [];
  let branchName = ws.git_branch;
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;

  for (const line of branchLines) {
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

  // 2. 获取 numstat (+/- 行数)
  const numstatMap = new Map<string, { additions: number; deletions: number }>();

  // unstaged numstat
  const unstagedNum = git(ws.path, ["diff", "--numstat"]);
  if (unstagedNum.status === 0 && unstagedNum.stdout) {
    for (const l of unstagedNum.stdout.split("\n").filter(Boolean)) {
      const [add, del, file] = l.split(/\t/);
      if (file) {
        numstatMap.set(file, {
          additions: parseInt(add, 10) || 0,
          deletions: parseInt(del, 10) || 0,
        });
      }
    }
  }

  // staged numstat
  const stagedNum = git(ws.path, ["diff", "--cached", "--numstat"]);
  if (stagedNum.status === 0 && stagedNum.stdout) {
    for (const l of stagedNum.stdout.split("\n").filter(Boolean)) {
      const [add, del, file] = l.split(/\t/);
      if (file) {
        const prev = numstatMap.get(file) || { additions: 0, deletions: 0 };
        numstatMap.set(file, {
          additions: prev.additions + (parseInt(add, 10) || 0),
          deletions: prev.deletions + (parseInt(del, 10) || 0),
        });
      }
    }
  }

  // 3. 获取文件清单状态
  const files: ChangedFile[] = [];
  const statusShort = git(ws.path, ["status", "--porcelain=v1"]);
  if (statusShort.status === 0 && statusShort.stdout) {
    for (const line of statusShort.stdout.split("\n").filter(Boolean)) {
      const indexStatus = line[0];
      const workTreeStatus = line[1];
      const filePath = line.slice(3).trim();

      const isUntracked = indexStatus === "?" && workTreeStatus === "?";
      const isStaged = indexStatus !== " " && indexStatus !== "?" && indexStatus !== "!";

      let statusKind: ChangedFile["status"] = "M";
      if (isUntracked) statusKind = "??";
      else if (indexStatus === "A" || workTreeStatus === "A") statusKind = "A";
      else if (indexStatus === "D" || workTreeStatus === "D") statusKind = "D";
      else if (indexStatus === "R" || workTreeStatus === "R") statusKind = "R";

      const stats = numstatMap.get(filePath) || { additions: 0, deletions: 0 };

      files.push({
        path: filePath,
        status: statusKind,
        staged: isStaged,
        additions: stats.additions,
        deletions: stats.deletions,
      });
    }
  }

  // 4. 获取统一 diff 内容
  const unstagedDiff = git(ws.path, ["diff"]);
  const stagedDiff = git(ws.path, ["diff", "--cached"]);

  let fullDiff = "";
  if (stagedDiff.status === 0 && stagedDiff.stdout) {
    fullDiff += `# 暂存区改动 (Staged Changes):\n${stagedDiff.stdout}\n`;
  }
  if (unstagedDiff.status === 0 && unstagedDiff.stdout) {
    if (fullDiff) fullDiff += "\n";
    fullDiff += `# 工作区改动 (Unstaged Changes):\n${unstagedDiff.stdout}`;
  }

  // 如果 diff 太大（> 200KB），进行安全截断
  if (fullDiff.length > 200_000) {
    fullDiff = fullDiff.slice(0, 200_000) + "\n\n... (Diff 过长，已截断展示前 200KB)";
  }

  return Response.json({
    workspaceId: ws.id,
    name: ws.name,
    path: ws.path,
    isGit: true,
    branch: branchName,
    upstream,
    ahead,
    behind,
    files,
    diff: fullDiff,
    dirtyCount: files.length,
  });
}
