# P1 实现契约：union 导入 + lineage 发现 + watch 扩展（CLI→trellis）

> 给 Codex 的验收契约。母设计 = [cli-branch-alignment.md](cli-branch-alignment.md)，先读它的 §0/§1/§2/§3/§6/§7。
> 本文件把母设计留白的 schema 迁移 / importer 签名 / 读点迁移 / 验收钉死。**只做 P1。P2/P3 不碰。**

## 0. 结果（期望终态）

attach 一个 CLI 会话后，trellis 把它**整组 lineage（root jsonl + 所有 fork jsonl）按 turn uuid 求并集**导成**一棵**树：共享 uuid 的 turn 合并成同一节点，fork 在分叉点长出子树，in-jsonl 分叉仍是兄弟（解析器已支持）。CLI 侧新出现 fork jsonl（`/branch`）或既有 jsonl 追加（rewind/线性续）→ watcher 自动增量 union 重导 → 前端 reload。**方向只到「CLI→trellis 显示」**。

## 1. 非目标（P1 明确不做，留 P2/P3）

- ❌ trellis→CLI 分叉 / 任意节点分叉 / 构造前缀 jsonl（全是 P2）。
- ❌ 改 trellis 续聊的 resume 目标定位逻辑（`getRootResumeIdForNode` 不动）。当前续聊只在 attached **root lineage 的 tip** 进行，P1 必须**保持它照常工作**，不需要让 fork 分支节点能正确续聊（那是 P2）。
- ❌ picker 分组展示对齐、fork 文件管理、并发护栏强化（P3）。

## 2. 改动边界（爆炸半径）

只动 `origin='cli-import'` 的 attached 会话链路。原生 chat/workspace/project **零改动**。判别开关是 `origin`，不是 `mode`。解析器 `cli-import.ts` 内核**不改**（已按 turn uuid 当节点 id、已把 in-jsonl 分叉解析成兄弟）——union 只在 DB 落地层把「一个 jsonl」扩成「一组 jsonl」。

## 3. Schema（幂等 ALTER/CREATE，沿用 `sqlite.ts` migrate 现有风格）

新表 `cli_lineages` = attached 会话的 jsonl 成员真相源（一棵 trellis 树绑 N 个 CLI session）：

```sql
CREATE TABLE IF NOT EXISTS cli_lineages (
  trellis_session_id TEXT NOT NULL,   -- attached session.id（= root jsonl 的 sid）
  claude_session_id  TEXT NOT NULL,   -- 该 lineage 的 CLI session id（root 或 fork）
  jsonl_path         TEXT NOT NULL,   -- 该 jsonl 绝对路径
  fork_point_uuid    TEXT,            -- 从哪个共享 turn uuid 分出（root 为 NULL）；P1 best-effort
  is_root            INTEGER NOT NULL DEFAULT 0,
  synced_uuid        TEXT,            -- 该 jsonl 的增量游标（从 sessions.synced_uuid 搬来）
  PRIMARY KEY (trellis_session_id, claude_session_id),
  FOREIGN KEY (trellis_session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS cli_lineages_session ON cli_lineages(trellis_session_id);
```

FK `ON DELETE CASCADE` → detach（`deleteSession`）自动清 lineage 行，无需手动删。

**既有 attached 会话的无损迁移**（migrate() 里跑一次，幂等）：对每个 `origin='cli-import'` 且 `cli_lineages` 尚无对应行的 session，插一行：`(id, id, source_jsonl_path, NULL, 1, synced_uuid)`（cli-import 会话的 root sid = session.id = jsonl 文件名；root 节点的 `claude_session_id` 本就 = session.id）。fork 留给启动重导时发现（见 §6 启动路径）。

**sessions 列处置**：`origin` / `source_jsonl_path` 保留——`source_jsonl_path` 改语义为「root jsonl 路径」（denormalized，仅供 picker 展示 + reconcile 取 root，**不是成员真相源**，成员查 `cli_lineages`）。`sessions.synced_uuid` 停用（游标搬到 lineage），列留着无害，不再读。**不要动** `repo.ts` 的 `SessionRow`/`SESSION_COLS`/`rowToSession` 和 `lib/types.ts` 的 `Session`（它们继续只认 root 的 `source_jsonl_path`，照常工作）。

## 4. importer 重构（`cli-import-db.ts`）

把核心从「一 jsonl 一 session」改成「一 lineage 组一 session（union upsert）」：

