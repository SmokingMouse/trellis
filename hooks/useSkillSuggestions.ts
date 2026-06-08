"use client";
import { useEffect, useState } from "react";

// C4 (followup): shared skill-picker matching for any input box. Lazily loads
// the skill list when enabled (tool-capable mode), then filters by a leading
// "/name" token (no space yet). Returns [] when not applicable.
export function useSkillSuggestions(
  text: string,
  enabled: boolean,
): { name: string; description: string }[] {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>(
    [],
  );
  useEffect(() => {
    if (!enabled || skills.length) return;
    fetch("/api/skills")
      .then((r) => r.json())
      .then((d) => setSkills(d.skills ?? []))
      .catch(() => {});
  }, [enabled, skills.length]);

  const q =
    enabled && text.startsWith("/") && !text.includes(" ")
      ? text.slice(1).toLowerCase()
      : null;
  return q !== null
    ? skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 6)
    : [];
}
