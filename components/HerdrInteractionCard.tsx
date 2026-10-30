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
import { Badge, Button, Icon, Input, Pill, cn } from "@/components/ui";
import { herdrPanePrompt, type HerdrPaneView } from "@/lib/herdr-ui";
import { refreshHerdrFleet } from "@/hooks/useHerdrFleet";
import {
  herdrApproval,
  herdrAskQuestions,
  herdrScreenQuestionStep,
  type HerdrAskOption,
  type HerdrAskQuestion,
} from "@/lib/herdr-console";
import { HerdrActionError, readHerdrPane, readHerdrPanePending, sendHerdrKeys, sendHerdrText } from "@/lib/herdr-actions";
import {
  herdrFreeTextReady,
  herdrOptionKeys,
  herdrPromptOptionKeys,
  herdrScreenRev,
  herdrScreenSignature,
  parseHerdrScreen,
  type HerdrScreenPrompt,
} from "@/lib/herdr-screen-parse";

type CardSource = "hook" | "transcript" | "screen" | "terminal";
const SOURCE_BADGE: Record<CardSource, string> = { hook: "H", transcript: "J", screen: "S", terminal: "T" };
const SOURCE_TITLE: Record<CardSource, string> = {
  hook: "数据来源：hook（PreToolUse / PermissionRequest）",
  transcript: "数据来源：transcript（jsonl 里未完成的 tool_use）",
  screen: "数据来源：读屏解析",
  terminal: "数据来源：原始终端",
};

