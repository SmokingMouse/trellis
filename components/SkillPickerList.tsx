"use client";

// C4: shared skill suggestion dropdown for input boxes. Pops upward
// (bottom-full) since every input that uses it sits at the bottom of its
// container. Renders nothing when there are no matches.
export function SkillPickerList({
  skills,
  onPick,
}: {
  skills: { name: string; description: string }[];
  onPick: (name: string) => void;
}) {
  if (!skills.length) return null;
  return (
    <div className="absolute bottom-full inset-x-0 mb-1 z-10 border border-stone-200 dark:border-stone-700 rounded-lg bg-white dark:bg-stone-900 shadow-lg overflow-hidden max-h-56 overflow-y-auto">
      {skills.map((s) => (
        <button
          key={s.name}
          type="button"
          onClick={() => onPick(s.name)}
          className="w-full text-left px-3 py-2 hover:bg-stone-50 dark:hover:bg-stone-800 border-b last:border-b-0 border-stone-100 dark:border-stone-800"
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
