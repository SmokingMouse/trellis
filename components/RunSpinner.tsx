"use client";

// Shared run-status spinner for SessionTabs + SessionSidebar (Wave 4 polish).
//
// A small indigo spinning ring (SVG arc + Tailwind animate-spin). Replaces the
// faint mode-dot `animate-ping` that users couldn't see. Dark mode handled via
// currentColor + a text-indigo tint at the call site, so the ring inherits.
//
// `size` is the px diameter of the ring (default 12). Keep tiny so it fits a
// 28px-tall tab without crowding the title.
export function RunSpinner({ size = 12 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 text-indigo-500 dark:text-indigo-400"
      aria-label="生成中"
      role="status"
    >
      <svg
        className="animate-spin"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden
      >
        {/* Track */}
        <circle
          cx="12"
          cy="12"
          r="9"
          stroke="currentColor"
          strokeWidth="3"
          opacity="0.25"
        />
        {/* Moving arc (~quarter circle). */}
        <path
          d="M21 12a9 9 0 0 0-9-9"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
        />
      </svg>
    </span>
  );
}

// Three-dot bounce — even more compact, used inline next to a title when a
// spinner ring would be redundant. CSS lives in globals.css (.trellis-dots).
export function RunDots() {
  return (
    <span className="trellis-dots shrink-0" aria-label="生成中" role="status" aria-hidden>
      <span />
      <span />
      <span />
    </span>
  );
}