- 新 `importCliLineage(trellisSessionId: string): ImportResult`：读该 session 的所有 `cli_lineages` 行 → 逐个 `parseCliSessionJsonl(jsonl_path)` → **按 turn uuid 求并集** upsert 进**同一** trellis session（session.id = trellisSessionId）。
  - 现有 `upsertNode`（ON CONFLICT 按 id 更新）已天然幂等：共享 uuid 的 turn 多个 jsonl 都解析出来，upsert 收敛成一行；fork 独有 turn 新建。
  - parentId 取并集图：每个 turn 的 parentId = 它自己 jsonl 解析出的 parentTurn（共享祖先 uuid 在各 jsonl 里一致 → 合并后仍指向同一节点）。
  - **siblingIndex 跨 jsonl 归一**：解析器是 per-jsonl 算 siblingIndex 的；union 后必须**在合并后的全集上按 parent 重算**（同 parent 下所有 turn——无论来自哪个 jsonl——按 createdAt 排序赋 0..n）。否则两个 fork 的同级 turn 会撞 siblingIndex。
  - root 节点（union 树里唯一 parentId=null 那个）的 `claude_session_id` = 它所属 lineage（is_root）的 claude_session_id（= trellisSessionId）。**非 root 节点 `claude_session_id` 一律 NULL**（保持现状；fork 节点的 per-lineage resume 归 P2，P1 不设，避免误触 `getRootResumeIdForNode`）。
  - 每个 lineage 行的 `synced_uuid` 用各自 jsonl 的 `parsed.lastUuid` 更新；全组都命中各自游标 → 整组 unchanged 跳过重写。
  - session 行的 `title`/`updatedAt`/`source_jsonl_path` 等取 root lineage 的（root jsonl 的 parsed 值），`source_jsonl_path` = root jsonl_path。
- `importCliSessionFromJsonl(path)`：**改造而非保留双版本**。它现在的职责拆给 attach 流程（见下）。所有原调用方（watcher×3、reconcile、startup）改调 `importCliLineage(sessionId)` —— 调用方先用 `jsonl_path → trellis_session_id`（查 `cli_lineages`）解析出 session。
- `trellisOwnedSessionIds()` 不动（已正确排除 `origin='cli-import'`）。

## 5. lineage 发现（`cli-discover.ts` 加；attach 时调）

`discoverLineage(jsonlPath): { rootSid, members: {sid, path, isRoot, forkPointUuid}[] }`：

1. `dir = dirname(jsonlPath)`；读 dir 下所有 `.jsonl`，对每个 `parseCliSessionJsonl` 取其 turn uuid 集合（turn.id 集合即可，不必 message 级）。
2. **分组（union-find）**：两个 jsonl 若共享 ≥1 turn uuid → 同组。对传入 jsonlPath 所在组做传递闭包。（用户可能选中的是 fork 而非 root，发现要归一到整组。）
3. **定 root**：组内 union 出的所有 turn 里，`parentId===null` 的 turn 按 createdAt 取最早那个 = 树根 turn；**包含该 root turn 作为自己 turn 的 jsonl** = root lineage，其 sid = `rootSid` = trellis session id。
4. **fork_point_uuid**（best-effort）：每个非 root jsonl，取它与组内并集共享的最后一个 turn uuid（= 它首个独有 turn 的 parentId）。算不出就 NULL，不阻塞。
5. 只扫同一 dir（fork-session 与源同 cwd → 同 encoded 目录，实测如此）。

## 6. attach / watcher / 启动 流程改造

**attachSession(jsonlPath)**（`cli-sync-watcher.ts`）：
1. `discoverLineage(jsonlPath)` → rootSid + members。
2. 事务里：seed session 行（id=rootSid，origin='cli-import'，mode 按 root jsonl 的 cwd 定 project/chat，source_jsonl_path=root path）+ 写全部 `cli_lineages` 行（synced_uuid 先 NULL）。
3. `importCliLineage(rootSid)`。
4. `refreshWatches()`。返回 ImportResult。

**watcher**：
- `attachedPaths()`（watcher 与 discover 各一份，§读点）→ 改成查 `cli_lineages.jsonl_path` 全集（不再查 `sessions.source_jsonl_path`）。
- watch dirs = 每个 lineage jsonl 的 dirname。
- 文件变更 P（debounce 后 `reimport(P)`）：
  - P ∈ `cli_lineages.jsonl_path` → 取其 trellis_session_id → `importCliLineage(sid)` → updated/imported 则 `publishCliSessionUpdated(sid)`。
  - P ∉ 但在某 watched dir 下 → **新 fork 检测**：parse P 取 turn uuid 集，若与某 attached 组的 union uuid 集相交 → 把 P 作为新 fork 插 `cli_lineages`（算 fork_point_uuid）→ `importCliLineage(sid)` → publish。这是「CLI `/branch` → trellis 自动长子树」的头牌路径，**必须实现**。
- `detachSession`：不变（`deleteSession` + FK cascade 清 lineage + origin 闸保原始 jsonl）。

