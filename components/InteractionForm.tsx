"use client";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeRaw from "rehype-raw";
import rehypeHighlight from "rehype-highlight";
import { useSessionStore } from "@/stores/sessionStore";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
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
  // 权限确认（requireApproval session）：其余一切工具 = 待审批的可变更操作。
  // YOLO 会话里普通工具从不暂停（run-bus auto-allow），所以这个分支只在
  // 权限确认会话里可达。
  return (
    <InteractionShell icon="🛡️" title="等待工具授权">
      <PermissionForm nodeId={nodeId} interaction={interaction} />
    </InteractionShell>
  );
}

// Eye-catching container that signals "model is waiting on you".
function InteractionShell({
  children,
  icon = "🙋",
  title = "模型在等你回答",
}: {
  children: React.ReactNode;
  icon?: string;
  title?: string;
}) {
  return (
    <div className="mt-5 rounded-card border-2 border-accent-line bg-accent-muted shadow-raise overflow-hidden">
      <div className="px-4 py-2 flex items-center gap-2 border-b border-accent-line/60 bg-accent-line/30">
        <span className="text-sm">{icon}</span>
        <span className="text-ui font-semibold text-accent-ink">
          {title}
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
  // 「其他」自定义回答（工具 schema 约定 Other 选项由 UI 侧提供，模型不出）。
  // customOn[i] = 该题选中了「其他」；customs[i] = 自定义文本。
  const [customOn, setCustomOn] = useState<Record<number, boolean>>({});
  const [customs, setCustoms] = useState<Record<number, string>>({});
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
    // 单选下选中预设选项 = 放弃「其他」。
    if (!multi) setCustomOn((prev) => ({ ...prev, [qi]: false }));
  };

  const toggleCustom = (qi: number, multi: boolean) => {
    setCustomOn((prev) => ({ ...prev, [qi]: !prev[qi] }));
    // 单选下选中「其他」= 放弃预设选项。
    if (!multi) setSelections((prev) => ({ ...prev, [qi]: [] }));
  };

  const answered = (qi: number) =>
    (selections[qi]?.length ?? 0) > 0 ||
    (!!customOn[qi] && !!customs[qi]?.trim());

  const allAnswered = useMemo(
    () => questions.every((_, qi) => answered(qi)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [questions, selections, customOn, customs],
  );

  const onSubmit = async () => {
    if (!allAnswered || submitting) return;
    setSubmitting(true);
    // Build answers map: { [question text]: string }. 工具 schema 里 answers
    // 的值只收 string——多选把所有选中项（含自定义文本）拼成一个串。
    const answers: Record<string, string> = {};
    questions.forEach((q, qi) => {
      const parts = [...(selections[qi] ?? [])];
      const custom = customOn[qi] ? customs[qi]?.trim() : "";
      if (custom) parts.push(custom);
      answers[q.question] = parts.join(", ");
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
              {multi && (
                <span className="ml-1.5 text-ui font-normal text-ink-muted">
                  （可多选）
                </span>
              )}
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
              {/* 「其他」自定义回答——schema 约定该选项由 UI 提供，模型的
                  options 里永远没有它。多选下可与预设项叠加。 */}
              <button
                type="button"
                disabled={submitting}
                onClick={() => toggleCustom(qi, multi)}
                className={`w-full text-left px-3 py-2 rounded-field border transition-colors flex items-start gap-2.5 disabled:opacity-60 ${
                  customOn[qi]
                    ? "border-accent bg-accent-line/40 ring-1 ring-accent-line/60"
                    : "border-line bg-surface hover:border-accent-line"
                }`}
              >
                <span
                  className={`mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center border ${
                    multi ? "rounded" : "rounded-full"
                  } ${
                    customOn[qi]
                      ? "bg-accent border-accent text-ink-inverse"
                      : "border-line-strong"
                  }`}
                  aria-hidden
                >
                  {customOn[qi] && (
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
                    其他
                  </span>
                  <span className="block text-ui text-ink-muted mt-0.5">
                    输入自定义回答
                  </span>
                </span>
              </button>
              {customOn[qi] && (
                <textarea
                  autoFocus
                  value={customs[qi] ?? ""}
                  onChange={(e) =>
                    setCustoms((prev) => ({ ...prev, [qi]: e.target.value }))
                  }
                  placeholder="输入你的回答……"
                  disabled={submitting}
                  rows={2}
                  className="w-full px-3 py-2 rounded-field border border-line-strong bg-surface text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent-line/60 resize-y"
                />
              )}
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

// ── 权限卡（requireApproval 会话的通用工具审批）─────────────────────────
// Bash 显示 command（等宽块），其余工具显示入参 JSON。三个动作：
// 允许（放行这一次）/ 本轮总是允许（同名工具此后自动放行，只影响这一次
// spawn，下一轮重置）/ 拒绝（可附理由，作为 tool_result 回给模型）。
function PermissionForm({
  nodeId,
  interaction,
}: {
  nodeId: string;
  interaction: PendingInteraction;
}) {
  const respond = useSessionStore((s) => s.respondToInteraction);
  const input = interaction.input as Record<string, unknown> | null;

  const [showDeny, setShowDeny] = useState(false);
  const [reason, setReason] = useState("");
  const [submitting, setSubmitting] = useState<
    "allow" | "always" | "deny" | null
  >(null);
  const [stale, setStale] = useState(false);

  const command =
    interaction.toolName === "Bash" && typeof input?.command === "string"
      ? input.command
      : null;
  const description =
    typeof input?.description === "string" ? input.description : null;
  const inputJson = useMemo(() => {
    if (command) return null; // Bash 已经用 command 块展示
    try {
      return JSON.stringify(input ?? {}, null, 2);
    } catch {
      return String(input);
    }
  }, [command, input]);

  const decide = async (
    kind: "allow" | "always" | "deny",
  ) => {
    if (submitting) return;
    setSubmitting(kind);
    const res =
      kind === "deny"
        ? await respond(nodeId, interaction.toolUseId, {
            behavior: "deny",
            message: reason.trim() || "用户拒绝了本次工具执行",
          })
        : await respond(nodeId, interaction.toolUseId, {
            behavior: "allow",
            // 与 run-bus auto-allow 同纪律：原样回显入参。
            updatedInput: interaction.input,
            ...(kind === "always" ? { alwaysAllowTool: true } : {}),
          });
    if (!res.ok && res.reason === "stale") {
      setStale(true);
    }
    setSubmitting(null);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2">
        <span className="px-2 py-0.5 rounded-md bg-ink text-ink-inverse text-ui font-mono font-semibold">
          {interaction.toolName}
        </span>
        {description && (
          <span className="text-ui text-ink-muted min-w-0 truncate">
            {description}
          </span>
        )}
      </div>

      {command ? (
        <pre className="text-ui font-mono leading-relaxed whitespace-pre-wrap break-all rounded-card border border-line bg-surface px-3 py-2.5 max-h-[260px] overflow-y-auto text-ink">
          {command}
        </pre>
      ) : (
        inputJson &&
        inputJson !== "{}" && (
          <pre className="text-ui font-mono leading-relaxed whitespace-pre-wrap break-all rounded-card border border-line bg-surface px-3 py-2.5 max-h-[260px] overflow-y-auto text-ink-muted">
            {inputJson}
          </pre>
        )
      )}

      {stale ? (
        <StaleNotice />
      ) : (
        <>
          {showDeny && (
            <textarea
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选）— 会传给模型，让它换个做法"
              disabled={submitting !== null}
              rows={2}
              className="w-full px-3 py-2 rounded-field border border-line-strong bg-surface text-ui text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent-line/60 resize-y"
            />
          )}
          <div className="flex flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => decide("allow")}
              disabled={submitting !== null}
              className="px-4 py-2 rounded-field bg-accent text-ink-inverse text-ui font-medium hover:bg-accent-strong active:scale-95 transition disabled:opacity-50 disabled:active:scale-100 flex items-center gap-2"
            >
              {submitting === "allow" && (
                <span className="w-3.5 h-3.5 border-2 border-white/40 border-t-white rounded-full animate-spin" />
              )}
              ✅ 允许
            </button>
            <button
              type="button"
              onClick={() => decide("always")}
              disabled={submitting !== null}
              title={`本轮回答内 ${interaction.toolName} 不再逐个确认（下一轮重置）`}
              className="px-4 py-2 rounded-field border border-accent-line bg-accent-muted text-accent-ink text-ui font-medium hover:bg-accent-line/40 active:scale-95 transition disabled:opacity-50 disabled:active:scale-100 flex items-center gap-2"
            >
              {submitting === "always" && (
                <span className="w-3.5 h-3.5 border-2 border-accent/30 border-t-accent rounded-full animate-spin" />
              )}
              ✅ 本轮总是允许
            </button>
            {showDeny ? (
              <button
                type="button"
                onClick={() => decide("deny")}
                disabled={submitting !== null}
                className="px-4 py-2 rounded-field border border-warn-line bg-warn-muted text-warn-ink text-ui font-medium hover:bg-warn-line/30 active:scale-95 transition disabled:opacity-50 disabled:active:scale-100 flex items-center gap-2"
              >
                {submitting === "deny" && (
                  <span className="w-3.5 h-3.5 border-2 border-warn/30 border-t-warn rounded-full animate-spin" />
                )}
                ✋ 确认拒绝
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setShowDeny(true)}
                disabled={submitting !== null}
                className="px-4 py-2 rounded-field border border-line-strong text-ink-muted text-ui font-medium hover:bg-surface-muted active:scale-95 transition disabled:opacity-50"
              >
                ✋ 拒绝
              </button>
            )}
          </div>
        </>
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
      // allow 必须回传 updatedInput（SDK 侧 schema 要求 record，缺了会
      // ZodError 打断整个 run）。计划审批不改写入参，原样回传即可。
      ...(behavior === "allow" ? { updatedInput: interaction.input } : {}),
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
            urlTransform={MD_URL_TRANSFORM}
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
