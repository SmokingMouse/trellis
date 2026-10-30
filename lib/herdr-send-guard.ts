// 发消息前的读屏核对：往正在跑的 agent 窗格里打字之前，先读一次带颜色的屏幕，
// 确认键盘焦点真在一个空输入框上才打。pane.send_input 本质是模拟键盘，文字落到哪
// 取决于那一刻 TUI 的状态，herdr 的 agent_status 不够用：
//   - 信任目录 / 模型选择这类对话框 herdr 可能报 idle → 文字会选中选项（dialog_open）；
//   - 电脑前打了一半的草稿、bash 模式（!）→ 消息拼进草稿一起发出 / 当命令跑（input_draft）。
// 宁可拒发也不误打：拒发时什么都没打，原文放回输入框，可安全重发。
//
// 纯函数，单测见 herdr-send-guard.test.ts（夹具是 Claude Code 2.1.x 真实读屏）。
// 思路参考 chyroc/jarvis 的 sendsafe（其规则源自 Ovis claude-input.ts，MIT）；这里是独立实现。

export type HerdrSendRefusalCode = "dialog_open" | "input_draft" | "screen_unknown";

export type HerdrSendCheck =
  | { ok: true }
  | {
      ok: false;
      code: HerdrSendRefusalCode;
      /** input_draft：输入框里现有的内容（纯文本，去掉 ❯），告诉用户那里有什么 */
      draft?: string;
      /** input_draft 且只有一行：可以用 HERDR_CLEAR_DRAFT_KEYS 清掉的那段字 */
      clearable?: string;
    };

/** 清空单行输入框：先删光标后，再删光标前（光标在哪都能清干净）。多行草稿清不掉。 */
export const HERDR_CLEAR_DRAFT_KEYS = ["ctrl+k", "ctrl+u"];

export const HERDR_SEND_REFUSAL_MESSAGE: Record<HerdrSendRefusalCode, string> = {
  dialog_open: "电脑上的终端正开着一个对话框（确认 / 选择列表等），这条消息没有发出去：先回答或关掉它再发",
  input_draft: "电脑上的输入框里有没发出去的内容，这条消息没有发出去，免得拼在一起",
  screen_unknown: "认不出窗格里 Claude 的输入框，这条消息没有发出去：在终端里看一眼再发",
};

// CSI / OSC / 其它两字节转义
const ESC_RE = /\x1b(?:\[([0-?]*)[ -/]*([@-~])|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;
const RULE_RE = /^[─━]{8,}$/;
// 命名会话的输入框上沿：`──── my-session ─`
const LABELED_RULE_RE = /^─{2,}\s.*─$/;
// 对话框的按键提示：`Enter to confirm · Esc to cancel`、`Enter to set as default · … · Esc to cancel`
const DIALOG_FOOTER_RE = /\b(?:esc to (?:cancel|go back|close|exit)|enter to (?:confirm|select|set|submit))\b/i;
// 光标停在编号选项上：`❯ 1. Yes`（Claude）、`› 1. Allow`（Codex）
const SELECTED_OPTION_RE = /^\s*[❯›>]\s*\d{1,2}[.)]\s+\S/;
// 粘贴 / 图片被折叠成的占位符：不管什么颜色都是内容
const PLACEHOLDER_RE = /\[(?:Pasted text #\d+|Image #\d+)/;
// IDE 选区胶囊（`[⧉ 3 lines selected] `）：不是输入，清空键也删不掉
const IDE_PILL_RE = /^[ \u00a0]?\[⧉ [^\]\n]+\] ?/;

export function stripAnsi(text: string): string {
  return text.replace(ESC_RE, "").replace(/\r/g, "");
}

const isBlankChar = (c: string) => c === " " || c === "\t" || c === "\u00a0";

function isRule(plainLine: string): boolean {
  const t = plainLine.trim();
  return RULE_RE.test(t) || LABELED_RULE_RE.test(t);
}

type Run = { text: string; dim: boolean; inverse: boolean };

/** 按 dim（SGR 2）/ inverse（SGR 7）切段；38/48/58 颜色整体跳过，`38;2;r;g;b` 里的 2 不是 dim。 */
function sgrRuns(line: string): Run[] {
  const out: Run[] = [];
  let dim = false;
  let inverse = false;
  let offset = 0;
  for (const m of line.matchAll(ESC_RE)) {
    const at = m.index ?? 0;
    if (at > offset) out.push({ text: line.slice(offset, at), dim, inverse });
    offset = at + m[0].length;
    if (m[2] !== "m") continue;
    const codes = (m[1] || "0").split(/[;:]/).map((c) => Number(c) || 0);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 38 || c === 48 || c === 58) {
        if (codes[i + 1] === 5) i += 2;
        else if (codes[i + 1] === 2) i += 4;
      } else if (c === 0) {
        dim = false;
        inverse = false;
      } else if (c === 22) dim = false;
      else if (c === 2) dim = true;
      else if (c === 27) inverse = false;
      else if (c === 7) inverse = true;
    }
  }
  if (offset < line.length) out.push({ text: line.slice(offset), dim, inverse });
  return out;
}

/**
 * 屏幕底部是不是一个对话框（文字会选中选项 / 落进对话框自己的输入框）：
 *   - 最后 4 行非空行里有对话框按键提示；或
 *   - 最后一条横线以下有「光标停在编号选项上」的行（横线以上是历史，旧消息里也可能有 `❯ 1.`）。
 * 对所有 agent 都适用（Claude / Codex 的审批和选择列表）。
 */
