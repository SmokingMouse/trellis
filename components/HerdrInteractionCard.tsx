"use client";

import { useEffect, useMemo, useState } from "react";
import type { HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";

type AskOption = { label?: unknown; description?: unknown };
type AskQuestion = {
  question?: unknown;
  header?: unknown;
  options?: unknown;
  multiSelect?: unknown;
};

function askQuestions(prompt: unknown): AskQuestion[] {
  if (!prompt || typeof prompt !== "object" || !("questions" in prompt)) {
    return [];
  }
  const questions = (prompt as { questions?: unknown }).questions;
  return Array.isArray(questions) ? (questions as AskQuestion[]) : [];
}

function approval(prompt: unknown): { tool: string; summary: string } | null {
  if (!prompt || typeof prompt !== "object" || !("approval" in prompt)) {
    return null;
  }
  const value = (prompt as { approval?: unknown }).approval;
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return {
    tool: typeof record.tool === "string" ? record.tool : "操作",
    summary: typeof record.summary === "string" ? record.summary : "",
  };
}

function options(question: AskQuestion): AskOption[] {
  return Array.isArray(question.options)
    ? (question.options as AskOption[])
    : [];
}

export function HerdrInteractionCard({
  pane,
  compact = false,
}: {
  pane: HerdrPaneView;
  compact?: boolean;
}) {
  const questions = useMemo(
    () => askQuestions(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  const approvalPrompt = useMemo(
    () => approval(pane.hook?.interactivePrompt),
    [pane.hook?.interactivePrompt],
  );
  const codexBlocked =
    pane.agentKind === "codex" && pane.status === "blocked" && !pane.hook;
  const waiting = pane.status === "waiting";
  const visible = pane.alive && (waiting || codexBlocked);
  const [step, setStep] = useState(0);
  const [answerState, setAnswerState] = useState<
    "idle" | "sending" | "answered" | "error"
  >("idle");
  const [screen, setScreen] = useState("");
  const [screenError, setScreenError] = useState(false);

  useEffect(() => {
    setStep(0);
    setAnswerState("idle");
  }, [pane.hook?.updatedAt, pane.paneId, pane.status]);

  const loadScreen = async () => {
    setScreenError(false);
    try {
      const response = await fetch(
        `/api/herdr/panes/${encodeURIComponent(pane.paneId)}/read`,
        { cache: "no-store" },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = (await response.json()) as { text?: string };
      setScreen(data.text ?? "");
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
    if (answerState === "sending" || answerState === "answered") return;
    setAnswerState("sending");
    try {
      const response = await fetch(
        `/api/herdr/panes/${encodeURIComponent(pane.paneId)}/keys`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ keys }),
        },
      );
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (finalAnswer) setAnswerState("answered");
      else setAnswerState("idle");
      if (advanceQuestion) setStep((current) => current + 1);
      void refreshHerdrFleet();
    } catch {
      setAnswerState("error");
    }
  };

  if (answerState === "answered") {
    return (
      <div
        data-herdr-card
        data-herdr-card-state="answered"
        className={`${compact ? "mx-2 mb-2 px-3 py-2" : "px-4 py-3 max-md:px-3"} rounded-card border border-positive-line bg-positive-muted text-sm text-positive-ink`}
        aria-live="polite"
      >
        ✓ 已回答，等待 Herdr 确认…
      </div>
    );
  }

  const question = questions[Math.min(step, Math.max(0, questions.length - 1))];
  const askOptions = question ? options(question) : [];

  return (
    <div
      data-herdr-card
      data-herdr-card-kind={codexBlocked ? "terminal" : approvalPrompt ? "permission" : "question"}
      className={`${compact ? "mx-2 mb-2 p-2.5" : "p-4 max-md:p-3"} rounded-card border-2 border-warn-line bg-warn-muted text-warn-ink shadow-raise`}
    >
      <div className="flex items-center gap-2 text-sm font-semibold">
        <span aria-hidden>{codexBlocked ? "⌨" : approvalPrompt ? "🔐" : "🙋"}</span>
        {codexBlocked
          ? "终端在等你"
          : approvalPrompt
            ? `${approvalPrompt.tool} 请求权限`
            : "Herdr 正在等你回答"}
        {questions.length > 1 && (
          <span className="ml-auto text-label font-normal tabular-nums">
            {step + 1}/{questions.length}
          </span>
        )}
      </div>

      {question && (
        <div className="mt-2" data-herdr-question>
          {typeof question.header === "string" && question.header && (
            <div className="text-label opacity-70">{question.header}</div>
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
                disabled={answerState === "sending"}
                onClick={() => {
                  const final = step >= questions.length - 1;
                  void sendKeys(
                    [String(index + 1), "Enter"],
                    final,
                    !final,
                  );
                }}
                className="min-h-11 rounded-field border border-warn-line bg-surface px-3 py-2 text-left text-sm text-ink disabled:opacity-60"
              >
                <span className="mr-1.5 font-mono text-label text-ink-faint">
                  {index + 1}
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
        </div>
      )}

      {approvalPrompt && (
        <div className="mt-2">
          {approvalPrompt.summary && (
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-md bg-surface/70 p-2 text-label text-ink">
              {approvalPrompt.summary}
            </pre>
          )}
          <div className="mt-2 grid grid-cols-2 gap-2">
            <button
              type="button"
              data-mobile-target="herdr-permission-allow"
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["1", "Enter"])}
              className="min-h-11 rounded-field bg-positive px-3 text-sm font-semibold text-ink-inverse disabled:opacity-60"
            >
              允许
            </button>
            <button
              type="button"
              data-mobile-target="herdr-permission-deny"
              disabled={answerState === "sending"}
              onClick={() => void sendKeys(["Escape"])}
              className="min-h-11 rounded-field bg-danger px-3 text-sm font-semibold text-ink-inverse disabled:opacity-60"
            >
              拒绝
            </button>
          </div>
        </div>
      )}

      {codexBlocked && (
        <div className="mt-2">
          <pre
            data-herdr-screen
            className={`${compact ? "max-h-36" : "max-h-64"} overflow-auto whitespace-pre-wrap break-words rounded-md bg-[#111827] p-3 font-mono text-[11px] leading-4 text-[#d1d5db]`}
          >
            {screenError
              ? "读屏暂不可用"
              : screen || "正在读取最近 40 行…"}
          </pre>
          <div className="mt-2 grid grid-cols-5 gap-1.5 sm:grid-cols-6">
            {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(
              (key) => (
                <button
                  key={key}
                  type="button"
                  data-mobile-target="herdr-terminal-key"
                  onClick={() => void sendKeys([key], false)}
                  className="min-h-11 rounded-field border border-warn-line bg-surface font-mono text-sm text-ink"
                >
                  {key}
                </button>
              ),
            )}
            <button
              type="button"
              data-mobile-target="herdr-terminal-enter"
              onClick={() => void sendKeys(["Enter"])}
              className="col-span-3 min-h-11 rounded-field bg-positive px-2 text-sm font-semibold text-ink-inverse"
            >
              Enter
            </button>
            <button
              type="button"
              data-mobile-target="herdr-terminal-escape"
              onClick={() => void sendKeys(["Escape"])}
              className="col-span-3 min-h-11 rounded-field bg-danger px-2 text-sm font-semibold text-ink-inverse"
            >
              Esc
            </button>
          </div>
        </div>
      )}

      {!question && !approvalPrompt && !codexBlocked && (
        <div className="mt-2 flex gap-2">
          <button
            type="button"
            data-mobile-target="herdr-generic-enter"
            onClick={() => void sendKeys(["Enter"])}
            className="min-h-11 flex-1 rounded-field bg-positive px-3 text-sm font-semibold text-ink-inverse"
          >
            Enter
          </button>
          <button
            type="button"
            data-mobile-target="herdr-generic-escape"
            onClick={() => void sendKeys(["Escape"])}
            className="min-h-11 flex-1 rounded-field bg-danger px-3 text-sm font-semibold text-ink-inverse"
          >
            Esc
          </button>
        </div>
      )}

      {answerState === "error" && (
        <div className="mt-2 text-label text-danger">按键发送失败，请重试</div>
      )}
    </div>
  );
}
