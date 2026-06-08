"use client";
import { useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { ModelPicker } from "./ModelPicker";
import { SessionPicker } from "./SessionPicker";
import { ExportMenu } from "./ExportMenu";
import { ModeBadge } from "./ModeBadge";
import { ThemeToggle } from "./ThemeToggle";
import { formatTokens } from "@/lib/format-tokens";
import type { ChatNode } from "@/lib/types";

// Sonnet / Opus default ceiling. (Some tiers expose 1M behind a beta header;
// trellis doesn't enable that, so 200K is the right denominator until we do.)
const CONTEXT_WINDOW = 200_000;

// In project mode every node under a root resumes the same claude session,
// so the model's working memory at any moment ≈ the input bundle of the
// most recent turn that actually reported tokens. cache_read carries the
// prior history bytes; cache_creation is whatever just got added.
function findRoot(nodeId: string, nodes: Record<string, ChatNode>): ChatNode | null {
  let cur: ChatNode | undefined = nodes[nodeId];
  for (let i = 0; i < 1000 && cur; i++) {
    if (!cur.parentId) return cur;
    cur = nodes[cur.parentId];
  }
  return null;
}

function findLatestCtxTurn(
  rootId: string,
  nodes: Record<string, ChatNode>,
): ChatNode | null {
  // Single pass: collect children-by-parent once, BFS from root, track max.
  const childrenByParent = new Map<string, string[]>();
  for (const n of Object.values(nodes)) {
    if (!n.parentId) continue;
    const list = childrenByParent.get(n.parentId);
    if (list) list.push(n.id);
    else childrenByParent.set(n.parentId, [n.id]);
  }
  let best: ChatNode | null = null;
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    const n = nodes[id];
    if (!n) continue;
    const total =
      n.tokenCount.input + n.tokenCount.cacheRead + n.tokenCount.cacheCreation;
    if (total > 0 && (!best || n.createdAt > best.createdAt)) best = n;
    const kids = childrenByParent.get(id);
    if (kids) stack.push(...kids);
  }
  return best;
}

