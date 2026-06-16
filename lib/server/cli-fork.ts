import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import { parseCliSessionJsonl } from "./cli-import";

type ContentBlock = {
  type: string;
  text?: string;
  tool_use_id?: string;
};

type RawEntry = {
  type: string;
  uuid?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
  timestamp?: string;
  sessionId?: string;
  message?: { role?: string; content?: string | ContentBlock[] };
  [key: string]: unknown;
};

type RawLine = {
  lineIndex: number;
  entry: RawEntry;
};

export type AttachedLineage = {
  lineageSid: string;
  sourceJsonlPath: string;
  isJsonlTip: boolean;
};

function ms(ts: string | undefined): number {
  if (!ts) return 0;
  const t = Date.parse(ts);
  return Number.isNaN(t) ? 0 : t;
}

function userText(e: RawEntry): string | null {
  const c = e.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const texts = c
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string);
    if (texts.length) return texts.join("\n");
  }
  return null;
}

function isToolResultEntry(e: RawEntry): boolean {
  const c = e.message?.content;
  return Array.isArray(c) && c.some((b) => b.type === "tool_result");
}

function isCommandNoise(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith("<command-name>") ||
    t.startsWith("<command-message>") ||
    t.startsWith("<local-command-") ||
    t.startsWith("<bash-input>") ||
    t.startsWith("<bash-stdout>") ||
    t.startsWith("Caveat:")
  );
}

function isTurnStart(e: RawEntry): boolean {
  if (e.type !== "user") return false;
  if (isToolResultEntry(e)) return false;
  const text = userText(e);
  if (!text || !text.trim()) return false;
  if (isCommandNoise(text)) return false;
  return true;
}

function readJsonl(jsonlPath: string): RawLine[] | null {
  let raw: string;
  try {
    raw = fs.readFileSync(jsonlPath, "utf8");
  } catch {
    return null;
  }
  const out: RawLine[] = [];
  const lines = raw.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    try {
      out.push({ lineIndex: i, entry: JSON.parse(line) as RawEntry });
    } catch {
      return null;
    }
  }
  return out;
}

function newestTurnId(jsonlPath: string): string | null {
  const parsed = parseCliSessionJsonl(jsonlPath);
  if (!parsed || parsed.turns.length === 0) return null;
  return [...parsed.turns].sort(
    (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
  )[0].id;
}

export function attachedLineageForNode(nodeId: string): AttachedLineage | null {
  const db = getDB();
  const node = db
    .prepare(
      `SELECT n.id, n.session_id, n.parent_id, n.claude_session_id, s.origin
       FROM nodes n
       JOIN sessions s ON s.id = n.session_id
       WHERE n.id = ?`,
    )
    .get(nodeId) as
    | {
        id: string;
        session_id: string;
        parent_id: string | null;
        claude_session_id: string | null;
        origin: string;
      }
    | undefined;
  if (!node || node.origin !== "cli-import") return null;

  let lineageSid = node.claude_session_id;
  let parentId = node.parent_id;
  const parentStmt = db.prepare(
    "SELECT parent_id, claude_session_id FROM nodes WHERE id = ?",
  );
  while (!lineageSid && parentId) {
    const parent = parentStmt.get(parentId) as
      | { parent_id: string | null; claude_session_id: string | null }
      | undefined;
    if (!parent) break;
    lineageSid = parent.claude_session_id;
    parentId = parent.parent_id;
  }
  if (!lineageSid) return null;

  const row = db
    .prepare(
      `SELECT jsonl_path
       FROM cli_lineages
       WHERE trellis_session_id = ? AND claude_session_id = ?`,
    )
    .get(node.session_id, lineageSid) as { jsonl_path: string } | undefined;
  if (!row) return null;

  const tipId = newestTurnId(row.jsonl_path);
  if (!tipId) return null;
  return {
    lineageSid,
    sourceJsonlPath: row.jsonl_path,
    isJsonlTip: tipId === nodeId,
  };
}

function ownerTurnFactory(rawLines: RawLine[]) {
  const byUuid = new Map<string, RawEntry>();
  for (const { entry } of rawLines) {
    if (typeof entry.uuid === "string") byUuid.set(entry.uuid, entry);
  }

  const turnOf = new Map<string, string | null>();
  function ownerTurn(uuid: string): string | null {
    const cached = turnOf.get(uuid);
    if (cached !== undefined) return cached;
    const e = byUuid.get(uuid);
    if (!e) {
      turnOf.set(uuid, null);
      return null;
    }
    turnOf.set(uuid, null);
    const owner = isTurnStart(e)
      ? e.uuid ?? null
      : e.parentUuid
        ? ownerTurn(e.parentUuid)
        : null;
    turnOf.set(uuid, owner);
    return owner;
  }

  function depth(uuid: string): number {
    const seen = new Set<string>();
    let cur: string | null | undefined = uuid;
    let n = 0;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      n++;
      cur = byUuid.get(cur)?.parentUuid;
    }
    return n;
  }

  return { byUuid, ownerTurn, depth };
}

