// 读屏解析：拿不到 hook 结构化数据时，从 Herdr 读到的终端文本里认出
// Claude Code 的「提问（AskUserQuestion）/ 权限审批」选择卡，以及 hook 盖不住的对话框
// （信任目录、MCP 服务器、Bypass 警告、模型 / 主题 / 登录方式选择），
// 让 HerdrInteractionCard 仍能渲染成可点选的选项卡片，而不是一大块原始终端。
// 每张卡带一个 rev（herdrScreenRev）：服务端发键前重读屏幕，rev 对不上就什么都不按。
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

/** hook 盖不住的对话框种类（kind=dialog 时）；认不出具体是哪种但形状对的是 other。 */
export type HerdrDialogKind = "trust" | "mcp" | "bypass" | "model" | "theme" | "login" | "other";

export type HerdrScreenPrompt = {
  /** dialog：不是 AskUserQuestion / 权限审批，而是 Claude Code 自己的对话框，渲染成通用「终端在问你」卡 */
  kind: "question" | "approval" | "dialog";
  /** kind=dialog 时是哪种对话框 */
  dialog?: HerdrDialogKind;
  /**
   * 选项没有序号（信任目录 / MCP / Bypass 警告）：只能从 ❯ 当前位置按 ↑/↓ 移过去再 Enter，
   * 所以这种卡的 rev 把 ❯ 位置也算进去（见 herdrScreenRev）。
   */
  unnumbered?: boolean;
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
  return parseUnnumbered(lines);
}

/** 整段对话框文字（标题 + 上方说明）认出是哪种 Claude Code 对话框；都不是返回 undefined。 */
function classifyDialog(text: string, title: string | null): HerdrDialogKind | undefined {
  if (/trust (?:this|the files in this) folder|project you created or one you trust/i.test(text)) return "trust";
  if (/New MCP servers? found/i.test(text)) return "mcp";
  if (/Bypass Permissions mode/i.test(text)) return "bypass";
  if (title && /^select model\b/i.test(title)) return "model";
  if (/Choose the text style|run \/theme/i.test(text)) return "theme";
  if (/Select login method/i.test(text)) return "login";
  return undefined;
}

const CURSOR_ROW_RE = /^(\s*)❯\s+(\S.*)$/;
const DIALOG_LINK_RE = /^(Security guide|Learn more|https?:\/\/\S+)$/i;

/**
 * 无序号的选择列表（信任目录 / MCP 服务器 / Bypass 警告）：最后 30 行里有 `❯ 标签` 光标行，
 * 上下紧挨着与它标签同列对齐的兄弟行，且底部有对话框按键提示（Enter to confirm · Esc to cancel）。
 * 这种卡只能按方向键选，认错一行就会选错 —— 任何一条对不上都返回 null。
 */
