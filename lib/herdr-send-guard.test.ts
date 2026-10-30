import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  checkClaudeSend,
  checkHerdrSend,
  herdrSendRefusalMessage,
  screenHasDialog,
  stripAnsi,
} from "./herdr-send-guard";

// 真实读屏：Claude Code 2.1.280 跑在 herdr 窗格里，`pane.read source: visible` 各读一次 ansi / text。
const FIXTURES = path.join(import.meta.dir, "__fixtures__", "herdr-screens");
const screen = (name: string, ext: "ansi" | "txt" = "ansi") =>
  fs.readFileSync(path.join(FIXTURES, `claude-2.1.280-${name}.${ext}`), "utf8");

const RULE = "\x1b[0m\x1b[38;2;136;136;136m" + "─".repeat(60);
const CURSOR = "\x1b[0m\x1b[7m \x1b[0m";
const FOOTER = "  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents";
/** 合成一屏：历史 + 输入框（两条横线夹着的行）+ 状态行。 */
const boxScreen = (...rows: string[]) => ["⏺ 历史输出", "", RULE, ...rows, RULE, FOOTER].join("\n");

describe("checkClaudeSend · 真实读屏", () => {
  test("空输入框 → 可以发", () => {
    expect(checkClaudeSend(screen("empty"))).toEqual({ ok: true });
  });

  test("电脑前打了一半的单行草稿 → input_draft，可清空", () => {
    expect(checkClaudeSend(screen("typed"))).toEqual({
      ok: false, code: "input_draft", draft: "hello draft 你好", clearable: "hello draft 你好",
    });
  });

  test("多行草稿 → input_draft，不可清空（清空键一次只清一行）", () => {
    const check = checkClaudeSend(screen("multiline"));
    expect(check).toMatchObject({ ok: false, code: "input_draft" });
    expect(check.ok === false && check.draft).toBe("line one\n  line two");
    expect(check.ok === false && check.clearable).toBeUndefined();
  });

  test("bash 模式（!）→ input_draft，消息会被当命令跑", () => {
    expect(checkClaudeSend(screen("bash"))).toMatchObject({ ok: false, code: "input_draft", draft: "! ls" });
  });

  test("多行粘贴 → input_draft", () => {
    expect(checkClaudeSend(screen("paste"))).toMatchObject({ ok: false, code: "input_draft" });
  });

  test("/model 选择列表（输入框消失，底部是按键提示）→ dialog_open", () => {
    expect(checkClaudeSend(screen("model-picker"))).toEqual({ ok: false, code: "dialog_open" });
  });

  test("信任目录对话框（herdr 可能报 idle）→ dialog_open", () => {
    expect(checkClaudeSend(screen("trust"))).toEqual({ ok: false, code: "dialog_open" });
  });

  test("ansi 与纯文本读屏去转义后一致（夹具自洽）", () => {
    for (const name of ["empty", "typed", "trust"]) {
      expect(stripAnsi(screen(name)).replace(/\s+$/gm, "")).toBe(screen(name, "txt").replace(/\s+$/gm, ""));
    }
  });
});

describe("checkClaudeSend · 颜色规则", () => {
  test("灰色建议（dim）+ 光标压在第一个灰字上 → 不算草稿", () => {
    const row = "❯ \x1b[7mF\x1b[0m\x1b[2mix the failing test\x1b[0m";
    expect(checkClaudeSend(boxScreen(row))).toEqual({ ok: true });
  });

  test("在灰色建议前面打了字 → 草稿", () => {
    const row = "❯ ab\x1b[7mc\x1b[0m\x1b[2m the rest\x1b[0m";
    expect(checkClaudeSend(boxScreen(row))).toMatchObject({ ok: false, code: "input_draft" });
  });

  test("光标反色压在打出来的字上、后面没有灰字 → 草稿", () => {
    const row = "❯ \x1b[7ma\x1b[0m";
    expect(checkClaudeSend(boxScreen(row))).toMatchObject({ ok: false, code: "input_draft", clearable: "a" });
  });

  test("38;2;r;g;b 真彩里的 2 不当 dim", () => {
    const row = "❯ \x1b[38;2;2;2;2mtyped\x1b[0m";
    expect(checkClaudeSend(boxScreen(row))).toMatchObject({ ok: false, code: "input_draft" });
  });

  test("读不到颜色（纯文本）时，输入框里任何字都当草稿", () => {
    expect(checkClaudeSend(boxScreen("❯ Fix the failing test"))).toMatchObject({ ok: false, code: "input_draft" });
  });

  test("IDE 选区胶囊不是输入", () => {
    expect(checkClaudeSend(boxScreen(`❯ [⧉ 3 lines selected] ${CURSOR}`))).toEqual({ ok: true });
  });

  test("粘贴占位符不管什么颜色都是内容", () => {
    const row = "❯ \x1b[2m[Pasted text #1 +20 lines]\x1b[0m";
    expect(checkClaudeSend(boxScreen(row))).toMatchObject({ ok: false, code: "input_draft" });
  });

  test("命名会话的带标签上沿也认作输入框边界", () => {
    const screenText = ["⏺ 历史", "──── my-session ─", `❯ ${CURSOR}`, RULE, FOOTER].join("\n");
    expect(checkClaudeSend(screenText)).toEqual({ ok: true });
  });
});

