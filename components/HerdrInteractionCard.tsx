"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  Check,
  CircleCheck,
  MessageCircleQuestion,
  ShieldCheck,
  Square,
  SquareCheck,
  SquareTerminal,
} from "lucide-react";
import { Button, Icon } from "@/components/ui";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  herdrApproval,
  herdrAskQuestions,
  type HerdrAskOption,
  type HerdrAskQuestion,
} from "@/lib/herdr-console";
import { readHerdrPane, sendHerdrKeys } from "@/lib/herdr-actions";

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
  /** 任何 agent 卡在 blocked 却没有 hook 提示时，也退回读屏 + 按键（默认只对 codex） */
  terminalFallback?: boolean;
  /** 动作区尾部的附加内容（总览卡的「回复…」） */
  footer?: ReactNode;
}) {
  const questions = useMemo(
    () => herdrAskQuestions(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  const approvalPrompt = useMemo(
    () => herdrApproval(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  const codexBlocked =
    pane.status === "blocked" &&
    (terminalFallback
      ? pane.hook?.state !== "waiting"
      : pane.agentKind === "codex" && !pane.hook);
  const waiting = pane.status === "waiting";
  const visible = pane.alive && (waiting || codexBlocked);
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const sending = useRef(false);
  const promptKey = JSON.stringify(pane.hook?.interactivePrompt);
  const [answerState, setAnswerState] = useState<
    "idle" | "sending" | "answered" | "error"
  >("idle");
  const [screen, setScreen] = useState("");
  const [screenError, setScreenError] = useState(false);

  useEffect(() => {
    setStep(0);
    setSelected([]);
    setAnswerState("idle");
  }, [promptKey, pane.paneId, pane.status]);

  const loadScreen = async () => {
    setScreenError(false);
    try {
      setScreen(await readHerdrPane(pane.paneId, embedded ? 14 : 40));
    } catch {
      setScreenError(true);
    }
  };

  useEffect(() => {
    if (!codexBlocked) return;
    void loadScreen();
    const timer = setInterval(() => void loadScreen(), 4_000);
    return () => clearInterval(timer);
    // pane revision/state changes remount the logical blocked prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [codexBlocked, pane.paneId, pane.pane.revision]);

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
      setAnswerState("error");
      return false;
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

  const reviewing = questions.length > 0 && step >= questions.length;
  const question = questions[step];
  const askOptions = question ? options(question) : [];
  const multiSelect = question?.multiSelect === true;
  const needsReview = questions.length > 1 || questions.some(question => question.multiSelect === true);

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

  return (
    <div
      data-herdr-card
      data-herdr-card-kind={codexBlocked ? "terminal" : approvalPrompt ? "permission" : "question"}
      className={embedded ? "px-3.5 pb-3 text-ink" : `${compact ? "mx-2 mb-2 p-2.5" : "p-3.5 max-md:p-3"} rounded-card border border-accent-line bg-surface text-ink`}
    >
      <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
        <Icon
          icon={codexBlocked ? SquareTerminal : approvalPrompt ? ShieldCheck : MessageCircleQuestion}
          className="text-accent"
        />
        {approvalPrompt && !codexBlocked ? (
          <>
            <span className="font-medium">需要你批准</span>
            <span className="rounded-sm border border-line-strong px-1.5 font-mono text-label">
              {approvalPrompt.tool}
            </span>
          </>
        ) : (
          <span className="font-medium">
            {codexBlocked ? "终端在等你" : "Herdr 正在等你回答"}
          </span>
        )}
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
            {typeof question.question === "string"
              ? question.question
              : "请选择一个选项"}
          </div>
          <div className={`mt-2 grid gap-2 ${compact ? "grid-cols-1" : "sm:grid-cols-2"}`}>
            {askOptions.map((option, index) => (
              <button
                key={`${index}:${String(option.label)}`}
                type="button"
                data-herdr-option={index + 1}
                data-mobile-target="herdr-option"
                aria-pressed={multiSelect ? selected.includes(index) : undefined}
                disabled={answerState === "sending"}
                onClick={async () => {
                  const final = !needsReview && step >= questions.length - 1;
                  const sent = await sendKeys([String(index + 1)], final, !multiSelect && !final);
                  if (sent && multiSelect) setSelected(current => current.includes(index) ? current.filter(item => item !== index) : [...current, index]);
                }}
                className={`min-h-11 rounded-field border px-3 py-2 text-left text-ui text-ink transition-colors hover:bg-surface-hover disabled:opacity-60 ${
                  multiSelect && selected.includes(index)
                    ? "border-accent-line bg-accent-muted"
                    : "border-line bg-surface"
                }`}
              >
                <span className="mr-1.5 inline-flex align-middle font-mono text-label text-ink-faint">
                  {multiSelect ? (
                    <Icon
                      icon={selected.includes(index) ? SquareCheck : Square}
                      size="sm"
                      className={selected.includes(index) ? "text-accent" : undefined}
                    />
                  ) : (
                    index + 1
                  )}
                </span>
                <span className="font-medium">
                  {typeof option.label === "string"
                    ? option.label
                    : `选项 ${index + 1}`}
                </span>
                {typeof option.description === "string" &&
                  option.description &&
                  !compact && (
                    <span className="mt-0.5 block text-label text-ink-muted">
                      {option.description}
                    </span>
                  )}
              </button>
            ))}
          </div>
          {multiSelect && (
            <Button type="button" variant="primary" data-herdr-multi-next data-mobile-target="herdr-multi-next"
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["right"], false, true)}
              className="mt-2 min-h-11 w-full">
              {step >= questions.length - 1 ? "确认所选项" : "下一题"}
            </Button>
          )}
        </div>
      )}

      {reviewing && (
        <Button type="button" variant="primary" data-herdr-submit-answers data-mobile-target="herdr-submit-answers"
          disabled={answerState === "sending"}
          onClick={() => void sendKeys(["Enter"])}
          className="mt-2 min-h-11 w-full">
          <Icon icon={Check} size="sm" />
          提交回答
        </Button>
      )}

      {approvalPrompt && (
        <div className="mt-2">
          {approvalPrompt.summary && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-field border border-line bg-surface-muted px-3 py-2 font-mono text-label text-ink">
              {approvalPrompt.summary}
            </pre>
          )}
          {/* Herdr 只能发按键：「1」放行、Escape 取消——没有理由输入。 */}
          <div className="mt-2.5 grid grid-cols-2 gap-2 sm:flex">
            <Button
              type="button"
              variant="primary"
              data-mobile-target="herdr-permission-allow"
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["1"])}
              className="min-h-11 sm:min-h-8 sm:min-w-36"
            >
              允许
            </Button>
            {/* Claude Code 权限卡第 2 项 = 「Yes, and don't ask again …」。 */}
            <Button
              type="button"
              variant="secondary"
              data-herdr-permission-always
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["2"])}
              className="min-h-11 min-w-0 sm:min-h-8"
              title="发按键 2：允许并记住，下次不再问"
            >
              <span className="truncate">总是允许 {alwaysTarget(approvalPrompt)}</span>
            </Button>
            <Button
              type="button"
              variant="ghost"
              data-mobile-target="herdr-permission-deny"
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["Escape"])}
              className="min-h-11 sm:min-h-8"
            >
              拒绝
            </Button>
            {footer}
          </div>
        </div>
      )}

      {codexBlocked && (
        <div className="mt-2">
          <pre
            data-herdr-screen
            className={`${embedded ? "max-h-56" : compact ? "max-h-36" : "max-h-64"} code-surface overflow-auto whitespace-pre-wrap break-words rounded-field p-3 font-mono text-nano`}
          >
            {screenError
              ? "读屏暂不可用"
              : screen || "正在读取最近 40 行…"}
          </pre>
          {/* 嵌在总览卡里时收成一排小键，读屏只留 36 高，不让一张卡吃掉半屏。 */}
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
        </div>
      )}

      {!question && !reviewing && !approvalPrompt && !codexBlocked && (
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

      {!approvalPrompt && footer && <div className="mt-2.5 flex flex-wrap gap-2">{footer}</div>}
      {answerState === "error" && (
        <div className="mt-2 text-label text-danger-ink">按键发送失败，请重试</div>
      )}
    </div>
  );
}
