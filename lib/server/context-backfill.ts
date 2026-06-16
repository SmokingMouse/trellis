import "server-only";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionCwd } from "@/lib/paths";
import type { Mode } from "@/lib/llm";
import { getDB } from "./sqlite";
import { parseCliSessionJsonl } from "./cli-import";

type RootRow = {
  session_id: string;
  mode: string;
  workspace_path: string | null;
  root_id: string;
  claude_session_id: string;
};

type NodeRow = {
  id: string;
  token_context: number | null;
};

function claudeSessionPath(sessionId: string, cwd: string | null): string {
  const effectiveCwd = cwd ?? os.homedir();
  const encodedCwd = effectiveCwd.replace(/[^a-zA-Z0-9]/g, "-");
  return path.join(
    os.homedir(),
    ".claude",
    "projects",
    encodedCwd,
    `${sessionId}.jsonl`,
  );
}

function findClaudeSessionPath(sessionId: string, cwd: string | null): string | null {
  const expected = claudeSessionPath(sessionId, cwd);
  if (fs.existsSync(expected)) return expected;
  const projectsDir = path.join(os.homedir(), ".claude", "projects");
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsDir);
  } catch {
    return null;
  }
  for (const dir of dirs) {
    const candidate = path.join(projectsDir, dir, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

let started = false;

export function startContextBackfill(): void {
  if (started) return;
  started = true;
  setTimeout(() => {
    try {
      backfillNativeProjectContext();
    } catch {
      /* best-effort legacy repair */
    }
  }, 0);
}

function backfillNativeProjectContext(): void {
  const db = getDB();
  const roots = db
    .prepare(
      `SELECT s.id AS session_id,
              s.context_mode AS mode,
              s.workspace_path,
              n.id AS root_id,
              n.claude_session_id
       FROM sessions s
       JOIN nodes n ON n.session_id = s.id
       WHERE s.origin = 'native'
         AND s.context_mode = 'project'
         AND n.parent_id IS NULL
         AND n.claude_session_id IS NOT NULL
         AND EXISTS (
           WITH RECURSIVE subtree(id) AS (
             SELECT n.id
             UNION ALL
             SELECT c.id FROM nodes c JOIN subtree st ON c.parent_id = st.id
           )
           SELECT 1 FROM nodes x
           JOIN subtree st ON st.id = x.id
           WHERE x.token_context IS NULL
             AND x.status = 'done'
           LIMIT 1
         )`,
    )
    .all() as RootRow[];

  const subtreeStmt = db.prepare(
    `WITH RECURSIVE subtree(id) AS (
       SELECT ?
       UNION ALL
       SELECT c.id FROM nodes c JOIN subtree st ON c.parent_id = st.id
     )
     SELECT n.id, n.token_context
     FROM nodes n
     JOIN subtree st ON st.id = n.id
     WHERE n.status = 'done'
       AND COALESCE(n.kind, 'qa') = 'qa'
     ORDER BY n.created_at`,
  );
  const updateStmt = db.prepare(
    "UPDATE nodes SET token_context = ? WHERE id = ? AND token_context IS NULL",
  );

  for (const root of roots) {
    const cwd = sessionCwd(root.mode as Mode, root.workspace_path);
    const jsonl = findClaudeSessionPath(root.claude_session_id, cwd);
    if (!jsonl) continue;
    const parsed = parseCliSessionJsonl(jsonl);
    if (!parsed?.turns.length) continue;
    const nodes = subtreeStmt.all(root.root_id) as NodeRow[];
    const turns = [...parsed.turns].sort((a, b) => a.createdAt - b.createdAt);
    const limit = Math.min(nodes.length, turns.length);
    const tx = db.transaction(() => {
      for (let i = 0; i < limit; i++) {
        const contextTokens = turns[i].tokens.contextTokens;
        if (typeof contextTokens === "number" && contextTokens > 0) {
          updateStmt.run(contextTokens, nodes[i].id);
        }
      }
    });
    tx();
  }
}
