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
