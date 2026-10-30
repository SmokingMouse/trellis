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

export const SIDEBAR_W = 260; // px — the explorer rail width（原型 08-beautiful-ui .sidebar）.

// Consumers that need the offset at runtime read the CSS variable
// `--trellis-sb` (set in app/page.tsx); the Outline rail composes it as
// `calc(var(--trellis-sb,0px) + 12px)` to keep its original 12px gutter.

// S1：宽度改成可拖拽（原来是写死的常量）。SIDEBAR_W 保留为**默认值**，
// 实际宽度存 localStorage、由 SessionSidebar 拖拽边缘调整，并继续通过
// `--trellis-sb` 发布给所有消费者 —— 所以消费者一行都不用改。
export const SIDEBAR_MIN = 160;
export const SIDEBAR_MAX = 420;
const SIDEBAR_KEY = "trellis-sidebar-width";
const LEGACY_SIDEBAR_W = 210;

export function loadSidebarWidth(): number {
  if (typeof window === "undefined") return SIDEBAR_W;
  const n = Number(window.localStorage.getItem(SIDEBAR_KEY));
  // 2026-10-30 默认宽 210 → 260（beautifului 原型）。存着旧默认值 210 的多半只是
  // 拖拽时碰巧落回原位、并非刻意选的宽度——按新默认处理，免得老用户永远看不到新布局。
  if (n === LEGACY_SIDEBAR_W) return SIDEBAR_W;
  return Number.isFinite(n) && n >= SIDEBAR_MIN && n <= SIDEBAR_MAX ? n : SIDEBAR_W;
}

export function persistSidebarWidth(w: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_KEY, String(w));
  } catch {
    /* 隐私模式：退化成只在本次会话内有效 */
  }
}
