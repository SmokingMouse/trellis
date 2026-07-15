"use client";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { MD_COMPONENTS } from "@/lib/md-components";
import { Button } from "./ui/Button";
import type { PendingInteraction } from "@/lib/types";

const REMARK_PLUGINS = [remarkGfm];
const REHYPE_FULL = [rehypeRaw, rehypeHighlight];

// A路③ (third / final knife, pure frontend): render a paused interactive-tool
// prompt as a form so the user can answer inside Trellis and the model
// continues. Reads node.pendingInteraction; submits via store
// respondToInteraction → POST /api/nodes/[id]/respond. The form vanishes once
// pendingInteraction is cleared (optimistic on submit, or by the
// interaction_resolved SSE event).

type QuestionOption = { label: string; description?: string };
type AskQuestion = {
  question: string;
  header?: string;
  options: QuestionOption[];
  multiSelect?: boolean;
};
type AskInput = { questions: AskQuestion[] };
type PlanInput = { plan?: string };

export function InteractionForm({
  nodeId,
  interaction,
}: {
  nodeId: string;
  interaction: PendingInteraction;
}) {
  if (interaction.toolName === "AskUserQuestion") {
    return (
      <InteractionShell>
        <AskUserQuestionForm nodeId={nodeId} interaction={interaction} />
      </InteractionShell>
    );
  }
  if (interaction.toolName === "ExitPlanMode") {
    return (
      <InteractionShell>
        <ExitPlanModeForm nodeId={nodeId} interaction={interaction} />
      </InteractionShell>
    );
  }
  return null;
}

// Eye-catching container that signals "model is waiting on you".
function InteractionShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="mt-5 rounded-card border-2 border-accent-line bg-accent-muted shadow-raise overflow-hidden">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-accent-line/60 bg-accent-line/30">
        <span className="text-sm">🙋</span>
        <span className="text-ui font-semibold text-accent-ink">
          模型在等你回答
        </span>
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function StaleNotice() {
  return (
    <div className="text-ui text-warn-ink flex items-center gap-2">
      <span>⚠️</span>
      <span>会话已失效，请重试</span>
    </div>
  );
}

