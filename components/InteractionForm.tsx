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
import { Button, Icon, Pill, SegmentedControl, Textarea, cn, type SegmentOption } from "@/components/ui";
import type { PendingInteraction } from "@/lib/types";
import { allowLabel, approvalToolKey, describeToolKey, type ApprovalScope } from "@/lib/approval-rules";

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

// 「模型在等你」的容器 —— bui Approval Card：浮起的卡片（card 圆角 + 叠层阴影），
// 头部一行：琥珀标签（图标 · 标题）· 工具名 chip · 描述；正文（CardBody）在下，
// 动作条（CardFooter）贴底、压一层内凹底色。
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
      className="ui-enter-up mt-4 overflow-hidden rounded-card bg-surface-raised shadow-raise"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3.5 pt-3 pb-2 text-ui text-ink">
        <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
          <Icon icon={icon} size="sm" />
          {title}
        </Pill>
        {tool && (
          <span className="inline-flex h-5.5 items-center rounded-chip bg-surface-muted px-[7px] font-mono text-[11.5px] text-ink-muted shadow-hairline">
            {tool}
          </span>
        )}
        {description && (
          <span className="min-w-0 break-words text-ink-muted">{description}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function CardBody({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-3 px-3.5 pb-3", className)}>{children}</div>;
}

// 动作条：桌面靠右排、主按钮在最右（DOM 里主按钮在前，md:flex-row-reverse 翻过来，
// 手机纵向堆叠时主按钮仍在最上）；左侧可放一句提示（加 md:mr-auto）。
function CardFooter({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line bg-surface-canvas/60 px-3 py-2.5 md:flex-row-reverse md:justify-start max-md:flex-col max-md:items-stretch max-md:gap-3">
      {children}
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

// 选项行首的序号徽标（bui .opt .n）。选中 = accent 实底；多选题选中时换成勾，
// 和单选区分开（题干旁另有「可多选」）。
function KeyBadge({ n, active, multi }: { n: number; active: boolean; multi: boolean }) {
  return (
    <span
      className={`grid size-5 shrink-0 place-items-center rounded-chip font-mono text-nano tabular-nums ${
        active ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted shadow-hairline"
      }`}
      aria-hidden
    >
      {active && multi ? <Check size={12} strokeWidth={3} /> : n}
    </span>
  );
}

const optionRowClass = (active: boolean) =>
  `flex w-full min-h-[38px] max-md:min-h-11 items-start gap-2.5 px-2 py-[9px] rounded-field text-left transition-colors disabled:opacity-60 ${
    active ? "bg-accent-muted" : "hover:bg-surface-hover"
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

  const total = questions.length;
  return (
    <>
      <CardBody className="gap-4">
        {questions.map((q, qi) => {
          const multi = !!q.multiSelect;
          const chosen = selections[qi] ?? [];
          const options = q.options ?? [];
          return (
            <div key={qi} className="flex flex-col gap-1.5">
              {(q.header || total > 1) && (
                <div className="flex items-center gap-2 text-label text-ink-faint">
                  {q.header && <span className="font-medium">{q.header}</span>}
                  {total > 1 && (
                    <span className="ml-auto tabular-nums">
                      {qi + 1} / {total}
                    </span>
                  )}
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
              <div className="-mx-2 flex flex-col gap-0.5">
                {options.map((opt, oi) => {
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
                      <KeyBadge n={oi + 1} active={active} multi={multi} />
                      <span className="min-w-0 flex-1">
                        <span className="block text-[13.5px] leading-5 text-ink">
                          {opt.label}
                        </span>
                        {opt.description && (
                          <span className="block text-label text-ink-faint mt-0.5">
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
                  <KeyBadge n={options.length + 1} active={!!customOn[qi]} multi={multi} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13.5px] leading-5 text-ink">
                      其他
                    </span>
                    <span className="block text-label text-ink-faint mt-0.5">
                      输入自定义回答
                    </span>
                  </span>
                </button>
                {customOn[qi] && (
                  <div className="px-2 pt-1">
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
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </CardBody>

      <CardFooter>
        {stale ? (
          <StaleNotice />
        ) : (
          <>
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
              <span className="text-ui text-ink-muted md:mr-auto">
                请回答全部问题
              </span>
            )}
          </>
        )}
      </CardFooter>
    </>
  );
}

// ── 权限卡（requireApproval 会话的通用工具审批）─────────────────────────
// Bash 显示 command（等宽块），其余工具显示入参 JSON。动作分三档作用域
// （参考 Codex 手机端）：仅本次 / 本会话始终允许 / 所有会话始终允许，外加拒绝
// （可附理由，作为 tool_result 回给模型）。作用域是次级选择（分段控件），主按钮
// 永远是「允许」本身、文案跟着作用域走；选了 session/global 时显示将要落下的
// 规则文本，点之前就知道放行范围。
const SCOPE_OPTIONS: SegmentOption<ApprovalScope>[] = [
  { value: "once", label: "仅本次" },
  { value: "session", label: "本会话" },
  { value: "global", label: "所有会话" },
];

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
  const [scope, setScope] = useState<ApprovalScope>("once");
  const [submitting, setSubmitting] = useState<"allow" | "deny" | null>(null);
  const [stale, setStale] = useState(false);
  // null = 这类交互不能建规则（只能逐次答），不渲染作用域选择。
  const toolKey = approvalToolKey(interaction);
  const effectiveScope: ApprovalScope = toolKey ? scope : "once";

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

  const decide = async (kind: "allow" | "deny") => {
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
            scope: effectiveScope,
          });
    if (!res.ok && res.reason === "stale") {
      setStale(true);
    }
    setSubmitting(null);
  };

  return (
    <>
      <CardBody>
        {command ? (
          <pre className="text-[12.5px] font-mono leading-[1.6] whitespace-pre-wrap break-all rounded-field bg-surface-muted shadow-hairline px-3 py-2 max-h-64 overflow-y-auto text-ink">
            {command}
          </pre>
        ) : (
          inputJson &&
          inputJson !== "{}" && (
            <pre className="text-[12.5px] font-mono leading-[1.6] whitespace-pre-wrap break-all rounded-field bg-surface-muted shadow-hairline px-3 py-2 max-h-64 overflow-y-auto text-ink-muted">
              {inputJson}
            </pre>
          )
        )}

        {!stale && showDeny && (
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
        {!stale && toolKey && (
          <div data-mobile-target="permission-scope" className="flex flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2 max-md:flex-col max-md:items-stretch">
              <span className="text-label text-ink-muted">放行范围</span>
              <SegmentedControl
                aria-label="放行范围"
                value={scope}
                onValueChange={setScope}
                options={SCOPE_OPTIONS}
                // 手机整宽三等分（每档 44px 高），桌面按内容宽度紧凑排在标签右侧。
                className="max-md:flex max-md:w-full max-md:[&>button]:flex-1 [&>button]:whitespace-nowrap"
              />
            </div>
            {scope !== "once" && (
              <p
                data-approval-rule-preview
                className={cn("text-label", scope === "global" ? "text-warn-ink" : "text-ink-muted")}
              >
                将放行 {describeToolKey(toolKey)}
                {scope === "session"
                  ? "（仅本会话，会话删除即失效）"
                  : "（所有需审批的会话，可在 设置 › 已授权规则 撤销）"}
              </p>
            )}
          </div>
        )}
      </CardBody>
      {/* 权重铁律：允许 = 主按钮（最宽，文案随作用域）；拒绝 = 描边，点后出理由
          框再确认。手机端纵向堆叠，主按钮整宽、加高在最上。 */}
      <CardFooter>
        {stale ? (
          <StaleNotice />
        ) : (
          <>
            <Button
              type="button"
              variant="primary"
              data-mobile-target="permission-allow"
              data-scope={effectiveScope}
              onClick={() => decide("allow")}
              disabled={submitting !== null}
              loading={submitting === "allow"}
              className="min-w-36 max-md:w-full max-md:min-h-12"
            >
              {allowLabel(effectiveScope)}
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
          </>
        )}
      </CardFooter>
    </>
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
    <>
      <CardBody>
        {plan && (
          <div className="md-body text-body text-ink leading-relaxed max-h-96 overflow-y-auto rounded-field bg-surface-muted shadow-hairline px-4 py-3">
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

        {!stale && showDeny && (
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
      </CardBody>
      <CardFooter>
        {stale ? (
          <StaleNotice />
        ) : (
          <>
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
          </>
        )}
      </CardFooter>
    </>
  );
}