**startCliSyncWatcher()**（启动全量重导）：遍历 attached session（`SELECT id FROM sessions WHERE origin='cli-import'`），对每个**先跑 `discoverLineage`（root jsonl 取自现有 lineage root 行）补发现新 fork** → `importCliLineage(id)` → publish。这条让既有 attached 会话在重启后自动收编已存在的 fork。

**reconcileAttachedTurn(provisionalNodeId)**：读点从 `sessions.source_jsonl_path` 改为：由 node→session→`importCliLineage(sessionId)`（重导整组）。其余轮询「canonical newest turn ≠ 临时 → 删临时」逻辑不变。newest turn 取整组 union 后按 createdAt 最大。

## 7. 读点迁移清单（逐个改，漏一个就回归已上线 attach）

- `lib/server/cli-sync-watcher.ts:15-23` `attachedPaths()` → 查 `cli_lineages.jsonl_path`。
- `lib/server/cli-discover.ts:20-28` `attachedPaths()` → 查 `cli_lineages.jsonl_path`（picker 排除 attached 时要排除**整组所有成员**，不止 root）。
- `lib/server/cli-import-db.ts:165-213` `reconcileAttachedTurn` → §6。
- `lib/server/cli-sync-watcher.ts:33/86/108` `importCliSessionFromJsonl(path)` 调用 → 改 `importCliLineage(sid)`。
- `app/api/cli-sync/attach/route.ts` GET 返回的 `sourceJsonlPath`（root，不变）；attach POST 走新 attachSession（签名不变）。
- `deleteSession`（`repo.ts:413-433`）：不改（origin 闸已挡 jsonl unlink；FK cascade 清 lineage）。**复核**：cli-import 节点只有 root 设 claude_session_id，且 deleteSession 对 cli-import 跳过 unlink，安全。

## 8. 验收（用 fixture，不需要真 claude binary）

**自动化 fixture 测**（核心 union 逻辑，写成 `npm run build` 之外的一次性 node 脚本或临时测试，验完即清）：
1. 在临时 dir 手造 jsonl（真实字段：`type`/`uuid`/`parentUuid`/`timestamp`/`sessionId`/`message`，参照真实 jsonl 一行的形状）：
   - `rootA.jsonl`：turn n1→n2→n3 线性（各 turn = 1 条真 user 文本 entry + 1 条 assistant entry）。
   - `forkB.jsonl`：**复制 n1/n2/n3 同 uuid**，再接 n5→n6（新 uuid，n5.parentUuid = n3 的末条 message uuid），`sessionId` 字段 + 文件名都换成 B 的 sid。
2. 走真实 attach 流程（`attachSession(rootA路径)`）→ 断言：
   - `cli_lineages` 有 2 行（rootA is_root=1、forkB is_root=0）。
   - 该 session 节点集 = {n1,n2,n3,n5,n6}（**5 个，n1/n2/n3 不重复**）。
   - parent 链：n5.parentId = n3，n6.parentId = n5；n1/n2/n3 线性。
   - siblingIndex 无冲突。
3. 模拟 CLI `/branch`：再造 `forkC.jsonl`（共享 n1/n2，接 n7）丢进 dir → 调 watcher 的 reimport/新 fork 检测 → 断言 trellis 多出 n7（parentId=n2），`cli_lineages` 3 行。
4. `detachSession(rootSid)` → 断言 session/nodes/lineage 全清，**3 个 fixture jsonl 文件仍在**（origin 闸）。
5. 清理临时 dir。

**回归门（必须全绿，证明没弄坏已上线功能）**：
- `npm run build` ✓。
- 既有真实 attached 会话（迁移后）：`GET /api/cli-sync/attach` 仍列出、`loadSession` 仍出树、源 jsonl 追加一行 → watcher 仍自动同步（curl `/api/cli-sync/events` 收到 `session_updated`）。
- attach 一个真实单 jsonl 会话（无 fork）→ 行为与改造前一致（退化成单成员 lineage）。

## 9. Stop when / Pause if

- **Stop when**：§8 fixture 测全过 + 回归门全绿 + `npm run build` ✓。不做 P2 的任何东西，不重构无关代码。
- **Pause if**（停下问人，别擅自扩范围或绕过）：
  - 发现 fork-session 实测假设不成立（fork jsonl 不共享 turn uuid、或不在同 dir）→ 分组算法地基塌，停。
  - 需要改 `getRootResumeIdForNode` / `repo.ts` SessionRow / `lib/types.ts` Session 才能跑通 → 说明边界判断错了，停。
  - 既有 attached 会话迁移后无法无损加载 → 停。
  - 解析器 `cli-import.ts` 需要改内核 → 停（P1 说好不动它）。
