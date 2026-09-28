"use client";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import { useSessionStore } from "@/stores/sessionStore";
import { MD_COMPONENTS, MD_URL_TRANSFORM } from "@/lib/md-components";
import {
  MARKDOWN_REHYPE_PLUGINS,
  MARKDOWN_REMARK_PLUGINS,
} from "@/lib/markdown-plugins";
import { Check, CircleAlert, ListChecks, MessageCircleQuestion, ShieldCheck, type LucideIcon } from "lucide-react";
import { Button, Icon, Textarea, Tooltip } from "@/components/ui";
import type { PendingInteraction } from "@/lib/types";

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
      <InteractionShell icon={MessageCircleQuestion} title="模型在等你回答">
        <AskUserQuestionForm nodeId={nodeId} interaction={interaction} />
      </InteractionShell>
    );
  }
  if (interaction.toolName === "ExitPlanMode") {
    return (
      <InteractionShell icon={ListChecks} title="计划待你批准">
        <ExitPlanModeForm nodeId={nodeId} interaction={interaction} />
      </InteractionShell>
    );
  }
  // 权限确认（requireApproval session）：其余一切工具 = 待审批的可变更操作。
  // 自动批准会话里普通工具从不暂停（run-bus auto-allow），所以这个分支只在
  // 权限确认会话里可达。
  const description =
    typeof (interaction.input as Record<string, unknown> | null)?.description === "string"
      ? ((interaction.input as Record<string, unknown>).description as string)
      : null;
  return (
    <InteractionShell
      icon={ShieldCheck}
      title="需要你批准"
      tool={interaction.toolName}
      description={description}
    >
      <PermissionForm nodeId={nodeId} interaction={interaction} />
    </InteractionShell>
  );
}

// 「模型在等你」的容器：描边卡（accent 细描边 + surface 底，不投影、不铺大底）
// —— 与稿子 .approve 同一语言。头部一行：图标 · 标题 · 工具名标签 · 描述。
function InteractionShell({
  children,
  icon,
  title,
  tool,
  description,
}: {
  children: React.ReactNode;
  icon: LucideIcon;
  title: string;
  tool?: string;
  description?: string | null;
}) {
  return (
    <div
      data-mobile-interaction
      className="mt-4 rounded-card border border-accent-line bg-surface p-3.5 max-md:p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-ui text-ink">
        <Icon icon={icon} className="text-accent" />
        <span className="font-medium">{title}</span>
        {tool && (
          <span className="rounded-sm border border-line-strong px-1.5 font-mono text-label text-ink">
            {tool}
          </span>
        )}
        {description && (
          <span className="min-w-0 break-words text-ink-muted">{description}</span>
        )}
      </div>
      <div className="mt-2.5">{children}</div>
    </div>
  );
}

function StaleNotice() {
  return (
    <div className="text-ui text-warn-ink flex items-center gap-2">
      <Icon icon={CircleAlert} size="sm" />
      <span>会话已失效，请重试</span>
    </div>
  );
}

// 选项行的单选 / 多选标记。选中 = accent 实底 + 勾；未选 = 中性描边。
function ChoiceMark({ active, multi }: { active: boolean; multi: boolean }) {
  return (
    <span
      className={`mt-0.5 shrink-0 w-4 h-4 flex items-center justify-center border ${
        multi ? "rounded-sm" : "rounded-full"
      } ${active ? "bg-accent border-accent text-accent-fg" : "border-line-strong bg-surface"}`}
      aria-hidden
    >
      {active && <Check size={11} strokeWidth={3} />}
    </span>
  );
}

