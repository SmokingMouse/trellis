import "server-only";
import type { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { HerdrAgent, HerdrPane } from "./herdr-types";
import { getDB } from "./sqlite";

export type HerdrSessionBinding = {
  sessionId: string;
  trellisSessionId: string;
  sessionSource: string;
  sessionKind: string;
  agentKind: string;
  paneId: string;
  terminalId: string;
  workspaceId: string;
  tabId: string;
  label: string | null;
  agentName: string | null;
  cwd: string | null;
  transcriptPath: string | null;
  agentStatus: string;
  revision: number;
  stateChangeSeq: number | null;
  firstSeenAt: number;
  lastSeenAt: number;
  alive: boolean;
};

type BindingRow = {
  session_id: string;
  trellis_session_id?: string;
  session_source: string;
  session_kind: string;
  agent_kind: string;
  pane_id: string;
  terminal_id: string;
  workspace_id: string;
  tab_id: string;
  label: string | null;
  agent_name: string | null;
  cwd: string | null;
  transcript_path: string | null;
  agent_status: string;
  revision: number;
  state_change_seq: number | null;
  first_seen_at: number;
  last_seen_at: number;
  alive: number;
};

type ReconcileOptions = {
  db?: Database;
  home?: string;
  now?: number;
  attachClaude?: (transcriptPath: string) => void;
  attachTranscript?: (transcriptPath: string, agentKind: string) => void;
};

export function claudeProjectSlug(cwd: string): string {
  return [...cwd].map((char) => (/[A-Za-z0-9-]/.test(char) ? char : "-")).join("");
}

function listClaudeMatches(home: string, sessionId: string): string[] {
  const root = path.join(home, ".claude", "projects");
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(root, entry.name, `${sessionId}.jsonl`))
      .filter((candidate) => fs.existsSync(candidate));
  } catch {
    return [];
  }
}

function listCodexMatches(home: string, sessionId: string): string[] {
  const root = path.join(home, ".codex", "sessions");
  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const candidate = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (
        entry.isFile() &&
        entry.name.startsWith("rollout-") &&
        entry.name.endsWith(`-${sessionId}.jsonl`)
      ) {
        matches.push(candidate);
      }
    }
  }
  return matches;
}

