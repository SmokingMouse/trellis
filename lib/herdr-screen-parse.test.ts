import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import {
  HERDR_PROMPT_LINES,
  cleanScreenLines,
  herdrArrowKeys,
  herdrPromptOptionKeys,
  herdrPromptTail,
  herdrScreenPromptWithRev,
  herdrScreenRev,
  herdrFreeTextReady,
  herdrOptionKeys,
  herdrScreenSignature,
  parseHerdrScreen,
} from "./herdr-screen-parse";

const RULE = "─".repeat(80);

// harbor 窗格（w3:p2）2026-09-30 的真实读屏尾部：上方是历史表格输出，顶部是多题标签行
const HARBOR = `  │ 收益                                     │ 9 月 MacBook 只跑了 8 次一次性命令
  └──────────────────────────────────────────┴─────────────────────────────

  推荐撤销连接（方案 b）。

  分工如下：
  - 本机侧我可以做：归档 5 个公司机上的 agent
  - 只有你能做：
    - 轮换那 3 个已入库的凭证。
  /tmp 下的生产库快照和代码快照都已删除。
${RULE}
←  ☒ 方向  ☒ 公司设备  ☐ Push  ✔ Submit  →

本地的 3 个提交 push 吗？

❯ 1. push main + 留档分支（推荐）
     3 个本地提交和 rescue 分支推到 origin 做异地备份。self-deployer 卡死或被停的状态下不会触发部署
  2. 只 push main
     rescue 分支只留在本地
  3. 先不 push
     全部只留在本地。导出快照里有 Mew Copier 的 instruction，要不要上 GitHub 由你定
  4. Type something.
${RULE}
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel
`;

const SINGLE = `本地的 3 个提交 push 吗?

❯ 1. push main + 留档分支（推荐）
     3 个本地提交和 rescue 分支推到 origin 做异地备份。self-deployer 卡死或被停的状态下不会触发部署
  2. 只 push main
     rescue 分支只留在本地
  3. 先不 push
     全部只留在本地。导出快照里有 Mew Copier 的 instruction，要不要上 GitHub 由你定
  4. Type something.
────────────────────────────────
  5. Chat about this

Enter to select · Tab/Arrow keys to navigate · Esc to cancel`;

const APPROVAL = `⏺ Bash(git push origin main)
${RULE}
 Bash command

   git push origin main
   Push 3 local commits to origin

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and don't ask again for git push commands in /Users/me/repo
   3. No, and tell Claude what to do differently (esc)
`;

