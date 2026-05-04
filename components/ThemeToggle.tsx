"use client";
import { useTheme } from "@/hooks/useTheme";

export function ThemeToggle() {
  const { theme, toggle } = useTheme();
  // theme is null until first effect — the inline pre-hydration script
  // means the visible chrome is already correct, but for the icon's
  // sun↔moon swap we wait so the SSR'd server-html doesn't disagree
  // with what's on screen after hydration.
  const isDark = theme === "dark";

  return (
    <button
      onClick={toggle}
      className="shrink-0 p-1.5 rounded-md text-stone-600 hover:text-stone-900 hover:bg-stone-100 dark:text-stone-400 dark:hover:text-stone-100 dark:hover:bg-stone-800 transition-colors"
      title={isDark ? "切换浅色" : "切换深色"}
      aria-label={isDark ? "切换浅色" : "切换深色"}
    >
      {theme === null ? (
        // Placeholder square so the header layout doesn't pop
        <span className="block w-[16px] h-[16px]" aria-hidden />
      ) : isDark ? (
        // Sun (currently dark → click to go light)
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41" />
        </svg>
      ) : (
        // Moon (currently light → click to go dark)
        <svg
          width="16"
          height="16"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      )}
    </button>
  );
}
