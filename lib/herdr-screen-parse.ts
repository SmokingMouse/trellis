// 读屏解析：拿不到 hook 结构化数据时，从 Herdr 读到的终端文本里认出
// Claude Code 的「提问（AskUserQuestion）/ 权限审批」选择卡，
// 让 HerdrInteractionCard 仍能渲染成可点选的选项卡片，而不是一大块原始终端。
//
// 纯函数，不依赖浏览器 / 服务端，单测见 herdr-screen-parse.test.ts。
// 识别不出就返回 null —— 宁可退回原始终端，也不猜错一个会被点下去的选项。

export type HerdrScreenOption = {
  /** TUI 上的序号（1 起），也是数字直选要发的键 */
  index: number;
  label: string;
  description?: string;
  recommended?: boolean;
  /** 「Type something.」—— 自由输入项 */
  isFreeText?: boolean;
  /** 「Chat about this」—— 不作答、转成对话 */
  isChat?: boolean;
  /** 审批卡的选项语义 */
  approval?: "allow" | "always" | "deny";
};

export type HerdrScreenTab = { label: string; done: boolean };

export type HerdrScreenPrompt = {
  kind: "question" | "approval";
  /** 选项块上方最近的那段文字（题目 / Do you want to proceed?）；截断拿不到时为 null */
  title: string | null;
  /** 标题上方、分隔线以下的说明行（审批卡的命令 / 文件名等） */
  context: string[];
  /** 审批卡的工具名（「Bash command」→ Bash）；认不出为 null */
  tool: string | null;
  options: HerdrScreenOption[];
  /** ❯ 当前所在选项的序号（1 起） */
  selectedIndex: number;
  /** 选项带勾选框 —— 多选题 */
  multiSelect: boolean;
  /** 多题 AskUserQuestion 顶部的题目标签行 */
  multiQuestion?: { total: number; current: number; tabs: HerdrScreenTab[] };
};

// CSI / OSC / 其它两字节转义
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;
const POINTER = "❯›▶>";
const OPTION_RE = new RegExp(`^(\\s*)([${POINTER}])?\\s*(\\d{1,2})[.)]\\s+(.*\\S)\\s*$`);
const SEPARATOR_RE = /^[\s─━═—\-╌┄┈_▔▁]+$/;
const FOOTER_RE = /(Enter to (select|confirm|submit)|Esc to (cancel|exit)|Tab\/Arrow keys|↑\/↓ to|to navigate)/i;
const TAB_BAR_RE = /^\s*←.*→\s*$/;
const TAB_MARK_RE = /^([☐☒☑✔✓■□])\s*(.+)$/;
const CHECKBOX_RE = /^(\[[ xX✔✓]\]|[☐☒☑■□])\s*/;
const RECOMMENDED_RE = /\s*[（(]\s*(推荐|recommended)\s*[)）]\s*$/i;
const BOX_EDGE_RE = /^\s*[│┃║]\s?(.*?)\s*[│┃║]?\s*$/;

