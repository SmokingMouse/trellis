import "server-only";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getDB } from "./sqlite";
import { parseCliSessionJsonl } from "./cli-import";
import {
  getSession,
  getRootResumeIdForNode,
  claudeSessionPath,
  isLineageIsolated,
} from "./repo";

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

// 「在 CLI 继续」轻量入口（progress/cli-branch-alignment.md §7）：project 模式会话
// 本就是真 claude CLI 会话——给出在 CLI 续该节点 lineage 的 cwd + resume id。
// attached（cli-import）取该节点的 lineage sid（验源 jsonl 在盘）；native project 走
// getRootResumeIdForNode（其自带 jsonl 存在性自愈，缺失返回 null=不可续）。
// 仅 project 模式（有 cwd 才可 resume）；chat/workspace 返回 null。续到的是该 lineage 的
// 主链 tip（CLI --resume 本就只跟主链——树内分叉走 P2 的前缀 jsonl，不在本入口范围）。
export function cliResumeForNode(
  nodeId: string,
): { cwd: string; resumeId: string } | null {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(nodeId) as { session_id: string } | undefined;
  if (!node) return null;
  const session = getSession(node.session_id);
  if (!session || session.mode !== "project" || !session.workspacePath) {
    return null;
  }
  if (session.origin === "cli-import") {
    const lin = attachedLineageForNode(nodeId);
    if (!lin || !fs.existsSync(lin.sourceJsonlPath)) return null;
    return { cwd: session.workspacePath, resumeId: lin.lineageSid };
  }
  // isolated（per-lineage）native 会话：续到该节点所属 lineage（fork 分支各有
  // 自己的 sid，root sid 只覆盖主 lineage）；legacy 会话维持 root sid 旧路径。
  if (isLineageIsolated(session.id)) {
    const lin = nativeLineageForNode(nodeId, session.workspacePath);
    if (!lin) return null;
    return { cwd: session.workspacePath, resumeId: lin.lineageSid };
  }
  const resumeId = getRootResumeIdForNode(nodeId, "claude", session.workspacePath);
  if (!resumeId) return null;
  return { cwd: session.workspacePath, resumeId };
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

// 前缀构造核心：在 sourceJsonl 里以 turnUuid（turn-start user entry uuid）为分叉点，
// 截出 root→该 turn 末条 assistant 的 uuid 链，改写 sessionId 为新 sid 写同目录
// `<newSid>.jsonl`。attached 与 native isolated（per-lineage）两条路共用——前者
// 节点 id 即 turn uuid，后者经 nodes.cli_turn_uuid 映射。
export function buildPrefixJsonlCore(
  sourceJsonlPath: string,
  turnUuid: string,
): { newSid: string; jsonlPath: string } | null {
  const rawLines = readJsonl(sourceJsonlPath);
  if (!rawLines || rawLines.length === 0) return null;

  const tail = terminalAssistantLine(rawLines, turnUuid);
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

  const jsonlPath = path.join(path.dirname(sourceJsonlPath), `${newSid}.jsonl`);
  fs.writeFileSync(jsonlPath, `${out.join("\n")}\n`, "utf8");
  return { newSid, jsonlPath };
}

export function buildPrefixJsonl(
  branchFromNodeId: string,
): { newSid: string; jsonlPath: string } | null {
  const lineage = attachedLineageForNode(branchFromNodeId);
  if (!lineage) return null;
  return buildPrefixJsonlCore(lineage.sourceJsonlPath, branchFromNodeId);
}

// ── native per-lineage（progress/project-lineage-isolation-spec.md）──────────
// attachedLineageForNode 的 native 版：origin='native' 的 isolated project 会话里，
// lineage 头节点（root / fork 节点）在自己行上持有 claude_session_id，线性子节点
// walk-up 解析归属；jsonl 路径由 claudeSessionPath(sid, spawnCwd) 确定性推导，
// 不经 cli_lineages（那是 attach-sync 域）。

export type NativeLineage = {
  lineageSid: string;
  jsonlPath: string;
  // 该节点的 turn 在 lineage jsonl 里的 uuid（nodes.cli_turn_uuid）。NULL =
  // 回填缺失 → 调用方在该点分叉须降级线性 resume。
  nodeTurnUuid: string | null;
  isJsonlTip: boolean;
};

export function nativeLineageForNode(
  nodeId: string,
  spawnCwd: string | null,
): NativeLineage | null {
  const db = getDB();
  const node = db
    .prepare(
      "SELECT parent_id, claude_session_id, cli_turn_uuid FROM nodes WHERE id = ?",
    )
    .get(nodeId) as
    | {
        parent_id: string | null;
        claude_session_id: string | null;
        cli_turn_uuid: string | null;
      }
    | undefined;
  if (!node) return null;

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

  const jsonlPath = claudeSessionPath(lineageSid, spawnCwd);
  if (!fs.existsSync(jsonlPath)) return null;
  const tipId = newestTurnId(jsonlPath);
  return {
    lineageSid,
    jsonlPath,
    nodeTurnUuid: node.cli_turn_uuid,
    isJsonlTip: node.cli_turn_uuid !== null && tipId === node.cli_turn_uuid,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// done 后回填该 native isolated 节点的 turn uuid（run-bus 钩子，best-effort）。
// jsonl 落盘略滞后于 done 事件（与 reconcileAttachedTurn 同时序）→ 轮询 ≤8×300ms。
// 防错配闸：最新 turn 的 question 必须包含节点 question（project prompt = 原文或
// anchor 包裹原文，contains 恒成立；skill 命令轮会被解析器滤成噪音则匹配不上）——
// 匹配不上就放弃：错误的 uuid 会让分叉切错位置，缺失只是降级线性，后者严格更安全。
export async function backfillNativeTurnUuid(nodeId: string): Promise<void> {
  const db = getDB();
  const row = db
    .prepare(
      `SELECT n.question, n.cli_turn_uuid, s.origin, s.context_mode AS mode,
              s.workspace_path AS wp, s.lineage_isolation AS iso
       FROM nodes n JOIN sessions s ON s.id = n.session_id
       WHERE n.id = ?`,
    )
    .get(nodeId) as
    | {
        question: string;
        cli_turn_uuid: string | null;
        origin: string;
        mode: string;
        wp: string | null;
        iso: number;
      }
    | undefined;
  if (
    !row ||
    row.cli_turn_uuid !== null ||
    row.origin !== "native" ||
    row.mode !== "project" ||
    row.iso !== 1
  ) {
    return;
  }

  const q = row.question.trim();
  for (let i = 0; i < 8; i++) {
    // project 的 spawnCwd 恒 = workspace_path（sessionCwd 只对 chat 改道 scratch）。
    const lin = nativeLineageForNode(nodeId, row.wp);
    if (lin) {
      const parsed = parseCliSessionJsonl(lin.jsonlPath);
      if (parsed && parsed.turns.length > 0) {
        const newest = [...parsed.turns].sort(
          (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
        )[0];
        if (!q || newest.question.includes(q)) {
          db.prepare(
            "UPDATE nodes SET cli_turn_uuid = ? WHERE id = ? AND cli_turn_uuid IS NULL",
          ).run(newest.id, nodeId);
          return;
        }
      }
    }
    await sleep(300);
  }
}
