"use client";

// 阻塞 hook 交互的作答卡：trellis 拉起的 claude 在 PreToolUse(AskUserQuestion) /
// PermissionRequest 时 hook 挂住等 Trellis，这里直接把结构化答案交给
// POST /api/herdr/interactions/:id，不往窗格发任何按键。
//
// 2.1.280 实测：AskUserQuestion 的 PreToolUse hook 挂住期间，电脑上的 TUI 看不到选择卡
// （只有 statusMessage 转圈）；PermissionRequest（含计划审批）则 TUI 照常弹框、与 hook 并行，
// 谁先答算谁。所以每张卡都有「交给终端」：hook 无输出退出，TUI 照常弹框，之后由原来的
// 发按键 / 读屏路径接手。
//
// DOM 约定沿用 HerdrInteractionCard（[data-herdr-card] / [data-herdr-approval] /
// data-mobile-target=herdr-permission-allow|deny），手机端 HerdrSwipeCard 的滑动作答照常生效。
import { useMemo, useState, type ReactNode } from "react";
import {
  Check,
  CircleCheck,
  ClipboardList,
  Maximize2,
  MessageCircleQuestion,
  ShieldCheck,
  SquareTerminal,
} from "lucide-react";
import { Button, Icon, Input, Modal, Pill, Textarea, cn, toast } from "@/components/ui";
import { MarkdownBody } from "@/lib/markdown-cache";
import { herdrPanePrompt, type HerdrPaneView } from "@/lib/herdr-ui";
import { herdrApproval, herdrAskQuestions, type HerdrAskQuestion } from "@/lib/herdr-console";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  BlockingAnswerError,
  answerBlockingInteraction,
  handoffBlockingInteraction,
  type BlockingSummary,
  type InteractionResolution,
  type PlanMode,
} from "@/lib/herdr-blocking";
import { OptionList, hookItems, options } from "./HerdrOptionList";

/**
 * 刚在 Trellis 上答过、观测 hook 还没收起 waiting 的那段时间：仍由本卡显示「已作答」，
 * 不能退回发按键路径（那边会把同一张卡再画一遍，用户可能再按一次键）。
 * 只认同一次工具调用：工具名一致，且两边都有 tool_use_id 时必须相同。
 */
export function blockingAnswered(pane: HerdrPaneView): boolean {
  const blocking = pane.hook?.blocking;
  if (blocking?.status !== "resolved") return false;
  const prompt = herdrPanePrompt(pane);
  if (!prompt || prompt.source !== "hook") return false;
  const tool = prompt.toolName ?? pane.hook?.toolName ?? null;
  if (tool !== blocking.toolName) return false;
  return !blocking.toolUseId || !prompt.toolUseId || blocking.toolUseId === prompt.toolUseId;
}

type Props = {
  pane: HerdrPaneView;
  compact?: boolean;
  embedded?: boolean;
  footer?: ReactNode;
};

type Phase = "idle" | "sending" | "answered" | "handoff" | "error";

const PLAN_MODES: { mode: PlanMode; label: string; title: string }[] = [
  { mode: "bypassPermissions", label: "批准并自动执行", title: "批准计划，之后的工具调用不再询问（bypassPermissions；会话不是以 bypass 启动时退到 auto 模式）" },
  { mode: "acceptEdits", label: "批准并自动接受编辑", title: "批准计划，文件编辑自动通过，其余照常询问（acceptEdits）" },
];

