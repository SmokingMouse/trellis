import fs from "node:fs";
import { fenceRepoPath, git, resolveDiffTarget } from "@/lib/server/workspace-git-diff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// GET /api/workspaces/git-diff/file?workspaceId=… | sessionId=… &path=<仓库根相对路径>[&rev=head]
//   → { path, rev, content, binary, truncated, size }
// 审阅层的「完整文件」：默认读工作区当前内容；文件已删除或 rev=head 时读 HEAD 版本。
// 路径经 fenceRepoPath 限定在仓库根内（含符号链接解析），认证由 proxy.ts 统一拦。

const MAX_BYTES = 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const resolved = resolveDiffTarget(url.searchParams);
  if ("error" in resolved) return Response.json({ error: resolved.error }, { status: resolved.status });
  const rel = url.searchParams.get("path") ?? "";
  const wantHead = url.searchParams.get("rev") === "head";

  const top = await git(resolved.target.path, ["rev-parse", "--show-toplevel"]);
  if (top.code !== 0) return Response.json({ error: "不是 Git 仓库" }, { status: 400 });
  const root = top.stdout.trim();
  const abs = fenceRepoPath(root, rel);
  if (!abs) return Response.json({ error: "路径不在仓库内" }, { status: 400 });

  let buf: Buffer | null = null;
  let rev: "worktree" | "head" = "worktree";
  if (!wantHead) {
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) return Response.json({ error: "不是普通文件" }, { status: 400 });
      const fd = fs.openSync(abs, "r");
      try {
        buf = Buffer.alloc(Math.min(st.size, MAX_BYTES + 1));
        fs.readSync(fd, buf, 0, buf.length, 0);
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      buf = null;
    }
  }
  if (!buf) {
    // 已删除（或明确要 HEAD 版本）：git show HEAD:<path>
    const r = await git(root, ["show", `HEAD:${rel}`]);
    if (r.code !== 0) return Response.json({ error: "读不到这个文件" }, { status: 404 });
    buf = Buffer.from(r.stdout, "utf8");
    rev = "head";
  }

  if (looksBinary(buf)) {
    return Response.json({ path: rel, rev, content: "", binary: true, truncated: false, size: buf.length });
  }
  const truncated = buf.length > MAX_BYTES;
  const content = buf.subarray(0, MAX_BYTES).toString("utf8");
  return Response.json({ path: rel, rev, content, binary: false, truncated, size: buf.length });
}