/** 去 ANSI、去 \r、去行尾空白；左右都有框线（旧版审批框）时剥掉框线。 */
export function cleanScreenLines(text: string): string[] {
  return text
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n")
    .map((raw) => {
      const line = raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").replace(/\s+$/, "");
      const boxed = line.match(BOX_EDGE_RE);
      // 只剥外框；表格（中间还有 │）保持原样，它只会是历史输出。
      // 保留框内缩进（去掉框线后第一个空格），续行判断要靠它。
      return boxed && !/[│┃║]/.test(boxed[1]) ? boxed[1] : line;
    });
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function isSeparator(line: string): boolean {
  return !isBlank(line) && SEPARATOR_RE.test(line) && line.trim().length >= 3;
}

function joinText(parts: string[]): string {
  return parts.reduce((acc, part) => {
    if (!acc) return part;
    // 中文与中文之间不插空格；有一侧是 ASCII 时补一个
    const cjk = /[　-鿿＀-￯]$/.test(acc) && /^[　-鿿＀-￯]/.test(part);
    return cjk ? acc + part : `${acc} ${part}`;
  }, "");
}

type RawOption = { line: number; indent: number; digitCol: number; pointer: boolean; index: number; text: string };

function matchOption(line: string, lineNo: number): RawOption | null {
  const m = line.match(OPTION_RE);
  if (!m) return null;
  const digitCol = line.indexOf(m[3], m[1].length);
  return { line: lineNo, indent: m[1].length, digitCol, pointer: Boolean(m[2]), index: Number(m[3]), text: m[4] };
}

function parseTabs(line: string): HerdrScreenTab[] | null {
  if (!TAB_BAR_RE.test(line)) return null;
  const inner = line.trim().replace(/^←\s*/, "").replace(/\s*→$/, "");
  const tabs: HerdrScreenTab[] = [];
  for (const chunk of inner.split(/\s{2,}/)) {
    const m = chunk.trim().match(TAB_MARK_RE);
    if (!m) continue;
    const label = m[2].trim();
    if (/^submit$/i.test(label)) continue;
    tabs.push({ label, done: m[1] !== "☐" && m[1] !== "□" });
  }
  return tabs.length ? tabs : null;
}

function approvalRole(label: string): HerdrScreenOption["approval"] {
  if (/^no\b/i.test(label)) return "deny";
  if (/don'?t ask again|allow all|always allow|for this session|during this session/i.test(label)) return "always";
  if (/^yes\b/i.test(label)) return "allow";
  return undefined;
}

/**
 * 从读屏文本里认出最后一个完整的选择卡。
 * 要求：选项从 1 起连续编号、至少两项、其中一项带 ❯ 指针，且选项块之后只剩提示行 / 空行 / 分隔线
 * （选择卡在屏幕最底部）。任何一条不满足都返回 null。
 */
export function parseHerdrScreen(text: string): HerdrScreenPrompt | null {
  if (!text) return null;
  const lines = cleanScreenLines(text);

  // 从下往上找最后一个「1.」，并从它往下收连续编号的选项块
  for (let start = lines.length - 1; start >= 0; start--) {
    const first = matchOption(lines[start], start);
    if (!first || first.index !== 1) continue;
    const block = collectBlock(lines, first);
    if (!block) continue;
    return block;
  }
  return null;
}

function collectBlock(lines: string[], first: RawOption): HerdrScreenPrompt | null {
  const raws: (RawOption & { desc: string[] })[] = [{ ...first, desc: [] }];
  let end = first.line;
  for (let i = first.line + 1; i < lines.length; i++) {
    const line = lines[i];
    const opt = matchOption(line, i);
    const current = raws[raws.length - 1];
    if (opt && opt.index === current.index + 1 && Math.abs(opt.digitCol - first.digitCol) <= 2) {
      raws.push({ ...opt, desc: [] });
      end = i;
      continue;
    }
    if (opt) return null; // 编号断了 / 另起了一个列表：不是我们认得的卡
    if (isBlank(line) || isSeparator(line)) continue;
    if (FOOTER_RE.test(line)) break;
    // 续行：比序号缩进更深，且紧跟在选项（或它的续行）后面、中间没隔空行
    if (indentOf(line) > current.digitCol && !isBlank(lines[i - 1]) && !isSeparator(lines[i - 1])) {
      current.desc.push(line.trim());
      end = i;
      continue;
    }
    break;
  }
  if (raws.length < 2) return null;
  const pointed = raws.filter((raw) => raw.pointer);
  if (pointed.length !== 1) return null;

  // 选择卡必须在屏幕最底部：块之后只允许空行 / 分隔线 / 操作提示，且非空行不超过 3 行
  let trailing = 0;
  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isSeparator(line)) continue;
    if (FOOTER_RE.test(line)) continue;
    trailing++;
  }
  if (trailing > 3) return null;

  // 标题：选项块上方最近的一段非空文字（遇到空行 / 分隔线 / 标签行停）
  let cursor = first.line - 1;
  while (cursor >= 0 && isBlank(lines[cursor])) cursor--;
  const titleParts: string[] = [];
  while (cursor >= 0 && titleParts.length < 3) {
    const line = lines[cursor];
    if (isBlank(line) || isSeparator(line) || TAB_BAR_RE.test(line)) break;
    titleParts.unshift(line.trim());
    cursor--;
  }
  const title = titleParts.length ? joinText(titleParts) : null;

  // 标题上方：题目标签行（多题）或说明块（审批的命令），都止于分隔线
  let tabs: HerdrScreenTab[] | null = null;
  const context: string[] = [];
  for (let i = cursor, seen = 0; i >= 0 && seen < 12; i--, seen++) {
    const line = lines[i];
    if (isSeparator(line)) break;
    const parsedTabs = parseTabs(line);
    if (parsedTabs) {
      tabs = parsedTabs;
      break;
    }
    if (!isBlank(line)) context.unshift(line.trim());
  }

  const options: HerdrScreenOption[] = raws.map((raw) => {
    let label = raw.text.trim();
    const option: HerdrScreenOption = { index: raw.index, label };
    if (RECOMMENDED_RE.test(label)) {
      label = label.replace(RECOMMENDED_RE, "").trim();
      option.label = label;
      option.recommended = true;
    }
    if (raw.desc.length) option.description = joinText(raw.desc);
    if (/^type something\.?$/i.test(label)) option.isFreeText = true;
    if (/^chat about this\.?$/i.test(label)) option.isChat = true;
    return option;
  });
  const multiSelect = options.some((option) => CHECKBOX_RE.test(option.label));
  if (multiSelect) for (const option of options) option.label = option.label.replace(CHECKBOX_RE, "").trim();

  const approval =
    (title !== null && /^do you want to\b/i.test(title)) ||
    (/^yes\b/i.test(options[0].label) && options.some((option) => /^no\b/i.test(option.label)));
  if (approval) for (const option of options) option.approval = approvalRole(option.label);

  const toolLine = approval ? context.find((line) => /^[A-Z][\w-]*( command| tool)?$/.test(line) || /^(Bash|Edit|Write|Read|WebFetch|MultiEdit|NotebookEdit)\b/.test(line)) : undefined;
  const tool = toolLine ? toolLine.replace(/\s+(command|tool)$/i, "").split(/[\s(]/)[0] : null;

  const result: HerdrScreenPrompt = {
    kind: approval ? "approval" : "question",
    title,
    context: approval && toolLine ? context.filter((line) => line !== toolLine) : context,
    tool,
    options,
    selectedIndex: pointed[0].index,
    multiSelect,
  };
  if (tabs && tabs.length > 1) {
    const current = tabs.findIndex((tab) => !tab.done);
    result.multiQuestion = { total: tabs.length, current: current === -1 ? tabs.length : current + 1, tabs };
  }
  return result;
}

/** 同一张卡的指纹：发键前重读屏幕，指纹变了就不发（屏幕已经不是用户看到的那张了）。 */
export function herdrScreenSignature(prompt: HerdrScreenPrompt | null): string {
  if (!prompt) return "";
  return JSON.stringify([prompt.kind, prompt.title, prompt.options.map((option) => option.label), prompt.multiQuestion?.current ?? 0]);
}

/**
 * 选第 N 项要发的按键。
 *
 * 用数字直选，而不是「↑/↓ 从 ❯ 移到目标再 Enter」：
 * - Claude Code 的选择卡把数字键绑成「直接选中该序号并确认」，HerdrInteractionCard 的 hook 路径
 *   已在真实窗格里校准过（2026-09-07 单题数字即提交；R5 多题数字即进下一题 / Review；权限卡「1」即放行）；
 * - 数字与 ❯ 当前位置无关，读屏和发键之间 ❯ 被挪动也不会选错；方向键方案依赖读屏那一刻的 ❯，
 *   且多发一个 Enter 就会落到下一张卡上。
 * 方向键方案保留在 herdrArrowKeys 里备用（单测覆盖），目前不接线。
 */
export function herdrOptionKeys(option: Pick<HerdrScreenOption, "index">): string[] {
  if (!Number.isInteger(option.index) || option.index < 1 || option.index > 9) {
    throw new Error(`option index out of digit range: ${option.index}`);
  }
  return [String(option.index)];
}

/** 备用：从 ❯ 当前位置按 ↑/↓ 移到目标项再 Enter。 */
export function herdrArrowKeys(from: number, to: number): string[] {
  const step = to > from ? "down" : "up";
  return [...Array.from({ length: Math.abs(to - from) }, () => step), "Enter"];
}

/**
 * 自由输入第二步前的核对：发了「Type something」的序号之后重读屏幕，
 * 必须还是同一道题（标题 + 其余选项不变），且 ❯ 落在自由输入项上，才往里打字。
 * 自由输入项自己的文字不参与比较——聚焦后 TUI 可能把它渲染成输入框。
 */
export function herdrFreeTextReady(
  before: HerdrScreenPrompt | null,
  after: HerdrScreenPrompt | null,
  freeIndex: number,
): boolean {
  if (!before || !after || after.multiSelect) return false;
  const others = (prompt: HerdrScreenPrompt) =>
    JSON.stringify(prompt.options.filter((option) => option.index !== freeIndex).map((option) => option.label));
  return (
    after.kind === before.kind &&
    after.title === before.title &&
    (after.multiQuestion?.current ?? 0) === (before.multiQuestion?.current ?? 0) &&
    others(after) === others(before) &&
    after.selectedIndex === freeIndex
  );
}
