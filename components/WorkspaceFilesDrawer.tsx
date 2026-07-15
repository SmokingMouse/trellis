"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { previewKind } from "@/lib/generated-files";

// Right-side drawer (mobile = bottom sheet) browsing the session's workspace
// cwd — read-only, lazy per-directory listing via /api/sessions/[id]/files.
// Files open in the same global FilePreview overlay as generated-file chips
// (the preview fence already whitelists the whole cwd). Entered by clicking
// the Header ModeBadge on workspace/project sessions.
//
// Skeleton mirrors NotesDrawer so transitions / backdrop / breakpoints feel
// consistent.

type Listing = {
  path: string;
  root: string;
  dirs: Array<{ name: string; path: string }>;
  files: Array<{ name: string; path: string; size: number }>;
  truncated: boolean;
};

const KIND_ICON: Record<string, string> = {
  html: "🌐",
  image: "🖼",
  pdf: "📕",
  markdown: "📝",
  text: "📄",
};

export function WorkspaceFilesDrawer() {
  const open = useSessionStore((s) => s.workspaceFilesOpen);
  const setOpen = useSessionStore((s) => s.setWorkspaceFilesOpen);
  const sessionId = useSessionStore((s) => s.session?.id ?? null);
  const workspacePath = useSessionStore(
    (s) => s.session?.workspacePath ?? null,
  );

  // Each drawer opening bumps the epoch → the whole tree remounts and
  // refetches, so the listing is fresh every time (files change between
  // turns). The ⟳ button bumps it too. 0 = never opened, render nothing
  // (avoids fetching behind a closed drawer).
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (open) setEpoch((e) => e + 1);
  }, [open]);

  // Esc closes (matches every other modal). FilePreview mounts above this
  // drawer and captures Esc first, so closing a preview doesn't close us.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, setOpen]);

  if (!sessionId || !workspacePath) return null;

  return (
    <div
      className={`fixed inset-0 z-50 ${open ? "" : "pointer-events-none"}`}
      aria-hidden={!open}
    >
      <div
        onClick={() => setOpen(false)}
        className={`absolute inset-0 bg-black/40 sm:bg-black/15 transition-opacity duration-200 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />
      <div
        className={`absolute bg-white dark:bg-stone-900 shadow-2xl flex flex-col overflow-hidden transition-transform duration-200
          inset-x-0 bottom-0 h-[60vh] rounded-t-2xl
          sm:inset-x-auto sm:right-2 sm:top-14 sm:bottom-2 sm:w-[360px] sm:h-auto sm:rounded-xl
          ${
            open
              ? "translate-y-0 sm:translate-x-0"
              : "translate-y-full sm:translate-y-0 sm:translate-x-[calc(100%+0.5rem)]"
          }`}
      >
        <div className="px-4 py-3 border-b border-stone-200 dark:border-stone-800 flex items-center gap-2 shrink-0">
          <div className="text-stone-400 dark:text-stone-500 uppercase tracking-wider text-[10px] font-medium">
            工作区文件
          </div>
          <div
            className="text-stone-400 dark:text-stone-500 text-xs font-mono truncate"
            title={workspacePath}
          >
            · {basename(workspacePath)}
          </div>
          <button
            onClick={() => setEpoch((e) => e + 1)}
            className="ml-auto text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 text-sm px-1.5 py-0.5"
            title="刷新"
            aria-label="刷新"
          >
            ⟳
          </button>
          <button
            onClick={() => setOpen(false)}
            className="text-stone-500 dark:text-stone-400 hover:text-stone-900 dark:hover:text-stone-100 text-sm px-2 py-0.5"
            aria-label="关闭"
          >
            ✕
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-2 px-2">
          {epoch > 0 && (
            <DirChildren
              key={`${sessionId}:${epoch}`}
              sessionId={sessionId}
              dir={null}
              depth={0}
            />
          )}
        </div>
        <div className="px-4 py-2 border-t border-stone-200 dark:border-stone-800 text-[10.5px] text-stone-400 dark:text-stone-500 shrink-0">
          只读浏览 · 点击文件预览
        </div>
      </div>
    </div>
  );
}

// One directory's contents. dir=null means the workspace root (server
// resolves it). Fetches on mount — mounted lazily, only when the parent
// folder is expanded — so deep trees never load wholesale.
function DirChildren({
  sessionId,
  dir,
  depth,
}: {
  sessionId: string;
  dir: string | null;
  depth: number;
}) {
  const openFilePreview = useSessionStore((s) => s.openFilePreview);
  const [listing, setListing] = useState<Listing | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setListing(null);
    setError(null);
    const qs = dir ? `?dir=${encodeURIComponent(dir)}` : "";
    fetch(`/api/sessions/${encodeURIComponent(sessionId)}/files${qs}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) {
          throw new Error(
            (body as { error?: string } | null)?.error ?? `HTTP ${r.status}`,
          );
        }
        return body as Listing;
      })
      .then((l) => alive && setListing(l))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, [sessionId, dir]);

  const pad = { paddingLeft: `${8 + depth * 14}px` };

  if (error)
    return (
      <div className="py-1 text-[12px] text-rose-600 dark:text-rose-400" style={pad}>
        {error}
      </div>
    );
  if (listing === null)
    return (
      <div className="py-1 text-[12px] text-stone-400 dark:text-stone-500" style={pad}>
        加载中…
      </div>
    );
  if (listing.dirs.length === 0 && listing.files.length === 0)
    return (
      <div className="py-1 text-[12px] text-stone-400 dark:text-stone-500" style={pad}>
        （空目录）
      </div>
    );

  return (
    <>
      {listing.dirs.map((d) => (
        <DirRow
          key={d.path}
          sessionId={sessionId}
          name={d.name}
          path={d.path}
          depth={depth}
        />
      ))}
      {listing.files.map((f) => (
        <button
          key={f.path}
          type="button"
          onClick={() => openFilePreview(f.path)}
          title={f.path}
          style={pad}
          className="w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left text-[12.5px] text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
        >
          <span className="shrink-0">
            {KIND_ICON[previewKind(f.name)] ?? "📄"}
          </span>
          <span className="flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-[10.5px] text-stone-400 dark:text-stone-500 tabular-nums">
            {fmtSize(f.size)}
          </span>
        </button>
      ))}
      {listing.truncated && (
        <div className="py-1 text-[11px] text-stone-400 dark:text-stone-500" style={pad}>
          …条目过多，已截断（前 300 条）
        </div>
      )}
    </>
  );
}

function DirRow({
  sessionId,
  name,
  path,
  depth,
}: {
  sessionId: string;
  name: string;
  path: string;
  depth: number;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        title={path}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        className="w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left text-[12.5px] text-stone-700 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800"
      >
        <span className="shrink-0 text-[10px] text-stone-400 dark:text-stone-500 w-3 text-center">
          {expanded ? "▼" : "▶"}
        </span>
        <span aria-hidden>📁</span>
        <span className="flex-1 truncate font-medium">{name}</span>
      </button>
      {expanded && (
        <DirChildren sessionId={sessionId} dir={path} depth={depth + 1} />
      )}
    </>
  );
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function basename(p: string): string {
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}
