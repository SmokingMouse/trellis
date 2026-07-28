import "server-only";
import fs from "node:fs";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST { parent, name } → mkdir <parent>/<name>, returns the new absolute
// path so the picker can select it like any other workspace dir.
//
// Sibling of /scratch (random name under ~/.trellis/scratch) — this one is
// "a new dir where *I* say, named what *I* say", which is what you want when
// starting a project rather than a throwaway sandbox.

/** The name lands verbatim on disk — it must be a single path segment. */
function badName(name: string): string | null {
  if (!name) return "目录名为空";
  if (name.length > 255) return "目录名过长";
  if (name !== name.trim()) return "目录名首尾不能有空白";
  if (name.includes("/") || name.includes("\0")) return "目录名不能含 / ";
  if (name === "." || name === "..") return "目录名不合法";
  return null;
}

export async function POST(req: Request) {
  let body: { parent?: string; name?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "bad json" }, { status: 400 });
  }

  const parent = body.parent ?? "";
  const name = (body.name ?? "").trim();
  if (!path.isAbsolute(parent)) {
    return Response.json({ error: "parent 必须是绝对路径" }, { status: 400 });
  }
  const bad = badName(name);
  if (bad) return Response.json({ error: bad }, { status: 400 });

  const base = path.resolve(parent);
  let stat: fs.Stats;
  try {
    stat = fs.statSync(base);
  } catch {
    return Response.json({ error: `父目录不存在：${base}` }, { status: 404 });
  }
  if (!stat.isDirectory()) {
    return Response.json({ error: `不是目录：${base}` }, { status: 400 });
  }

  // Non-recursive: a missing parent is a bug upstream, and EEXIST is the
  // signal we want to surface rather than silently reuse someone's dir.
  const target = path.join(base, name);
  try {
    fs.mkdirSync(target);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      return Response.json({ error: `已存在：${target}` }, { status: 409 });
    }
    if (code === "EACCES" || code === "EPERM") {
      return Response.json({ error: `没有写权限：${base}` }, { status: 403 });
    }
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
  return Response.json({ path: target });
}
