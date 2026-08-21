// CLI session 镜像的 DB 落地层（Stage A 收尾 + Stage B watcher 复用）。
// 把 cli-import.ts 解析出的节点树 upsert 进 trellis 的 sessions/nodes/search_index。
// 幂等：节点 id = CLI turn 的 uuid（确定性），重复同步走 ON CONFLICT 更新、不产重复行。
// 详见 progress/cli-sync.md。
import "server-only";
import { existsSync } from "node:fs";
import { getDB } from "./sqlite";
import { parseCliSessionJsonl } from "./cli-import";
import { parseCodexSessionJsonl } from "./codex-import";
import { ensureWorkspaceForPath } from "./workspaces";
import type { ParsedCliSession, ParsedTurn } from "./cli-import";

export type ImportResult = {
  sessionId: string;
  status: "imported" | "updated" | "skipped-native" | "unchanged" | "empty";
  turns: number;
};

// trellis 自己 spawn 的 claude/codex session id 全集 —— 用来在「发现」阶段跳过
// trellis 自有 jsonl（防回环）。务必排除 origin='cli-import' 的行，否则镜像 session
// 会把自己的源 id 也算进来。
export function trellisOwnedSessionIds(): Set<string> {
  const db = getDB();
  const rows = db
    .prepare(
      `SELECT n.claude_session_id AS cid, n.codex_session_id AS xid
       FROM nodes n
       JOIN sessions s ON s.id = n.session_id
       WHERE s.origin != 'cli-import'
         AND (n.claude_session_id IS NOT NULL OR n.codex_session_id IS NOT NULL)`,
    )
    .all() as { cid: string | null; xid: string | null }[];
  const set = new Set<string>();
  for (const r of rows) {
    if (r.cid) set.add(r.cid);
    if (r.xid) set.add(r.xid);
  }
  return set;
}

type LineageRow = {
  trellis_session_id: string;
  cli_session_id: string;
  provider_family: "claude" | "codex";
  jsonl_path: string;
  fork_point_uuid: string | null;
  is_root: number;
  synced_uuid: string | null;
};

type ParsedLineage = {
  row: LineageRow;
  parsed: ParsedCliSession;
};

function lineageRows(trellisSessionId: string): LineageRow[] {
  const db = getDB();
  return db
    .prepare(
      `SELECT trellis_session_id, cli_session_id, provider_family, jsonl_path,
              fork_point_uuid, is_root, synced_uuid
       FROM cli_lineages
       WHERE trellis_session_id = ?
       ORDER BY is_root DESC, jsonl_path`,
    )
    .all(trellisSessionId) as LineageRow[];
}

function parseLineages(rows: LineageRow[]): ParsedLineage[] {
  return parseLineagesChecked(rows).parsed;
}

// 「读不到」和「读到了但没内容」必须分开。前者意味着我们对这条 lineage 的
// turn 集合**一无所知** —— 拿这种残缺集合去做「不在集合里就删」的清理，会把整条
// lineage 的节点全剥掉（CLI transcript 过期 / 用户清理 / fork jsonl 被删都会走
// 到这里，不是理论风险）。所以解析失败必须能被调用方看见。
function parseLineagesChecked(rows: LineageRow[]): {
  parsed: ParsedLineage[];
  anyUnreadable: boolean;
} {
  const out: ParsedLineage[] = [];
  let anyUnreadable = false;
  for (const row of rows) {
    const parsed =
      row.provider_family === "codex"
        ? parseCodexSessionJsonl(row.jsonl_path)
        : parseCliSessionJsonl(row.jsonl_path);
    if (!parsed || parsed.turns.length === 0) {
      if (!existsSync(row.jsonl_path)) anyUnreadable = true;
      continue;
    }
    out.push({ row, parsed });
  }
  return { parsed: out, anyUnreadable };
}

function unionTurns(parsedRows: ParsedLineage[]): ParsedTurn[] {
  const byId = new Map<string, ParsedTurn>();
  for (const item of parsedRows) {
    for (const t of item.parsed.turns) {
      if (!byId.has(t.id)) byId.set(t.id, { ...t });
    }
  }
  const turns = [...byId.values()];
  const byParent = new Map<string | null, ParsedTurn[]>();
  for (const t of turns) {
    (byParent.get(t.parentId) ?? byParent.set(t.parentId, []).get(t.parentId)!).push(t);
  }
  for (const group of byParent.values()) {
    group.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    group.forEach((t, i) => (t.siblingIndex = i));
  }
  return turns.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
}