describe("parseHerdrScreen", () => {
  test("单题 AskUserQuestion：标题 / 描述 / 推荐 / 自由输入 / 聊天 / 当前选中", () => {
    const parsed = parseHerdrScreen(SINGLE)!;
    expect(parsed.kind).toBe("question");
    expect(parsed.title).toBe("本地的 3 个提交 push 吗?");
    expect(parsed.selectedIndex).toBe(1);
    expect(parsed.multiSelect).toBeFalse();
    expect(parsed.multiQuestion).toBeUndefined();
    expect(parsed.options).toEqual([
      { index: 1, label: "push main + 留档分支", recommended: true, description: "3 个本地提交和 rescue 分支推到 origin 做异地备份。self-deployer 卡死或被停的状态下不会触发部署" },
      { index: 2, label: "只 push main", description: "rescue 分支只留在本地" },
      { index: 3, label: "先不 push", description: "全部只留在本地。导出快照里有 Mew Copier 的 instruction，要不要上 GitHub 由你定" },
      { index: 4, label: "Type something.", isFreeText: true },
      { index: 5, label: "Chat about this", isChat: true },
    ]);
  });

  test("harbor 真实读屏：跳过历史表格，认出多题标签行", () => {
    const parsed = parseHerdrScreen(HARBOR)!;
    expect(parsed.title).toBe("本地的 3 个提交 push 吗？");
    expect(parsed.options).toHaveLength(5);
    expect(parsed.options[0]).toMatchObject({ label: "push main + 留档分支", recommended: true });
    expect(parsed.multiQuestion).toEqual({
      total: 3,
      current: 3,
      tabs: [
        { label: "方向", done: true },
        { label: "公司设备", done: true },
        { label: "Push", done: false },
      ],
    });
  });

  test("权限审批：工具名、命令说明、允许 / 总是允许 / 拒绝", () => {
    const parsed = parseHerdrScreen(APPROVAL)!;
    expect(parsed.kind).toBe("approval");
    expect(parsed.title).toBe("Do you want to proceed?");
    expect(parsed.tool).toBe("Bash");
    expect(parsed.context).toEqual(["git push origin main", "Push 3 local commits to origin"]);
    expect(parsed.options.map((o) => o.approval)).toEqual(["allow", "always", "deny"]);
    expect(parsed.selectedIndex).toBe(1);
  });

  test("旧版带框线的审批卡也能剥框认出", () => {
    const boxed = `╭──────────────────────────────╮
│ Edit file                    │
│   src/app.ts                 │
│                              │
│ Do you want to make this edit to app.ts? │
│ ❯ 1. Yes                     │
│   2. Yes, allow all edits during this session (shift+tab) │
│   3. No, and tell Claude what to do differently (esc) │
╰──────────────────────────────╯`;
    const parsed = parseHerdrScreen(boxed)!;
    expect(parsed.kind).toBe("approval");
    expect(parsed.title).toBe("Do you want to make this edit to app.ts?");
    expect(parsed.options.map((o) => o.approval)).toEqual(["allow", "always", "deny"]);
    expect(parsed.tool).toBe("Edit");
  });

  test("❯ 移到第 3 项时 selectedIndex 跟着走", () => {
    const moved = SINGLE.replace("❯ 1.", "  1.").replace("  3. 先不", "❯ 3. 先不");
    expect(parseHerdrScreen(moved)!.selectedIndex).toBe(3);
  });

  test("带 ANSI 颜色的读屏", () => {
    const ansi = `\x1b[1mPick a color\x1b[0m\r\n\r\n\x1b[36m❯ 1. Red\x1b[0m\r\n  2. Blue\r\n\x1b[2mEnter to select · Esc to cancel\x1b[0m\r\n`;
    const parsed = parseHerdrScreen(ansi)!;
    expect(parsed.title).toBe("Pick a color");
    expect(parsed.options.map((o) => o.label)).toEqual(["Red", "Blue"]);
  });

  test("上方历史输出里的编号列表不干扰，只取最后一张卡", () => {
    const text = `我建议：
1. 先备份
2. 再迁移

Which database?

❯ 1. Postgres
     Default
  2. SQLite
Enter to select`;
    const parsed = parseHerdrScreen(text)!;
    expect(parsed.title).toBe("Which database?");
    expect(parsed.options.map((o) => o.label)).toEqual(["Postgres", "SQLite"]);
    expect(parsed.options[0].description).toBe("Default");
  });

  test("普通输出里的编号列表（没有 ❯）不算选择卡", () => {
    expect(parseHerdrScreen("计划：\n1. 读代码\n2. 改代码\n3. 跑测试\n")).toBeNull();
  });

  test("选择卡之后又有大段输出（卡已经过去了）→ null", () => {
    const text = `${SINGLE}\n⏺ 已 push。\n  main -> origin/main\n  rescue -> origin/rescue\n  完成\n`;
    expect(parseHerdrScreen(text)).toBeNull();
  });

  test("顶部被截断、第 1 项看不到 → null", () => {
    const cut = SINGLE.split("\n").slice(4).join("\n");
    expect(parseHerdrScreen(cut)).toBeNull();
  });

  test("只截掉标题：选项照认，title 为 null", () => {
    const cut = SINGLE.split("\n").slice(2).join("\n");
    const parsed = parseHerdrScreen(cut)!;
    expect(parsed.title).toBeNull();
    expect(parsed.options).toHaveLength(5);
  });

  test("中英混排、标题折行、英文 (Recommended)", () => {
    const text = `Which deploy target 用哪个
环境部署?

❯ 1. staging (Recommended)
     先在 staging 验证 smoke test
  2. prod
Enter to select · Esc to cancel`;
    const parsed = parseHerdrScreen(text)!;
    expect(parsed.title).toBe("Which deploy target 用哪个环境部署?");
    expect(parsed.options[0]).toMatchObject({ label: "staging", recommended: true, description: "先在 staging 验证 smoke test" });
  });

  test("描述跨多行合并", () => {
    const text = `选哪个？

❯ 1. 方案 A
     第一行说明
     第二行说明
  2. 方案 B
Enter to select`;
    expect(parseHerdrScreen(text)!.options[0].description).toBe("第一行说明第二行说明");
  });

  test("多选题（勾选框）标记 multiSelect 并去掉框", () => {
    const text = `Which features?

❯ 1. [ ] Auth
  2. [✔] Billing
  3. Type something.
Enter to select · Esc to cancel`;
    const parsed = parseHerdrScreen(text)!;
    expect(parsed.multiSelect).toBeTrue();
    expect(parsed.options.map((o) => o.label)).toEqual(["Auth", "Billing", "Type something."]);
  });

  test("Review 提交页也是一张卡", () => {
    const text = `←  ☒ Color  ☒ Shape  ✔ Submit  →

Review your answers

 ● Color → Red
 ● Shape → Circle

Ready to submit your answers?

❯ 1. Submit answers
  2. Cancel`;
    const parsed = parseHerdrScreen(text)!;
    expect(parsed.title).toBe("Ready to submit your answers?");
    expect(parsed.options.map((o) => o.label)).toEqual(["Submit answers", "Cancel"]);
  });

  test("空文本 / 只有一个选项 / 编号不连续 → null", () => {
    expect(parseHerdrScreen("")).toBeNull();
    expect(parseHerdrScreen("Q?\n❯ 1. only\n")).toBeNull();
    expect(parseHerdrScreen("Q?\n❯ 1. a\n  3. c\n")).toBeNull();
  });
});

