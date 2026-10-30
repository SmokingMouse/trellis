import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HerdrInteractionCard } from "@/components/HerdrInteractionCard";
import type { BlockingSummary } from "@/lib/herdr-blocking";
import type { HerdrPaneView } from "@/lib/herdr-ui";

function pane(blocking: BlockingSummary | undefined, interactivePrompt: unknown, toolName = "AskUserQuestion"): HerdrPaneView {
  return {
    paneId: "w1:p1",
    alive: true,
    status: "waiting",
    agentKind: "claude",
    pane: { revision: 1 },
    transcript: null,
    hook: { sessionId: "s", agent: "claude", state: "waiting", toolName, interactivePrompt, paneKey: "w1:p1", updatedAt: Date.now(), blocking },
  } as unknown as HerdrPaneView;
}

const QUESTIONS = [{ question: "Which color?", header: "Color", multiSelect: false, options: [{ label: "Red" }, { label: "Blue" }] }];
const base = { id: "ix_0123456789abcdef0123", toolUseId: "t1", createdAt: 1, connected: true };

test("没有阻塞交互 → 原来的发按键卡（hook 来源）", () => {
  const html = renderToStaticMarkup(<HerdrInteractionCard pane={pane(undefined, { questions: QUESTIONS, tool_name: "AskUserQuestion", tool_use_id: "t1" })} />);
  expect(html).toContain('data-herdr-card-source="hook"');
  expect(html).not.toContain("data-herdr-blocking");
});

test("阻塞提问 → 结构化卡：有选项、自由输入、「交给终端」，不走发按键", () => {
  const html = renderToStaticMarkup(<HerdrInteractionCard pane={pane({ ...base, kind: "question", toolName: "AskUserQuestion", questions: QUESTIONS, status: "pending" }, { questions: QUESTIONS })} />);
  expect(html).toContain('data-herdr-card-source="blocking"');
  expect(html).toContain("Which color?");
  expect(html).toContain("Blue");
  expect(html).toContain("data-herdr-free-text");
  expect(html).toContain("data-herdr-blocking-handoff");
});

test("阻塞授权 → 保留滑动卡依赖的 DOM 标记，有「本会话总是允许」", () => {
  const html = renderToStaticMarkup(<HerdrInteractionCard pane={pane({ ...base, toolUseId: null, kind: "permission", toolName: "Bash", summary: "make deploy", canAlways: true, status: "pending" }, { approval: { tool: "Bash", summary: "make deploy" } }, "Bash")} />);
  expect(html).toContain("data-herdr-approval");
  expect(html).toContain('data-mobile-target="herdr-permission-allow"');
  expect(html).toContain('data-mobile-target="herdr-permission-deny"');
  expect(html).toContain("本会话总是允许");
  expect(html).toContain("make deploy");
});

test("阻塞计划 → Markdown 预览 + 全屏 + 三个选项", () => {
  const html = renderToStaticMarkup(<HerdrInteractionCard pane={pane({ ...base, toolUseId: null, kind: "plan", toolName: "ExitPlanMode", plan: "# 标题\n\n- 第一步", status: "pending" }, { approval: { tool: "ExitPlanMode", summary: "" } }, "ExitPlanMode")} />);
  expect(html).toContain("<h1");
  expect(html).toContain("第一步");
  expect(html).toContain("data-herdr-plan-fullscreen");
  expect(html).toContain('data-herdr-plan-approve="bypassPermissions"');
  expect(html).toContain('data-herdr-plan-approve="acceptEdits"');
  expect(html).toContain("打回写意见");
});

test("刚在 Trellis 上答过（resolved）且还是同一次调用 → 显示已作答，不退回发按键", () => {
  const prompt = { questions: QUESTIONS, tool_name: "AskUserQuestion", tool_use_id: "t1" };
  const answered = renderToStaticMarkup(<HerdrInteractionCard pane={pane({ ...base, kind: "question", toolName: "AskUserQuestion", status: "resolved" }, prompt)} />);
  expect(answered).toContain('data-herdr-card-state="answered"');
  // 换了一次调用（tool_use_id 不同）→ 不能挡住新卡
  const other = renderToStaticMarkup(<HerdrInteractionCard pane={pane({ ...base, kind: "question", toolName: "AskUserQuestion", status: "resolved" }, { ...prompt, tool_use_id: "t2" })} />);
  expect(other).toContain('data-herdr-card-source="hook"');
});
