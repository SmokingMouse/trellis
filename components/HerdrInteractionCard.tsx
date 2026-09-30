"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  ChevronRight,
  CircleCheck,
  MessageCircleQuestion,
  MessagesSquare,
  ShieldCheck,
  Square,
  SquareCheck,
  SquareTerminal,
} from "lucide-react";
import { Badge, Button, Icon, Input, cn } from "@/components/ui";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  herdrApproval,
  herdrAskQuestions,
  type HerdrAskOption,
  type HerdrAskQuestion,
} from "@/lib/herdr-console";
import { readHerdrPane, sendHerdrInput, sendHerdrKeys } from "@/lib/herdr-actions";
import {
  herdrOptionKeys,
  herdrScreenSignature,
  parseHerdrScreen,
  type HerdrScreenPrompt,
} from "@/lib/herdr-screen-parse";

const RECOMMENDED = /\s*[（(]\s*(推荐|recommended)\s*[)）]\s*$/i;
const SCREEN_LINES = 40;

function options(question: HerdrAskQuestion): HerdrAskOption[] {
  return Array.isArray(question.options)
    ? (question.options as HerdrAskOption[])
    : [];
}

/** 「总是允许」按钮上的对象：Bash 取命令前两个词，其余用工具名。 */
function alwaysTarget(prompt: { tool: string; summary: string }): string {
  if (prompt.tool === "Bash" && prompt.summary) {
    return prompt.summary.trim().split(/\s+/).slice(0, 2).join(" ");
  }
  return prompt.tool;
}

type OptionItem = {
  key: string;
  /** TUI 序号（1 起） */
  index: number;
  label: string;
  description?: string;
  recommended?: boolean;
  checked?: boolean;
};

/**
 * 选项卡片列表：hook 路径（AskUserQuestion tool_input）与读屏路径共用这一套。
 * 纵向列表：标题 + 弱色描述 + 「推荐」标记；宽的会话卡在 sm 以上两列。
 */
function OptionList({
  items,
  columns,
  clampDescription,
  multiSelect = false,
  disabled,
  onPick,
}: {
  items: OptionItem[];
  columns: boolean;
  /** 总览卡里描述只留一行（悬停看全文） */
  clampDescription: boolean;
  multiSelect?: boolean;
  disabled: boolean;
  onPick: (item: OptionItem) => void;
}) {
  return (
    <div className={cn("mt-2 grid gap-1.5", columns && "sm:grid-cols-2 sm:gap-2")}>
      {items.map((item) => (
        <button
          key={item.key}
          type="button"
          data-herdr-option={item.index}
          data-mobile-target="herdr-option"
          aria-pressed={multiSelect ? item.checked === true : undefined}
          disabled={disabled}
          onClick={() => onPick(item)}
          title={item.description ? `${item.label}\n${item.description}` : item.label}
          className={cn(
            "flex min-h-11 min-w-0 items-start gap-2 rounded-field border px-3 py-2 text-left text-ui text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 sm:min-h-9",
            item.checked || (!multiSelect && item.recommended)
              ? "border-accent-line"
              : "border-line",
            item.checked ? "bg-accent-muted" : "bg-surface",
          )}
        >
          <span className="mt-px inline-flex w-4 shrink-0 justify-center font-mono text-label text-ink-faint">
            {multiSelect ? (
              <Icon
                icon={item.checked ? SquareCheck : Square}
                size="sm"
                className={item.checked ? "text-accent" : undefined}
              />
            ) : (
              item.index
            )}
          </span>
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate font-medium">{item.label}</span>
              {item.recommended && (
                <Badge variant="accent" className="shrink-0">推荐</Badge>
              )}
            </span>
            {item.description && (
              <span
                className={cn(
                  "mt-0.5 block text-label text-ink-muted",
                  clampDescription && "truncate",
                )}
              >
                {item.description}
              </span>
            )}
          </span>
        </button>
      ))}
    </div>
  );
}

