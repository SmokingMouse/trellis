import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// C4 (Stage 18): list the user's ~/.claude/skills/ for the input `/`-picker.
// trellis only does discovery/autocomplete — actual skill execution is handled
// by the claude CLI itself when the `/skill-name ...` text is sent in
// workspace/project mode (chat mode has no tools, so the picker is hidden there).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function parseFrontmatter(
  raw: string,
  fallbackName: string,
): { name: string; description: string } {
  let name = fallbackName;
  let description = "";
  const m = /^---\n([\s\S]*?)\n---/.exec(raw);
  if (m) {
    const fm = m[1];
    const nm = /^name:\s*(.+)$/m.exec(fm);
    const dm = /^description:\s*(.+)$/m.exec(fm);
    if (nm) name = nm[1].trim();
    if (dm) description = dm[1].trim();
  }
  // Keep descriptions short for the picker; full text lives in the skill.
  if (description.length > 120) description = description.slice(0, 120) + "…";
  return { name, description };
}

export async function GET() {
  const dir = path.join(os.homedir(), ".claude", "skills");
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const skills: { name: string; description: string }[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        const raw = await fs.readFile(
          path.join(dir, e.name, "SKILL.md"),
          "utf8",
        );
        skills.push(parseFrontmatter(raw, e.name));
      } catch {
        /* no SKILL.md in this dir — skip */
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ skills });
  } catch {
    // skills dir missing — return empty so the picker just shows nothing.
    return Response.json({ skills: [] });
  }
}
