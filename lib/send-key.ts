// A4: configurable send key for chat inputs.
//   "enter"     — Enter sends, Shift+Enter newline (GPT/Claude default).
//   "mod-enter" — Cmd/Ctrl+Enter sends, Enter newline (safer against
//                 accidental sends; better for multi-line / long-form input).
// Default is "mod-enter": this is a thinking-tree tool where prompts tend to
// be multi-line (Feynman explanations, structured questions), so Enter=newline
// avoids the frequent mis-sends Enter-to-send caused. Flip per-preference via
// the footer toggle. (Zone editor is always ⌘Enter regardless.)
export type SendKey = "enter" | "mod-enter";
export const SEND_KEY_DEFAULT: SendKey = "mod-enter";

export function isSendKey(s: unknown): s is SendKey {
  return s === "enter" || s === "mod-enter";
}

// True when the keydown should submit (vs. insert a newline).
export function isSendCombo(
  e: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean },
  sendKey: SendKey,
): boolean {
  if (e.key !== "Enter") return false;
  if (sendKey === "enter") return !e.shiftKey && !e.metaKey && !e.ctrlKey;
  return e.metaKey || e.ctrlKey;
}

// Short hint string for placeholders / footers.
export function sendHint(sendKey: SendKey): string {
  return sendKey === "enter" ? "↩ 发送 · ⇧↩ 换行" : "⌘↩ 发送 · ↩ 换行";
}
