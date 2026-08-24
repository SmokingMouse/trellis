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
import { codexLineageForNode } from "./codex-fork";
// jsonl 读取与 turn 归属全部走 ./cli-jsonl —— 与 cli-import 同一份实现。
// 这里曾经有一套自己抄的副本（userText / isToolResultEntry / isCommandNoise /
// isTurnStart / ms），import 侧后来长出 5 道结构闸而这份没跟，导致 fork 在一条
// 自己认不出边界的 turn 上截前缀。事故与实测数字记在 ./cli-jsonl 头部。
import {
  type CliRawEntry,
  keepUuidChain,
  readJsonlLines,
  terminalAssistantLine,
} from "./cli-jsonl";
import { providerFamily, DEFAULT_PROVIDER } from "@/lib/llm";

export type AttachedLineage = {
  lineageSid: string;
  sourceJsonlPath: string;
  isJsonlTip: boolean;
};

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
       WHERE trellis_session_id = ? AND cli_session_id = ?
         AND provider_family = 'claude'`,
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
// 仅 project 模式（有 cwd 才可 resume）；chat 返回 null。续到的是该 lineage 的
// 主链 tip（CLI --resume 本就只跟主链——树内分叉走 P2 的前缀 jsonl，不在本入口范围）。
export function cliResumeForNode(
  nodeId: string,
): { cwd: string; resumeId: string; family: "claude" | "codex" } | null {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(nodeId) as { session_id: string } | undefined;
  if (!node) return null;
  const session = getSession(node.session_id);
  if (!session || session.mode !== "project" || !session.workspacePath) {
    return null;
  }
  // codex 系 project：rollout 就是真 codex CLI 会话，出 `codex resume <sid>`。
  // attach（cli-import）是 claude 专属域，codex 不会有。
  const family = providerFamily(session.model ?? DEFAULT_PROVIDER);
  if (family === "codex") {
    const resumeId =
      session.origin === "cli-import" || isLineageIsolated(session.id)
      ? codexLineageForNode(nodeId)?.lineageSid ?? null
      : getRootResumeIdForNode(nodeId, "codex", session.workspacePath);
    if (!resumeId) return null;
    return { cwd: session.workspacePath, resumeId, family: "codex" };
  }
  if (session.origin === "cli-import") {
    const lin = attachedLineageForNode(nodeId);
    if (!lin || !fs.existsSync(lin.sourceJsonlPath)) return null;
    return { cwd: session.workspacePath, resumeId: lin.lineageSid, family: "claude" };
  }
  // isolated（per-lineage）native 会话：续到该节点所属 lineage（fork 分支各有
  // 自己的 sid，root sid 只覆盖主 lineage）；legacy 会话维持 root sid 旧路径。
  if (isLineageIsolated(session.id)) {
    const lin = nativeLineageForNode(nodeId, session.workspacePath);
    if (!lin) return null;
    return { cwd: session.workspacePath, resumeId: lin.lineageSid, family: "claude" };
  }
  const resumeId = getRootResumeIdForNode(nodeId, "claude", session.workspacePath);
  if (!resumeId) return null;
  return { cwd: session.workspacePath, resumeId, family: "claude" };
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
  provider: "claude" | "codex" = "claude",
): void {
  const db = getDB();
  db.prepare(
    `INSERT INTO cli_lineages
       (trellis_session_id, cli_session_id, provider_family, jsonl_path,
        fork_point_uuid, is_root, synced_uuid)
     VALUES (?, ?, ?, ?, ?, 0, NULL)
     ON CONFLICT(trellis_session_id, cli_session_id) DO UPDATE SET
       provider_family = excluded.provider_family,
       jsonl_path = excluded.jsonl_path,
       fork_point_uuid = excluded.fork_point_uuid`,
  ).run(trellisSessionId, newSid, provider, jsonlPath, forkPointUuid);
}

// 前缀构造核心：在 sourceJsonl 里以 turnUuid（turn-start user entry uuid）为分叉点，
// 截出 root→该 turn 末条 assistant 的 uuid 链，改写 sessionId 为新 sid 写同目录
// `<newSid>.jsonl`。attached 与 native isolated（per-lineage）两条路共用——前者
// 节点 id 即 turn uuid，后者经 nodes.cli_turn_uuid 映射。
export function buildPrefixJsonlCore(
  sourceJsonlPath: string,
  turnUuid: string,
): { newSid: string; jsonlPath: string } | null {
  const rawLines = readJsonlLines(sourceJsonlPath);
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
    const entry: CliRawEntry = { ...line.entry };
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
  // 回填缺失 → 调用方在该点分叉须安全降级为起 fresh 独立 session 并由 DB 历史折叠供给上下文。
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
// 防错配闸：在逆序（最新优先）轮次中寻找 question 包含节点 question 的 turn
// （project prompt = 原文或 anchor 包裹原文，contains 恒成立；skill 命令轮会被解析器滤成噪音则匹配不上）——
// 匹配不上就放弃：错误的 uuid 会让分叉切错位置；缺失只是降级 fresh+DB 历史折叠，严格更安全。
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
        const sortedTurns = [...parsed.turns].sort(
          (a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id),
        );
        const match = q
          ? sortedTurns.find((t) => t.question.includes(q))
          : sortedTurns[0];
        if (match) {
          db.prepare(
            "UPDATE nodes SET cli_turn_uuid = ? WHERE id = ? AND cli_turn_uuid IS NULL",
          ).run(match.id, nodeId);
          return;
        }
      }
    }
    await sleep(300);
  }
}
