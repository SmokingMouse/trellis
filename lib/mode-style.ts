// Shared mode color tokens for the three session modes. Single source of
// truth so ModeBadge (Header) and SessionTabs (tab bar) can't drift apart.
//
// Colors come from the semantic token layer (globals.css @theme):
// mode-chat / mode-workspace / mode-project each carry dot·ink·muted·line·
// line-strong roles, decoupled from the status hues (warn/danger) so a
// palette can restyle modes without touching alert semantics.
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
    dot: "bg-mode-chat",
    text: "text-mode-chat-ink",
    badge: "border-mode-chat-line bg-mode-chat-muted text-mode-chat-ink",
    activeBg: "bg-mode-chat-muted",
    activeBorder: "border-mode-chat-line-strong",
  },
  workspace: {
    label: "Workspace",
    dot: "bg-mode-workspace",
    text: "text-mode-workspace-ink",
    badge:
      "border-mode-workspace-line bg-mode-workspace-muted text-mode-workspace-ink",
    activeBg: "bg-mode-workspace-muted",
    activeBorder: "border-mode-workspace-line-strong",
  },
  project: {
    label: "Project",
    dot: "bg-mode-project",
    text: "text-mode-project-ink",
    badge: "border-mode-project-line bg-mode-project-muted text-mode-project-ink",
    activeBg: "bg-mode-project-muted",
    activeBorder: "border-mode-project-line-strong",
  },
};

export function modeStyle(mode: string | null | undefined): ModeStyle {
  return MODE_STYLES[mode ?? "chat"] ?? MODE_STYLES.chat;
}
