// Shared mode color tokens for the three session modes. Single source of
// truth so ModeBadge (Header) and SessionTabs (tab bar) can't drift apart.
//
// Palette (from the original ModeBadge): chat = neutral stone,
// workspace = amber, project = rose.
//
// - `dot`:    bg-* for the small mode color dot on a tab.
// - `text`:   text-* for an active-tab label tint.
// - `badge`:  the full bordered chip class used by ModeBadge.
// - `activeBg`/`activeBorder`: tinted highlight for the currently-active tab.
// - `label`:  the human-readable mode name.

export type ModeStyle = {
  label: string;
  dot: string;
  text: string;
  badge: string;
  activeBg: string;
  activeBorder: string;
};

export const MODE_STYLES: Record<string, ModeStyle> = {
  chat: {
    label: "Chat",
    dot: "bg-stone-400 dark:bg-stone-500",
    text: "text-stone-700 dark:text-stone-200",
    badge:
      "border-stone-300 dark:border-stone-700 bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200",
    activeBg: "bg-stone-100 dark:bg-stone-800",
    activeBorder: "border-stone-400 dark:border-stone-500",
  },
  workspace: {
    label: "Workspace",
    dot: "bg-amber-500 dark:bg-amber-400",
    text: "text-amber-900 dark:text-amber-200",
    badge:
      "border-amber-300 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200",
    activeBg: "bg-amber-50 dark:bg-amber-950/40",
    activeBorder: "border-amber-400 dark:border-amber-700",
  },
  project: {
    label: "Project",
    dot: "bg-rose-500 dark:bg-rose-400",
    text: "text-rose-900 dark:text-rose-200",
    badge:
      "border-rose-300 dark:border-rose-800 bg-rose-50 dark:bg-rose-950/40 text-rose-900 dark:text-rose-200",
    activeBg: "bg-rose-50 dark:bg-rose-950/40",
    activeBorder: "border-rose-400 dark:border-rose-700",
  },
};

export function modeStyle(mode: string | null | undefined): ModeStyle {
  return MODE_STYLES[mode ?? "chat"] ?? MODE_STYLES.chat;
}