describe("checkClaudeSend · 认不出 / 截断", () => {
  test("没有输入框也没有对话框（启动画面等）→ screen_unknown", () => {
    expect(checkClaudeSend("Welcome to Claude Code\n\nloading…")).toEqual({ ok: false, code: "screen_unknown" });
  });

  test("只看得到下沿（草稿比窗格还高）→ input_draft", () => {
    expect(checkClaudeSend(["  a very long draft", RULE, FOOTER].join("\n"))).toMatchObject({ ok: false, code: "input_draft" });
  });
});

describe("screenHasDialog", () => {
  test("横线以上历史里的 `❯ 1.` 不算对话框", () => {
    const text = ["❯ 1. 旧消息里的列表", "  2. 第二项", RULE.replace(/\x1b\[[0-9;]*m/g, ""), "❯", "─".repeat(60), FOOTER].join("\n");
    expect(screenHasDialog(text)).toBeFalse();
  });

  test("Codex 的编号审批（横线以下、光标在选项上）→ 对话框", () => {
    const text = ["  Allow command?", "› 1. Allow", "  2. Deny"].join("\n");
    expect(screenHasDialog(text)).toBeTrue();
  });

  test("工作中的 esc to interrupt 不是对话框按键提示", () => {
    expect(screenHasDialog("✻ Cogitating… (12s · esc to interrupt)\n")).toBeFalse();
  });
});

describe("checkHerdrSend", () => {
  test("非 Claude agent 只查对话框，不认输入框", () => {
    expect(checkHerdrSend("codex", "› typed into codex")).toEqual({ ok: true });
    expect(checkHerdrSend("codex", screen("model-picker"))).toEqual({ ok: false, code: "dialog_open" });
  });
});

describe("herdrSendRefusalMessage", () => {
  test("带上草稿原文，过长截断", () => {
    expect(herdrSendRefusalMessage("input_draft", "hi")).toContain("「hi」");
    expect(herdrSendRefusalMessage("input_draft", "x".repeat(200))).toContain(`${"x".repeat(80)}…`);
    expect(herdrSendRefusalMessage("dialog_open")).toContain("对话框");
  });
});

describe("就绪判定 · 2026-10-30 本机 claude 2.1.280 实录（herdr 0.9.3）", () => {
  test("默认权限模式的空输入框（页脚 `? for shortcuts`）→ 可以发", () => {
    expect(checkClaudeSend(screen("ready-default"))).toEqual({ ok: true });
    expect(checkClaudeSend(screen("ready-default", "txt"))).toEqual({ ok: true });
  });

  for (const name of ["trust-no", "mcp-server", "theme", "login"]) {
    test(`${name} 对话框 → dialog_open（herdr 0.9.3 报 blocked，旧版报 idle 也一样拦）`, () => {
      expect(checkClaudeSend(screen(name))).toMatchObject({ ok: false });
      expect(checkClaudeSend(screen(name)).ok).toBeFalse();
    });
  }

  test("信任目录（❯ 默认停在 No, exit）→ dialog_open", () => {
    expect(checkClaudeSend(screen("trust-no"))).toEqual({ ok: false, code: "dialog_open" });
  });

  test("只有输入框没有页脚 → screen_unknown（不算就绪）", () => {
    const noFooter = ["⏺ 历史输出", "", RULE, "❯\u00a0" + CURSOR, RULE].join("\n");
    expect(checkClaudeSend(noFooter)).toEqual({ ok: false, code: "screen_unknown" });
  });

  test("没有页脚但有草稿 → 照样报 input_draft（说清电脑上有什么）", () => {
    const draft = ["⏺ 历史输出", "", RULE, "❯\u00a0half" + CURSOR, RULE].join("\n");
    expect(checkClaudeSend(draft)).toMatchObject({ ok: false, code: "input_draft" });
  });
});