const optionRowClass = (active: boolean) =>
  `w-full max-md:min-h-11 text-left px-3 py-2 rounded-field border transition-colors flex items-start gap-2.5 disabled:opacity-60 ${
    active
      ? "border-accent-line bg-accent-muted"
      : "border-line bg-surface hover:bg-surface-hover"
  }`;

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
              <div className="text-label font-medium text-ink-faint">
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
                    data-mobile-target="ask-option"
                    aria-pressed={active}
                    disabled={submitting}
                    onClick={() => toggle(qi, opt.label, multi)}
                    className={optionRowClass(active)}
                  >
                    <ChoiceMark active={active} multi={multi} />
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
                data-mobile-target="ask-option"
                aria-pressed={!!customOn[qi]}
                disabled={submitting}
                onClick={() => toggleCustom(qi, multi)}
                className={optionRowClass(!!customOn[qi])}
              >
                <ChoiceMark active={!!customOn[qi]} multi={multi} />
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
                <Textarea
                  autoFocus
                  value={customs[qi] ?? ""}
                  onChange={(e) =>
                    setCustoms((prev) => ({ ...prev, [qi]: e.target.value }))
                  }
                  placeholder="输入你的回答……"
                  disabled={submitting}
                  rows={2}
                  className="resize-y"
                />
              )}
            </div>
          </div>
        );
      })}

      {stale ? (
        <StaleNotice />
      ) : (
        <div className="flex items-center gap-3 max-md:flex-col max-md:items-stretch">
          <Button
            type="button"
            data-mobile-target="ask-submit"
            variant="primary"
            className="max-md:w-full"
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
      {command ? (
        <pre className="text-ui font-mono leading-relaxed whitespace-pre-wrap break-all rounded-field border border-line bg-surface-muted px-3 py-2 max-h-64 overflow-y-auto text-ink">
          {command}
        </pre>
      ) : (
        inputJson &&
        inputJson !== "{}" && (
          <pre className="text-ui font-mono leading-relaxed whitespace-pre-wrap break-all rounded-field border border-line bg-surface-muted px-3 py-2 max-h-64 overflow-y-auto text-ink-muted">
            {inputJson}
          </pre>
        )
      )}

      {stale ? (
        <StaleNotice />
      ) : (
        <>
          {showDeny && (
            <Textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选）— 会传给模型，让它换个做法"
              disabled={submitting !== null}
              rows={2}
              className="resize-y"
            />
          )}
          {/* 权重铁律：允许一次 = 主按钮（最宽）；拒绝 = 描边，点后出理由框再
              确认；总是允许 = 靠右的低权重文字按钮。手机端纵向堆叠，顺序不变。 */}
          <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-3">
            <Button
              type="button"
              variant="primary"
              data-mobile-target="permission-allow"
              onClick={() => decide("allow")}
              disabled={submitting !== null}
              loading={submitting === "allow"}
              className="min-w-36 max-md:w-full"
            >
              允许一次
            </Button>
            {showDeny ? (
              <Button
                type="button"
                variant="danger"
                data-mobile-target="permission-deny-confirm"
                onClick={() => decide("deny")}
                disabled={submitting !== null}
                loading={submitting === "deny"}
                className="max-md:w-full"
              >
                确认拒绝
              </Button>
            ) : (
              <Button
                type="button"
                variant="secondary"
                data-mobile-target="permission-deny"
                onClick={() => setShowDeny(true)}
                disabled={submitting !== null}
                className="max-md:w-full"
              >
                拒绝
              </Button>
            )}
            <Tooltip
              content={`本轮回答内 ${interaction.toolName} 不再逐个确认（下一轮重置）`}
              side="top"
            >
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-mobile-target="permission-always"
                onClick={() => decide("always")}
                disabled={submitting !== null}
                loading={submitting === "always"}
                className="ml-auto font-normal max-md:ml-0 max-md:self-start"
              >
                本轮总是允许
              </Button>
            </Tooltip>
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
        <div className="md-body text-body text-ink leading-relaxed max-h-96 overflow-y-auto rounded-field border border-line bg-surface-muted px-4 py-3">
          <ReactMarkdown
            remarkPlugins={MARKDOWN_REMARK_PLUGINS}
            rehypePlugins={MARKDOWN_REHYPE_PLUGINS}
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
            <Textarea
              autoFocus
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="拒绝理由（可选）— 会传给模型，让它调整计划"
              disabled={submitting !== null}
              rows={3}
              className="resize-y"
            />
          )}
          <div className="flex items-center gap-2 max-md:flex-col max-md:items-stretch max-md:gap-3">
            <Button
              type="button"
              data-mobile-target="plan-allow"
              variant="primary"
              className="min-w-36 max-md:w-full"
              onClick={() => decide("allow")}
              disabled={submitting !== null}
              loading={submitting === "allow"}
            >
              批准执行
            </Button>
            {showDeny ? (
              <Button
                type="button"
                variant="danger"
                data-mobile-target="plan-deny-confirm"
                onClick={() => decide("deny")}
                disabled={submitting !== null}
                loading={submitting === "deny"}
                className="max-md:w-full"
              >
                确认拒绝
              </Button>
            ) : (
              <Button
                type="button"
                data-mobile-target="plan-deny"
                variant="secondary"
                className="max-md:w-full"
                onClick={() => setShowDeny(true)}
                disabled={submitting !== null}
              >
                拒绝
              </Button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
