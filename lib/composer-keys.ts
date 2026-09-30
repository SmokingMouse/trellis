import { isSendCombo, type SendKey } from "./send-key";

// 输入框按键判定（常规 Composer 与 Herdr 输入框共用，见 components/ComposerShell.tsx）。
// 纯函数，便于单测：
//   - 输入法组字中的 Enter（isComposing / keyCode 229）一律忽略；
//   - Safari 在 compositionend 之后还会补发一次 keydown(Enter)，再挡 100ms；
//   - 发送键组合（sendKey 偏好：⌘↩ 或 ↩）→ send；
//   - Esc 且调用方关心 → escape；其余交给浏览器（换行 / 普通输入）。
// 补全面板的 ↑↓/Enter/Tab 由 useSlashNav 在这之前先吃掉，不经过这里。
export type ComposerKeyAction = "ignore" | "send" | "escape" | "default";

export type ComposerKeyEvent = {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  keyCode?: number;
  isComposing?: boolean;
};

export function resolveComposerKey(
  e: ComposerKeyEvent,
  opts: { sendKey: SendKey; compositionEndAt: number; now: number; handlesEscape: boolean },
): ComposerKeyAction {
  if (e.isComposing || e.keyCode === 229) return "ignore";
  if (e.key === "Enter" && opts.now - opts.compositionEndAt < 100) return "ignore";
  if (isSendCombo(e, opts.sendKey)) return "send";
  if (e.key === "Escape" && opts.handlesEscape) return "escape";
  return "default";
}