export function screenHasDialog(plain: string): boolean {
  const lines = plain.replace(/\r/g, "").split("\n");
  for (let i = lines.length - 1, seen = 0; i >= 0 && seen < 4; i--) {
    if (!lines[i].trim()) continue;
    seen++;
    if (DIALOG_FOOTER_RE.test(lines[i])) return true;
  }
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 30; i--) {
    if (isRule(lines[i])) return false;
    if (SELECTED_OPTION_RE.test(lines[i])) return true;
  }
  return false;
}

type InputBox = { raw: string[]; plain: string[]; footer: boolean } | "clipped" | null;

/**
 * Claude Code 的输入框：屏幕上最后两条横线之间的行。只看得到下沿 = 草稿比窗格还高。
 * footer：下沿横线下面紧跟着页脚（`? for shortcuts` / 权限模式 / statusline 等任何非空行）。
 * 启动中、信任目录这类对话框刚关掉还没画完时只有横线没有页脚 —— 不算就绪。
 */
function findInputBox(ansi: string): InputBox {
  const raw = ansi.replace(/\r/g, "").split("\n");
  const plain = raw.map((line) => stripAnsi(line).replace(/\s+$/, ""));
  let end = plain.length - 1;
  while (end >= 0 && !isRule(plain[end])) end--;
  if (end < 0) return null;
  let start = end - 1;
  while (start >= 0 && !isRule(plain[start])) start--;
  if (start < 0) return "clipped";
  const footer = plain.slice(end + 1, end + 5).some((line) => line.trim() !== "");
  return { raw: raw.slice(start + 1, end), plain: plain.slice(start + 1, end), footer };
}

/**
 * 输入框里有没有「打出来的字」：❯ 之后任何不是 dim 的非空字符都算；
 * Claude 自己的灰色建议（dim）和光标（反色，落在第一个灰字上）不算。
 * 光标反色压在一个字上、后面却没有灰字 = 光标压在打出来的字上，也算草稿。
 */
function hasTypedText(rows: string[], pillChars: number): boolean {
  let afterPrompt = false;
  let first = true;
  let cursor = false;
  let grey = false;
  let pill = pillChars;
  for (const row of rows) {
    for (const run of sgrRuns(row)) {
      for (const c of run.text) {
        if (!afterPrompt) {
          afterPrompt = c === "❯";
          continue;
        }
        if (pill > 0) {
          pill--;
          continue;
        }
        if (isBlankChar(c)) continue;
        if (run.dim) grey = true;
        else if (first && run.inverse) cursor = true;
        else return true;
        first = false;
      }
    }
  }
  return cursor && !grey;
}

/**
 * Claude Code 窗格此刻能不能安全打字。ansi 是 `pane.read format: ansi` 的可见屏；
 * 读不到颜色时（纯文本）灰色建议和草稿分不清，任何字都当草稿 —— 方向是拒发，安全。
 */
export function checkClaudeSend(ansi: string): HerdrSendCheck {
  const plain = stripAnsi(ansi);
  if (screenHasDialog(plain)) return { ok: false, code: "dialog_open" };
  const box = findInputBox(ansi);
  if (box === null) return { ok: false, code: "screen_unknown" };
  if (box === "clipped") return { ok: false, code: "input_draft", draft: "" };

  const rows = box.plain.map((row) => row.replace(/\u00a0/g, " ").replace(/\s+$/, ""));
  const text = rows.join("\n").replace(/^❯/, "").trim();
  // 第一行不是 ❯：bash 模式（!）或别的输入模式 —— 消息会被当命令跑
  if (rows.length === 0 || !rows[0].startsWith("❯")) return { ok: false, code: "input_draft", draft: text };

  const afterPrompt = box.plain[0].slice(1);
  const pill = afterPrompt.match(IDE_PILL_RE)?.[0] ?? "";
  const rest = [afterPrompt.slice(pill.length), ...box.plain.slice(1)].join("\n").replace(/\u00a0/g, " ");
  // 空输入框还要看得到页脚才算就绪（见 findInputBox）
  const ready: HerdrSendCheck = box.footer ? { ok: true } : { ok: false, code: "screen_unknown" };
  if (!rest.trim()) return ready;
  if (PLACEHOLDER_RE.test(box.plain.join(" "))) return { ok: false, code: "input_draft", draft: text };
  if (!hasTypedText(box.raw, [...pill].length)) return ready;

  const draft = rest.trim();
  const refusal: HerdrSendCheck = { ok: false, code: "input_draft", draft };
  if (box.plain.length === 1 && draft) refusal.clearable = draft;
  return refusal;
}

/** 按 agent 选规则：Claude 查对话框 + 输入框；其余 agent（Codex 等）只查对话框。 */
export function checkHerdrSend(agent: string | null | undefined, ansi: string): HerdrSendCheck {
  if (agent === "claude") return checkClaudeSend(ansi);
  return screenHasDialog(stripAnsi(ansi)) ? { ok: false, code: "dialog_open" } : { ok: true };
}

/** 拒发提示：草稿过长时截断，免得一大段原文塞满提示条。 */
export function herdrSendRefusalMessage(code: HerdrSendRefusalCode, draft?: string): string {
  if (code !== "input_draft" || !draft) return HERDR_SEND_REFUSAL_MESSAGE[code];
  const shown = [...draft].length > 80 ? `${[...draft].slice(0, 80).join("")}…` : draft;
  return `电脑上的输入框里有没发出去的内容：「${shown}」。这条消息没有发出去，免得拼在一起`;
}
