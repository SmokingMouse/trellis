import "server-only";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Sibling of CHAT_SCRATCH (lib/paths.ts): chat mode shares one scratch cwd,
// while each "blank sandbox" workspace/project session gets its own fresh
// empty dir here — no repo, no CLAUDE.md, nothing to pick up as context.
const SCRATCH_ROOT = path.join(os.homedir(), ".trellis", "scratch");

const ADJECTIVES = [
  "quiet",
  "sunny",
  "misty",
  "brave",
  "amber",
  "gentle",
  "lucky",
  "mellow",
  "nimble",
  "vivid",
  "cozy",
  "swift",
];

const ANIMALS = [
  "otter",
  "heron",
  "lynx",
  "finch",
  "badger",
  "koala",
  "marmot",
  "plover",
  "civet",
  "gecko",
  "wren",
  "tapir",
];

function randomSlug(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  const n = Math.floor(Math.random() * 100)
    .toString()
    .padStart(2, "0");
  return `${adj}-${animal}-${n}`;
}

export async function POST() {
  try {
    fs.mkdirSync(SCRATCH_ROOT, { recursive: true });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }

  // Non-recursive mkdir throws EEXIST on slug collision → retry with a new
  // slug. ~14k combinations; a handful of attempts always suffices.
  for (let attempt = 0; attempt < 10; attempt++) {
    const dir = path.join(SCRATCH_ROOT, randomSlug());
    try {
      fs.mkdirSync(dir);
      return Response.json({ path: dir });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      return Response.json(
        { error: err instanceof Error ? err.message : String(err) },
        { status: 500 },
      );
    }
  }
  return Response.json(
    { error: "could not allocate a scratch dir (too many collisions)" },
    { status: 500 },
  );
}