export type HerdrScreenPromptSummary = { kind: "approval" | "question" | "dialog"; tool: string | null };

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
    <div className={cn("-mx-2 mt-1.5 grid gap-0.5", columns && "sm:grid-cols-2 sm:gap-1")}>
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
            // bui Approval Card 的选项行：无框，选中 = accent 淡底；推荐项靠「推荐」徽标说
            "flex min-h-11 min-w-0 items-start gap-2.5 rounded-field px-2 py-[9px] text-left text-ui text-ink transition-colors disabled:opacity-60 sm:min-h-[38px]",
            item.checked ? "bg-accent-muted" : "hover:bg-surface-hover",
          )}
        >
          {multiSelect ? (
            <span className="grid size-5 shrink-0 place-items-center">
              <Icon
                icon={item.checked ? SquareCheck : Square}
                size="sm"
                className={item.checked ? "text-accent" : "text-ink-faint"}
              />
            </span>
          ) : (
            // 序号徽标（就是要发给终端的那个键）
            <span
              className={cn(
                "grid size-5 shrink-0 place-items-center rounded-chip font-mono text-nano tabular-nums",
                item.checked ? "bg-accent text-accent-fg" : "bg-surface-muted text-ink-muted shadow-hairline",
              )}
            >
              {item.index}
            </span>
          )}
          <span className="min-w-0 flex-1">
            <span className="flex min-w-0 items-center gap-1.5">
              <span className="min-w-0 truncate text-[13.5px] leading-5">{item.label}</span>
              {item.recommended && (
                <Badge variant="accent" className="shrink-0">推荐</Badge>
              )}
            </span>
            {item.description && (
              <span
                className={cn(
                  "mt-0.5 block text-label text-ink-faint",
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
  onScreenPrompt,
  probeScreen = false,
}: {
  pane: HerdrPaneView;
  compact?: boolean;
  /** 嵌进 /herdr 总览的「需要你」卡：外框和标题行由宿主卡片画，这里只出内容 + 动作 */
  embedded?: boolean;
  /** 任何 agent 卡在 blocked 却没有 hook 提示、读屏也认不出选择卡时，退回原始终端 + 按键（默认只对 codex） */
  terminalFallback?: boolean;
  /** 动作区尾部的附加内容（总览卡的「回复…」） */
  footer?: ReactNode;
  /** 读屏认出（或不再认出）选择卡时通知宿主——总览卡标题行据此显示「提问」/「要执行 Bash」 */
  onScreenPrompt?: (prompt: HerdrScreenPromptSummary | null) => void;
  /**
   * 窗格不是 blocked 也读屏找对话框：信任目录这类对话框 herdr 可能报 idle，
   * 发消息被拒（dialog_open）后输入框据此临时挂一张卡。
   */
  probeScreen?: boolean;
}) {
  // 数据源优先级 hook > transcript（jsonl 里未完成的 tool_use）> 读屏。前两者同一形状、同一套渲染。
  const panePrompt = useMemo(
    () => herdrPanePrompt({ hook: pane.hook, transcript: pane.transcript }),
    [pane.hook, pane.transcript],
  );
  const structured = panePrompt?.prompt;
  const transcriptMode = panePrompt?.source === "transcript";
  const questions = useMemo(() => herdrAskQuestions(structured), [structured]);
  const hookApproval = useMemo(() => herdrApproval(structured), [structured]);
  // 没有 hook / transcript 的「等人」数据，但 Herdr 报 blocked：读屏。
  const screenMode = (pane.status === "blocked" || probeScreen) && pane.hook?.state !== "waiting" && !transcriptMode;
  // 读屏认不出选择卡时，是否退回原始终端 + 按键
  const rawAllowed = terminalFallback || (pane.agentKind === "codex" && !pane.hook);
  const waiting = pane.status === "waiting";
  const [step, setStep] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const sending = useRef(false);
  const promptKey = JSON.stringify(structured);
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
  // 服务端发键前用它核对屏幕（/keys、/text 的 expectedRev），对不上 409 prompt_changed
  const rev = herdrScreenRev(screenPrompt);
  const showRaw = screenMode && !screenPrompt && (rawAllowed || parsed?.multiSelect === true);
  const visible = pane.alive && (waiting || Boolean(screenPrompt) || showRaw);
  const summaryKind = screenPrompt?.kind ?? null;
  const summaryTool = screenPrompt?.tool ?? null;
  const onScreenPromptRef = useRef(onScreenPrompt);
  useEffect(() => {
    onScreenPromptRef.current = onScreenPrompt;
  });
  useEffect(() => {
    onScreenPromptRef.current?.(summaryKind ? { kind: summaryKind, tool: summaryTool } : null);
  }, [summaryKind, summaryTool]);

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

  // transcript 多题：jsonl 只给题目，不知道终端停在第几题（用户可能已在终端里答了几题）——
  // 读屏认题号，对齐本地的 step。
  const trackScreenStep = transcriptMode && questions.length > 1;
  useEffect(() => {
    if (!screenMode && !trackScreenStep) return;
    void loadScreen();
    const timer = setInterval(() => void loadScreen(), 4_000);
    return () => clearInterval(timer);
    // pane revision/state changes remount the logical blocked prompt.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [screenMode, trackScreenStep, pane.paneId, pane.pane.revision]);

  const screenStep = useMemo(
    () => (trackScreenStep && screen ? herdrScreenQuestionStep(parseHerdrScreen(screen), questions) : null),
    [trackScreenStep, screen, questions],
  );
  // 只跟着「屏幕变了」走：本地刚按完数字 step+1、屏幕还没重绘时不能被旧屏拉回去。
  // 声明在复位 effect 之后 —— 同一轮里复位成 0 之后再被它纠正回屏幕上的题号。
  useEffect(() => {
    if (screenStep === null || sending.current) return;
    setStep(screenStep);
    setSelected([]);
  }, [screenStep, promptKey, pane.status]);

  if (!visible) return null;

  /**
   * transcript 卡的发键前核对（对应读屏卡的「重读屏幕核对指纹」）：
   *   ① 窗格仍 blocked，且 jsonl 里还是这个 tool_use 没完成；
   *   ② 多题：重读屏幕认出终端停在第几题，必须和卡上正显示的这一题一致。
   * 返回拒发原因；null = 可以发。
   */
  const verifyTranscript = async (): Promise<string | null> => {
    const expectedTool = panePrompt?.toolUseId ?? null;
    let pending: Awaited<ReturnType<typeof readHerdrPanePending>>;
    try {
      pending = await readHerdrPanePending(pane.paneId);
    } catch {
      return "核对窗格状态失败，没有发送";
    }
    if (pending.status !== "blocked" || !expectedTool || pending.toolUseId !== expectedTool) {
      void refreshHerdrFleet();
      return "终端里的请求已经变了（可能已在终端作答或被取消），没有发送";
    }
    if (questions.length > 1) {
      const fresh = await loadScreen();
      const current = fresh === null ? null : herdrScreenQuestionStep(parseHerdrScreen(fresh), questions);
      if (current === null) return "认不出终端当前停在第几题，没有发送；请展开「查看终端原文」确认";
      if (current !== step) {
        setStep(current);
        setSelected([]);
        return current >= questions.length
          ? "终端已在最后确认页，请看清再点"
          : `终端当前在第 ${current + 1} 题，已切过去，请看清再选`;
      }
    }
    return null;
  };

  const sendKeys = async (
    keys: string[],
    finalAnswer = true,
    advanceQuestion = false,
    expectedRev?: string,
  ) => {
    if (sending.current || answerState === "answered") return false;
    sending.current = true;
    setAnswerState("sending");
    try {
      if (transcriptMode) {
        const problem = await verifyTranscript();
        if (problem) {
          setErrorText(problem);
          setAnswerState("error");
          return false;
        }
      }
      await sendHerdrKeys(pane.paneId, keys, expectedRev);
      if (finalAnswer) setAnswerState("answered");
      else setAnswerState("idle");
      if (advanceQuestion) {
        setStep((current) => current + 1);
        setSelected([]);
      }
      void refreshHerdrFleet();
      return true;
    } catch (error) {
      if (error instanceof HerdrActionError && error.promptChanged) {
        // 服务端重读屏幕发现对话框变了，什么都没按：刷新卡片给用户看新的
        setErrorText(error.message);
        setAnswerState("error");
        void loadScreen();
        return false;
      }
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
    const expectedRev = rev;
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
    const sent = await sendKeys(keys, true, false, expectedRev);
    if (!sent) return;
    answeredSignature.current = expected;
    setTimeout(() => void loadScreen(), 700);
  };

  /**
   * 自由输入（选择卡的「Type something」）：
   *   ① 重读屏幕核对卡没变 → 发该项序号（数字直选，聚焦卡内输入框）
   *   ② 稍等重读，核对还是同一道题且 ❯ 落在自由输入项上 → 立即打字 + Enter（/text，不排队）
   * 任一步核对不过就停手；不发 Esc —— 多题时 Esc 会连已答的题一起丢掉。
   */
  const sendFreeText = async (freeIndex: number) => {
    const text = freeText.trim();
    if (!text || sending.current || answerState === "answered") return;
    const expected = signature;
    const expectedRev = rev;
    const before = screenPrompt;
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
      await sendHerdrKeys(pane.paneId, herdrOptionKeys({ index: freeIndex }), expectedRev);
      // 读屏接口有 1 秒服务端缓存，TUI 重绘也要一点时间：最多等约 3 秒看 ❯ 落位
      let ready = false;
      let focusedRev = "";
      for (let attempt = 0; attempt < 6 && !ready; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        const focused = await loadScreen();
        const focusedPrompt = focused === null ? null : parseHerdrScreen(focused);
        ready = herdrFreeTextReady(before, focusedPrompt, freeIndex);
        focusedRev = herdrScreenRev(focusedPrompt);
      }
      if (!ready) {
        setErrorText(`已按 ${freeIndex} 选中「Type something」，但终端没进入预期的输入状态，文字没有发送；请展开终端原文看看`);
        setAnswerState("error");
        return;
      }
      await sendHerdrText(pane.paneId, text, true, focusedRev);
      answeredSignature.current = expected;
      setAnswerState("answered");
      setFreeText("");
      void refreshHerdrFleet();
      setTimeout(() => void loadScreen(), 700);
    } catch (error) {
      setErrorText(error instanceof HerdrActionError && error.promptChanged ? error.message : "发送失败，请重试");
      setAnswerState("error");
      if (error instanceof HerdrActionError && error.promptChanged) void loadScreen();
    } finally {
      sending.current = false;
    }
  };

  if (answerState === "answered") {
    return (
      <div
        data-herdr-card
        data-herdr-card-state="answered"
        className={embedded ? "flex items-center gap-2 px-3.5 pb-3 text-ui text-ink-muted" : `${compact ? "mx-2 mb-2 px-3 py-2" : "px-3.5 py-2.5 max-md:px-3"} flex items-center gap-2 rounded-card bg-surface-raised shadow-raise text-ui text-ink-muted`}
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
  // 提问卡与 hook 盖不住的对话框（信任目录 / 模型选择等，kind=dialog）共用选项列表渲染
  const screenQuestion = screenPrompt && screenPrompt.kind !== "approval" ? screenPrompt : null;
  const screenDialog = screenPrompt?.kind === "dialog";
  const multi = screenQuestion?.multiQuestion;
  // 卡内有自由输入框时，宿主的「回复…」就重复了，不再渲染
  const freeOption = screenQuestion?.options.find((option) => option.isFreeText) ?? null;
  const hostFooter = freeOption ? null : footer;
  const screenIsReview = Boolean(screenQuestion && /submit your answers|review your answers/i.test(screenQuestion.title ?? ""));
  const kind = showRaw ? "terminal" : approval ? "permission" : "question";
  const pickSend = (keys: string[]) => (screenPrompt ? sendScreenKeys(keys) : sendKeys(keys));
  const cardSource: CardSource = screenPrompt ? "screen" : showRaw ? "terminal" : transcriptMode ? "transcript" : "hook";

  const rawScreen = (
      <pre
        data-herdr-screen
        className={`${embedded ? "max-h-56" : compact ? "max-h-36" : "max-h-64"} code-surface overflow-auto whitespace-pre-wrap break-words rounded-field p-3 font-mono text-nano`}
      >
        {screenError
          ? "读屏暂不可用"
          : screen || `正在读取最近 ${SCREEN_LINES} 行…`}
      </pre>
  );
  const rawTerminal = (
    <>
      {rawScreen}
      {/* 嵌在总览卡里时收成一排小键，不让一张卡吃掉半屏。 */}
      <div className={embedded ? "mt-2 flex flex-wrap gap-1.5 [&>button]:min-h-8 [&>button]:min-w-9 [&>button]:px-2.5 max-md:[&>button]:min-h-11" : "mt-2 grid grid-cols-5 gap-1.5 sm:grid-cols-6"}>
        {["1", "2", "3", "4", "5", "6", "7", "8", "9"].map(
          (key) => (
            <button
              key={key}
              type="button"
              data-mobile-target="herdr-terminal-key"
              onClick={() => void sendKeys([key], false)}
              className="min-h-11 rounded-field bg-surface-raised font-mono text-ui text-ink shadow-btn transition-colors hover:bg-surface-hover"
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
          className="col-span-3 min-h-11 rounded-field bg-surface-raised px-2 text-ui font-medium text-ink shadow-btn transition-colors hover:bg-surface-hover"
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
      data-herdr-card-source={cardSource}
      className={cn("relative", embedded ? "px-3.5 pb-3 text-ink" : `${compact ? "mx-2 mb-2 p-2.5" : "p-3.5 max-md:p-3"} ui-enter-up rounded-card bg-surface-raised shadow-raise text-ink`)}
    >
      {/* 调试用来源角标：平时几乎看不见，悬停才显形 */}
      <span
        data-herdr-card-source-badge
        title={SOURCE_TITLE[cardSource]}
        className="absolute bottom-1 right-1.5 cursor-default select-none font-mono text-nano leading-none text-ink-faint opacity-25 transition-opacity hover:opacity-100"
      >
        {SOURCE_BADGE[cardSource]}
      </span>
      <div className={`${embedded ? "hidden" : "flex"} items-center gap-2 text-ui`}>
        <Pill tone="warn" className="h-5 px-[7px] text-[11.5px]">
          <Icon
            icon={showRaw ? SquareTerminal : approval ? ShieldCheck : MessageCircleQuestion}
            size="sm"
          />
          {approval && !showRaw ? "需要你批准" : showRaw ? "终端在等你" : screenDialog ? "终端在问你" : "Herdr 正在等你回答"}
        </Pill>
        {approval && !showRaw && (
          <span className="inline-flex h-5.5 items-center rounded-chip bg-surface-muted px-[7px] font-mono text-[11.5px] text-ink-muted shadow-hairline">
            {approval.tool}
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
          {screenDialog && screenQuestion.context.length > 0 && (
            <div className="mt-0.5 whitespace-pre-wrap text-label text-ink-faint" data-herdr-dialog-context>
              {screenQuestion.context.join("\n")}
            </div>
          )}
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
            onPick={(item) => void sendScreenKeys(herdrPromptOptionKeys(screenQuestion, item.index))}
          />
          {(freeOption || screenQuestion.options.some((option) => option.isChat)) && (
            <form
              className="mt-2 flex flex-wrap gap-1.5"
              onSubmit={(event) => {
                event.preventDefault();
                if (freeOption) void sendFreeText(freeOption.index);
              }}
            >
              {freeOption && (
                <>
                  <Input
                    value={freeText}
                    onChange={(event) => setFreeText(event.target.value)}
                    placeholder="都不合适？直接写你的回答"
                    aria-label="自由输入回答"
                    data-herdr-free-text={freeOption.index}
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
                    onClick={() => void sendScreenKeys(herdrPromptOptionKeys(screenQuestion, option.index))}
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
            <pre className="max-h-32 overflow-auto whitespace-pre-wrap break-words rounded-field bg-surface-muted px-3 py-2 font-mono text-label text-ink shadow-hairline">
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
            {hostFooter}
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
            className="min-h-11 flex-1 rounded-field bg-surface-raised px-3 text-ui font-medium text-ink shadow-btn transition-colors hover:bg-surface-hover"
          >
            Esc
          </button>
        </div>
      )}

      {!approval && hostFooter && <div className="mt-2.5 flex flex-wrap gap-2">{hostFooter}</div>}
      {transcriptMode && trackScreenStep && (
        <details className="group mt-2.5" data-herdr-screen-raw>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 text-label text-ink-faint hover:text-ink-muted [&::-webkit-details-marker]:hidden">
            <Icon icon={ChevronRight} size="sm" className="transition-transform group-open:rotate-90" />
            查看终端原文
          </summary>
          <div className="mt-1.5">{rawScreen}</div>
        </details>
      )}
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
