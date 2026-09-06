import "server-only";
import { LARK_THREAD_TABLES_SQL } from "@/lib/server/lark/protocol";
import { Database } from "bun:sqlite";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { BUILTIN_AGENT_SEEDS } from "@/lib/agent-presets";

const DB_DIR = path.join(os.homedir(), ".trellis");
const DB_PATH = path.join(DB_DIR, "data.db");

let _db: Database | null = null;

function dbPath(): string {
  return process.env.TRELLIS_DB_PATH || DB_PATH;
}

export function getDB(): Database {
  if (_db) return _db;
  const file = dbPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  migrate(db);
  _db = db;
  return db;
}

function migrate(db: Database) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      root_node_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_updated_at ON sessions(updated_at);

    CREATE TABLE IF NOT EXISTS nodes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      parent_id TEXT,
      parent_anchor_text TEXT,
      question TEXT NOT NULL,
      response TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'streaming',
      error_message TEXT,
      sibling_index INTEGER NOT NULL DEFAULT 0,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS nodes_session ON nodes(session_id);
    CREATE INDEX IF NOT EXISTS nodes_parent ON nodes(parent_id);
  `);

  // Idempotent column add for project mode: each trellis session may bind
  // to one claude CLI session id (null in chat).
  // Legacy: this column was authoritative pre-2026-05. After the per-root
  // upgrade, claude_session_id moved to nodes.claude_session_id (see below);
  // this column stays for backfill source + historical readability but is
  // no longer read at runtime.
  const hasClaudeSessionId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'claude_session_id'",
    )
    .get();
  if (!hasClaudeSessionId) {
    db.exec("ALTER TABLE sessions ADD COLUMN claude_session_id TEXT");
  }

  // Per-root claude session id. Each root node (parent_id IS NULL, kind='qa')
  // in a project-mode session owns its own claude CLI session — so canvas
  // "新提问" gives the user a fresh context without losing the existing
  // tree's memory. Branches walk up to their root to find which claude
  // session to --resume. NULL on chat roots and on every branch.
  const hasNodeClaudeId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'claude_session_id'",
    )
    .get();
  if (!hasNodeClaudeId) {
    db.exec("ALTER TABLE nodes ADD COLUMN claude_session_id TEXT");
    // Backfill: copy the legacy per-session id onto each session's primary
    // root node (sessions.root_node_id). Pre-upgrade, a session had exactly
    // one root that owned its claude id; that mapping is lossless.
    db.exec(`
      UPDATE nodes
      SET claude_session_id = (
        SELECT s.claude_session_id FROM sessions s WHERE s.id = nodes.session_id
      )
      WHERE id IN (
        SELECT root_node_id FROM sessions WHERE claude_session_id IS NOT NULL
      )
    `);
  }

  // Per-root codex session id — the codex sibling of claude_session_id.
  // Resume ids are provider-family-scoped (a codex CLI session can only be
  // resumed by codex, never by claude), so each family gets its own column;
  // storing them in one shared column let a codex id reach `claude --resume`
  // and fail with "No conversation found". NULL on chat roots,
  // every branch, and any root whose first turn ran a non-codex provider.
  const hasNodeCodexId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'codex_session_id'",
    )
    .get();
  if (!hasNodeCodexId) {
    db.exec("ALTER TABLE nodes ADD COLUMN codex_session_id TEXT");
  }

  // Stage 14: per-session context mode + workspace cwd. See
  // progress/mode-workspace-rebuild.md. Mode previously lived in
  // localStorage as a global preference; now it's locked at session
  // creation so each tree carries its own context. Sessions with a
  // claude_session_id are migrated to 'project' (they were cli-multi);
  // everything else lands on 'chat' (lossless for lean; cli-single
  // sessions lose tool access — accepted, see spec migration section).
  const hasContextMode = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'context_mode'",
    )
    .get();
  if (!hasContextMode) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN context_mode TEXT NOT NULL DEFAULT 'chat'",
    );
    db.exec(
      "UPDATE sessions SET context_mode = 'project' WHERE claude_session_id IS NOT NULL",
    );
  }
  // 2026-07-16: the workspace tier was retired (chat/project only). Any
  // stray 'workspace' rows fold into project — same cwd + tools, they just
  // gain cross-turn memory. Idempotent; local DBs had zero such rows.
  db.exec(
    "UPDATE sessions SET context_mode = 'project' WHERE context_mode = 'workspace'",
  );
  const hasWorkspacePath = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'workspace_path'",
    )
    .get();
  if (!hasWorkspacePath) {
    db.exec("ALTER TABLE sessions ADD COLUMN workspace_path TEXT");
  }

  // Wave 2 (B2): session archive flag. archived = soft-hide, fully reversible
  // (never touches jsonl / nodes — only filters lists). 0 = active, 1 =
  // archived. Idempotent ALTER following the same pattern as every column
  // above. Existing rows default to 0 (active) — lossless.
  const hasArchived = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'archived'",
    )
    .get();
  if (!hasArchived) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
    );
  }

  // D1: per-session custom system prompt (chat mode only — project
  // gets its persona from CLAUDE.md + full tools). NULL = use the built-in
  // DEFAULT_SYSTEM_PROMPT. Locked at session creation like mode/workspace.
  const hasSystemPrompt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'system_prompt'",
    )
    .get();
  if (!hasSystemPrompt) {
    db.exec("ALTER TABLE sessions ADD COLUMN system_prompt TEXT");
  }

  // Per-session model lock: stores the ProviderId (claude-opus / claude-sonnet
  // / claude-haiku / codex) chosen when the session was created, so switching
  // away and back doesn't silently inherit whatever the global picker last
  // pointed at. NULL = legacy rows → fall back to DEFAULT_PROVIDER on read.
  // Idempotent ALTER, same pattern as every column above.
  const hasModel = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'model'")
    .get();
  if (!hasModel) {
    db.exec("ALTER TABLE sessions ADD COLUMN model TEXT");
  }

  // CLI session 同步（progress/cli-sync.md）。一个 session 的来源：
  //   'native'     — trellis 自己造的（默认，所有既有行）
  //   'cli-import' — 从 ~/.claude/projects 的本地 CLI jsonl 镜像来的（只读）
  // source_jsonl_path = 镜像源 jsonl 绝对路径；synced_uuid = 上次同步到的末行
  // uuid（增量游标，watcher 据此只重解析新增部分）。后两者 native 行恒 NULL。
  const cliSyncCols: { name: string; sql: string }[] = [
    {
      name: "origin",
      sql: "ALTER TABLE sessions ADD COLUMN origin TEXT NOT NULL DEFAULT 'native'",
    },
    {
      name: "source_jsonl_path",
      sql: "ALTER TABLE sessions ADD COLUMN source_jsonl_path TEXT",
    },
    {
      name: "synced_uuid",
      sql: "ALTER TABLE sessions ADD COLUMN synced_uuid TEXT",
    },
    {
      name: "cli_provider",
      sql: "ALTER TABLE sessions ADD COLUMN cli_provider TEXT",
    },
  ];
  for (const c of cliSyncCols) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = ?")
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // CLI branch alignment P1: one attached trellis session can bind a whole
  // lineage of Claude or Codex jsonl files (root + fork sessions). The old
  // sessions.source_jsonl_path remains a denormalized root path; this table is
  // the authoritative member list and carries per-jsonl sync cursors.
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_lineages (
      trellis_session_id TEXT NOT NULL,
      cli_session_id TEXT NOT NULL,
      provider_family TEXT NOT NULL DEFAULT 'claude',
      jsonl_path TEXT NOT NULL,
      fork_point_uuid TEXT,
      is_root INTEGER NOT NULL DEFAULT 0,
      synced_uuid TEXT,
      PRIMARY KEY (trellis_session_id, cli_session_id),
      FOREIGN KEY (trellis_session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS cli_lineages_session ON cli_lineages(trellis_session_id);
  `);
  // Existing installs used a Claude-specific column name. SQLite preserves
  // the PK/index/FK definitions when renaming, so this is a lossless in-place
  // migration rather than a shadow-table copy.
  const lineageColumns = db
    .prepare("SELECT name FROM pragma_table_info('cli_lineages')")
    .all() as { name: string }[];
  const lineageColumnNames = new Set(lineageColumns.map((column) => column.name));
  if (
    lineageColumnNames.has("claude_session_id") &&
    !lineageColumnNames.has("cli_session_id")
  ) {
    db.exec(
      "ALTER TABLE cli_lineages RENAME COLUMN claude_session_id TO cli_session_id",
    );
    lineageColumnNames.delete("claude_session_id");
    lineageColumnNames.add("cli_session_id");
  }
  if (!lineageColumnNames.has("provider_family")) {
    db.exec(
      "ALTER TABLE cli_lineages ADD COLUMN provider_family TEXT NOT NULL DEFAULT 'claude'",
    );
  }
  db.exec(`
    UPDATE sessions
    SET cli_provider = 'claude'
    WHERE origin = 'cli-import' AND cli_provider IS NULL
  `);
  db.exec(`
    INSERT OR IGNORE INTO cli_lineages
      (trellis_session_id, cli_session_id, provider_family, jsonl_path,
       fork_point_uuid, is_root, synced_uuid)
    SELECT id, id, COALESCE(cli_provider, 'claude'), source_jsonl_path,
           NULL, 1, synced_uuid
    FROM sessions
    WHERE origin = 'cli-import'
      AND source_jsonl_path IS NOT NULL
  `);

  // Idempotent column add for short LLM-generated topic label per node.
  // Used by overview rendering (LoD) and outline. Null until first done.
  const hasTopicLabel = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'topic_label'",
    )
    .get();
  if (!hasTopicLabel) {
    db.exec("ALTER TABLE nodes ADD COLUMN topic_label TEXT");
  }

  // Reference cards (Stage 12). Six idempotent column adds for the new
  // node kind. Existing qa rows get kind='qa' via DEFAULT and NULL refs.
  // See progress/reference-nodes.md for the data model rationale.
  const refColumns: { name: string; sql: string }[] = [
    { name: "kind", sql: "ALTER TABLE nodes ADD COLUMN kind TEXT NOT NULL DEFAULT 'qa'" },
    { name: "ref_source_type", sql: "ALTER TABLE nodes ADD COLUMN ref_source_type TEXT" },
    { name: "ref_source_uri", sql: "ALTER TABLE nodes ADD COLUMN ref_source_uri TEXT" },
    { name: "ref_content_md", sql: "ALTER TABLE nodes ADD COLUMN ref_content_md TEXT" },
    { name: "ref_fetched_at", sql: "ALTER TABLE nodes ADD COLUMN ref_fetched_at INTEGER" },
    { name: "ref_meta_json", sql: "ALTER TABLE nodes ADD COLUMN ref_meta_json TEXT" },
  ];
  for (const c of refColumns) {
    const has = db
      .prepare(
        "SELECT 1 FROM pragma_table_info('nodes') WHERE name = ?",
      )
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // Idempotent: per-node read marker. NULL = unread; ms-since-epoch =
  // timestamp the user first kept the node open long enough to count as
  // read (1s gate, set client-side, persisted via POST /api/nodes/[id]/read).
  const hasReadAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'read_at'",
    )
    .get();
  if (!hasReadAt) {
    db.exec("ALTER TABLE nodes ADD COLUMN read_at INTEGER");
  }

  // Card-level “read later” marker. This is deliberately independent from
  // read_at: opening a saved card does not clear it, and marking a card read
  // does not remove the bookmark.
  const hasBookmarkedAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'bookmarked_at'",
    )
    .get();
  if (!hasBookmarkedAt) {
    db.exec("ALTER TABLE nodes ADD COLUMN bookmarked_at INTEGER");
  }

  // Idempotent: split out cache token tracking so the UI can distinguish
  // net cost (input + output) from cache leverage (cache_read, often
  // dominant in cli-multi). Existing token_input / token_output columns
  // continue to mean "raw model input" / "model output" — old rows had
  // cache buckets summed into token_input via claude.ts; that's a
  // historical mis-attribution we accept (no migration to retroactively
  // fix). New rows get clean separation.
  const cacheCols: { name: string; sql: string }[] = [
    {
      name: "token_cache_read",
      sql: "ALTER TABLE nodes ADD COLUMN token_cache_read INTEGER NOT NULL DEFAULT 0",
    },
    {
      name: "token_cache_creation",
      sql: "ALTER TABLE nodes ADD COLUMN token_cache_creation INTEGER NOT NULL DEFAULT 0",
    },
  ];
  for (const c of cacheCols) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('nodes') WHERE name = ?")
      .get(c.name);
    if (!has) db.exec(c.sql);
  }

  // B (token fix): the main agent's true context-window occupancy for this
  // turn = the LAST assistant message's input+cache, NOT the result.usage sum
  // (which double-counts every tool-loop iteration + same-model subagents).
  // Nullable: legacy rows / codex-less-precise / non-claude → NULL → the % gauge
  // falls back to the old input+cache_read+cache_creation estimate.
  const hasTokenContext = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'token_context'",
    )
    .get();
  if (!hasTokenContext) {
    db.exec("ALTER TABLE nodes ADD COLUMN token_context INTEGER");
  }

  // Stage 15: image attachments on a node. JSON-encoded NodeAttachment[]
  // (see lib/types.ts). NULL means no attachments. Actual image bytes
  // live in ~/.trellis/blobs/<hash>.<ext>; the JSON only carries
  // metadata (hash, mime, size, filename, optional width/height).
  const hasAttachments = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'attachments_json'",
    )
    .get();
  if (!hasAttachments) {
    db.exec("ALTER TABLE nodes ADD COLUMN attachments_json TEXT");
  }

  // Stage 17: LLM tool invocations per node. JSON-encoded ToolCall[]
  // (see lib/types.ts). NULL when the turn didn't trigger any tools.
  // Mutated incrementally during the run via appendToolCallStart /
  // markToolCallDone — partial JSON is always well-formed because we
  // re-serialize the whole array on each update (cheap at the tool
  // call counts a single turn produces).
  const hasToolCalls = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'tool_calls_json'",
    )
    .get();
  if (!hasToolCalls) {
    db.exec("ALTER TABLE nodes ADD COLUMN tool_calls_json TEXT");
  }

  // A路②: in-flight interactive-tool prompt (AskUserQuestion / ExitPlanMode)
  // awaiting a user answer. JSON-encoded { toolUseId, toolName, input }. NULL
  // when nothing is pending. Persisted so a page reload / reconnect / late tab
  // can re-render the waiting form; cleared the moment the user responds (or
  // the run aborts). Only ever set while status='streaming'.
  const hasPendingInteraction = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'pending_interaction_json'",
    )
    .get();
  if (!hasPendingInteraction) {
    db.exec("ALTER TABLE nodes ADD COLUMN pending_interaction_json TEXT");
  }

  // Per-lineage 上下文隔离（progress/project-lineage-isolation-spec.md）。
  // lineage_isolation: 1 = 该 project session 走 per-lineage resume（一条岔一个
  // claude session；线性续聊 append，真分叉构造前缀 jsonl）。仅新建 project session
  // 置 1；存量行恒 0 → 保持全树共享 root sid 的旧行为（混排 jsonl 无法可靠迁移）。
  const hasLineageIsolation = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'lineage_isolation'",
    )
    .get();
  if (!hasLineageIsolation) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN lineage_isolation INTEGER NOT NULL DEFAULT 0",
    );
  }

  // 权限确认（P0 permission gate）：1 = 该 session 的 project 轮次以
  // --permission-mode default + ask 规则 spawn，可变更类工具（Bash/Write/Edit…）
  // 暂停等用户在 UI 里允许/拒绝；0 = 现状 YOLO（skip-permissions）。创建时锁定，
  // 仅 claude 系 project 可置 1（chat 无文件工具；codex 无 stdio 协议）。
  const hasRequireApproval = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'require_approval'",
    )
    .get();
  if (!hasRequireApproval) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN require_approval INTEGER NOT NULL DEFAULT 0",
    );
  }

  // 该节点的 turn 在其 lineage jsonl 里的 turn-start user entry uuid（=
  // ParsedTurn.id）。native isolated project 节点 done 后由 backfillNativeTurnUuid
  // 回填；是 buildPrefixJsonl 在该节点分叉的下刀坐标。NULL = 回填缺失 → 该点分叉
  // 降级为线性 resume（安全降级，等价旧行为）。attached 会话不用它（节点 id 本身
  // 就是 jsonl uuid）。
  const hasCliTurnUuid = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'cli_turn_uuid'",
    )
    .get();
  if (!hasCliTurnUuid) {
    db.exec("ALTER TABLE nodes ADD COLUMN cli_turn_uuid TEXT");
  }

  // codex 版的分叉下刀坐标（cli_turn_uuid 的镜像）：该节点那轮在其 lineage
  // rollout 里的 user-message 序号（1-based）。codex rollout 没有 uuid 链，
  // append-only 日志里序号即稳定坐标；done 后由 backfillCodexTurnOrdinal 回填。
  // NULL = 回填缺失 → 该点分叉降级线性 resume。
  const hasCodexTurnOrdinal = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'codex_turn_ordinal'",
    )
    .get();
  if (!hasCodexTurnOrdinal) {
    db.exec("ALTER TABLE nodes ADD COLUMN codex_turn_ordinal INTEGER");
  }

  // 树面板手动隐藏（雪藏）：仅根节点（parent_id IS NULL）有意义。NULL = 可见；
  // ms 时间戳 = 用户显式把这棵树收进「已隐藏」组的时刻。强制冷藏、不参与热度
  // 排名；数据/搜索不受影响。写即复活：树内新增节点（分叉/重试）自动清空。
  const hasHiddenAt = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'hidden_at'",
    )
    .get();
  if (!hasHiddenAt) {
    db.exec("ALTER TABLE nodes ADD COLUMN hidden_at INTEGER");
  }

  // Agent 长任务 response 分层（见 lib/types.ts:ChatNode.finalStart）：最后一次
  // 结构性中断（thinking/工具调用）之后的正文起始偏移。[0, final_start) 是过程
  // 叙述，之后是最终答复。NULL/0 = 不分层（纯 chat、存量行 → 渲染不变）。
  const hasFinalStart = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'final_start'",
    )
    .get();
  if (!hasFinalStart) {
    db.exec("ALTER TABLE nodes ADD COLUMN final_start INTEGER");
  }

  // 单轮耗时（毫秒）。记录从提问发送到整轮流式结束 / 导入解析的总耗时。
  const hasDurationMs = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('nodes') WHERE name = 'duration_ms'",
    )
    .get();
  if (!hasDurationMs) {
    db.exec("ALTER TABLE nodes ADD COLUMN duration_ms INTEGER");
  }

  // 自动命名（体验 D）：title 的来源标记。default = 建会话时的首问截断；
  // auto = 首答后小模型生成 / 每 8 节点刷新；user = 手动重命名（此后自动命名
  // 永不覆盖）。存量回填：title ≠ 根节点首问前 60 字 → 视为手动改过名 → 标
  // user。导入系（attach/import）title 派生规则不同必然 mismatch 也被标 user
  // —— 保守正确：非 native 会话本就不在自动命名范围内。
  const hasTitleSource = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'title_source'",
    )
    .get();
  if (!hasTitleSource) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN title_source TEXT NOT NULL DEFAULT 'default'",
    );
    db.exec(`
      UPDATE sessions SET title_source = 'user'
      WHERE EXISTS (
        SELECT 1 FROM nodes n
        WHERE n.id = sessions.root_node_id
          AND substr(n.question, 1, 60) <> sessions.title
      )
    `);
  }

  // 服务端 app 级偏好 kv（settings 页可改、spawn 路径要读的那类——localStorage
  // prefs 服务端读不到）。首个用户：打标/起题模型（label_model_claude/codex）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);

  // Notebook: per-session free-form excerpts the user collects while
  // reading. Each row points back to its source node so the UI can offer
  // a "jump to source + scroll to mark" return path.
  db.exec(`
    CREATE TABLE IF NOT EXISTS notes (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_node_id TEXT NOT NULL,
      quoted_text TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS notes_session ON notes(session_id);
  `);

  // CLI session 同步（Stage B，progress/cli-sync.md）：用户 opt-in 的 ~/.claude/
  // projects 子目录白名单。watcher 启动时 bulk 导入这些目录里的（非 trellis 自有）
  // jsonl，并 fs.watch 增量同步。删一条只停止同步、不删已镜像的 session。
  db.exec(`
    CREATE TABLE IF NOT EXISTS cli_sync_dirs (
      path TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL
    );
  `);

  // S1（progress/project-workspace-layer.md）：把「执行环境」提升为一等实体，
  // session 从平铺变成 Project → Workspace → Session 三级。
  //
  // 关键纪律：**sessions.workspace_path 保留不删**。它是 spawn cwd 的唯一真源
  // （lib/paths.ts:18 sessionCwd），且 cli-import 反向从 jsonl 的 cwd 推它。
  // 下面的 workspace_id 只是「归属指针」，不是替代 —— 这样 spawn / resume /
  // claude 前缀 jsonl 分叉 / codex 前缀 rollout 四条链路零改动。
  //
  // cluster_key 是聚类的去重键，与 git_remote 刻意分开两列：
  //   有 remote  → 归一化后的 remote URL（同 repo 的所有 worktree 天然同值）
  //   无 remote  → `git rev-parse --git-common-dir` 的路径（纯本地 repo 也能聚）
  //   非 git     → 父目录路径（scratch 特判）
  // git_remote 只存真实 remote 供显示，可为 NULL；用它当唯一键会让后两类无法去重。
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      cluster_key TEXT NOT NULL UNIQUE,
      git_remote TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      git_branch TEXT,
      created_by TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS workspaces_project ON workspaces(project_id);
  `);

  // ON DELETE SET NULL（而非 CASCADE）：移除一个 workspace 不该连坐删掉它下面的
  // 会话历史 —— 那些 session 仍持有 workspace_path、仍能正常 resume，只是回到
  // 「未归组」状态。这正是「workspace_path 才是真源」的设计在删除路径上的体现。
  const hasSessionWorkspaceId = db
    .prepare(
      "SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'workspace_id'",
    )
    .get();
  if (!hasSessionWorkspaceId) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id) ON DELETE SET NULL",
    );
  }

  // S88: 自定义 Agent。一行 = 一个可复用的人设（提示词 + 模型 + 技能 + 工具 + 隔离度），
  // 有稳定 id/slug 供后续的定时任务 / @提及 / 讨论组按引用取用。
  //
  // 刻意不为「默认 Agent」建行 —— `sessions.agent_id IS NULL` 就是它。执行链因此能写成
  // `if (agentId) { 新逻辑 } else { 今天的代码原封不动 }`，物理上杜绝默认路径回归。
  //
  // slug 同时是三样东西：claude `--agent` 的值、pack 里 agents/<slug>.md 的文件名、
  // 未来 @提及的名字 —— 所以必须是安全的路径片段（校验在 lib/server/agents.ts）。
  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      system_prompt TEXT NOT NULL DEFAULT '',
      model TEXT,
      tools_json TEXT,
      disallowed_tools_json TEXT,
      skills_json TEXT,
      inherit_env INTEGER NOT NULL DEFAULT 0,
      permission TEXT,
      require_approval INTEGER,
      builtin INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS agents_enabled ON agents(enabled, sort_order);
  `);

  seedBuiltinAgents(db);

  // ON DELETE SET NULL 而非 CASCADE，理由同 workspace_id：删一个 agent 不该连坐删掉
  // 用它聊过的全部历史，退回默认人设即可。
  const hasSessionAgentId = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'agent_id'")
    .get();
  if (!hasSessionAgentId) {
    db.exec(
      "ALTER TABLE sessions ADD COLUMN agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL",
    );
  }

  // 每轮实际由谁答。会话级人设也落一份，用于事后审计「这轮是哪个 agent 答的」——
  // agent 定义是 live 引用（改了老会话就跟着改），这一列是仅有的历史线索。
  // agent_scope: NULL | 'session' | 'mention'，@提及派活的那一轮才是 'mention'。
  for (const col of ["agent_id", "agent_scope"] as const) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('nodes') WHERE name = ?")
      .get(col);
    if (!has) db.exec(`ALTER TABLE nodes ADD COLUMN ${col} TEXT`);
  }

  // S88: 自动化任务。三张表的切分理由见 progress/custom-agents-plan.md：
  //
  //   tasks          「agent + prompt + workspace」冻成一个按钮
  //   task_triggers   触发器，**一对多独立成表**
  //   task_runs       每次执行的留档
  //
  // 触发器为什么不是 tasks 上的一列：用户要的是「每天 9 点自动跑 **而且** 我想
  // 随手点一下」—— 做成列就得建两行、复制一份 prompt。拆表后手动触发 = 零个
  // trigger 行，cron = 一个 kind='cron' 行，未来飞书群 = 一个 kind='lark' 行。
  // 更硬的理由：每个 trigger 有自己的运行时状态（cron 的 last_fired_at、git 的
  // sha 游标），挂在 tasks 上会变成一堆互斥的 nullable 列。
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      agent_id TEXT,
      prompt TEXT NOT NULL,
      workspace_path TEXT,
      context_mode TEXT NOT NULL DEFAULT 'project',
      model TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      home_session_id TEXT,
      timeout_ms INTEGER NOT NULL DEFAULT 1800000,
      overlap_policy TEXT NOT NULL DEFAULT 'skip',
      notify_on TEXT NOT NULL DEFAULT 'error',
      max_budget_usd REAL,
      max_retries INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS tasks_enabled ON tasks(enabled);

    CREATE TABLE IF NOT EXISTS task_triggers (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      config_json TEXT NOT NULL,
      last_fired_at INTEGER,
      cursor TEXT,
      last_checked_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_triggers_task ON task_triggers(task_id);
    CREATE INDEX IF NOT EXISTS task_triggers_kind ON task_triggers(enabled, kind);

    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      trigger_id TEXT,
      trigger_kind TEXT NOT NULL,
      status TEXT NOT NULL,
      session_id TEXT,
      node_id TEXT,
      scheduled_for INTEGER NOT NULL,
      attempt INTEGER NOT NULL DEFAULT 1,
      started_at INTEGER,
      ended_at INTEGER,
      error_message TEXT,
      prompt_snapshot TEXT,
      agent_id_snapshot TEXT,
      token_input INTEGER NOT NULL DEFAULT 0,
      token_output INTEGER NOT NULL DEFAULT 0,
      notified_at INTEGER,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS task_runs_task ON task_runs(task_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS task_runs_node ON task_runs(node_id);
    CREATE INDEX IF NOT EXISTS task_runs_active ON task_runs(status);

    CREATE TABLE IF NOT EXISTS scheduler_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      last_tick_at INTEGER NOT NULL
    );
  `);

  // ★ 抢槽去重的核心。一个 trigger 的一个**计划槽位**（对齐到整分钟的
  // scheduled_for），全库只能有一条 run。多进程同时 tick、重启后 catch-up
  // 重复计算，都会撞在这条约束上而不是多跑一次、多烧一次钱。
  // partial index 的 WHERE 让手动触发（trigger_id IS NULL）不受约束 ——
  // 手动点两次就该跑两次。
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS task_runs_slot
      ON task_runs(trigger_id, scheduled_for, attempt)
      WHERE trigger_id IS NOT NULL;
  `);

  // 任务会话不该挤在用户的会话侧栏里。'user' | 'task' | 'lark'。
  // 注意：这个 `kind` 与 `nodes.kind`（'qa' | 'reference'）**同名不同义**，
  // 两者没有任何关系，写查询时别把两张表的 kind 当同一个枚举（S89 记）。
  const hasSessionKind = db
    .prepare("SELECT 1 FROM pragma_table_info('sessions') WHERE name = 'kind'")
    .get();
  if (!hasSessionKind) {
    db.exec("ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'user'");
  }

  // 飞书是入口，Trellis 的 session/node 树仍是对话真源。bot 只保存连接与执行配置，
  // chat 只保存飞书会话到树链尾的映射，inbox 只承担消息去重；三者不复制回答正文。
  db.exec(`
    CREATE TABLE IF NOT EXISTS lark_bots (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      app_id TEXT NOT NULL UNIQUE,
      app_secret TEXT NOT NULL,
      agent_id TEXT,
      workspace_path TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      bot_open_id TEXT,
      bot_name TEXT,
      last_connected_at INTEGER,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS lark_bots_enabled ON lark_bots(enabled);

    CREATE TABLE IF NOT EXISTS lark_chats (
      id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL REFERENCES lark_bots(id) ON DELETE CASCADE,
      chat_id TEXT NOT NULL,
      chat_type TEXT NOT NULL,
      session_id TEXT,
      last_node_id TEXT,
      title TEXT,
      last_message_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(bot_id, chat_id)
    );

    CREATE INDEX IF NOT EXISTS lark_chats_bot ON lark_chats(bot_id, last_message_at DESC);

    CREATE TABLE IF NOT EXISTS lark_inbox (
      message_id TEXT PRIMARY KEY,
      bot_id TEXT NOT NULL,
      status TEXT NOT NULL,
      node_id TEXT
    );
  `);

  // S134 IM 入口层（spec: progress/im-entry-layer.md）：四旋钮进 lark_bots（加列不改列），
  // 话题 → 树、机器人出站消息 → 节点两张映射表。建表语句与测试共用 LARK_THREAD_TABLES_SQL。
  const larkPolicyColumns: Array<[string, string]> = [
    ["group_trigger", "TEXT NOT NULL DEFAULT 'mention'"],
    ["trigger_prefix", "TEXT"],
    ["reply_mode", "TEXT NOT NULL DEFAULT 'thread'"],
    ["session_policy", "TEXT NOT NULL DEFAULT 'thread'"],
    ["ack_mode", "TEXT NOT NULL DEFAULT 'reaction'"],
  ];
  for (const [column, ddl] of larkPolicyColumns) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('lark_bots') WHERE name = ?")
      .get(column);
    if (!has) db.exec(`ALTER TABLE lark_bots ADD COLUMN ${column} ${ddl}`);
  }
  db.exec(LARK_THREAD_TABLES_SQL);

  // S89: `tasks.model` 这一列名不副实 —— 它存的一直是 **providerId**
  // （`lib/server/tasks.ts` 里 `isProviderId(task.model) ? task.model : DEFAULT_PROVIDER`），
  // 而 `agents.model` 存的是 CLI 模型名（如 'haiku'）。同名不同义，是真会写错的那种。
  //
  // 加列而不是改列：`migrate()` 至今全是加法 DDL（decisions.md 2026-07-28 把这条列为
  // 部署方案可行的理由之一），这条纪律比一列干净更值钱。读时 `provider_id ?? model` 兜底，
  // 写只写新列。旧列**留一个版本再删** —— 真库里 tasks 目前是 0 行（facts.md 第一条），
  // 所以这次迁移零数据风险，但流程仍按有数据的情形走。
  const hasTaskProviderId = db
    .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = 'provider_id'")
    .get();
  if (!hasTaskProviderId) {
    db.exec("ALTER TABLE tasks ADD COLUMN provider_id TEXT");
    db.exec("UPDATE tasks SET provider_id = model WHERE provider_id IS NULL");
  }

  // 定时任务可选飞书落点。二元组的完整性与 chat 归属由 tasks service 校验；这里继续
  // 遵守 migrate() 的加法式 DDL，避免旧库升级需要重建 tasks。
  for (const column of ["lark_bot_id", "lark_chat_id"] as const) {
    const has = db
      .prepare("SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?")
      .get(column);
    if (!has) db.exec(`ALTER TABLE tasks ADD COLUMN ${column} TEXT`);
  }

  // Stage 16: FTS5 cross-session full-text search. Single virtual table
  // covers question / response / reference / note text. trigram tokenizer
  // is the FTS5-builtin pick for mixed CJK + ASCII: 3-char sliding window
  // gives substring matching across languages (the same trade as Notion /
  // Linear). UNINDEXED meta columns let us filter/JOIN without paying
  // inverted-index cost. See progress/fts-search.md for the data model.
  //
  // Min-query constraint: trigram needs ≥ 3 chars per token, so the API
  // and UI both short-circuit shorter queries with a hint.
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
      text,
      source_kind UNINDEXED,
      source_id UNINDEXED,
      session_id UNINDEXED,
      tokenize = 'trigram'
    );
  `);

  // 一次性数据迁移，用 PRAGMA user_version 记进度（0 = 从没跑过）。
  const schemaVersion = (
    db.query("PRAGMA user_version").get() as { user_version: number }
  ).user_version;
  if (schemaVersion < 1) {
    // v1：CLI 同步的 turn 切分判据变了（cli-import.ts:isTurnStart 现在按
    // isMeta / promptSource 排除 CLI 注入的 user 消息）。存量镜像会话是按旧判据
    // 导的——真 turn 的回复被假 turn 劫走，留下一堆「有工具、无回复」的僵尸节点。
    // 这里作废增量游标，强制下次 importCliLineage 全量重导；假节点由 import 事务
    // 里的清理逻辑顺带删。不作废不行：allUnchanged 判定会直接跳过整个重写，存量
    // 永远修不好。
    db.exec("UPDATE cli_lineages SET synced_uuid = NULL");
    db.exec("PRAGMA user_version = 1");
  }

  // Reap dangling streams from a previous server crash, exactly once on boot.
  db.prepare(
    `UPDATE nodes SET status = 'error', error_message = 'interrupted',
            pending_interaction_json = NULL
     WHERE status = 'streaming'`,
  ).run();

  // ★ S88：上面那条的**对称件**，必须成对存在 —— 只做一个比都不做更危险。
  //
  // task_run 的终结完全依赖进程内的 onSettled 回调，而 SIGKILL 时它一次都不跑。
  // 结果是那行永远卡在 running，overlap_policy='skip' 会因此**永久跳过**该任务
  // 后续所有执行 —— 一个静默瘫痪整个功能的死锁，界面上还看不出异常。
  //
  // pending 也要 reap：否则重启后 pending 队列复活一批过期任务，等价于绕过
  // catch-up 窗口做无限补跑。补跑走 task-scheduler 的 catchUp，不靠 pending 复活。
  //
  // 放在 migrate() 里而不是调度器启动时：getDB() 触发 migrate 远早于
  // instrumentation 注册调度器，分开会开出一个「节点已 error 但 run 仍 running」
  // 的不一致窗口，而那个窗口里刚好可能有 API 请求读到。
  db.prepare(
    `UPDATE task_runs SET status = 'error', error_message = 'interrupted',
            ended_at = ?
     WHERE status IN ('running', 'pending')`,
  ).run(Date.now());

  // 长连接事件已被飞书投递过，崩溃后不擅自重放；用户重发会得到新的 message_id。
  // 只收尸 processing，done/error/ignored 都是终态，保留作去重锚。
  db.prepare(
    "UPDATE lark_inbox SET status = 'error' WHERE status = 'processing'",
  ).run();

  // First-boot backfill: if the search_index has zero rows but the DB
  // already holds data (upgrade from a pre-Stage-16 build), seed it
  // from the existing tables in a single transaction. Idempotent —
  // subsequent boots skip because COUNT > 0.
  const indexed = db
    .prepare("SELECT COUNT(*) AS n FROM search_index")
    .get() as { n: number };
  if (indexed.n === 0) {
    const haveNodes = db
      .prepare("SELECT COUNT(*) AS n FROM nodes")
      .get() as { n: number };
    const haveNotes = db
      .prepare("SELECT COUNT(*) AS n FROM notes")
      .get() as { n: number };
    if (haveNodes.n > 0 || haveNotes.n > 0) {
      const tx = db.transaction(() => {
        db.exec(`
          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT question, 'node_question', id, session_id
          FROM nodes WHERE kind = 'qa' AND question != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT response, 'node_response', id, session_id
          FROM nodes WHERE kind = 'qa' AND status = 'done' AND response != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT ref_content_md, 'node_reference', id, session_id
          FROM nodes WHERE kind = 'reference'
            AND ref_content_md IS NOT NULL AND ref_content_md != '';

          INSERT INTO search_index(text, source_kind, source_id, session_id)
          SELECT quoted_text, 'note', id, session_id
          FROM notes;
        `);
      });
      tx();
    }
  }
}

// 把 lib/agent-presets.ts 的五个预设种进 agents 表。
//
// INSERT OR IGNORE 按 slug 幂等：每次 boot 都跑，已存在就不动 —— 所以用户改过的
// 内置 agent 不会被下次启动覆盖回去，删掉的也不会复活（删除走 enabled=0，见 agents.ts）。
//
// inherit_env = 1：这五个是**纯人设**，用户选它们是想换语气，不是想进沙箱。
// 隔离（inherit_env=0）会连 CLAUDE.md、本机 skill、MCP 一起砍掉（2026-07-31 实测，
// 见 progress/facts.md），对「在 project 会话里换个说话风格」这个用法是纯伤害。
// 新建的自定义 agent 默认相反（隔离），因为那才是「可复现、能搬机器」的用法。
function seedBuiltinAgents(db: Database) {
  const now = Date.now();
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO agents
       (id, slug, name, description, system_prompt, inherit_env, builtin, enabled, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1, 1, ?, ?, ?)`,
  );
  const tx = db.transaction(() => {
    BUILTIN_AGENT_SEEDS.forEach((seed, i) => {
      stmt.run(
        `builtin-${seed.slug}`,
        seed.slug,
        seed.name,
        seed.description,
        seed.systemPrompt,
        i,
        now,
        now,
      );
    });
  });
  tx();
}
