import "server-only";
import fs from "node:fs";
import path from "node:path";
import { getSessionWorkspacePath } from "@/lib/server/repo";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type WorkspaceListing = {
  path: string;
  root: string;
  dirs: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; size: number }>;
  truncated: boolean;
};

const MAX_ENTRIES = 300;

// Noise hidden from the drawer: dotfiles + dependency/cache trees that are
// never "artifacts". Unlike the workspace picker's list we keep dist/build
// visible — agent output often lands exactly there.
const HIDDEN_NAME_PATTERNS = [/^\./, /^node_modules$/, /^__pycache__$/, /^venv$/];

function isHidden(name: string): boolean {
  return HIDDEN_NAME_PATTERNS.some((re) => re.test(name));
}

// GET /api/sessions/<id>/files?dir=<abs> — non-recursive listing of one
// directory inside the session's workspace cwd, for the workspace-files
// drawer. Read-only, fenced to the cwd realpath prefix. Symlinks are skipped
// entirely so a link can't walk the listing outside the fence; previewing an
// individual file goes through /api/files with its own whitelist
// (workspace-files.ts), which already covers the whole cwd.
export async function GET(
  req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const ws = getSessionWorkspacePath(id);
  if (!ws) {
    return Response.json(
      { error: "session has no workspace" },
      { status: 404 },
    );
  }
  let root: string;
  try {
    root = fs.realpathSync(ws);
  } catch {
    return Response.json(
      { error: `工作区目录已不存在：${ws}` },
      { status: 404 },
    );
  }

  const raw = new URL(req.url).searchParams.get("dir");
  let target = root;
  if (raw && raw !== root) {
    if (!path.isAbsolute(raw)) {
      return Response.json({ error: "dir must be absolute" }, { status: 400 });
    }
    try {
      target = fs.realpathSync(path.resolve(raw));
    } catch {
      return Response.json(
        { error: `目录不存在：${raw}` },
        { status: 404 },
      );
    }
    if (target !== root && !target.startsWith(root + path.sep)) {
      return Response.json({ error: "目录在工作区之外" }, { status: 403 });
    }
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return Response.json(
      { error: `无法读取目录：${target}` },
      { status: 403 },
    );
  }

  const dirs: WorkspaceListing["dirs"] = [];
  const files: WorkspaceListing["files"] = [];
  let truncated = false;
  for (const entry of entries) {
    if (isHidden(entry.name)) continue;
    if (dirs.length + files.length >= MAX_ENTRIES) {
      truncated = true;
      break;
    }
    const abs = path.join(target, entry.name);
    if (entry.isDirectory()) {
      dirs.push({ name: entry.name, path: abs });
    } else if (entry.isFile()) {
      let size = 0;
      try {
        size = fs.statSync(abs).size;
      } catch {
        continue;
      }
      files.push({ name: entry.name, path: abs, size });
    }
    // Symlinks / sockets / etc. fall through — intentionally not listed.
  }

  const byName = (a: { name: string }, b: { name: string }) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  dirs.sort(byName);
  files.sort(byName);

  return Response.json({
    path: target,
    root,
    dirs,
    files,
    truncated,
  } satisfies WorkspaceListing);
}