function parseUnnumbered(lines: string[]): HerdrScreenPrompt | null {
  let footerSeen = false;
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 4; i--) {
    if (isBlank(lines[i])) continue;
    seen++;
    if (FOOTER_RE.test(lines[i])) footerSeen = true;
  }
  if (!footerSeen) return null;

  let cursor = -1;
  let column = 0;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 30; i--) {
    const m = lines[i].match(CURSOR_ROW_RE);
    if (m) {
      cursor = i;
      column = lines[i].indexOf(m[2], m[1].length + 1);
      break;
    }
  }
  if (cursor < 0) return null;
  const sibling = (line: string | undefined) =>
    line !== undefined &&
    !isBlank(line) &&
    !FOOTER_RE.test(line) &&
    !isSeparator(line) &&
    line.length > column &&
    line.slice(0, column).trim() === "" &&
    line[column] !== " ";
  let top = cursor;
  let bottom = cursor;
  while (sibling(lines[top - 1])) top--;
  while (sibling(lines[bottom + 1])) bottom++;
  if (top === bottom) return null;
  // 列表之后只允许空行 / 分隔线 / 按键提示
  for (let i = bottom + 1; i < lines.length; i++) {
    if (!isBlank(lines[i]) && !isSeparator(lines[i]) && !FOOTER_RE.test(lines[i])) return null;
  }

  // 列表上方到分隔线（或最多 20 行）按空行切段：带问号的最后一段是标题，其余是说明
  const paragraphs: string[][] = [];
  let current: string[] = [];
  for (let i = top - 1, seen = 0; i >= 0 && seen < 20; i--, seen++) {
    const line = lines[i];
    if (isSeparator(line)) break;
    if (isBlank(line)) {
      if (current.length) paragraphs.unshift(current);
      current = [];
      continue;
    }
    current.unshift(line.trim());
  }
  if (current.length) paragraphs.unshift(current);
  const texts = paragraphs.map(joinText).filter((text) => !DIALOG_LINK_RE.test(text));
  let titleAt = -1;
  for (let i = texts.length - 1; i >= 0; i--) {
    if (/[?？]/.test(texts[i])) {
      titleAt = i;
      break;
    }
  }
  if (titleAt < 0) titleAt = texts.length ? 0 : -1;
  const title = titleAt >= 0 ? texts[titleAt] : null;
  const context = texts.filter((_, i) => i !== titleAt);

  const options: HerdrScreenOption[] = [];
  for (let i = top; i <= bottom; i++) {
    const label = lines[i].trim().replace(/^❯\s*/, "").trim();
    options.push({ index: i - top + 1, label });
  }
  return {
    kind: "dialog",
    dialog: classifyDialog(texts.join("\n"), title) ?? "other",
    unnumbered: true,
    title,
    context,
    tool: null,
    options,
    selectedIndex: cursor - top + 1,
    multiSelect: false,
  };
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

  // 选择卡必须在屏幕最底部：块之后只允许空行 / 分隔线 / 操作提示，且非空行不超过 3 行。
  // 主题选择下面跟着一段 diff 预览，认得出是它时放宽到 8 行。
  let trailing = 0;
  for (let i = end + 1; i < lines.length; i++) {
    const line = lines[i];
    if (isBlank(line) || isSeparator(line)) continue;
    if (FOOTER_RE.test(line)) continue;
    trailing++;
  }
  const dialogKind = classifyDialog(lines.slice(Math.max(0, first.line - 16), first.line).join("\n"), title);
  if (trailing > (dialogKind === "theme" ? 8 : 3)) return null;

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
    !dialogKind &&
    ((title !== null && /^do you want to\b/i.test(title)) ||
      (/^yes\b/i.test(options[0].label) && options.some((option) => /^no\b/i.test(option.label))));
  if (approval) for (const option of options) option.approval = approvalRole(option.label);

  const toolLine = approval ? context.find((line) => /^[A-Z][\w-]*( command| tool)?$/.test(line) || /^(Bash|Edit|Write|Read|WebFetch|MultiEdit|NotebookEdit)\b/.test(line)) : undefined;
  const tool = toolLine ? toolLine.replace(/\s+(command|tool)$/i, "").split(/[\s(]/)[0] : null;

  const result: HerdrScreenPrompt = {
    kind: dialogKind ? "dialog" : approval ? "approval" : "question",
    title,
    context: approval && toolLine ? context.filter((line) => line !== toolLine) : context,
    tool,
    options,
    selectedIndex: pointed[0].index,
    multiSelect,
  };
  if (dialogKind) {
    result.dialog = dialogKind;
    // 启动画面的 logo 字符画不是说明
    result.context = result.context.filter((line) => /[A-Za-z\u4e00-\u9fff]/.test(line));
    // 模型选择一行两栏（`Sonnet ✔      Sonnet 5 · Efficient…`）：第一栏是标签，其余当描述
    for (const option of options) {
      const [label, ...rest] = option.label.split(/\s{2,}/);
      if (rest.length && !option.description) {
        option.label = label;
        option.description = rest.join(" ");
      }
      if (RECOMMENDED_RE.test(option.label)) {
        option.label = option.label.replace(RECOMMENDED_RE, "").trim();
        option.recommended = true;
      }
    }
  }
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

/** 发键前核对用的读屏行数：卡片（客户端）和发键接口（服务端）都只看最后这么多行，rev 才对得上。 */
export const HERDR_PROMPT_LINES = 40;

/** 取读屏文本的最后 HERDR_PROMPT_LINES 行（读屏接口按需切尾，这里与它同一口径）。 */
export function herdrPromptTail(text: string): string {
  return text.replace(/\r/g, "").split("\n").slice(-HERDR_PROMPT_LINES).join("\n");
}

// cyrb53：53 位、同步、浏览器和服务端结果一致，够区分一屏对话框；不做安全用途。
function hash53(text: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761);
    h2 = Math.imul(h2 ^ c, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, "0");
}