// ── AskUserQuestion ──────────────────────────────────────────────────────
function AskUserQuestionForm({
  nodeId,
  interaction,
}: {
  nodeId: string;
  interaction: PendingInteraction;
}) {
  const respond = useSessionStore((s) => s.respondToInteraction);
  const input = interaction.input as AskInput;
  const questions = Array.isArray(input?.questions) ? input.questions : [];

  // selections[i] = set of chosen labels for question i.
  const [selections, setSelections] = useState<Record<number, string[]>>({});
  const [submitting, setSubmitting] = useState(false);
  const [stale, setStale] = useState(false);

  const toggle = (qi: number, label: string, multi: boolean) => {
    setSelections((prev) => {
      const cur = prev[qi] ?? [];
      if (multi) {
        const next = cur.includes(label)
          ? cur.filter((l) => l !== label)
          : [...cur, label];
        return { ...prev, [qi]: next };
      }
      // single-select: replace
      return { ...prev, [qi]: cur[0] === label ? [] : [label] };
    });
  };

  const allAnswered = useMemo(
    () => questions.every((_, qi) => (selections[qi]?.length ?? 0) > 0),
    [questions, selections],
  );

  const onSubmit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    // Build answers map: { [question text]: label (single) | label[] (multi) }
    const answers: Record<string, string | string[]> = {};
    questions.forEach((q, qi) => {
      const chosen = selections[qi] ?? [];
      answers[q.question] = q.multiSelect ? chosen : chosen[0];
    });
    const res = await respond(nodeId, interaction.toolUseId, {
      behavior: "allow",
      updatedInput: { ...(input ?? {}), answers },
    });
    if (!res.ok && res.reason === "stale") {
      setStale(true);
    }
    setSubmitting(false);
  };

  if (questions.length === 0) {
    return <StaleNotice />;
  }

  return (
    <div className="flex flex-col gap-4">
      {questions.map((q, qi) => {
        const multi = !!q.multiSelect;
        const chosen = selections[qi] ?? [];
        return (
          <div key={qi} className="flex flex-col gap-2">
            {q.header && (
              <div className="text-nano font-semibold uppercase tracking-wide text-accent">
                {q.header}
              </div>
            )}
            <div className="text-body font-medium text-ink-strong">
              {q.question}
            </div>
            <div className="flex flex-col gap-1.5">
              {(q.options ?? []).map((opt, oi) => {
                const active = chosen.includes(opt.label);
                return (
                  <button
                    key={oi}
                    type="button"
                    disabled={submitting}
                    onClick={() => toggle(qi, opt.label, multi)}
                    className={`w-full text-left px-3 py-2 rounded-field border transition-colors flex items-start gap-2.5 disabled:opacity-60 ${
                      active
                        ? "border-accent bg-accent-line/40 ring-1 ring-accent-line/60"
                        : "border-line bg-surface hover:border-accent-line"
                    }`}
                  >
                    <span
                      className={`mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center border ${
                        multi ? "rounded" : "rounded-full"
                      } ${
                        active
                          ? "bg-accent border-accent text-ink-inverse"
                          : "border-line-strong"
                      }`}
                      aria-hidden
                    >
                      {active && (
                        <svg
                          width="10"
                          height="10"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <path d="M20 6L9 17l-5-5" />
                        </svg>
                      )}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-body font-medium text-ink">
                        {opt.label}
                      </span>
                      {opt.description && (
                        <span className="block text-ui text-ink-muted mt-0.5">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        );
      })}

      {stale ? (
        <StaleNotice />
      ) : (
        <div className="flex items-center gap-3">
          <Button
            type="button"
            variant="primary"
            onClick={onSubmit}
            disabled={!allAnswered}
            loading={submitting}
          >
            提交
          </Button>
          {!allAnswered && (
            <span className="text-ui text-ink-muted">
              请回答全部问题
            </span>
          )}
        </div>
      )}
    </div>
  );
}

// ── ExitPlanMode ─────────────────────────────────────────────────────────
function ExitPlanModeForm({
  nodeId,
  interaction,
}: {
  nodeId: string;
  interaction: PendingInteraction;
}) {
  const respond = useSessionStore((s) => s.respondToInteraction);
  const input = interaction.input as PlanInput;
  const plan = typeof input?.plan === "string" ? input.plan : "";

  const [showDeny, setShowDeny] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);
  const [stale, setStale] = useState(false);

  const decide = async (behavior: "allow" | "deny") => {
    if (submitting) return;
    setSubmitting(behavior);
    const res = await respond(nodeId, interaction.toolUseId, {
      behavior,
      message:
        behavior === "deny" && reason.trim() ? reason.trim() : undefined,
    });
    if (!res.ok && res.reason === "stale") {
      setStale(true);
    }
    setSubmitting(null);
  };

  return (
    <div className="flex flex-col gap-4">
      {plan && (
        <div className="md-body text-body text-ink leading-relaxed max-h-[420px] overflow-y-auto rounded-card border border-line bg-surface px-4 py-3">
          <ReactMarkdown
            remarkPlugins={REMARK_PLUGINS}
            rehypePlugins={REHYPE_FULL}
            components={MD_COMPONENTS}
          >
            {plan}
          </ReactMarkdown>
        </div>
      )}

      {stale ? (
        <StaleNotice />
      ) : (
        <>
          {showDeny && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选）— 会传给模型，让它调整计划"
              disabled={submitting !== null}
              rows={3}
              className="w-full px-3 py-2 rounded-field border border-line-strong bg-surface text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent-line/60 resize-y"
            />
          )}
          <div className="flex items-center gap-3">
            <Button
              type="button"
              variant="primary"
              onClick={() => decide("allow")}
              disabled={submitting !== null}
              loading={submitting === "allow"}
            >
              ✅ 批准执行
            </Button>
            {showDeny ? (
              <button
                type="button"
                onClick={() => decide("deny")}
                disabled={submitting !== null}
                className="px-4 py-2 rounded-field border border-warn-line bg-warn-muted text-warn-ink text-ui font-medium hover:bg-warn-line/30 active:scale-95 transition disabled:opacity-50 disabled:active:scale-100 flex items-center gap-2"
              >
                {submitting === "deny" && (
                  <span className="w-3.5 h-3.5 border-2 border-warn/40 border-t-warn rounded-full animate-spin" />
                )}
                ✋ 确认拒绝
              </button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                onClick={() => setShowDeny(true)}
                disabled={submitting !== null}
              >
                ✋ 拒绝
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