export function Header() {
  const session = useSessionStore((s) => s.session);
  const nodes = useSessionStore((s) => s.nodes);
  const activeNodeId = useSessionStore((s) => s.activeNodeId);
  const noteCount = useSessionStore((s) => s.notes.length);
  const setNotesOpen = useSessionStore((s) => s.setNotesOpen);
  const setSearchOpen = useSessionStore((s) => s.setSearchOpen);
  const setOutlineOpen = useSessionStore((s) => s.setOutlineOpen);
  const chatEnhanced = useSessionStore((s) => s.chatEnhanced);
  const setChatEnhanced = useSessionStore((s) => s.setChatEnhanced);
  const nodeCount = Object.keys(nodes).length;
  // Aggregate four buckets independently — total input vs total output vs
  // total cache leverage. Computed via useMemo (NOT inside the Zustand
  // selector) because returning a fresh object from a selector defeats
  // its referential-equality bail-out and triggers an infinite render
  // loop ("getSnapshot should be cached"). The selector returns the
  // stable nodes map; useMemo only recomputes when that ref changes.
  const totals = useMemo(
    () =>
      Object.values(nodes).reduce(
        (acc, n) => {
          acc.input += n.tokenCount.input;
          acc.output += n.tokenCount.output;
          acc.cacheRead += n.tokenCount.cacheRead;
          acc.cacheCreation += n.tokenCount.cacheCreation;
          return acc;
        },
        { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
      ),
    [nodes],
  );

  // Project-mode context occupancy for the currently-focused root's claude
  // session. Skipped in chat / workspace because every turn is independent
  // there — % has no meaning.
  const ctx = useMemo(() => {
    if (session?.mode !== "project") return null;
    if (!activeNodeId) return null;
    const root = findRoot(activeNodeId, nodes);
    if (!root) return null;
    const latest = findLatestCtxTurn(root.id, nodes);
    if (!latest) return null;
    const tokens =
      latest.tokenCount.input +
      latest.tokenCount.cacheRead +
      latest.tokenCount.cacheCreation;
    return {
      tokens,
      percent: Math.min(100, (tokens / CONTEXT_WINDOW) * 100),
      rootId: root.id,
      rootLabel: root.topicLabel ?? root.question.slice(0, 30),
    };
  }, [session?.mode, activeNodeId, nodes]);

  // Three-band color: muted → amber → rose. 80% is when context pressure
  // usually starts mattering (model gets slower; cache stops growing).
  const ctxTone =
    ctx == null
      ? ""
      : ctx.percent >= 80
        ? "text-rose-600 dark:text-rose-400"
        : ctx.percent >= 50
          ? "text-amber-600 dark:text-amber-400"
          : "text-stone-500 dark:text-stone-400";

  return (
    <header className="fixed top-0 inset-x-0 h-12 bg-white/85 dark:bg-stone-950/85 backdrop-blur border-b border-stone-200 dark:border-stone-800 flex items-center px-3 sm:px-4 z-40 gap-2 sm:gap-3">
      <div className="flex items-center gap-2 shrink-0">
        <div className="w-6 h-6 rounded bg-gradient-to-br from-indigo-500 via-fuchsia-500 to-amber-400" />
        <span className="font-semibold tracking-tight hidden sm:inline">Trellis</span>
        <span className="text-stone-300 dark:text-stone-600 hidden sm:inline">/</span>
      </div>
      <div className="flex-1 min-w-0">
        <SessionPicker />
      </div>
      <div className="flex items-center gap-2 sm:gap-3 text-xs text-stone-500 dark:text-stone-400 shrink-0">
        <button
          onClick={() => setSearchOpen(true)}
          title="搜索 (⌘P)"
          aria-label="搜索"
          className="px-2 py-1 rounded text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
        </button>
        {session && (
          <>
            <button
              onClick={() => setOutlineOpen(true)}
              title="思维树"
              aria-label="思维树"
              className="md:hidden px-2 py-1 rounded text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center"
            >
              <svg
                width="15"
                height="15"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <line x1="9" y1="6" x2="21" y2="6" />
                <line x1="9" y1="12" x2="21" y2="12" />
                <line x1="9" y1="18" x2="21" y2="18" />
                <circle cx="4" cy="6" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="4" cy="12" r="1.4" fill="currentColor" stroke="none" />
                <circle cx="4" cy="18" r="1.4" fill="currentColor" stroke="none" />
              </svg>
            </button>
            {session.mode === "chat" && (
              <button
                onClick={() => setChatEnhanced(!chatEnhanced)}
                title="增强模式：开启后 chat 能跑 skill + 联网（YOLO，无沙箱、能跑任意命令）。默认关 = 纯对话。"
                aria-label="增强模式"
                className={`px-2 py-1 rounded inline-flex items-center gap-1 transition-colors ${
                  chatEnhanced
                    ? "bg-amber-100 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300"
                    : "text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
                }`}
              >
                <span aria-hidden>⚡</span>
                <span className="hidden sm:inline text-[11px]">
                  {chatEnhanced ? "增强·开" : "增强"}
                </span>
              </button>
            )}
            <span className="hidden md:inline">{nodeCount} 节点</span>
            <span className="hidden md:inline text-stone-300 dark:text-stone-600">·</span>
            <span
              className="hidden md:inline-flex items-center gap-1.5 tabular-nums"
              title={`输入 ${totals.input} · 输出 ${totals.output} · 缓存命中 ${totals.cacheRead}${
                totals.cacheCreation > 0
                  ? ` · 缓存写入 ${totals.cacheCreation}`
                  : ""
              }`}
            >
              <span>↑{formatTokens(totals.input)}</span>
              <span>↓{formatTokens(totals.output)}</span>
              {(totals.cacheRead > 0 || totals.cacheCreation > 0) && (
                <span className="text-emerald-600 dark:text-emerald-400">
                  ⚡{formatTokens(totals.cacheRead)}
                  {totals.cacheCreation > 0
                    ? `+${formatTokens(totals.cacheCreation)}`
                    : ""}
                </span>
              )}
            </span>
            {ctx && (
              <>
                <span className="hidden md:inline text-stone-300 dark:text-stone-600">·</span>
                <span
                  className={`inline-flex items-center gap-1 tabular-nums ${ctxTone}`}
                  title={`当前 root「${ctx.rootLabel}」的 Claude 会话占用 ${formatTokens(ctx.tokens)} / ${formatTokens(CONTEXT_WINDOW)} tokens (${ctx.percent.toFixed(1)}%)。新提问可清空。`}
                >
                  🧠 {ctx.percent < 10 ? ctx.percent.toFixed(1) : Math.round(ctx.percent)}%
                </span>
              </>
            )}
            <button
              onClick={() => setNotesOpen(true)}
              title="笔记"
              aria-label="笔记"
              className="px-2 py-1 rounded text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-800 inline-flex items-center gap-1.5"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              {noteCount > 0 && (
                <span className="tabular-nums text-[11px]">
                  {noteCount}
                </span>
              )}
            </button>
            <ExportMenu />
          </>
        )}
        <ModeBadge />
        <ModelPicker />
        <ThemeToggle />
      </div>
    </header>
  );
}
