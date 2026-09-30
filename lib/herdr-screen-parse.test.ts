import { describe, expect, test } from "bun:test";
import {
  cleanScreenLines,
  herdrArrowKeys,
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
