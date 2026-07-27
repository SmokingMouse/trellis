// Workbench Wave 4 — single source of truth for the IDE-shell layout math.
//
// The left explorer sidebar is a fixed rail. When it's open, every full-bleed
// content surface (Canvas, NodeFullView, QuestionInput) and the existing
// desktop Outline rail shift right by SIDEBAR_W so nothing overlaps. We expose
// the offset as an inline style (px) rather than scattering Tailwind arbitrary
// values, so there is exactly one magic number.
//
// Only applied at the `md` breakpoint and up — mobile keeps the sidebar as a
// non-permanent overlay and the content stays full-width (mobile views are
// fullscreen-by-default and don't render the desktop rail).

export const SIDEBAR_W = 210; // px — the explorer rail width.

// Consumers that need the offset at runtime read the CSS variable
// `--trellis-sb` (set in app/page.tsx); the Outline rail composes it as
// `calc(var(--trellis-sb,0px) + 12px)` to keep its original 12px gutter.

// S1：宽度改成可拖拽（原来是写死的常量）。SIDEBAR_W 保留为**默认值**，
// 实际宽度存 localStorage、由 SessionSidebar 拖拽边缘调整，并继续通过
// `--trellis-sb` 发布给所有消费者 —— 所以消费者一行都不用改。
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 420;
const SIDEBAR_KEY = "trellis-sidebar-width";

export function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_W;
  const n = Number(window.localStorage.getItem(SIDEBAR_KEY));
  return Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_W;
}

export function persistSidebarWidth(w: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(w));
  } catch {
    /* 隐私模式：退化成只在本次会话内有效 */
  }
}
