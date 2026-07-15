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
  activeIndex = -1,
}: {
  skills: { name: string; description: string }[];
  onPick: (name: string) => void;
  commands?: Command[];
  onPickCommand?: (command: Command) => void;
  activeIndex?: number;
}) {
  if (!skills.length && !commands.length) return null;
  // Keep the keyboard highlight visible inside the scrollable list. Ref
  // callbacks re-run per render, but scrollIntoView(nearest) on an already
  // visible element is a no-op.
  const activeRef = (el: HTMLButtonElement | null) =>
    el?.scrollIntoView({ block: "nearest" });
  const rowClass = (isActive: boolean) =>
    `w-full text-left px-3 py-2 border-b last:border-b-0 border-stone-100 dark:border-stone-800 ${
      isActive
        ? "bg-stone-100 dark:bg-stone-800"
        : "hover:bg-stone-50 dark:hover:bg-stone-800"
    }`;
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 z-10 border border-stone-200 dark:border-stone-700 rounded-lg bg-white dark:bg-stone-900 shadow-lg overflow-hidden max-h-56 overflow-y-auto">
      {commands.map((c, i) => (
        <button
          key={`cmd-${c.name}`}
          type="button"
          ref={i === activeIndex ? activeRef : undefined}
          onClick={() => onPickCommand?.(c)}
          className={rowClass(i === activeIndex)}
        >
          <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200 flex items-center gap-1.5">
            <span
              className="text-[10px] px-1 py-0.5 rounded bg-indigo-100 dark:bg-indigo-900/50 text-indigo-700 dark:text-indigo-300 font-sans"
              aria-hidden
            >
              ⚡ 命令
            </span>
            <span>
              /{c.name}
              {c.hint && (
                <span className="text-stone-400 dark:text-stone-500">
                  {" "}
                  {c.hint}
                </span>
              )}
            </span>
          </div>
          <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
            {c.description}
          </div>
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
          <div className="text-[13px] font-mono text-stone-800 dark:text-stone-200">
            /{s.name}
          </div>
          {s.description && (
            <div className="text-[11px] text-stone-500 dark:text-stone-400 truncate">
              {s.description}
            </div>
          )}
        </button>
      ))}
    </div>
  );
}