describe("cleanScreenLines", () => {
  test("剥外框但不动表格", () => {
    expect(cleanScreenLines("│ hi │\n│ a │ b │")).toEqual(["hi", "│ a │ b │"]);
  });
});

describe("按键映射", () => {
  test("数字直选：第 N 项发 N，与 ❯ 位置无关", () => {
    const parsed = parseHerdrScreen(SINGLE)!;
    expect(herdrOptionKeys(parsed.options[2])).toEqual(["3"]);
    expect(herdrOptionKeys(parsed.options[4])).toEqual(["5"]);
    expect(() => herdrOptionKeys({ index: 10 })).toThrow();
  });

  test("备用方向键方案", () => {
    expect(herdrArrowKeys(1, 3)).toEqual(["down", "down", "Enter"]);
    expect(herdrArrowKeys(4, 2)).toEqual(["up", "up", "Enter"]);
    expect(herdrArrowKeys(2, 2)).toEqual(["Enter"]);
  });

  test("指纹：同一张卡稳定，换题 / 换卡就变", () => {
    const a = parseHerdrScreen(SINGLE);
    const moved = parseHerdrScreen(SINGLE.replace("❯ 1.", "  1.").replace("  2. 只", "❯ 2. 只"));
    expect(herdrScreenSignature(a)).toBe(herdrScreenSignature(moved));
    expect(herdrScreenSignature(a)).not.toBe(herdrScreenSignature(parseHerdrScreen(APPROVAL)));
    expect(herdrScreenSignature(null)).toBe("");
  });

  test("自由输入第二步核对：❯ 落到 Type something 且题目没变才打字", () => {
    const before = parseHerdrScreen(HARBOR)!;
    const focused = parseHerdrScreen(HARBOR.replace("❯ 1.", "  1.").replace("  4. Type something.", "❯ 4. Type something."));
    expect(herdrFreeTextReady(before, focused, 4)).toBeTrue();
    // 聚焦后自由输入项渲染成输入框（文字变了）也算
    const asInput = parseHerdrScreen(HARBOR.replace("❯ 1.", "  1.").replace("  4. Type something.", "❯ 4. 先 push main"));
    expect(herdrFreeTextReady(before, asInput, 4)).toBeTrue();
    // ❯ 没动 / 换了题 / 读屏失败 → 不打字
    expect(herdrFreeTextReady(before, before, 4)).toBeFalse();
    expect(herdrFreeTextReady(before, parseHerdrScreen(SINGLE.replace("❯ 1.", "  1.").replace("  4. Type", "❯ 4. Type")), 4)).toBeFalse();
    expect(herdrFreeTextReady(before, null, 4)).toBeFalse();
  });
});

