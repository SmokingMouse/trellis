"use client";

// Shared run-status spinner for SessionTabs + SessionSidebar (Wave 4 polish).
//
// A small accent-tinted spinning ring (SVG arc + Tailwind animate-spin).
// Replaces the faint mode-dot `animate-ping` that users couldn't see. Theme
// handled via currentColor + the text-accent tint here, so the ring inherits.
//
// `size` is the px diameter of the ring (default 12). Keep tiny so it fits a
// 28px-tall tab without crowding the title.
export function RunSpinner({ size = 12 }: { size?: number }) {
  return (
    <span
      className="inline-flex shrink-0 text-accent"
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
// spinner ring would be redundant. Now delegates to the ui/Dots primitive
// (the app-wide "in progress" vocabulary); W7 retires the ring above too.
export { Dots as RunDots } from "@/components/ui/Dots";
