"use client";
import type { Command } from "@/lib/commands";

// C4/C1: shared "/" suggestion dropdown for input boxes — Trellis commands
// (⚡ first-class, all modes) render above skills (tool-capable modes only),
// same ordering as the first-screen QuestionInput dropdown. Pops upward
// (bottom-full) since every input that uses it sits at the bottom of its
// container. Renders nothing when there are no matches.
//
// activeIndex is the keyboard highlight from useSlashNav, in the combined
// commands-then-skills index space (matching render order).
export function SkillPickerList({
  skills,
  onPick,
  commands = [],
  onPickCommand,
  agents = [],
  onPickAgent,
  activeIndex = -1,
  skillPrefix = "/",
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
}) {
  if (!skills.length && !commands.length && !agents.length) return null;
  // Keep the keyboard highlight visible inside the scrollable list. Ref
  // callbacks re-run per render, but scrollIntoView(nearest) on an already
  // visible element is a no-op.
  const activeRef = (el: HTMLButtonElement | null) =>
    el?.scrollIntoView({ block: "nearest" });
  const rowClass = (isActive: boolean) =>
    `w-full text-left px-3 py-2 border-b last:border-b-0 border-line-faint ${
      isActive ? "bg-surface-muted" : "hover:bg-surface-muted"
    }`;
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 z-10 border border-line rounded-lg bg-surface shadow-pop overflow-hidden max-h-56 overflow-y-auto">
      {commands.map((c, i) => (
        <button
          key={`cmd-${c.name}`}
          type="button"
          ref={i === activeIndex ? activeRef : undefined}
          onClick={() => onPickCommand?.(c)}
          className={rowClass(i === activeIndex)}
        >
          <div className="text-ui font-mono text-ink flex items-center gap-1.5">
            {/* ⚡徽章标识「Trellis 命令」身份（非告警）→ accent-muted */}
            <span
              className="text-nano px-1 py-0.5 rounded bg-accent-muted text-accent-ink font-sans"
              aria-hidden
            >
              ⚡ 命令
            </span>
            <span>
              /{c.name}
              {c.hint && (
                <span className="text-ink-faint">
                  {" "}
                  {c.hint}
                </span>
              )}
            </span>
          </div>
          <div className="text-label text-ink-muted truncate">
            {c.description}
          </div>
        </button>
      ))}
      {agents.map((a, i) => (
        <button
          key={`agent-${a.slug}`}
          type="button"
          ref={i === activeIndex ? activeRef : undefined}
          onClick={() => onPickAgent?.(a.slug)}
          className={rowClass(i === activeIndex)}
        >
          <div className="text-ui font-mono text-ink flex items-center gap-1.5">
            <span
              className="text-nano px-1 py-0.5 rounded bg-accent-muted text-accent-ink font-sans"
              aria-hidden
            >
              🎭 单轮
            </span>
            <span>@{a.slug}</span>
            <span className="text-ink-faint font-sans">{a.name}</span>
          </div>
          {a.description && (
            <div className="text-label text-ink-muted truncate">{a.description}</div>
          )}
        </button>
      ))}
      {skills.map((s, i) => (
        <button
          key={`skill-${s.name}`}
          type="button"
          ref={commands.length + i === activeIndex ? activeRef : undefined}
          onClick={() => onPick(s.name)}
          className={rowClass(commands.length + i === activeIndex)}
        >
          <div className="text-ui font-mono text-ink">
            {skillPrefix}{s.name}
          </div>
          {s.description && (
            <div className="text-label text-ink-muted truncate">
              {s.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
