"use client";
import { useEffect, useMemo } from "react";
import { useSessionStore } from "@/stores/sessionStore";
import { buildNodeIndex } from "@/lib/node-index";
import { ToastShell } from "@/components/ui/Toast";

// Bottom-right stack of toasts for nodes that finished streaming while the
// user was not focused on them. Each toast shows "#N 完成" + the topic
// label / question prefix, and a × dismiss. Click body → focus that node
// (canvas pans / fullscreen swaps) and dismiss. Auto-dismiss after 6s.
//
// kind "waiting" = run 暂停在交互式工具（提问 / 计划批准 / 权限授权）等用户
// 回答。与 done 同一堆叠位，但不自动消失——run 阻塞着，提醒消失了用户就再也
// 不知道有事等他。回答 / 终结后由 store 清除。
//
// Why 6s, not 3-4s: the typical use case is "I asked something, branched
// off, then went back to read another card" — the user needs enough time
// to (a) notice the toast, (b) decide whether to break flow now or
// finish what they're reading. 6s is on the long end of common toast
// timings (Material 4-10s; macOS notifications 5-10s) without being
// nagging. User can dismiss faster if they want.
const AUTO_DISMISS_MS = 6000;

export function DoneToast() {
  const toasts = useSessionStore((s) => s.doneToasts);
  const nodes = useSessionStore((s) => s.nodes);
  const setActiveNode = useSessionStore((s) => s.setActiveNode);
  const setViewMode = useSessionStore((s) => s.setViewMode);
  const dismiss = useSessionStore((s) => s.dismissDoneToast);

  // Indices recomputed when nodes map changes — cheap, runs only when the
  // tree actually mutates (not on every render).
  const indices = useMemo(() => buildNodeIndex(nodes), [nodes]);

  if (toasts.length === 0) return null;

  return (
    <div className="fixed bottom-4 right-4 z-40 flex flex-col gap-2 max-w-sm pointer-events-none">
      {toasts.map((t) => (
        <Toast
          key={t.nodeId}
          nodeId={t.nodeId}
          emittedAt={t.emittedAt}
          waiting={t.kind === "waiting"}
          waitingTitle={waitingTitle(nodes[t.nodeId])}
          index={indices[t.nodeId] ?? 0}
          label={topicForNode(nodes[t.nodeId])}
          onClick={() => {
            setActiveNode(t.nodeId);
            setViewMode("linear");
            dismiss(t.nodeId);
          }}
          onDismiss={() => dismiss(t.nodeId)}
        />
      ))}
    </div>
  );
}

function Toast({
  nodeId,
  emittedAt,
  waiting,
  waitingTitle,
  index,
  label,
  onClick,
  onDismiss,
}: {
  nodeId: string;
  emittedAt: number;
  waiting: boolean;
  waitingTitle: string;
  index: number;
  label: string;
  onClick: () => void;
  onDismiss: () => void;
}) {
  // Per-toast timer. Resets when `emittedAt` changes (re-toast scenario:
  // user retried a node already in the toasts list). Waiting toasts never
  // auto-dismiss — the run is blocked on the user.
  useEffect(() => {
    if (waiting) return;
    const remaining = AUTO_DISMISS_MS - (Date.now() - emittedAt);
    if (remaining <= 0) {
      onDismiss();
      return;
    }
    const t = window.setTimeout(onDismiss, remaining);
    return () => window.clearTimeout(t);
    // onDismiss is captured fresh per render via the parent's closure;
    // safe to skip from deps to avoid resetting the timer on identity churn.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, emittedAt, waiting]);

  return (
    <ToastShell
      tone={waiting ? "warn" : "positive"}
      onClick={onClick}
      className={`px-3 py-2 cursor-pointer transition-colors flex items-start gap-2.5 min-w-0 ${
        waiting ? "hover:border-warn" : "hover:border-positive"
      }`}
    >
      <span
        className={`shrink-0 w-2 h-2 rounded-full mt-1.5 ${
          waiting ? "bg-warn animate-pulse" : "bg-unread"
        }`}
        aria-hidden
      />
      <div className="flex-1 min-w-0">
        <div className="text-ui font-medium text-ink-strong flex items-center gap-1.5">
          {index ? (
            <span className="font-mono text-ink-faint tabular-nums">
              #{index}
            </span>
          ) : null}
          <span>{waiting ? waitingTitle : "已完成"}</span>
        </div>
        <div className="text-ui text-ink-muted truncate">
          {label}
        </div>
      </div>
      <button
        onClick={(e) => {
          e.stopPropagation();
          onDismiss();
        }}
        className="shrink-0 -mt-0.5 -mr-1 px-1.5 py-0.5 text-ink-faint hover:text-ink text-sm leading-none"
        aria-label="关闭"
      >
        ×
      </button>
    </ToastShell>
  );
}

// 文案按暂停在哪个交互式工具上区分；node / pendingInteraction 已被清时给兜底
// （store 会同步清 toast，这里只防一帧的竞态渲染）。
function waitingTitle(
  n: import("@/lib/types").ChatNode | undefined,
): string {
  const tool = n?.pendingInteraction?.toolName;
  if (tool === "AskUserQuestion") return "🙋 等你回答";
  if (tool === "ExitPlanMode") return "📋 等你批准计划";
  return "🛡️ 等待工具授权";
}

function topicForNode(n: import("@/lib/types").ChatNode | undefined): string {
  if (!n) return "";
  if (n.kind === "reference") {
    return n.topicLabel ?? "参考材料";
  }
  return n.topicLabel ?? truncate(n.question, 40);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}