/**
 * 对话框的 rev：对话框区域规范化后的文字（种类、标题、说明、各选项标签与描述、多题当前题号）的哈希。
 * 有序号的卡按数字直选，与 ❯ 位置无关，rev 不含 ❯；无序号的卡靠方向键从 ❯ 移过去，❯ 动了 rev 就变。
 * 没有卡返回 ""。
 */
export function herdrScreenRev(prompt: HerdrScreenPrompt | null): string {
  if (!prompt) return "";
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  return hash53(
    JSON.stringify([
      prompt.kind,
      prompt.dialog ?? "",
      normalize(prompt.title ?? ""),
      prompt.context.map(normalize),
      prompt.options.map((option) => [option.index, normalize(option.label), normalize(option.description ?? "")]),
      prompt.multiSelect,
      prompt.multiQuestion?.current ?? 0,
      prompt.unnumbered ? prompt.selectedIndex : 0,
    ]),
  );
}

/** 读屏文本 → 卡 + rev（服务端发键前、pending 接口共用）。 */
export function herdrScreenPromptWithRev(text: string): { prompt: HerdrScreenPrompt | null; rev: string } {
  const prompt = parseHerdrScreen(herdrPromptTail(text));
  return { prompt, rev: herdrScreenRev(prompt) };
}

/** 选卡上第 N 项要发的键：有序号用数字直选，无序号从 ❯ 当前位置按方向键再 Enter。 */
export function herdrPromptOptionKeys(prompt: HerdrScreenPrompt, index: number): string[] {
  if (!prompt.options.some((option) => option.index === index)) {
    throw new Error(`prompt has no option ${index}`);
  }
  return prompt.unnumbered ? herdrArrowKeys(prompt.selectedIndex, index) : herdrOptionKeys({ index });
}

/**
 * 选第 N 项要发的按键。
 *
 * 用数字直选，而不是「↑/↓ 从 ❯ 移到目标再 Enter」：
 * - Claude Code 的选择卡把数字键绑成「直接选中该序号并确认」，HerdrInteractionCard 的 hook 路径
 *   已在真实窗格里校准过（2026-09-07 单题数字即提交；R5 多题数字即进下一题 / Review；权限卡「1」即放行）；
 * - 数字与 ❯ 当前位置无关，读屏和发键之间 ❯ 被挪动也不会选错；方向键方案依赖读屏那一刻的 ❯，
 *   且多发一个 Enter 就会落到下一张卡上。
 * 方向键方案（herdrArrowKeys）只给没有序号的对话框用，那里 rev 含 ❯ 位置，❯ 一动就拒发。
 */
export function herdrOptionKeys(option: Pick<HerdrScreenOption, "index">): string[] {
  if (!Number.isInteger(option.index) || option.index < 1 || option.index > 9) {
    throw new Error(`option index out of digit range: ${option.index}`);
  }
  return [String(option.index)];
}

/** 从 ❯ 当前位置按 ↑/↓ 移到目标项再 Enter：无序号对话框（信任目录等）用，见 herdrPromptOptionKeys。 */
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
