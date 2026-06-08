import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

// C2 (Stage 21 bridge): persist a node's insight into the user's global
// Claude Code memory dir (~/.claude/memory/) so future Claude sessions can
// recall it. Write is triggered explicitly by the user clicking "存到记忆";
// trellis never writes here on its own. Format mirrors auto-memory: one fact
// per file with frontmatter (name/description/metadata.type) + a MEMORY.md
// index line.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const VALID_TYPES = ["user", "feedback", "project", "reference"];

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9一-龥]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "memory"
  );
}

export async function POST(req: Request) {
  let body: { title?: string; content?: string; type?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: "invalid JSON" }, { status: 400 });
  }
  const title = (body.title ?? "").trim();
  const content = (body.content ?? "").trim();
  if (!content) {
    return Response.json({ error: "empty content" }, { status: 400 });
  }
  const type = VALID_TYPES.includes(body.type ?? "") ? body.type! : "reference";

  const dir = path.join(os.homedir(), ".claude", "memory");
  // Unique name: slug + short random suffix so two saves never silently
  // overwrite each other (or an existing auto-memory file).
  const base = slugify(title || content.slice(0, 40));
  const name = `${base}-${crypto.randomBytes(3).toString("hex")}`;
  const description = (title || content.slice(0, 60)).replace(/\n/g, " ");

  const md = `---
name: ${name}
description: ${description}
metadata:
  type: ${type}
---

${content}
`;

  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${name}.md`), md, "utf8");
    // Best-effort index append; failure here shouldn't fail the save.
    try {
      await fs.appendFile(
        path.join(dir, "MEMORY.md"),
        `- [${description}](${name}.md) — trellis 沉淀\n`,
        "utf8",
      );
    } catch {
      /* index is non-critical */
    }
    return Response.json({ ok: true, file: `${name}.md` });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
}
