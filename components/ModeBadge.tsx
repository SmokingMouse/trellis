"use client";
import { useEffect, useState } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { MODE_STYLES } from "@/lib/mode-style";
import { AGENT_UNSUPPORTED_HINT, agentSupported } from "@/lib/run-config";
import type { ProviderId } from "@/lib/llm";
import { Bot, ShieldCheck } from "lucide-react";
import { Icon, StatusDot, Tooltip } from "@/components/ui";

// Badge rendered in the Header for an active session. Shows
// "Chat" / "Project · <shortName>" depending on the locked session mode.
// Renders nothing when there's no session (the new-session draft picker
// lives in QuestionInput).
//
// Hover reveals the full workspace path. Click is a no-op — mode +
// workspace are locked at session creation; to use a different mode, open
// a new session. (Browsing the workspace's files lives on the breadcrumb and
// the「更多」menu — a status chip that secretly acts as a button proved
// undiscoverable.)
export function ModeBadge() {
  const session = useSessionStore((s) => s.session);
  const agentId = session?.agentId ?? null;
  const [agentLookup, setAgentLookup] = useState<{
    id: string;
    name: string | null;
  } | null>(null);
  // 会话锁定的是 agent **id**，名字要查一次。agent 列表极少变，拉一次就够。
  useEffect(() => {
    if (!agentId) return;
    let alive = true;
    fetch(`/api/agents/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (alive) setAgentLookup({ id: agentId, name: d?.agent?.name ?? null });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [agentId]);

  if (!session) return null;
  const agentName = agentLookup?.id === agentId ? agentLookup.name : null;

  const mode = session.mode || "chat";
  const path = session.workspacePath;
  const cfg = MODE_CONFIG[mode] ?? MODE_CONFIG.chat;

  // shortName fallback: last segment of the path. Server-derived names
  // (package.json / Cargo.toml) live in the picker; we don't ship those
  // through the session row to keep the schema lean.
  const shortName = path ? basename(path) : null;

  return (
    <Tooltip
      content={
        path
          ? `${cfg.label} · ${path}（模式与工作区在会话创建时锁定）`
          : `${cfg.label}（会话创建时锁定，换语境请开新会话）`
      }
    >
      <div
        role="status"
        tabIndex={0}
        data-mode-badge={mode}
        className="inline-flex h-7 max-w-64 items-center gap-1.5 rounded-field border border-line px-2 text-label text-ink"
      >
        <StatusDot tone={mode === "project" ? "project" : "chat"} />
        {/* 手机上只留圆点省空间；桌面写出模式名。 */}
        <span className="hidden sm:inline font-medium">{cfg.label}</span>
        {shortName && (
          <span className="min-w-0 truncate font-mono text-ink-muted max-w-[6rem] sm:max-w-[9rem]">
            {shortName}
          </span>
        )}
        {/* S88 会话人设。两个真实服务商都生效；mock 灰掉说明。 */}
        {agentName && <AgentChip name={agentName} model={session.model} />}
        {/* 权限确认会话：可变更工具逐个审批（创建时锁定）。 */}
        {session.requireApproval && (
          <span
            role="img"
            aria-label="需确认：执行命令、写文件等操作前先弹卡等你允许"
            className="inline-flex text-ink-muted"
          >
            <Icon icon={ShieldCheck} size="sm" />
          </span>
        )}
      </div>
    </Tooltip>
  );
}

function AgentChip({ name, model }: { name: string; model: string | null }) {
  // S89: 判据统一走 lib/run-config.ts 的 agentSupported（mock 会话同样拿不到 agent）。
  const inactive = !model || !agentSupported(model as ProviderId);
  return (
    <span
      aria-label={inactive ? `${name}：${AGENT_UNSUPPORTED_HINT}` : `Agent：${name}（会话创建时锁定）`}
      className={`inline-flex min-w-0 items-center gap-1 border-l border-line pl-1.5 text-ink-muted ${inactive ? "text-ink-faint line-through" : ""}`}
    >
      <Icon icon={Bot} size="sm" />
      <span className="truncate max-w-[7rem]">{name}</span>
    </span>
  );
}

// 模式名来自 lib/mode-style.ts（与 SessionTabs 共用）。
const MODE_CONFIG: Record<string, { label: string }> = {
  chat: MODE_STYLES.chat,
  project: MODE_STYLES.project,
};

function basename(p: string): string {
  if (!p) return "";
  const stripped = p.replace(/\/+$/, "");
  const idx = stripped.lastIndexOf("/");
  return idx === -1 ? stripped : stripped.slice(idx + 1);
}
