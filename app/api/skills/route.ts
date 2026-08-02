import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

// C4 (Stage 18): list the user's ~/.claude/skills/ for the input `/`-picker.
// trellis only does discovery/autocomplete — actual skill execution is handled
// by the claude CLI itself when the `/skill-name ...` text is sent in
// project mode (chat mode has no tools, so the picker is hidden there).
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
    const skills: { name: string; dir: string; description: string }[] = [];
    for (const e of entries) {
      // symlink 也要收：指向别处仓库的 skill 是常态（本机 `trellis-admin` 就是
      // 软链回本仓 `skills/trellis-admin`）。readdir 给的 Dirent **不穿透**，
      // `isDirectory()` 对 symlink 恒 false —— 只认它就会把这类 skill 整个漏掉，
      // 而 CLI 侧（init 事件的 slash_commands）和物化侧（agent-pack.ts:129/134
      // 的 existsSync/symlinkSync 都穿透）都看得见，唯独这个发现层瞎。
      if (!e.isDirectory()) {
        if (!e.isSymbolicLink()) continue;
        try {
          // stat 穿透确认目标真是目录；悬空软链静默跳过。
          const st = await fs.stat(path.join(dir, e.name));
          if (!st.isDirectory()) continue;
        } catch {
          continue;
        }
      }
      try {
        const raw = await fs.readFile(
          path.join(dir, e.name, "SKILL.md"),
          "utf8",
        );
        // `dir` 是目录名，`name` 是 frontmatter 里的名字 —— 两者可以不同，且
        // **agent 的技能引用必须存 dir**：claude 加载 plugin skill 时取的是目录名
        // （2026-07-31 实测：symlink 名 linked-zebra 指向 xhs-cards，列出来是
        // `trellis-pack:linked-zebra`）。`name` 只用于给人看的补全列表。
        skills.push({ ...parseFrontmatter(raw, e.name), dir: e.name });
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