export function HerdrBlockingCard({ pane, compact = false, embedded = false, footer }: Props) {
  const blocking = pane.hook?.blocking as BlockingSummary;
  // 换一次交互时宿主用 key={blocking.id} 重挂本组件，本地状态自然复位。
  const [localPhase, setPhase] = useState<Phase>("idle");
  const [errorText, setErrorText] = useState("");
  const phase: Phase = blocking.status === "resolved" ? "answered" : localPhase;

  const send = async (run: () => Promise<{ connected: boolean }>, done: Phase) => {
    if (phase === "sending" || phase === "answered" || phase === "handoff") return;
    setPhase("sending");
    try {
      const { connected } = await run();
      setPhase(done);
      if (!connected && done === "answered") {
        toast("已记下回答", { description: "终端那边的 hook 正在重连，连上后立即生效" });
      }
    } catch (error) {
      setErrorText(
        error instanceof BlockingAnswerError && error.status === 409
          ? `${error.message}，卡片会退回终端作答`
          : error instanceof Error ? `发送失败：${error.message}` : "发送失败，请重试",
      );
      setPhase("error");
    } finally {
      void refreshHerdrFleet();
    }
  };
  const answer = (resolution: InteractionResolution) => send(() => answerBlockingInteraction(blocking.id, resolution), "answered");
  const handoff = () => send(() => handoffBlockingInteraction(blocking.id), "handoff");

  const shell = (kind: string, children: ReactNode) => (
    <div
      data-herdr-card
      data-herdr-card-kind={kind}
      data-herdr-card-source="blocking"
      data-herdr-blocking={blocking.id}
      className={cn("relative", embedded ? "px-3.5 pb-3 text-ink" : `${compact ? "mx-2 mb-2 p-2.5" : "p-3.5 max-md:p-3"} ui-enter-up rounded-card bg-surface-raised shadow-raise text-ink`)}
    >
      <span
        data-herdr-card-source-badge
        title="数据来源：阻塞 hook（结构化作答，不发按键）"
        className="absolute bottom-1 right-1.5 cursor-default select-none font-mono text-nano leading-none text-ink-faint opacity-25 transition-opacity hover:opacity-100"
      >
        B
      </span>
      {children}
    </div>
  );

  if (phase === "answered" || phase === "handoff") {
    return (
      <div
        data-herdr-card
        data-herdr-card-state={phase}
        data-herdr-card-source="blocking"
        className={embedded ? "flex items-center gap-2 px-3.5 pb-3 text-ui text-ink-muted" : `${compact ? "mx-2 mb-2 px-3 py-2" : "px-3.5 py-2.5 max-md:px-3"} flex items-center gap-2 rounded-card bg-surface-raised shadow-raise text-ui text-ink-muted`}
        aria-live="polite"
      >
        <Icon icon={phase === "answered" ? CircleCheck : SquareTerminal} size="sm" className={phase === "answered" ? "text-positive" : undefined} />
        {phase === "answered" ? "已在 Trellis 作答，Claude 继续中…" : "已交给终端，请在电脑上的 TUI 里作答"}
      </div>
    );
  }

  const busy = phase === "sending";
  const tail = (
    <BlockingTail
      connected={blocking.connected}
      busy={busy}
      onHandoff={() => void handoff()}
      error={phase === "error" ? errorText : ""}
    />
  );

  if (blocking.kind === "plan") {
    return shell("plan", (
      <PlanBody
        plan={blocking.plan ?? ""}
        embedded={embedded}
        busy={busy}
        onApprove={(mode) => void answer({ type: "plan", approve: true, mode })}
        onReject={(feedback) => void answer({ type: "plan", approve: false, ...(feedback ? { feedback } : {}) })}
        footer={footer}
        tail={tail}
      />
    ));
  }

  if (blocking.kind === "permission") {
    const hookApproval = herdrApproval(pane.hook?.interactivePrompt);
    const summary = blocking.summary ?? hookApproval?.summary ?? "";
    return shell("permission", (
      <>
        <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
          <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
            <Icon icon={ShieldCheck} size="sm" />
            需要你批准
          </Pill>
          <span className="inline-flex h-5.5 items-center rounded-chip bg-surface-muted px-[7px] font-mono text-[11.5px] text-ink-muted shadow-hairline">
            {blocking.toolName}
          </span>
        </div>
        <div className="mt-2" data-herdr-approval>
          {summary && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-field bg-surface-muted px-3 py-2 font-mono text-label text-ink shadow-hairline">
              {summary}
            </pre>
          )}
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:flex">
            <Button
              type="button"
              variant="primary"
              data-mobile-target="herdr-permission-allow"
              disabled={busy}
              onClick={() => void answer({ type: "permission", allow: true })}
              className="min-h-11 sm:min-h-8 sm:min-w-36"
            >
              允许
            </Button>
            {blocking.canAlways && (
              <Button
                type="button"
                variant="secondary"
                data-herdr-permission-always
                disabled={busy}
                onClick={() => void answer({ type: "permission", allow: true, always: true })}
                className="min-h-11 min-w-0 sm:min-h-8"
                title={`允许，并在本会话里记住 ${blocking.toolName} 的这类调用（只到 claude 退出为止）`}
              >
                <span className="truncate">本会话总是允许</span>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              data-mobile-target="herdr-permission-deny"
              disabled={busy}
              onClick={() => void answer({ type: "permission", allow: false })}
              className="min-h-11 sm:min-h-8"
            >
              拒绝
            </Button>
            {footer}
          </div>
        </div>
        {tail}
      </>
    ));
  }

  return shell("question", (
    <QuestionBody
      questions={herdrAskQuestions({ questions: blocking.questions ?? [] })}
      embedded={embedded}
      columns={!compact && !embedded}
      busy={busy}
      onSubmit={(answers) => void answer({ type: "answers", answers })}
      footer={footer}
      tail={tail}
    />
  ));
}

function BlockingTail({ connected, busy, onHandoff, error }: { connected: boolean; busy: boolean; onHandoff: () => void; error: string }) {
  return (
    <>
      <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button
          type="button"
          variant="link"
          data-herdr-blocking-handoff
          disabled={busy}
          onClick={onHandoff}
          title="不在这里答：让电脑上的终端照常弹出对话框"
          className="text-label text-ink-muted"
        >
          <Icon icon={SquareTerminal} size="sm" />
          交给终端
        </Button>
        {!connected && <span className="text-label text-ink-faint">终端那边的 hook 正在重连…</span>}
      </div>
      {error && <div className="mt-2 text-label text-danger-ink">{error}</div>}
    </>
  );
}

// ── AskUserQuestion ──────────────────────────────────────────────────────

function QuestionBody({
  questions,
  embedded,
  columns,
  busy,
  onSubmit,
  footer,
  tail,
}: {
  questions: HerdrAskQuestion[];
  embedded: boolean;
  columns: boolean;
  busy: boolean;
  onSubmit: (answers: Record<string, string>) => void;
  footer?: ReactNode;
  tail: ReactNode;
}) {
  const [step, setStep] = useState(0);
  // 每题的答案：选中的选项下标（多选可多个）或自由文本
  const [picks, setPicks] = useState<Record<number, number[]>>({});
  const [texts, setTexts] = useState<Record<number, string>>({});
  const [draft, setDraft] = useState("");

  const answerOf = (index: number, nextPicks = picks, nextTexts = texts): string => {
    const q = questions[index];
    const text = nextTexts[index]?.trim();
    if (text) return text;
    const labels = (nextPicks[index] ?? [])
      .map((i) => options(q)[i]?.label)
      .filter((l): l is string => typeof l === "string" && l !== "");
    return labels.join(", ");
  };
  const allAnswers = (nextPicks = picks, nextTexts = texts): Record<string, string> | null => {
    const out: Record<string, string> = {};
    for (let i = 0; i < questions.length; i++) {
      const text = typeof questions[i].question === "string" ? (questions[i].question as string) : "";
      const value = answerOf(i, nextPicks, nextTexts);
      if (!text || !value) return null;
      out[text] = value;
    }
    return out;
  };
  // 单题单选：点了就交（与 TUI 的数字直选一致）；多题：逐题选完进「确认」页再交。
  const single = questions.length === 1 && questions[0]?.multiSelect !== true;
  const advance = (nextPicks: Record<number, number[]>, nextTexts: Record<number, string>) => {
    if (single) {
      const all = allAnswers(nextPicks, nextTexts);
      if (all) onSubmit(all);
      return;
    }
    setStep((s) => s + 1);
    setDraft("");
  };

  const reviewing = step >= questions.length;
  const question = questions[step];
  const multiSelect = question?.multiSelect === true;
  const ready = useMemo(() => allAnswers() !== null, [picks, texts, questions]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <>
      <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
        <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
          <Icon icon={MessageCircleQuestion} size="sm" />
          Claude 在等你回答
        </Pill>
        {questions.length > 1 && (
          <span className="ml-auto text-label text-ink-faint tabular-nums">
            {Math.min(step + 1, questions.length)}/{questions.length}
          </span>
        )}
      </div>

      {question && (
        <div className="mt-2" data-herdr-question>
          {typeof question.header === "string" && question.header && (
            <div className="text-label text-ink-faint">{question.header}</div>
          )}
          <div className="text-sm font-medium">
            {typeof question.question === "string" ? question.question : "请选择一个选项"}
          </div>
          <OptionList
            items={hookItems(question, picks[step] ?? [])}
            columns={columns}
            clampDescription={embedded}
            multiSelect={multiSelect}
            disabled={busy}
            onPick={(item) => {
              const index = item.index - 1;
              const current = picks[step] ?? [];
              const nextPicks = {
                ...picks,
                [step]: multiSelect
                  ? current.includes(index) ? current.filter((v) => v !== index) : [...current, index]
                  : [index],
              };
              const nextTexts = { ...texts, [step]: "" };
              setPicks(nextPicks);
              setTexts(nextTexts);
              if (!multiSelect) advance(nextPicks, nextTexts);
            }}
          />
          {multiSelect && (
            <Button
              type="button"
              variant="primary"
              data-herdr-multi-next
              data-mobile-target="herdr-multi-next"
              disabled={busy || !(picks[step]?.length)}
              onClick={() => advance(picks, texts)}
              className="mt-2 min-h-11 w-full"
            >
              {single || step >= questions.length - 1 ? "确认所选项" : "下一题"}
            </Button>
          )}
          <form
            className="mt-2 flex flex-wrap gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const text = draft.trim();
              if (!text) return;
              const nextTexts = { ...texts, [step]: text };
              const nextPicks = { ...picks, [step]: [] };
              setTexts(nextTexts);
              setPicks(nextPicks);
              advance(nextPicks, nextTexts);
            }}
          >
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder="都不合适？直接写你的回答"
              aria-label="自由输入回答"
              data-herdr-free-text
              disabled={busy}
              className="min-w-0 flex-1 max-md:min-h-11"
            />
            <Button type="submit" variant="secondary" disabled={busy || !draft.trim()} className="min-h-11 sm:min-h-8">
              {single ? "发送" : "确定"}
            </Button>
          </form>
        </div>
      )}

      {reviewing && (
        <div className="mt-2" data-herdr-review>
          <ul className="space-y-1 text-ui">
            {questions.map((q, i) => (
              <li key={i} className="flex min-w-0 gap-2">
                <button
                  type="button"
                  onClick={() => setStep(i)}
                  className="min-w-0 truncate text-left text-ink-muted hover:text-ink"
                  title="改这一题"
                >
                  {typeof q.header === "string" && q.header ? q.header : `第 ${i + 1} 题`}
                </button>
                <span className="min-w-0 flex-1 truncate font-medium">{answerOf(i) || "（未答）"}</span>
              </li>
            ))}
          </ul>
          <Button
            type="button"
            variant="primary"
            data-herdr-submit-answers
            data-mobile-target="herdr-submit-answers"
            disabled={busy || !ready}
            onClick={() => {
              const all = allAnswers();
              if (all) onSubmit(all);
            }}
            className="mt-2 min-h-11 w-full"
          >
            <Icon icon={Check} size="sm" />
            提交回答
          </Button>
        </div>
      )}
      {footer && <div className="mt-2.5 flex flex-wrap gap-2">{footer}</div>}
      {tail}
    </>
  );
}

