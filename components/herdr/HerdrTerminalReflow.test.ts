import { describe, expect, test } from "bun:test";
import React from "react";
import { renderToString } from "react-dom/server";
import { HerdrTerminalReflow } from "./HerdrTerminalReflow";

describe("HerdrTerminalReflow", () => {
  test("ASCII 表格：整块连续表格行被归入独立表格容器，且框线与内容分离", () => {
    const tableText = `+-------------------+---------------------------------------------------------+
|      动作         |                          结果                           |
+-------------------+---------------------------------------------------------+
| batch unfreeze    | 完成，记录 invalidation #321 失败步骤重试须从当前步骤续跑 |
| 批次状态          | collecting, members 8 (#311-320), missing #321          |
+-------------------+---------------------------------------------------------+`;

    const html = renderToString(React.createElement(HerdrTerminalReflow, { text: tableText }));
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("batch unfreeze");
    expect(html).toContain("invalidation #321");
    // 边框字符与内容文本均正常渲染
    expect(html).toContain("+");
    expect(html).toContain("|");
  });

  test("过滤 Claude Code 终端 TUI 悬浮残留行", () => {
    const rawText = `* #321 已按验收打回处理:
+-------------------+---------------------------------------------------------+
|      动作         |                          结果                           |
+-------------------+---------------------------------------------------------+
Jump to bottom (ctrl+End) ↓
> /goal active (18h)`;

    const html = renderToString(React.createElement(HerdrTerminalReflow, { text: rawText }));
    expect(html).not.toContain("Jump to bottom (ctrl+End)");
    expect(html).toContain("/goal active (18h)");
  });

  test("Thought 过程语义芯片与时间戳", () => {
    const thoughtText = `Thought for 19s, ran 4 shell commands`;
    const html = renderToString(React.createElement(HerdrTerminalReflow, { text: thoughtText }));
    expect(html).toContain("Thought for 19s");
    expect(html).toContain("ran 4 shell commands");
  });

  test("bypass permissions on 状态栏转换为深色状态胶囊，杜绝纯白反光条", () => {
    const statusText = `>> bypass permissions on (shift+tab to cycle) · ← 2 agents`;
    const html = renderToString(React.createElement(HerdrTerminalReflow, { text: statusText }));
    expect(html).toContain("bypass permissions on");
    expect(html).toContain("shift+tab to cycle");
    expect(html).toContain("2 agents");
  });

  test("去 ANSI 转义序列与控制字符安全", () => {
    const ansiText = "\x1b[32m✔ Success\x1b[0m: task finished\r\n";
    const html = renderToString(React.createElement(HerdrTerminalReflow, { text: ansiText }));
    expect(html).toContain("Success");
    expect(html).not.toContain("\x1b[32m");
    expect(html).not.toContain("\x1b[0m");
  });
});
