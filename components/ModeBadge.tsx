"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { MODE_STYLES } from "@/lib/mode-style";
import { AGENT_UNSUPPORTED_HINT, agentSupported } from "@/lib/run-config";
import type { ProviderId } from "@/lib/llm";

// Badge rendered in the Header for an active session. Shows
// "Chat" / "Project · <shortName>" depending on the locked session mode.
// Renders nothing when there's no session (the new-session draft picker
// lives in QuestionInput).
//
// Hover reveals the full workspace path. Click is a no-op — mode +
// workspace are locked at session creation; to use a different mode, open
// a new session. (Browsing the workspace's files has its own 📁 Header
// button — a status chip that secretly acts as a button proved
// undiscoverable.)
export function ModeBadge() {
  const session = useSessionStore((s) => s.session);
  const agentId = session?.agentId ?? null;
  const [agentName, setAgentName] = useState<string | null>(null);
  // 会话锁定的是 agent **id**，名字要查一次。agent 列表极少变，拉一次就够。
  useEffect(() => {
    if (!agentId) {
      setAgentName(null);
      return;
    }
    let alive = true;
    fetch(`/api/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => alive && setAgentName(d?.agent?.name ?? null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (!session) return null;

  const mode = session.mode || "chat";
  const path = session.workspacePath;
  const cfg = MODE_CONFIG[mode] ?? MODE_CONFIG.chat;

  // shortName fallback: last segment of the path. Server-derived names
  // (package.json / Cargo.toml) live in the picker; we don't ship those
  // through the session row to keep the schema lean.
  const shortName = path ? basename(path) : null;

  return (
    <div
      role="status"
      title={
        path
          ? `${cfg.label} · ${path}\n模式与工作区在 session 创建时锁定`
          : `${cfg.label}\nsession 创建时锁定 — 换语境请开新 session`
      }
      className={`inline-flex items-center gap-1.5 h-7 px-2 rounded-md border ${cfg.badge}`}
    >
      <cfg.Icon />
      {/* Mode label hidden on mobile to save space — the icon already
          encodes the mode (chat bubble / link). Desktop shows the word
          for clarity. */}
      <span className="hidden sm:inline text-label font-medium">
        {cfg.label}
      </span>
      {shortName && (
        <>
          <span className="hidden sm:inline text-ink-faint">
            ·
          </span>
          <span className="text-label font-mono truncate max-w-[6rem] sm:max-w-[10rem]">
            {shortName}
          </span>
        </>
      )}
      {/* S88 会话人设。codex 不认 --agent，切过去后 agent 静默失效 ——
          灰掉并说明，否则就是「配了以为生效」的谎言级 UI。 */}
      {agentName && <AgentChip name={agentName} model={session.model} />}
      {/* 权限确认会话：可变更工具逐个审批（创建时锁定）。 */}
      {session.requireApproval && (
        <span title="需确认：Bash/Write/Edit 等工具执行前弹卡等你允许" aria-label="需确认">
          🛡️
        </span>
      )}
    </div>
  );
}

function AgentChip({ name, model }: { name: string; model: string | null }) {
  // S89: 原来手写 `model.startsWith("codex")`，漏掉 mock —— 服务端的钳制条件是
  // `providerFamily(...) === "claude"`（chat/route.ts），mock 会话同样拿不到 agent，
  // 却会在这里显示成生效。判据统一走 lib/run-config.ts 的 agentSupported。
  const inactive = !model || !agentSupported(model as ProviderId);
  return (
    <span
      title={
        inactive
          ? `${name}\n${AGENT_UNSUPPORTED_HINT}`
          : `Agent：${name}（会话创建时锁定）`
      }
      className={`text-label truncate max-w-[7rem] ${inactive ? "text-ink-faint line-through" : ""}`}
    >
      🎭 {name}
    </span>
  );
}

// Mode label + badge class come from the shared lib/mode-style.ts token
// table (DRY with SessionTabs). Icons stay local to this component.
const MODE_CONFIG: Record<
  string,
  { label: string; badge: string; Icon: () => React.ReactElement }
> = {
  chat: { ...MODE_STYLES.chat, Icon: ChatIcon },
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
