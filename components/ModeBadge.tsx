"use client";
import { useSessionStore } from "@/stores/sessionStore";
import { MODE_STYLES } from "@/lib/mode-style";

// Badge rendered in the Header for an active session. Shows
// "Chat" / "Workspace · <shortName>" / "Project · <shortName>" depending
// on the locked session mode. Renders nothing when there's no session
// (the new-session draft picker lives in QuestionInput).
//
// Hover reveals the full workspace path. Mode + workspace are locked at
// session creation — to use a different mode, open a new session. When the
// session has a workspace cwd, clicking the badge opens the read-only
// workspace-files drawer; without one (chat) it stays a static status chip.
export function ModeBadge() {
  const session = useSessionStore((s) => s.session);
  const setWorkspaceFilesOpen = useSessionStore((s) => s.setWorkspaceFilesOpen);
  if (!session) return null;

  const mode = session.mode || "chat";
  const path = session.workspacePath;
  const cfg = MODE_CONFIG[mode] ?? MODE_CONFIG.chat;

  // shortName fallback: last segment of the path. Server-derived names
  // (package.json / Cargo.toml) live in the picker; we don't ship those
  // through the session row to keep the schema lean.
  const shortName = path ? basename(path) : null;

  const body = (
    <>
      <cfg.Icon />
      {/* Mode label hidden on mobile to save space — the icon already
          encodes the mode (chat bubble / chevron / link). Desktop shows
          the word for clarity. */}
      <span className="hidden sm:inline text-[11px] font-medium">
        {cfg.label}
      </span>
      {shortName && (
        <>
          <span className="hidden sm:inline text-stone-400 dark:text-stone-600">
            ·
          </span>
          <span className="text-[11px] font-mono truncate max-w-[6rem] sm:max-w-[10rem]">
            {shortName}
          </span>
        </>
      )}
    </>
  );

  if (path) {
    return (
      <button
        type="button"
        onClick={() => setWorkspaceFilesOpen(true)}
        title={`${cfg.label} · ${path}\n点击浏览工作区文件（只读）\n模式与工作区在 session 创建时锁定`}
        aria-label="浏览工作区文件"
        className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border cursor-pointer hover:opacity-80 transition-opacity ${cfg.badge}`}
      >
        {body}
      </button>
    );
  }

  return (
    <div
      role="status"
      title={`${cfg.label}\nsession 创建时锁定 — 换语境请开新 session`}
      className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border ${cfg.badge}`}
    >
      {body}
    </div>
  );
}

// Mode label + badge class come from the shared lib/mode-style.ts token
// table (DRY with SessionTabs). Icons stay local to this component.
const MODE_CONFIG: Record<
  string,
  { label: string; badge: string; Icon: () => React.ReactElement }
> = {
  chat: { ...MODE_STYLES.chat, Icon: ChatIcon },
  workspace: { ...MODE_STYLES.workspace, Icon: WorkspaceIcon },
  project: { ...MODE_STYLES.project, Icon: ProjectIcon },
};

function ChatIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

function WorkspaceIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <polyline points="4 17 10 11 4 5" />
      <line x1="12" y1="19" x2="20" y2="19" />
    </svg>
  );
}

function ProjectIcon() {
  return (
    <svg
      width="13"
      height="13"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}

function basename(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}