function hookItems(question: HerdrAskQuestion, selected: number[]): OptionItem[] {
  return options(question).map((option, index) => {
    const raw = typeof option.label === "string" ? option.label : `选项 ${index + 1}`;
    return {
      key: `${index}:${raw}`,
      index: index + 1,
      label: raw.replace(RECOMMENDED, "").trim() || raw,
      recommended: RECOMMENDED.test(raw),
      description:
        typeof option.description === "string" && option.description
          ? option.description
          : undefined,
      checked: selected.includes(index),
    };
  });
}

type ApprovalView = {
  tool: string;
  summary: string;
  allowKeys: string[];
  alwaysKeys: string[] | null;
  alwaysTitle: string;
};

function screenApproval(prompt: HerdrScreenPrompt): ApprovalView {
  const tool = prompt.tool ?? "操作";
  const summary = prompt.context.join("\n");
  const allow = prompt.options.find((option) => option.approval === "allow") ?? prompt.options[0];
  const always = prompt.options.find((option) => option.approval === "always");
  return {
    tool,
    summary,
    allowKeys: herdrOptionKeys(allow),
    alwaysKeys: always ? herdrOptionKeys(always) : null,
    alwaysTitle: always ? `发按键 ${always.index}：${always.label}` : "",
  };
}

export function HerdrInteractionCard({
  pane,
  compact = false,
  embedded = false,
  terminalFallback = false,
  footer,
}: {
  pane: HerdrPaneView;
  compact?: boolean;
  /** 嵌进 /herdr 总览的「需要你」卡：外框和标题行由宿主卡片画，这里只出内容 + 动作 */
  embedded?: boolean;
  /** 任何 agent 卡在 blocked 却没有 hook 提示、读屏也认不出选择卡时，退回原始终端 + 按键（默认只对 codex） */
  terminalFallback?: boolean;
  /** 动作区尾部的附加内容（总览卡的「回复…」） */
  footer?: ReactNode;
}) {
  const questions = useMemo(
    () => herdrAskQuestions(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  const hookApproval = useMemo(
    () => herdrApproval(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  // 没有 hook 的「等人」数据（hook 装之前起的进程 / 记录丢了），但 Herdr 报 blocked：读屏。
  const screenMode = pane.status === "blocked" && pane.hook?.state !== "waiting";
  // 读屏认不出选择卡时，是否退回原始终端 + 按键
  const rawAllowed = terminalFallback || (pane.agentKind === "codex" && !pane.hook);
  const waiting = pane.status === "waiting";
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const sending = useRef(false);
  const promptKey = JSON.stringify(pane.hook?.interactivePrompt);
  const [answerState, setAnswerState] = useState<
    "idle" | "sending" | "answered" | "error"
  >("idle");
  const [errorText, setErrorText] = useState("");
  const [screen, setScreen] = useState("");
  const [screenError, setScreenError] = useState(false);
  const [freeText, setFreeText] = useState("");
  const answeredSignature = useRef<string | null>(null);

  const parsed = useMemo(
    () => (screenMode ? parseHerdrScreen(screen) : null),
    [screenMode, screen],
  );
  // 多选题读屏只能看到勾选状态、不知道确认键落在哪 —— 交还给原始终端
  const screenPrompt = parsed && !parsed.multiSelect ? parsed : null;
  const signature = herdrScreenSignature(screenPrompt);
  const showRaw = screenMode && !screenPrompt && (rawAllowed || parsed?.multiSelect === true);
  const visible = pane.alive && (waiting || Boolean(screenPrompt) || showRaw);

  useEffect(() => {
    setStep(0);
    setSelected([]);
    setAnswerState("idle");
    answeredSignature.current = null;
  }, [promptKey, pane.paneId, pane.status]);

  // 读屏里换了一张新卡（多题的下一题 / 新的审批），把「已回答」复位
  useEffect(() => {
    if (!signature || answeredSignature.current === null) return;
    if (signature !== answeredSignature.current) {
      answeredSignature.current = null;
      setAnswerState("idle");
      setFreeText("");
    }
  }, [signature]);

  const loadScreen = async (): Promise<string | null> => {
    setScreenError(false);
    try {
      const text = await readHerdrPane(pane.paneId, SCREEN_LINES);
      setScreen(text);
      return text;
    } catch {
      setScreenError(true);
      return null;
    }
  };

  useEffect(() => {
    if (!screenMode) return;
    void loadScreen();
    const timer = setInterval(() => void loadScreen(), 4_000);
    return () => clearInterval(timer);
    // pane revision/state changes remount the logical blocked prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenMode, pane.paneId, pane.pane.revision]);

  if (!visible) return null;

  const sendKeys = async (
    keys: string[],
    finalAnswer = true,
    advanceQuestion = false,
  ) => {
    if (sending.current || answerState === "answered") return false;
    sending.current = true;
    setAnswerState("sending");
    try {
      await sendHerdrKeys(pane.paneId, keys);
      if (finalAnswer) setAnswerState("answered");
      else setAnswerState("idle");
      if (advanceQuestion) {
        setStep((current) => current + 1);
        setSelected([]);
      }
      void refreshHerdrFleet();
      return true;
    } catch {
      setErrorText("按键发送失败，请重试");
      setAnswerState("error");
      return false;
    } finally {
      sending.current = false;
    }
  };

  /**
   * 读屏卡的发键：先重读一次屏幕，确认还是用户眼前这张卡（标题 + 选项 + 第几题都没变）才发，
   * 否则只刷新卡片不发——读屏轮询 4 秒一次，期间窗格可能已经换了卡。
   */
  const sendScreenKeys = async (keys: string[]) => {
    if (sending.current || answerState === "answered") return;
    const expected = signature;
    const fresh = await loadScreen();
    if (fresh === null) {
      setErrorText("读屏失败，没有发送");
      setAnswerState("error");
      return;
    }
    const current = parseHerdrScreen(fresh);
    if (herdrScreenSignature(current && !current.multiSelect ? current : null) !== expected) {
      setErrorText("终端里的卡片刚变了，请看清再选");
      setAnswerState("error");
      return;
    }
    // 一律先进「已回答」：多题的下一题 / Review 页换上来时签名变了，上面的 effect 会复位；
    // 单题 / 审批答完后窗格离开 blocked，status 变化同样复位。
    const sent = await sendKeys(keys, true);
    if (!sent) return;
    answeredSignature.current = expected;
    setTimeout(() => void loadScreen(), 700);
  };

  /** 自由输入：Esc 收起选择卡，文字进 Herdr 输入队列，窗格空闲后作为下一条消息送达。 */
  const sendFreeText = async () => {
    const text = freeText.trim();
    if (!text || sending.current) return;
    const expected = signature;
    const fresh = await loadScreen();
    const current = fresh === null ? null : parseHerdrScreen(fresh);
    if (herdrScreenSignature(current && !current.multiSelect ? current : null) !== expected) {
      setErrorText("终端里的卡片刚变了，请看清再发");
      setAnswerState("error");
      return;
    }
    sending.current = true;
    setAnswerState("sending");
    try {
      await sendHerdrKeys(pane.paneId, ["Escape"]);
      await sendHerdrInput(pane.paneId, text);
      answeredSignature.current = expected;
      setAnswerState("answered");
      setFreeText("");
      void refreshHerdrFleet();
    } catch {
      setErrorText("发送失败，请重试");
      setAnswerState("error");
    } finally {
      sending.current = false;
    }
  };

  if (answerState === "answered") {
    return (
      <div
        data-herdr-card
        data-herdr-card-state="answered"
        className={embedded ? "flex items-center gap-2 px-3.5 pb-3 text-ui text-ink-muted" : `${compact ? "mx-2 mb-2 px-3 py-2" : "px-3.5 py-2.5 max-md:px-3"} flex items-center gap-2 rounded-card border border-line bg-surface text-ui text-ink-muted`}
        aria-live="polite"
      >
        <Icon icon={CircleCheck} size="sm" className="text-positive" />
        已回答，等待 Herdr 确认…
      </div>
    );
  }

  const busy = answerState === "sending";
  const reviewing = !screenMode && questions.length > 0 && step >= questions.length;
  const question = screenMode ? undefined : questions[step];
  const multiSelect = question?.multiSelect === true;
  const needsReview = questions.length > 1 || questions.some(question => question.multiSelect === true);
  const columns = !compact && !embedded;

  // Calibrated in our own Herdr pane with Claude Code 2.1.258 (Sonnet),
  // 2026-09-07: a ONE-question single-select digit submits immediately.
  // R5 calibration (fj-hb-fix2-505f, w1Y:pF): ONE AskUserQuestion with
  // Color + Shape single-select questions; "2" advanced to Shape, "1"
  // stopped at "Review your answers / Submit answers" (both answers shown).
  // Only the subsequent Enter submitted. Thus questions.length > 1 needsReview.
  // In a multi-select,
  // digits toggle; Enter toggles the highlighted item (it does NOT submit).
  // Herdr key "right" opens the Review tab, then Enter submits the answers.
  // Permission card: digit "1" alone allows; Escape cancels the tool and
  // interrupts the turn. Verified both on an ask-rule Bash printf permission.
  // Keep these as separate user actions so no extra Enter reaches the next card.
  //
  // 读屏路径沿用同一套数字直选（见 herdrOptionKeys 的取舍说明）：多题时数字只会进下一题 /
  // Review 页，下一张卡由读屏重新认出来，逐题作答。

  const screenApprovalView = screenPrompt?.kind === "approval" ? screenApproval(screenPrompt) : null;
  const approval: ApprovalView | null = hookApproval
    ? {
        tool: hookApproval.tool,
        summary: hookApproval.summary,
        allowKeys: ["1"],
        // Claude Code 权限卡第 2 项 = 「Yes, and don't ask again …」。
        alwaysKeys: ["2"],
        alwaysTitle: "发按键 2：允许并记住，下次不再问",
      }
    : screenApprovalView;
  const screenQuestion = screenPrompt?.kind === "question" ? screenPrompt : null;
  const multi = screenQuestion?.multiQuestion;
  const screenIsReview = Boolean(screenQuestion && /submit your answers|review your answers/i.test(screenQuestion.title ?? ""));
  const kind = showRaw ? "terminal" : approval ? "permission" : "question";
  const pickSend = (keys: string[]) => (screenPrompt ? sendScreenKeys(keys) : sendKeys(keys));

  const rawTerminal = (
    <>
      <pre
        data-herdr-screen
        className={`${embedded ? "max-h-56" : compact ? "max-h-36" : "max-h-64"} code-surface overflow-auto whitespace-pre-wrap break-words rounded-field p-3 font-mono text-nano`}
      >
        {screenError
          ? "读屏暂不可用"
          : screen || `正在读取最近 ${SCREEN_LINES} 行…`}
      </pre>
      {/* 嵌在总览卡里时收成一排小键，不让一张卡吃掉半屏。 */}
      <div className={embedded ? "mt-2 flex flex-wrap gap-1.5 [&>button]:min-h-8 [&>button]:min-w-9 [&>button]:px-2.5 max-md:[&>button]:min-h-11" : "mt-2 grid grid-cols-5 gap-1.5 sm:grid-cols-6"}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(
          (key) => (
            <button
              key={key}
              type="button"
              data-mobile-target="herdr-terminal-key"
              onClick={() => void sendKeys([key], false)}
              className="min-h-11 rounded-field border border-line bg-surface font-mono text-ui text-ink transition-colors hover:bg-surface-hover"
            >
              {key}
            </button>
          ),
        )}
        <button
          type="button"
          data-mobile-target="herdr-terminal-enter"
          onClick={() => void sendKeys(["Enter"])}
          className="col-span-3 min-h-11 rounded-field bg-accent px-2 text-ui font-medium text-accent-fg transition-colors hover:bg-accent-strong"
        >
          Enter
        </button>
        <button
          type="button"
          data-mobile-target="herdr-terminal-escape"
          onClick={() => void sendKeys(["Escape"])}
          className="col-span-3 min-h-11 rounded-field border border-line-strong bg-surface px-2 text-ui font-medium text-ink transition-colors hover:bg-surface-hover"
        >
          Esc
        </button>
      </div>
    </>
  );

  return (
    <div
      data-herdr-card
      data-herdr-card-kind={kind}
      data-herdr-card-source={screenPrompt ? "screen" : showRaw ? "terminal" : "hook"}
      className={embedded ? "px-3.5 pb-3 text-ink" : `${compact ? "mx-2 mb-2 p-2.5" : "p-3.5 max-md:p-3"} rounded-card border border-accent-line bg-surface text-ink`}
    >
      <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
        <Icon
          icon={showRaw ? SquareTerminal : approval ? ShieldCheck : MessageCircleQuestion}
          className="text-accent"
        />
        {approval && !showRaw ? (
          <>
            <span className="font-medium">需要你批准</span>
            <span className="rounded-sm border border-line-strong px-1.5 font-mono text-label">
              {approval.tool}
            </span>
          </>
        ) : (
          <span className="font-medium">
            {showRaw ? "终端在等你" : "Herdr 正在等你回答"}
          </span>
        )}
        {questions.length > 1 && !screenMode && (
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
            {typeof question.question === "string"
              ? question.question
              : "请选择一个选项"}
          </div>
          <OptionList
            items={hookItems(question, selected)}
            columns={columns}
            clampDescription={embedded}
            multiSelect={multiSelect}
            disabled={busy}
            onPick={async (item) => {
              const index = item.index - 1;
              const final = !needsReview && step >= questions.length - 1;
              const sent = await sendKeys([String(item.index)], final, !multiSelect && !final);
              if (sent && multiSelect) setSelected(current => current.includes(index) ? current.filter(value => value !== index) : [...current, index]);
            }}
          />
          {multiSelect && (
            <Button type="button" variant="primary" data-herdr-multi-next data-mobile-target="herdr-multi-next"
              disabled={busy}
              onClick={() => void sendKeys(["right"], false, true)}
              className="mt-2 min-h-11 w-full">
              {step >= questions.length - 1 ? "确认所选项" : "下一题"}
            </Button>
          )}
        </div>
      )}

      {reviewing && (
        <Button type="button" variant="primary" data-herdr-submit-answers data-mobile-target="herdr-submit-answers"
          disabled={busy}
          onClick={() => void sendKeys(["Enter"])}
          className="mt-2 min-h-11 w-full">
          <Icon icon={Check} size="sm" />
          提交回答
        </Button>
      )}

      {screenQuestion && (
        <div className="mt-2" data-herdr-question data-herdr-screen-question>
          {multi && (
            <div className="text-label text-ink-faint" data-herdr-multi-question={multi.total}>
              共 {multi.total} 题，逐题作答
              {!screenIsReview && <> · 第 {Math.min(multi.current, multi.total)} 题</>}
              {screenIsReview && <> · 最后确认</>}
            </div>
          )}
          <div className="text-sm font-medium">
            {screenQuestion.title ?? "请选择一个选项"}
          </div>
          <OptionList
            items={screenQuestion.options
              .filter((option) => !option.isFreeText && !option.isChat)
              .map((option) => ({
                key: `${option.index}:${option.label}`,
                index: option.index,
                label: option.label,
                description: option.description,
                recommended: option.recommended,
              }))}
            columns={columns}
            clampDescription={embedded}
            disabled={busy}
            onPick={(item) => void sendScreenKeys(herdrOptionKeys(item))}
          />
          {(screenQuestion.options.some((option) => option.isFreeText) ||
            screenQuestion.options.some((option) => option.isChat)) && (
            <form
              className="mt-2 flex flex-wrap gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                void sendFreeText();
              }}
            >
              {screenQuestion.options.some((option) => option.isFreeText) && (
                <>
                  <Input
                    value={freeText}
                    onChange={(event) => setFreeText(event.target.value)}
                    placeholder={multi ? "都不合适？写你的回答（会收起整张提问卡，作为下一条消息发给它）" : "都不合适？写你的回答（收起选择卡，作为下一条消息发给它）"}
                    aria-label="自由输入回答"
                    data-herdr-free-text
                    disabled={busy}
                    className="min-w-0 flex-1 max-md:min-h-11"
                  />
                  <Button type="submit" variant="secondary" disabled={busy || !freeText.trim()} className="min-h-11 sm:min-h-8">
                    发送
                  </Button>
                </>
              )}
              {screenQuestion.options
                .filter((option) => option.isChat)
                .map((option) => (
                  <Button
                    key={option.index}
                    type="button"
                    variant="ghost"
                    data-herdr-chat-option={option.index}
                    disabled={busy}
                    title={`发按键 ${option.index}：${option.label}`}
                    onClick={() => void sendScreenKeys(herdrOptionKeys(option))}
                    className="min-h-11 sm:min-h-8"
                  >
                    <Icon icon={MessagesSquare} size="sm" />
                    先聊聊
                  </Button>
                ))}
            </form>
          )}
        </div>
      )}

      {approval && (
        <div className="mt-2" data-herdr-approval>
          {screenApprovalView && screenPrompt?.title && (
            <div className="mb-1.5 text-label text-ink-faint">
              {embedded ? `${approval.tool} · ` : ""}{screenPrompt.title}
            </div>
          )}
          {approval.summary && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-field border border-line bg-surface-muted px-3 py-2 font-mono text-label text-ink">
              {approval.summary}
            </pre>
          )}
          {/* Herdr 只能发按键：「1」放行、Escape 取消——没有理由输入。 */}
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:flex">
            <Button
              type="button"
              variant="primary"
              data-mobile-target="herdr-permission-allow"
              disabled={busy}
              onClick={() => void pickSend(approval.allowKeys)}
              className="min-h-11 sm:min-h-8 sm:min-w-36"
            >
              允许
            </Button>
            {approval.alwaysKeys && (
              <Button
                type="button"
                variant="secondary"
                data-herdr-permission-always
                disabled={busy}
                onClick={() => void pickSend(approval.alwaysKeys!)}
                className="min-h-11 min-w-0 sm:min-h-8"
                title={approval.alwaysTitle}
              >
                <span className="truncate">总是允许 {alwaysTarget(approval)}</span>
              </Button>
            )}
            <Button
              type="button"
              variant="ghost"
              data-mobile-target="herdr-permission-deny"
              disabled={busy}
              onClick={() => void pickSend(["Escape"])}
              className="min-h-11 sm:min-h-8"
            >
              拒绝
            </Button>
            {footer}
          </div>
        </div>
      )}

      {showRaw && <div className="mt-2">{rawTerminal}</div>}


      {!question && !reviewing && !approval && !showRaw && !screenPrompt && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-mobile-target="herdr-generic-enter"
            onClick={() => void sendKeys(["Enter"])}
            className="min-h-11 flex-1 rounded-field bg-accent px-3 text-ui font-medium text-accent-fg transition-colors hover:bg-accent-strong"
          >
            Enter
          </button>
          <button
            type="button"
            data-mobile-target="herdr-generic-escape"
            onClick={() => void sendKeys(["Escape"])}
            className="min-h-11 flex-1 rounded-field border border-line-strong bg-surface px-3 text-ui font-medium text-ink transition-colors hover:bg-surface-hover"
          >
            Esc
          </button>
        </div>
      )}

      {!approval && footer && <div className="mt-2.5 flex flex-wrap gap-2">{footer}</div>}
      {screenPrompt && (
        <details className="group mt-2.5" data-herdr-screen-raw>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-label text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
            <Icon icon={ChevronRight} size="sm" className="transition-transform group-open:rotate-90" />
            查看终端原文
          </summary>
          <div className="mt-1.5">{rawTerminal}</div>
        </details>
      )}
      {answerState === "error" && (
        <div className="mt-2 text-label text-danger-ink">{errorText || "按键发送失败，请重试"}</div>
      )}
    </div>
  );
}