export function transcriptCwd(
  agentKind: string,
  transcriptPath: string,
): string | null {
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const buffer = Buffer.alloc(8 * 1024);
    const decoder = new StringDecoder("utf8");
    let pending = "";
    const cwdFromLine = (line: string): string | null => {
      try {
        const entry = JSON.parse(line) as { cwd?: unknown; payload?: { cwd?: unknown } };
        const cwd = agentKind === "codex" ? entry.payload?.cwd : entry.cwd;
        return typeof cwd === "string" ? cwd : null;
      } catch { return null; }
    };
    // cwd is header metadata. Bound corrupt/no-header files as well as reads
    // of valid multi-megabyte sessions; never materialize the entire transcript.
    for (let consumed = 0; consumed < 1024 * 1024;) {
      const read = fs.readSync(fd, buffer, 0, buffer.length, null);
      consumed += read;
      if (!read) return cwdFromLine(pending + decoder.end());
      pending += decoder.write(buffer.subarray(0, read));
      let newline: number;
      while ((newline = pending.indexOf("\n")) >= 0) {
        const cwd = cwdFromLine(pending.slice(0, newline));
        if (cwd !== null) return cwd;
        pending = pending.slice(newline + 1);
      }
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

const transcriptMisses = new Map<string, number>();
const TRANSCRIPT_MISS_TTL_MS = 5_000;

export function resolveTranscriptPath(
  pane: HerdrPane,
  home = os.homedir(),
  now = Date.now(),
): string | null {
  const session = pane.agent_session;
  if (!session) return null;
  const agentKind = pane.agent ?? session.agent;
  const key = JSON.stringify([home, agentKind, session.kind, session.value, pane.cwd]);
  if ((transcriptMisses.get(key) ?? 0) > now) return null;
  const miss = () => {
    for (const [key, until] of transcriptMisses) if (until <= now) transcriptMisses.delete(key);
    if (transcriptMisses.size >= 1024) transcriptMisses.delete(transcriptMisses.keys().next().value!);
    transcriptMisses.set(key, now + TRANSCRIPT_MISS_TTL_MS);
    return null;
  };
  let candidate: string | null = null;
  if (session.kind === "path") {
    candidate = path.resolve(session.value);
  } else if (agentKind === "claude") {
    const matches = listClaudeMatches(home, session.value);
    if (matches.length === 1) candidate = matches[0];
    else if (pane.cwd) {
      const fallback = path.join(
        home,
        ".claude",
        "projects",
        claudeProjectSlug(pane.cwd),
        `${session.value}.jsonl`,
      );
      if (fs.existsSync(fallback)) candidate = fallback;
    }
  } else if (agentKind === "codex") {
    const matches = listCodexMatches(home, session.value);
    if (matches.length === 1) candidate = matches[0];
  }
  if (!candidate || !fs.existsSync(candidate)) return miss();
  const recordedCwd = transcriptCwd(agentKind, candidate);
  if (pane.cwd && recordedCwd !== pane.cwd) return miss();
  transcriptMisses.delete(key);
  return candidate;
}

function rowToBinding(row: BindingRow): HerdrSessionBinding {
  return {
    sessionId: row.session_id,
    trellisSessionId: row.trellis_session_id ?? row.session_id,
    sessionSource: row.session_source,
    sessionKind: row.session_kind,
    agentKind: row.agent_kind,
    paneId: row.pane_id,
    terminalId: row.terminal_id,
    workspaceId: row.workspace_id,
    tabId: row.tab_id,
    label: row.label,
    agentName: row.agent_name,
    cwd: row.cwd,
    transcriptPath: row.transcript_path,
    agentStatus: row.agent_status,
    revision: row.revision,
    stateChangeSeq: row.state_change_seq,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    alive: row.alive === 1,
  };
}

export function listHerdrBindings(db: Database = getDB()): HerdrSessionBinding[] {
  return (db
    .prepare(`SELECT h.*, l.trellis_session_id FROM herdr_sessions h
      LEFT JOIN cli_lineages l ON l.cli_session_id = h.session_id
      ORDER BY h.alive DESC, h.last_seen_at DESC`)
    .all() as BindingRow[]).map(rowToBinding);
}

export function getHerdrBinding(
  sessionId: string,
  db: Database = getDB(),
): HerdrSessionBinding | null {
  const row = db
    .prepare(`SELECT h.*, l.trellis_session_id FROM herdr_sessions h
      LEFT JOIN cli_lineages l ON l.cli_session_id = h.session_id
      WHERE h.session_id = ? OR l.trellis_session_id = ?
      ORDER BY h.alive DESC, h.last_seen_at DESC LIMIT 1`)
    .get(sessionId, sessionId) as BindingRow | undefined;
  return row ? rowToBinding(row) : null;
}

export function hasAliveHerdrBinding(sessionId: string, db: Database = getDB()): boolean {
  return !!db.prepare(`SELECT 1 FROM herdr_sessions h
    JOIN cli_lineages l ON l.cli_session_id = h.session_id
    WHERE l.trellis_session_id = ? AND h.alive = 1
    UNION SELECT 1 FROM herdr_sessions WHERE session_id = ? AND alive = 1`).get(sessionId, sessionId);
}

export function markHerdrPaneClosed(
  paneId: string,
  db: Database = getDB(),
  now = Date.now(),
): void {
  db.prepare(
    "UPDATE herdr_sessions SET alive = 0, last_seen_at = ? WHERE pane_id = ?",
  ).run(now, paneId);
}

export function reconcileHerdrPane(
  pane: HerdrPane,
  agent?: HerdrAgent,
  options: ReconcileOptions = {},
): HerdrSessionBinding | null {
  const session = pane.agent_session;
  if (!session?.value) return null;
  const db = options.db ?? getDB();
  const now = options.now ?? Date.now();
  const agentKind = pane.agent ?? session.agent;
  // Pane reconciliation is keyed by the exact reported CLI sid; lineage
  // resolution is only for callers starting from a Trellis session id.
  const existingRow = db.prepare("SELECT * FROM herdr_sessions WHERE session_id = ?").get(session.value) as BindingRow | undefined;
  const existing = existingRow ? rowToBinding(existingRow) : null;
  const cachedPath = existing?.transcriptPath;
  const transcriptPath =
    cachedPath &&
    fs.existsSync(cachedPath) &&
    (!pane.cwd || transcriptCwd(agentKind, cachedPath) === pane.cwd)
      ? cachedPath
      : resolveTranscriptPath(pane, options.home);
  db.prepare(
    `INSERT INTO herdr_sessions
       (session_id, session_source, session_kind, agent_kind, pane_id,
        terminal_id, workspace_id, tab_id, label, agent_name, cwd,
        transcript_path, agent_status, revision, state_change_seq,
        first_seen_at, last_seen_at, alive)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
     ON CONFLICT(session_id) DO UPDATE SET
       session_source = excluded.session_source,
       session_kind = excluded.session_kind,
       agent_kind = excluded.agent_kind,
       pane_id = excluded.pane_id,
       terminal_id = excluded.terminal_id,
       workspace_id = excluded.workspace_id,
       tab_id = excluded.tab_id,
       label = excluded.label,
       agent_name = excluded.agent_name,
       cwd = excluded.cwd,
       transcript_path = excluded.transcript_path,
       agent_status = excluded.agent_status,
       revision = excluded.revision,
       state_change_seq = excluded.state_change_seq,
       last_seen_at = excluded.last_seen_at,
       alive = 1`,
  ).run(
    session.value,
    session.source,
    session.kind,
    agentKind,
    pane.pane_id,
    pane.terminal_id,
    pane.workspace_id,
    pane.tab_id,
    pane.label ?? null,
    agent?.name ?? null,
    pane.cwd ?? null,
    transcriptPath,
    pane.agent_status,
    pane.revision,
    agent?.state_change_seq ?? null,
    now,
    now,
  );
  if (transcriptPath) {
    if (options.attachTranscript) {
      options.attachTranscript(transcriptPath, agentKind);
    } else if (agentKind === "claude") {
      options.attachClaude?.(transcriptPath);
    }
  }
  const row = db.prepare(`SELECT h.*, l.trellis_session_id FROM herdr_sessions h
    LEFT JOIN cli_lineages l ON l.cli_session_id = h.session_id WHERE h.session_id = ?`).get(session.value) as BindingRow;
  return rowToBinding(row);
}

export function reconcileHerdrSnapshot(
  panes: HerdrPane[],
  agents: HerdrAgent[],
  options: ReconcileOptions = {},
): HerdrSessionBinding[] {
  const db = options.db ?? getDB();
  const now = options.now ?? Date.now();
  const livePaneIds = new Set(panes.map((pane) => pane.pane_id));
  for (const pane of panes) {
    reconcileHerdrPane(pane, agents.find((agent) => agent.pane_id === pane.pane_id), {
      ...options,
      db,
      now,
    });
  }
  const rows = db.prepare("SELECT DISTINCT pane_id FROM herdr_sessions WHERE alive = 1").all() as {
    pane_id: string;
  }[];
  const close = db.prepare(
    "UPDATE herdr_sessions SET alive = 0, last_seen_at = ? WHERE pane_id = ?",
  );
  for (const row of rows) {
    if (!livePaneIds.has(row.pane_id)) close.run(now, row.pane_id);
  }
  return listHerdrBindings(db);
}

export async function attachHerdrTranscript(
  transcriptPath: string,
  agentKind: string,
): Promise<void> {
  if (agentKind !== "claude" && agentKind !== "codex") return;
  const { attachSession } = await import("./cli-sync-watcher");
  attachSession(transcriptPath, agentKind, { origin: "herdr" });
}