function lineageSidByTurn(parsedRows: ParsedLineage[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of parsedRows) {
    for (const t of item.parsed.turns) {
      if (!out.has(t.id)) out.set(t.id, item.row.cli_session_id);
    }
  }
  return out;
}

function nodesHaveLineageSids(
  db: ReturnType<typeof getDB>,
  trellisSessionId: string,
  expected: Map<string, string>,
  provider: "claude" | "codex",
): boolean {
  const column = provider === "codex" ? "codex_session_id" : "claude_session_id";
  const rows = db
    .prepare(`SELECT id, ${column} AS sid FROM nodes WHERE session_id = ?`)
    .all(trellisSessionId) as { id: string; sid: string | null }[];
  const actual = new Map(rows.map((row) => [row.id, row.sid]));
  for (const [turnId, lineageSid] of expected) {
    if (actual.get(turnId) !== lineageSid) return false;
  }
  return true;
}

function lineageNewestTurn(trellisSessionId: string): ParsedTurn | null {
  const rows = lineageRows(trellisSessionId);
  const parsedRows = parseLineages(rows);
  const turns = unionTurns(parsedRows);
  return turns.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id))[0] ?? null;
}

// 把一个 attached CLI lineage 组 union 镜像/更新进同一个 trellis session。
// 返回状态供调用方决定是否提示。
export function importCliLineage(trellisSessionId: string): ImportResult {
  const db = getDB();
  const rows = lineageRows(trellisSessionId);
  if (rows.length === 0) {
    return { sessionId: trellisSessionId, status: "empty", turns: 0 };
  }

  // 既有 native session 撞 id → 不碰（那是 trellis 自己的，绝不覆盖）。
  const existing = db
    .prepare("SELECT origin FROM sessions WHERE id = ?")
    .get(trellisSessionId) as { origin: string } | undefined;
  if (existing && existing.origin !== "cli-import") {
    return { sessionId: trellisSessionId, status: "skipped-native", turns: 0 };
  }

  const { parsed: parsedRows, anyUnreadable } = parseLineagesChecked(rows);
  if (parsedRows.length === 0) {
    return { sessionId: trellisSessionId, status: "empty", turns: 0 };
  }

  const turnLineageSids = lineageSidByTurn(parsedRows);
  const turns = unionTurns(parsedRows);
  const provider = parsedRows[0].row.provider_family;
  // 增量游标全命中 → 整组文件都没新增，跳过整个重写。
  const allUnchanged =
    parsedRows.length === rows.length &&
    parsedRows.every(
      ({ row, parsed }) => row.synced_uuid !== null && row.synced_uuid === parsed.lastUuid,
    ) &&
    nodesHaveLineageSids(db, trellisSessionId, turnLineageSids, provider);
  if (allUnchanged) {
    return {
      sessionId: trellisSessionId,
      status: "unchanged",
      turns: turns.length,
    };
  }

  const rootParsed =
    parsedRows.find((p) => p.row.is_root === 1) ??
    parsedRows[0];
  const rootPath = rootParsed.row.jsonl_path;
  const roots = turns
    .filter((t) => t.parentId === null)
    .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  const rootNodeId = (roots[0] ?? turns[0]).id;
  // attach 走 project 模式才能 resume 续聊（workspace 无状态、chat 无 cwd）。
  // 无 cwd 的会话退回 chat（只能浏览，续聊无意义）。
  const mode = rootParsed.parsed.cwd ? "project" : "chat";

  const hadNodes = Boolean(
    db.prepare("SELECT 1 FROM nodes WHERE session_id = ? LIMIT 1").get(trellisSessionId),
  );

  // S1 归组。事务外解析（可能 spawn git），失败只落「未归组」不影响导入。
  // 上面的 upsert 用 COALESCE 兜底，避免一次解析失败把已有归属清成 NULL。
  let workspaceId: string | null = null;
  if (rootParsed.parsed.cwd) {
    try {
      workspaceId = ensureWorkspaceForPath(rootParsed.parsed.cwd);
    } catch {
      workspaceId = null;
    }
  }

  const tx = db.transaction(() => {
    // ── session upsert（FK：必须先于 nodes）──────────────────────────────
    db.prepare(
      `INSERT INTO sessions
         (id, title, root_node_id, created_at, updated_at, context_mode,
          workspace_path, workspace_id, model, origin, source_jsonl_path,
          synced_uuid, cli_provider)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cli-import', ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         root_node_id = excluded.root_node_id,
         updated_at = excluded.updated_at,
         workspace_path = excluded.workspace_path,
         workspace_id = COALESCE(excluded.workspace_id, sessions.workspace_id),
         model = COALESCE(sessions.model, excluded.model),
         source_jsonl_path = excluded.source_jsonl_path,
         synced_uuid = excluded.synced_uuid,
         cli_provider = excluded.cli_provider`,
    ).run(
      trellisSessionId,
      rootParsed.parsed.title,
      rootNodeId,
      rootParsed.parsed.createdAt,
      rootParsed.parsed.updatedAt,
      mode,
      rootParsed.parsed.cwd,
      workspaceId,
      provider === "codex" ? "codex" : null,
      rootPath,
      rootParsed.parsed.lastUuid,
      provider,
    );

    // 每个节点记录所属 CLI lineage。共享祖先由 root lineage 首先占有，fork 独有
    // turn 归各自 fork lineage；attached 续聊/分叉据此定位源 jsonl。
    const upsertNode = db.prepare(
      `INSERT INTO nodes
         (id, session_id, parent_id, parent_anchor_text, question, response,
          status, error_message, sibling_index, token_input, token_output,
          token_cache_read, token_cache_creation, token_context, created_at, duration_ms,
          kind, tool_calls_json, claude_session_id, codex_session_id,
          cli_turn_uuid, codex_turn_ordinal, final_start)
       VALUES (?, ?, ?, NULL, ?, ?, 'done', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 'qa', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         session_id = excluded.session_id,
         parent_id = excluded.parent_id,
         question = excluded.question,
         response = excluded.response,
         sibling_index = excluded.sibling_index,
         token_input = excluded.token_input,
         token_output = excluded.token_output,
         token_cache_read = excluded.token_cache_read,
         token_cache_creation = excluded.token_cache_creation,
         token_context = excluded.token_context,
         duration_ms = excluded.duration_ms,
         tool_calls_json = excluded.tool_calls_json,
         claude_session_id = excluded.claude_session_id,
         codex_session_id = excluded.codex_session_id,
         cli_turn_uuid = excluded.cli_turn_uuid,
         codex_turn_ordinal = excluded.codex_turn_ordinal,
         final_start = excluded.final_start`,
    );

    const ftsDel = db.prepare(
      "DELETE FROM search_index WHERE source_id = ? AND source_kind IN ('node_question','node_response')",
    );
    const ftsIns = db.prepare(
      "INSERT INTO search_index (text, source_kind, source_id, session_id) VALUES (?, ?, ?, ?)",
    );

    for (const t of turns) {
      upsertNode.run(
        t.id,
        trellisSessionId,
        t.parentId,
        t.question,
        t.response,
        t.siblingIndex,
        t.tokens.input,
        t.tokens.output,
        t.tokens.cacheRead,
        t.tokens.cacheCreation,
        t.tokens.contextTokens,
        t.createdAt,
        t.durationMs ?? null,
        t.toolCalls.length ? JSON.stringify(t.toolCalls) : null,
        provider === "claude"
          ? (turnLineageSids.get(t.id) ?? trellisSessionId)
          : null,
        provider === "codex"
          ? (turnLineageSids.get(t.id) ?? trellisSessionId)
          : null,
        provider === "claude" ? t.id : null,
        provider === "codex" ? (t.turnOrdinal ?? null) : null,
        t.finalStart || null,
      );
      // 重建该节点的全文索引（先删后插，幂等）。
      ftsDel.run(t.id);
      if (t.question.trim())
        ftsIns.run(t.question, "node_question", t.id, trellisSessionId);
      if (t.response.trim())
        ftsIns.run(t.response, "node_response", t.id, trellisSessionId);
    }

    // 清理「上一版解析建出、这一版不再认可」的节点（判据变更后残留的假 turn，
    // 它们带着当年被劫走的那份回复，和现在归位到真 turn 的那份重复）。
    // 这是**删用户可见数据**，四道闸缺一不可：
    //   id 出现在 jsonl 的 entry uuid 集合里 —— 「这节点当年就是从这个 jsonl 建出来
    //     的」。import 建的节点 id 恒等于某条 entry 的 uuid；trellis 自己建的节点 id
    //     是本地生成的 v4，绝不在里面。**绝不能用 claude_session_id 代替**：
    //     attached 会话里从非 tip 分叉时，chat/route.ts 的 setNodeResumeId 会给
    //     trellis 的临时节点写上 sid，而 reconcileAttachedTurn 只在 run 正常 done 时
    //     兜底 —— 用 sid 当判据会删掉用户打断的那一轮里他自己敲的问题。
    //     （也比 cli_turn_uuid 强：那列是这次才开始写的，存量节点没有。）
    //   status != 'streaming' —— 不碰正在跑的 run
    //   无子节点 —— 上面 upsert 已把真子 turn 的 parent 提升走；还挂着孩子说明用户
    //     在它上面分叉过，保守放过
    //   !anyUnreadable —— 有 lineage 的 jsonl 读不到时，turnIdSet 是残缺的，
    //     「不在集合里就删」会把那条 lineage 的节点整片剥掉。transcript 过期 / 用户
    //     清理 jsonl 都会走到这儿，而 v1 迁移作废游标后每个 attached 会话都要重导
    //     一次 —— 没这道闸，升级后第一次启动就是一次批量销毁。
    if (!anyUnreadable) {
      const turnIdSet = new Set(turns.map((t) => t.id));
      const jsonlUuids = new Set<string>();
      for (const item of parsedRows) {
        for (const u of item.parsed.entryUuids) jsonlUuids.add(u);
      }
      const staleLeaves = db.prepare(
        `SELECT id FROM nodes
         WHERE session_id = ?
           AND status != 'streaming'
           AND NOT EXISTS (SELECT 1 FROM nodes c WHERE c.parent_id = nodes.id)`,
      );
      const delNode = db.prepare("DELETE FROM nodes WHERE id = ?");
      // 从叶子往上逐层剥。假 turn 会串成链（旧解析里 A假 → B假 → 真），一轮只能
      // 删掉当时的叶子 B；A 那时还挂着 B 当孩子，得等下一轮才轮到它。每轮至少删
      // 一个，删不动就退出，不会空转。
      for (;;) {
        const batch = (staleLeaves.all(trellisSessionId) as { id: string }[])
          .filter((r) => jsonlUuids.has(r.id) && !turnIdSet.has(r.id));
        if (batch.length === 0) break;
        for (const r of batch) {
          ftsDel.run(r.id);
          delNode.run(r.id);
        }
      }
    }

    const updateCursor = db.prepare(
      `UPDATE cli_lineages
       SET synced_uuid = ?
       WHERE trellis_session_id = ? AND cli_session_id = ?`,
    );
    for (const item of parsedRows) {
      updateCursor.run(
        item.parsed.lastUuid,
        trellisSessionId,
        item.row.cli_session_id,
      );
    }
  });
  tx();

  return {
    sessionId: trellisSessionId,
    status: hadNodes ? "updated" : "imported",
    turns: turns.length,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// 身份对账（Stage 2，progress/cli-sync.md）：trellis 在 attach 的会话里续聊完一轮后，
// claude 已把这轮写进 jsonl（canonical uuid），但 trellis 流式时建的是临时 nid 节点。
// 二者同一轮，会双份。对账 = 轮询 import 直到 canonical 节点落库 → 删临时节点。
// 自包含、不依赖 watcher、对竞态幂等（watcher 若也 import 了，canonical 已在，照删临时）。
// 返回 sessionId（供 run-bus 广播客户端重载）；非 attached / 该轮没落 jsonl → 返回 null。
export async function reconcileAttachedTurn(
  provisionalNodeId: string,
): Promise<string | null> {
  const db = getDB();
  const node = db
    .prepare("SELECT session_id FROM nodes WHERE id = ?")
    .get(provisionalNodeId) as { session_id: string } | undefined;
  if (!node) return null;
  const session = db
    .prepare(
      "SELECT origin FROM sessions WHERE id = ?",
    )
    .get(node.session_id) as
    | { origin: string }
    | undefined;
  if (!session || session.origin !== "cli-import") return null;

  // 轮询：每轮先 import（幂等，把 jsonl 里已出现的新轮变成 canonical 节点），再看
  // canonical 节点（≠ 临时 nid）是否已落库。done 后 claude 已写 jsonl，通常 1-2 轮命中。
  for (let i = 0; i < 8; i++) {
    importCliLineage(node.session_id);
    const newest = lineageNewestTurn(node.session_id);
    if (newest && newest.id !== provisionalNodeId) {
      const landed = db.prepare("SELECT 1 FROM nodes WHERE id = ?").get(newest.id);
      if (landed) {
        // canonical 已在 → 删临时节点（它没 children：刚续聊的 leaf；也没设
        // claude_session_id：project 只有根设，故删它不会触发 jsonl 清理）。
        const tx = db.transaction(() => {
          db.prepare("DELETE FROM search_index WHERE source_id = ?").run(
            provisionalNodeId,
          );
          db.prepare("DELETE FROM nodes WHERE id = ?").run(provisionalNodeId);
        });
        tx();
        return node.session_id;
      }
    }
    await sleep(300);
  }
  return null; // 超时仍没落 jsonl（极少）：留临时节点，下次 reload 由 watcher 兜底
}