// 真实读屏夹具：claude 2.1.280 在 herdr 窗格里，`pane read --source visible` 各读一次 ansi / text。
// trust / model-picker / empty… 是早先录的；trust-no / mcp-server / theme / login / ready-default 是
// 2026-10-30 用临时 CLAUDE_CONFIG_DIR + 临时目录真跑 `claude --model haiku` 录的（路径换成 /private/tmp/project）。
const FIXTURES = path.join(import.meta.dir, "__fixtures__", "herdr-screens");
const fixture = (name: string, ext: "ansi" | "txt" = "txt") =>
  fs.readFileSync(path.join(FIXTURES, `claude-2.1.280-${name}.${ext}`), "utf8");
const parseFixture = (name: string, ext: "ansi" | "txt" = "txt") => parseHerdrScreen(herdrPromptTail(fixture(name, ext)));

describe("hook 盖不住的对话框 · 真实读屏", () => {
  test("信任目录：无序号、❯ 默认停在 No, exit", () => {
    const prompt = parseFixture("trust-no");
    expect(prompt).toMatchObject({
      kind: "dialog",
      dialog: "trust",
      unnumbered: true,
      selectedIndex: 1,
      options: [{ index: 1, label: "No, exit" }, { index: 2, label: "Yes, I trust this folder" }],
    });
    expect(prompt?.title).toStartWith("Quick safety check: Is this a project you created or one you trust?");
    expect(prompt?.context).toEqual(["Accessing workspace:", "/private/tmp/project", "Claude Code'll be able to read, edit, and execute files here."]);
  });

  test("信任目录：❯ 在 Yes 上（另一份夹具）", () => {
    expect(parseFixture("trust")).toMatchObject({ kind: "dialog", dialog: "trust", unnumbered: true, selectedIndex: 2 });
  });

  test("MCP 服务器：三个无序号选项，没有问号时第一段是标题", () => {
    expect(parseFixture("mcp-server")).toMatchObject({
      kind: "dialog",
      dialog: "mcp",
      unnumbered: true,
      title: "New MCP server found in this project: demo",
      selectedIndex: 3,
      options: [
        { label: "Use this MCP server" },
        { label: "Use this and all future MCP servers in this project" },
        { label: "Continue without using this MCP server" },
      ],
    });
  });

  test("模型选择：有序号，一行两栏拆成标签 + 描述，推荐标记照认", () => {
    const prompt = parseFixture("model-picker");
    expect(prompt).toMatchObject({ kind: "dialog", dialog: "model", selectedIndex: 4 });
    expect(prompt?.unnumbered).toBeUndefined();
    expect(prompt?.options.map((option) => option.label)).toEqual(["Default", "Opus (1M context)", "Fable", "Sonnet ✔", "Haiku"]);
    expect(prompt?.options[0]).toMatchObject({ recommended: true });
    expect(prompt?.options[4].description).toStartWith("Haiku 4.5");
  });

  test("主题选择：选项下面跟着 diff 预览也认得；logo 字符画不进说明", () => {
    const prompt = parseFixture("theme");
    expect(prompt).toMatchObject({ kind: "dialog", dialog: "theme", selectedIndex: 2 });
    expect(prompt?.options).toHaveLength(7);
    expect(prompt?.context).toEqual(["Let's get started."]);
  });

  test("登录方式选择", () => {
    expect(parseFixture("login")).toMatchObject({ kind: "dialog", dialog: "login", title: "Select login method:" });
  });

  test("空输入框 / 默认页脚：不是对话框", () => {
    expect(parseFixture("empty")).toBeNull();
    expect(parseFixture("ready-default")).toBeNull();
  });

  test("ansi 与纯文本读出同一个 rev", () => {
    for (const name of ["trust", "trust-no", "mcp-server", "model-picker", "theme", "login"]) {
      expect(herdrScreenRev(parseFixture(name, "ansi"))).toBe(herdrScreenRev(parseFixture(name)));
    }
  });

  test("对话框不在屏幕底部（后面还有别的输出）就不认", () => {
    expect(parseHerdrScreen(`${fixture("trust-no")}\n⏺ later output\nmore\nand more\nstill more`)).toBeNull();
  });
});

