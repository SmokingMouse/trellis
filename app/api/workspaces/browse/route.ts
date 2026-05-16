import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export type BrowseEntry = {
  name: string;
  path: string;
};

export type BrowseResponse = {
  path: string;
  parent: string | null;
  children: BrowseEntry[];
  truncated: boolean;
  home: string;
};

const MAX_ENTRIES = 500;

// Patterns hidden by default — dotfiles + common build/cache dirs that
// would never be a workspace cwd. `showHidden=true` overrides.
const HIDDEN_NAME_PATTERNS = [
  /^\./,
  /^node_modules$/,
  /^__pycache__$/,
  /^dist$/,
  /^build$/,
  /^target$/,
  /^\.next$/,
  /^\.venv$/,
  /^venv$/,
  /^Library$/, // macOS user Library: huge, rarely a cwd
];

function isHidden(name: string): boolean {
  return HIDDEN_NAME_PATTERNS.some((re) => re.test(name));
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = url.searchParams.get("path");
  const showHidden = url.searchParams.get("showHidden") === "true";

  // No path → start at $HOME. Relative paths rejected (the picker is
  // strictly absolute-path oriented).
  const target =
    raw && path.isAbsolute(raw) ? path.resolve(raw) : os.homedir();

  let stat: fs.Stats;
  try {
    stat = fs.statSync(target);
  } catch {
    return Response.json(
      { error: `Path does not exist: ${target}` },
      { status: 404 },
    );
  }
  if (!stat.isDirectory()) {
    return Response.json(
      { error: `Not a directory: ${target}` },
      { status: 400 },
    );
  }

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch {
    return Response.json(
      { error: `Cannot read directory: ${target}` },
      { status: 403 },
    );
  }

  const children: BrowseEntry[] = [];
  let truncated = false;
  for (const entry of entries) {
    // Only real directories — skip files and symlinks. Symlinks could
    // form cycles or point outside an expected scope; v1 keeps it strict.
    if (!entry.isDirectory()) continue;
    if (!showHidden && isHidden(entry.name)) continue;
    if (children.length >= MAX_ENTRIES) {
      truncated = true;
      continue;
    }
    children.push({
      name: entry.name,
      path: path.join(target, entry.name),
    });
  }

  children.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  const parent = path.dirname(target);
  return Response.json({
    path: target,
    parent: parent === target ? null : parent,
    children,
    truncated,
    home: os.homedir(),
  } satisfies BrowseResponse);
}
