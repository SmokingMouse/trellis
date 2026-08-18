"use client";
import { useEffect, useState } from "react";

// C4 (followup): shared skill-picker matching for any input box. Lazily loads
// the provider-scoped skill list, then filters a leading `/name` or `$name`
// token (no space yet). Returns [] when not applicable.
export function useSkillSuggestions(
  text: string,
  enabled: boolean,
  provider: "claude" | "codex" = "claude",
  workspace?: string | null,
): { name: string; description: string }[] {
  const [skills, setSkills] = useState<{ name: string; description: string }[]>(
    [],
  );
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const params = new URLSearchParams({ provider });
    if (workspace) params.set("workspace", workspace);
    fetch(`/api/skills?${params}`)
      .then((r) => r.json())
      .then((d) => {
        if (alive) setSkills(d.skills ?? []);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [enabled, provider, workspace]);

  const marker = text.startsWith("$") ? "$" : text.startsWith("/") ? "/" : null;
  const q =
    enabled && marker && !text.includes(" ")
      ? text.slice(1).toLowerCase()
      : null;
  return q !== null
    ? skills.filter((s) => s.name.toLowerCase().includes(q)).slice(0, 6)
    : [];
}
