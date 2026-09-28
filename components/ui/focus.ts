import type { KeyboardEvent } from "react";

// Modal / Drawer 的 Tab 循环（focus trap）。
//
// 为什么不用 Radix Dialog 的 modal 模式自带的 FocusScope：modal 模式会给 body
// 上 pointer-events:none、把其余 DOM 标 aria-hidden，并把焦点硬拽回弹窗——
// 而本项目还有一批没迁移的非 Radix 浮层（FilePreview / CodeBlock 全屏 /
// ContextMenu / 旧 toast），它们叠在弹窗上时会点不动、拿不到焦点。所以弹窗走
// Radix 的 modal={false}（仍有 portal / Esc / role=dialog / 自动聚焦与归还），
// Tab 循环在这里自己做：只在焦点本来就在面板里时接管 Tab，不和外来浮层抢。
const TABBABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]), [contenteditable="true"]';

export function trapTabKey(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== "Tab") return;
  const panel = e.currentTarget;
  // 从 portal 出去的子弹层（Select / Popover）冒泡上来的 Tab 不管
  if (!(e.target instanceof Node) || !panel.contains(e.target)) return;
  const items = Array.from(panel.querySelectorAll<HTMLElement>(TABBABLE)).filter(
    (el) => el.getClientRects().length > 0,
  );
  if (items.length === 0) {
    e.preventDefault();
    return;
  }
  const first = items[0];
  const last = items[items.length - 1];
  const active = document.activeElement;
  if (e.shiftKey && (active === first || active === panel)) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && active === last) {
    e.preventDefault();
    first.focus();
  }
}

/** 打开时：面板里已有元素自己聚焦（autoFocus / effect）就不动，否则聚焦面板本身。 */
export function focusPanelIfIdle(panel: HTMLElement | null) {
  if (!panel) return;
  if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true });
}

/** 关闭时：焦点丢回 body 的话，还给打开前的元素（还在文档里才还）。 */
export function restoreFocus(prev: Element | null) {
  const active = document.activeElement;
  if (active && active !== document.body) return;
  if (prev instanceof HTMLElement && prev.isConnected) prev.focus({ preventScroll: true });
}