describe("herdrScreenRev", () => {
  test("无卡为空串；同一张卡稳定；换了标题 / 选项就变", () => {
    expect(herdrScreenRev(null)).toBe("");
    const rev = herdrScreenRev(parseHerdrScreen(SINGLE));
    expect(rev).toMatch(/^[0-9a-f]{14}$/);
    expect(herdrScreenRev(parseHerdrScreen(SINGLE))).toBe(rev);
    expect(herdrScreenRev(parseHerdrScreen(SINGLE.replace("只 push main", "只 push dev")))).not.toBe(rev);
    expect(herdrScreenRev(parseHerdrScreen(SINGLE.replace("push 吗?", "push 吗？？")))).not.toBe(rev);
  });

  test("有序号的卡：❯ 挪动不改 rev（数字直选与 ❯ 无关）", () => {
    const moved = SINGLE.replace("❯ 1.", "  1.").replace("  2. 只", "❯ 2. 只");
    expect(herdrScreenRev(parseHerdrScreen(moved))).toBe(herdrScreenRev(parseHerdrScreen(SINGLE)));
  });

  test("无序号的卡：❯ 挪动改 rev（方向键从 ❯ 算起）", () => {
    expect(herdrScreenRev(parseFixture("trust"))).not.toBe(herdrScreenRev(parseFixture("trust-no")));
  });

  test("只看最后 HERDR_PROMPT_LINES 行：上方历史变了不影响 rev", () => {
    const filler = Array.from({ length: HERDR_PROMPT_LINES }, (_, i) => `history ${i}`).join("\n");
    const a = herdrScreenPromptWithRev(`${filler}\nold stuff\n${fixture("trust-no")}`);
    const b = herdrScreenPromptWithRev(`completely different\n${filler}\n${fixture("trust-no")}`);
    expect(a.rev).toBe(b.rev);
    expect(a.rev).toBe(herdrScreenRev(parseFixture("trust-no")));
  });
});

describe("herdrPromptOptionKeys", () => {
  test("有序号：数字直选", () => {
    expect(herdrPromptOptionKeys(parseHerdrScreen(SINGLE)!, 3)).toEqual(["3"]);
  });

  test("无序号：从 ❯ 当前位置按方向键再 Enter", () => {
    const trustNo = parseFixture("trust-no")!;
    expect(herdrPromptOptionKeys(trustNo, 2)).toEqual(["down", "Enter"]);
    expect(herdrPromptOptionKeys(trustNo, 1)).toEqual(["Enter"]);
    expect(herdrPromptOptionKeys(parseFixture("mcp-server")!, 1)).toEqual(["up", "up", "Enter"]);
  });

  test("没有这一项 → 抛错，不乱按", () => {
    expect(() => herdrPromptOptionKeys(parseFixture("trust-no")!, 3)).toThrow();
  });
});
