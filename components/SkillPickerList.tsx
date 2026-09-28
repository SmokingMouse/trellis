"use client";
import { AtSign, Sparkles, SquareSlash, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Icon } from "@/components/ui";
import type { Command } from "@/lib/commands";

// C4/C1: shared "/" suggestion dropdown for input boxes — Trellis commands
// (first-class, all modes) render above skills (tool-capable modes only).
// placement="above" pops upward (bottom-full) for the docked composers;
// "inline" flows under the first-screen QuestionInput. Renders nothing when
// there are no matches.
//
// activeIndex is the keyboard highlight from useSlashNav, in the combined
// commands-then-skills index space (matching render order).
//
// 行样式（W3）：行首 lucide 图标区分身份（命令 / 单轮 Agent / 技能），名字等宽，
// 行尾弱化文字标注类别；不再用 emoji 徽章。
export function SkillPickerList({
  skills,
  onPick,
  commands = [],
  onPickCommand,
  agents = [],
  onPickAgent,
  activeIndex = -1,
  skillPrefix = "/",
  placement = "above",
}: {
  skills: { name: string; description: string }[];
  onPick: (name: string) => void;
  commands?: Command[];
  onPickCommand?: (command: Command) => void;
  // S88: `@slug` 提及 —— 把这一轮定向丢给某个 Agent。与 commands/skills
  // **互斥出现**（前两者绑开头的 `/`，这个绑开头的 `@`），所以索引空间不重叠，
  // agents 分组的 activeIndex 直接从 0 起算，不必再叠加偏移。
  agents?: { slug: string; name: string; description: string }[];
  onPickAgent?: (slug: string) => void;
  activeIndex?: number;
  skillPrefix?: "/" | "$";
  placement?: "above" | "inline";
}) {
  if (!skills.length && !commands.length && !agents.length) return null;
  // Keep the keyboard highlight visible inside the scrollable list. Ref
  // callbacks re-run per render, but scrollIntoView(nearest) on an already
  // visible element is a no-op.
  const activeRef = (el: HTMLButtonElement | null) =>
    el?.scrollIntoView({ block: "nearest" });
  const row = ({
    key,
    active,
    onClick,
    icon,
    name,
    extra,
    kind,
    description,
  }: {
    key: string;
    active: boolean;
    onClick: () => void;
    icon: LucideIcon;
    name: string;
    extra?: ReactNode;
    kind: string;
    description?: string;
  }) => (
    <button
      key={key}
      type="button"
      role="option"
      aria-selected={active}
      ref={active ? activeRef : undefined}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`w-full text-left px-2.5 py-1.5 rounded-field flex items-start gap-2.5 transition-colors ${
        active ? "bg-surface-hover" : "hover:bg-surface-hover"
      }`}
    >
      <Icon icon={icon} size="sm" className="mt-0.5 text-ink-faint" />
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5 text-ui text-ink">
          <span className="font-mono">{name}</span>
          {extra}
          <span className="ml-auto shrink-0 text-label text-ink-faint">{kind}</span>
        </span>
        {description && (
          <span className="block text-label text-ink-muted truncate">{description}</span>
        )}
      </span>
    </button>
  );
  return (
    <div
      role="listbox"
      aria-label="命令与技能"
      className={`${
        placement === "above" ? "absolute bottom-full inset-x-0 mb-1 z-10" : "mt-2"
      } border border-line rounded-card bg-surface shadow-pop p-1 max-h-64 overflow-y-auto`}
    >
      {commands.map((c, i) =>
        row({
          key: `cmd-${c.name}`,
          active: i === activeIndex,
          onClick: () => onPickCommand?.(c),
          icon: SquareSlash,
          name: `/${c.name}`,
          extra: c.hint ? <span className="font-mono text-ink-faint">{c.hint}</span> : undefined,
          kind: "命令",
          description: c.description,
        }),
      )}
      {agents.map((a, i) =>
        row({
          key: `agent-${a.slug}`,
          active: i === activeIndex,
          onClick: () => onPickAgent?.(a.slug),
          icon: AtSign,
          name: `@${a.slug}`,
          extra: <span className="text-ink-faint">{a.name}</span>,
          kind: "单轮 Agent",
          description: a.description,
        }),
      )}
      {skills.map((s, i) =>
        row({
          key: `skill-${s.name}`,
          active: commands.length + i === activeIndex,
          onClick: () => onPick(s.name),
          icon: Sparkles,
          name: `${skillPrefix}${s.name}`,
          kind: "技能",
          description: s.description,
        }),
      )}
    </div>
  );
}