function terminalAssistantLine(
  rawLines: RawLine[],
  turnId: string,
): RawLine | null {
  const { ownerTurn, depth } = ownerTurnFactory(rawLines);
  let best: RawLine | null = null;
  for (const line of rawLines) {
    const uuid = line.entry.uuid;
    if (
      typeof uuid !== "string" ||
      line.entry.type !== "assistant" ||
      line.entry.isSidechain === true ||
      ownerTurn(uuid) !== turnId
    ) {
      continue;
    }
    if (!best) {
      best = line;
      continue;
    }
    const d = depth(uuid);
    const bd = depth(best.entry.uuid as string);
    if (
      d > bd ||
      (d === bd && ms(line.entry.timestamp) > ms(best.entry.timestamp)) ||
      (d === bd &&
        ms(line.entry.timestamp) === ms(best.entry.timestamp) &&
        line.lineIndex > best.lineIndex)
    ) {
      best = line;
    }
  }
  return best;
}

function keepUuidChain(rawLines: RawLine[], tailUuid: string): Set<string> | null {
  const { byUuid } = ownerTurnFactory(rawLines);
  const keep = new Set<string>();
  let cur: string | null | undefined = tailUuid;
  while (cur) {
    if (keep.has(cur)) return null;
    keep.add(cur);
    cur = byUuid.get(cur)?.parentUuid;
  }
  return keep;
}

// X 在 trellis 树里是否已有「除了 exceptId 之外」的子节点。续聊时：tip 且无其他子
// → 线性 append；否则（非 tip 或已有子）→ 必须分叉，否则会污染该 lineage 的线性 jsonl。
export function hasOtherChild(parentId: string, exceptId: string): boolean {
  const db = getDB();
  const row = db
    .prepare(
      "SELECT 1 FROM nodes WHERE parent_id = ? AND id != ? LIMIT 1",
    )
    .get(parentId, exceptId);
  return Boolean(row);
}

// 登记一条 fork lineage（trellis 在 X 分叉造了新 jsonl）。幂等 upsert，与 watcher
// 的新 fork 检测共用 cli_lineages 表；is_root=0、synced_uuid=NULL 待首次 import 回填。
export function registerForkLineage(
  trellisSessionId: string,
  newSid: string,
  jsonlPath: string,
  forkPointUuid: string,
): void {
  const db = getDB();
  db.prepare(
    `INSERT INTO cli_lineages
       (trellis_session_id, claude_session_id, jsonl_path, fork_point_uuid, is_root, synced_uuid)
     VALUES (?, ?, ?, ?, 0, NULL)
     ON CONFLICT(trellis_session_id, claude_session_id) DO UPDATE SET
       jsonl_path = excluded.jsonl_path,
       fork_point_uuid = excluded.fork_point_uuid`,
  ).run(trellisSessionId, newSid, jsonlPath, forkPointUuid);
}

export function buildPrefixJsonl(
  branchFromNodeId: string,
): { newSid: string; jsonlPath: string } | null {
  const lineage = attachedLineageForNode(branchFromNodeId);
  if (!lineage) return null;
  const rawLines = readJsonl(lineage.sourceJsonlPath);
  if (!rawLines || rawLines.length === 0) return null;

  const tail = terminalAssistantLine(rawLines, branchFromNodeId);
  const tailUuid = tail?.entry.uuid;
  if (!tail || typeof tailUuid !== "string") return null;

  const keepUuids = keepUuidChain(rawLines, tailUuid);
  if (!keepUuids) return null;

  const newSid = crypto.randomUUID();
  const out: string[] = [];
  for (const line of rawLines) {
    if (line.lineIndex > tail.lineIndex) break;
    const uuid = line.entry.uuid;
    if (typeof uuid === "string" && !keepUuids.has(uuid)) continue;
    const entry: RawEntry = { ...line.entry };
    if (Object.prototype.hasOwnProperty.call(entry, "sessionId")) {
      entry.sessionId = newSid;
    }
    out.push(JSON.stringify(entry));
  }
  if (out.length === 0) return null;

  const jsonlPath = path.join(path.dirname(lineage.sourceJsonlPath), `${newSid}.jsonl`);
  fs.writeFileSync(jsonlPath, `${out.join("\n")}\n`, "utf8");
  return { newSid, jsonlPath };
}