// ── ExitPlanMode ─────────────────────────────────────────────────────────

function PlanBody({
  plan,
  embedded,
  busy,
  onApprove,
  onReject,
  footer,
  tail,
}: {
  plan: string;
  embedded: boolean;
  busy: boolean;
  onApprove: (mode: PlanMode) => void;
  onReject: (feedback: string) => void;
  footer?: ReactNode;
  tail: ReactNode;
}) {
  const [full, setFull] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [feedback, setFeedback] = useState("");
  const cacheKey = `herdr-plan:${plan.length}:${plan.slice(0, 64)}`;

  const actions = (
    <div className="mt-2.5 flex flex-col gap-2 sm:flex-row sm:flex-wrap" data-herdr-plan-actions>
      {rejecting ? (
        <>
          <Textarea
            autoFocus
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="写下修改意见 — 会传给模型，让它改计划再提交"
            aria-label="打回意见"
            disabled={busy}
            rows={3}
            className="w-full resize-y"
          />
          <div className="flex gap-2">
            <Button
              type="button"
              variant="danger"
              data-herdr-plan-reject-confirm
              disabled={busy}
              onClick={() => {
                setFull(false);
                onReject(feedback.trim());
              }}
              className="min-h-11 flex-1 sm:min-h-8 sm:flex-none"
            >
              确认打回
            </Button>
            <Button type="button" variant="ghost" disabled={busy} onClick={() => setRejecting(false)} className="min-h-11 sm:min-h-8">
              取消
            </Button>
          </div>
        </>
      ) : (
        <>
          {PLAN_MODES.map(({ mode, label, title }, i) => (
            <Button
              key={mode}
              type="button"
              variant={i === 0 ? "primary" : "secondary"}
              data-herdr-plan-approve={mode}
              data-mobile-target={i === 0 ? "herdr-plan-approve" : undefined}
              disabled={busy}
              title={title}
              onClick={() => {
                setFull(false);
                onApprove(mode);
              }}
              className="min-h-11 sm:min-h-8"
            >
              {label}
            </Button>
          ))}
          <Button
            type="button"
            variant="ghost"
            data-herdr-plan-reject
            disabled={busy}
            onClick={() => setRejecting(true)}
            className="min-h-11 sm:min-h-8"
          >
            打回写意见
          </Button>
          {footer}
        </>
      )}
    </div>
  );

  return (
    <>
      <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
        <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
          <Icon icon={ClipboardList} size="sm" />
          计划待审批
        </Pill>
      </div>
      <div className="relative mt-2" data-herdr-plan>
        <div className="md-body max-h-80 overflow-y-auto rounded-field bg-surface-muted px-4 py-3 text-body leading-relaxed text-ink shadow-hairline max-md:max-h-64">
          {plan ? <MarkdownBody cacheKey={cacheKey} content={plan} /> : <span className="text-ink-faint">（计划为空）</span>}
        </div>
        {plan && (
          <Button
            type="button"
            variant="secondary"
            size="icon"
            data-herdr-plan-fullscreen
            aria-label="全屏查看计划"
            title="全屏查看计划"
            onClick={() => setFull(true)}
            className="absolute right-2 top-2"
          >
            <Icon icon={Maximize2} size="sm" />
          </Button>
        )}
      </div>
      {actions}
      {tail}
      {full && (
        <Modal size="full" title="计划待审批" onClose={() => setFull(false)}>
          <div className="flex h-full min-h-0 flex-col p-4 max-md:p-3">
            <div className="flex items-center gap-2 text-ui">
              <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
                <Icon icon={ClipboardList} size="sm" />
                计划待审批
              </Pill>
              <Button type="button" variant="ghost" size="sm" className="ml-auto" onClick={() => setFull(false)}>
                收起
              </Button>
            </div>
            <div className="md-body mt-3 min-h-0 flex-1 overflow-y-auto text-body leading-relaxed text-ink">
              <MarkdownBody cacheKey={cacheKey} content={plan} />
            </div>
            {actions}
          </div>
        </Modal>
      )}
    </>
  );
}
