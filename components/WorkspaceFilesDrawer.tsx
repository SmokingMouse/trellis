"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { previewKind } from "@/lib/generated-files";
import { Drawer } from "@/components/ui/Drawer";
import { IconButton } from "@/components/ui/IconButton";

// Right-side drawer (mobile = bottom sheet) browsing the session's workspace
// cwd — read-only, lazy per-directory listing via /api/sessions/[id]/files.
// Files open in the same global FilePreview overlay as generated-file chips
// (the preview fence already whitelists the whole cwd). Entered by clicking
// the Header ModeBadge on project sessions.
//
// 外壳（scrim/滑入/Esc）来自 ui/Drawer 原语，与 NotesDrawer 一致。

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

  // Esc-close 由 Drawer 内置（非 capture 监听）。FilePreview mounts above
  // this drawer and captures Esc first, so closing a preview doesn't close us.

  if (!sessionId || !workspacePath) return null;

  return (
    <Drawer open={open} onClose={() => setOpen(false)}>
      <div className="px-4 py-3 border-b border-line flex items-center gap-2 shrink-0">
        <div className="text-ink-faint uppercase tracking-wider text-nano font-medium">
          工作区文件
        </div>
        <div
          className="text-ink-faint text-xs font-mono truncate"
          title={workspacePath}
        >
          · {basename(workspacePath)}
        </div>
        <IconButton
          label="刷新"
          size="sm"
          className="ml-auto"
          onClick={() => setEpoch((e) => e + 1)}
        >
          ⟳
        </IconButton>
        <IconButton label="关闭" size="sm" onClick={() => setOpen(false)}>
          ✕
        </IconButton>
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
      <div className="px-4 py-2 border-t border-line text-nano text-ink-faint shrink-0">
        只读浏览 · 点击文件预览
      </div>
    </Drawer>
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
      <div className="py-1 text-ui text-danger" style={pad}>
        {error}
      </div>
    );
  if (listing === null)
    return (
      <div className="py-1 text-ui text-ink-faint" style={pad}>
        加载中…
      </div>
    );
  if (listing.dirs.length === 0 && listing.files.length === 0)
    return (
      <div className="py-1 text-ui text-ink-faint" style={pad}>
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
          className="w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left text-ui text-ink-muted hover:bg-surface-muted"
        >
          <span className="shrink-0">
            {KIND_ICON[previewKind(f.name)] ?? "📄"}
          </span>
          <span className="flex-1 truncate">{f.name}</span>
          <span className="shrink-0 text-nano text-ink-faint tabular-nums">
            {fmtSize(f.size)}
          </span>
        </button>
      ))}
      {listing.truncated && (
        <div className="py-1 text-label text-ink-faint" style={pad}>
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
        className="w-full flex items-center gap-1.5 py-1 pr-2 rounded text-left text-ui text-ink-muted hover:bg-surface-muted"
      >
        <span className="shrink-0 text-nano text-ink-faint w-3 text-center">
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
