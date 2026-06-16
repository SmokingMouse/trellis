# CLI Session 同步（本地 Claude Code 会话 → trellis 镜像）

## 状态：per-session attach + 真双向，全部落地 + dev 验证（分支 `feat/cli-session-sync`，未 commit）

> 设计经一次推翻：从"按目录批量只读镜像"改为"用户手选 attach + 两侧都能续聊"。
> 决策见 `decisions.md`（2026-06-16 两条）。下面是最终架构。

**最终架构（四件 + 对账）**
- 解析器 `lib/server/cli-import.ts`（纯函数，jsonl→Q/A 树）：批量 2243 真 jsonl → 2207 解析、
  0 崩溃、0 悬挂。节点 id = jsonl turn uuid（单一命名空间，双向收敛的关键）。
- DB 落地 `lib/server/cli-import-db.ts`：`importCliSessionFromJsonl`（幂等 upsert，根节点设
  `claude_session_id`=源 sid 供 resume）+ `trellisOwnedSessionIds`（防回环去重）+
  `reconcileAttachedTurn`（身份对账）。schema：sessions 加 `origin/source_jsonl_path/synced_uuid`。
- 发现 `lib/server/cli-discover.ts`：两级懒加载（项目目录 → 目录内会话摘要），排除自有 + 已 attach。
- watcher `lib/server/cli-sync-watcher.ts`：按 attached session 派生监听目录，fs.watch 增量、
  600ms debounce、只同步 attached 文件。`attachSession/detachSession`。`instrumentation.ts` boot 起。
- API：`/api/cli-sync/discover`（GET 清单）、`/api/cli-sync/attach`（GET 已 attach / POST attach·detach）。
- UI：`components/CliAttachPicker.tsx`（picker 弹窗）+ SessionSidebar 入口按钮 + CLI 角标。
  store 加 `bumpSessionsRevision`。续聊对账走 `run-bus` finalize → `reload_session` 事件 → 客户端重载。

**双向语义**
- CLI→trellis：watcher 监听 attached jsonl，CLI 侧新轮 ≤1s 自动导入。
- trellis→CLI：attached = project 模式，续聊走 `getRootResumeIdForNode` resume 真实 claude 会话、
  写回同一 jsonl；done 后 `reconcileAttachedTurn` 删临时流式节点、让 canonical jsonl-uuid 节点接管
  （轮询 import 直到落库），广播 `reload_session` 让客户端拿正确 id。**实测：trellis 续聊 → jsonl 从
  1 turn 变 2 turn（PONG 写回），DB 2 节点全 jsonl-uuid、0 临时残留。**
- **物理约束**：同一会话别在 CLI 和 trellis 同时各聊一轮（抢 append）；串行无碍。picker 底部有提示。

**dev 端到端验证全过**：discover 60 项目 / per-dir 清单 ✓；attach（mode=project + claude_session_id 设）
✓；watcher attached 文件追加自动同步、非 attached 不碰 ✓；detach 源 jsonl 存活 ✓；真实续聊写回 +
对账无重复 ✓；浏览器实测 picker/attach/detach/CLI 角标全过 ✓。`npm run build` ✓。

**待办**：部署 prod（重启 launchd `com.smokingmouse.trellis`）。

**设计注记**
- attached 会话本质线性（jsonl 不记 trellis 的树）：续聊应在 tip 进行；在历史中间分叉会被 claude 线性
  追加到 tip、重导后落在线性位置（非分叉点）。可接受，符合 CLI 会话本质。
- watcher 每次文件变更 = 全量重解析该 jsonl + upsert（synced_uuid 命中则跳过）；live session 高频
  append 下每 debounce 重解析整文件，≤3MB 可接受；真成瓶颈再上按 offset 增量。

## Verified Facts（已验，别再猜）

- **CLI session「live 感知」用活动信号、不用进程检测**：实测进程检测不可靠——claude CLI 不稳定
  持有 jsonl 打开（lsof 抓不到），且 CLI 进程混在 Claude.app 一堆 Electron 进程里难区分。
  可靠且更简单的信号 = **SSE `session_updated` 事件**（jsonl 正被写 = claude 正在驱动 = live）。
  实现：`hooks/useCliSyncEvents` 收事件 → `markSessionLive(id)` 续期 12s（`LIVE_TTL_MS`），
  SessionSidebar 角标在 live 期间显「● live」脉冲、停写自动褪回「CLI」。零新后端，复用现成事件流。
  实测：追加 jsonl → 2s 内 live、停 13s 褪去。
- **实时无刷新链路（Session 38 建）**：watcher reimport → `publishCliSessionUpdated` →
  `/api/cli-sync/events` SSE → `useCliSyncEvents`（挂在 app/page.tsx）→ 当前打开的 attach
  session 自动 `loadSession` 重载。实测 curl 验证事件 1s 内推出。

- **CLI jsonl 用 `type:"system"` 边界节点承载 turn 间父链**：compact / context 摘要会插一条
  `{type:"system", subtype, messageCount, durationMs}` 的 entry，下一条真 user turn 的
  `parentUuid` 指向它。**解析时若只保留 user/assistant，父链会在此断裂、每个 turn 退化成孤根。**
  修法：`byUuid` 必须收**全部带 uuid 的 entry**，让 ownerTurn 上溯时穿过 system 节点继续走
  （`cli-import.ts` byUuid 构建处）。Stage A 实测踩到（14 turn 全成孤根），根因即此。
- **resume/用量限制打断 → 同一问题重复出现**：会成为同一 parent 下的兄弟 turn（一个空回答=被
  打断的那次，一个有真回答）。镜像里保留为 siblings，符合 trellis B-fork 兄弟模型。
- **attach 的删除 hazard 与解法**：`deleteSession`/删节点按 `claude_session_id` 列
  `fs.unlinkSync(claudeSessionPath(...))` 删 jsonl —— 对 attach 会话那 path 是用户**原始 CLI 历史**。
  但 attach 又**必须**给根节点设 `claude_session_id`（resume 续聊要）。解法：保留设值，靠
  `deleteSession` 对 `origin='cli-import'` 跳过 jsonl unlink 来挡（detach=删 trellis 侧 session，
  实测源 jsonl 存活）。per-node 删除路径只对根有 claude_session_id，但根删除走 deleteSession 闸；
  续聊新轮（branch）本就无该列，天然安全。

## 动机

trellis 的北极星是「替代 Claude Code CLI」。但用户在 CLI 里已经积累了大量本地会话
（`~/.claude/projects/<encoded-cwd>/<session_id>.jsonl`，本机 88 个 project 目录），
这些历史此刻完全进不了 trellis——既搜不到、也看不到树状结构。本功能把选定的 CLI 会话
**持续实时镜像**进 trellis，让 CLI 重度用户的历史在工作台里可浏览、可搜索、可导出。

承接 [session-workbench](session-workbench.md) 的「承载更多工作」方向：不只是新会话在
trellis 里跑，连存量 CLI 历史也收编进来。

## 范围口径（已定）

- **opt-in 选择器**：用户勾选要镜像哪几个 project 目录（或具体会话），只 watch 这些。
  88 个目录全量镜像会把 session 列表瞬间淹掉，故不做全量。
- **只读镜像，v1 不续聊**：用户要的是「持续实时同步」。续聊会和 CLI 进程抢写同一个
  jsonl → 冲突。所以 v1 = 只读镜像（浏览/搜索/导出）。续聊留作单独 Stage（走
  `--fork-session` 复制一份再聊，不碰原 jsonl）。

## 数据流

```
~/.claude/projects/<dir>/<sid>.jsonl
   │  (fs.watch 增量)
   ▼
解析器 cli-import.ts  ──collapse──▶  Q/A 节点树
   │                                    │
   │  排除 trellis 自己 spawn 的 sid     ▼
   └──────────────────────────▶  sessions(origin='cli-import') + nodes + search_index
```

## jsonl → 节点 映射（解析规则）

每行一条 entry，带 `parentUuid` 串成链（rewind/edit 才分叉）。collapse 规则：

| jsonl entry | → | trellis |
|---|---|---|
| 真·user 文本消息 | → | 新节点的 `question` |
| 后续 assistant 的 `text` 块（拼接） | → | `response` |
| `tool_use` 块 + 配对的下一条 user `tool_result` | → | `tool_calls_json`（`ToolCall[]`，复用 Stage 17 渲染） |
| `parentUuid` 链 | → | `parentId`；同一 parent 多 user-turn 子 = 兄弟节点（`sibling_index`） |
| 该 turn 末条 assistant 的 `message.usage` | → | token 四桶 + `token_context` |
| jsonl 文件名（= session id） | → | 根节点 `claude_session_id`（为日后续聊留绑定） |

**一个「turn」= 一条真·user 文本消息，到下一条真·user 文本消息之间的所有 assistant 行。**

### 必须过滤的噪音行（不是真 user turn）

- `<local-command-caveat>…`、`<command-name>/clear</command-name>` 等命令注入行
- content 是 `tool_result` 数组的 user 行（属于上一个 turn 的工具回填，不开新节点）
- `type` ∈ `{system, attachment, mode, file-history-snapshot, last-prompt, ai-title,
  permission-mode}` 的非对话行
- assistant 的 `thinking` 块：v1 丢弃（trellis 本就不存 thinking，D4 blocked）

### sidechain（subagent）

`isSidechain=true` 的行是 subagent 运行轨迹。v1 **丢弃**（或折叠进触发它的 `Task`
工具调用 output），不单独建子树。Stage 22「subagent 子树可视化」是独立功能，不在本范围。

## 防回环去重（翻盘性风险，已排掉）

trellis 自己 spawn claude（chat B-fork / workspace / project）也往 `~/.claude/projects/`
写 jsonl。全量扫会把 trellis 自己的会话再导回来 → 重复 + 回环。

**排除键**：trellis 把自己造的每个 claude session id 都存在
`nodes.claude_session_id` / `nodes.codex_session_id`，而 jsonl 文件名就是 session id。
同步时跳过任何「文件名（去 `.jsonl`）∈ 已知 trellis session id 集合」的文件。干净可靠。

```sql
SELECT claude_session_id FROM nodes WHERE claude_session_id IS NOT NULL
UNION SELECT codex_session_id FROM nodes WHERE codex_session_id IS NOT NULL
```

## Schema 变更（幂等 ALTER，沿用现有 migration 风格）

`sessions` 表加三列：

| 列 | 含义 |
|---|---|
| `origin TEXT NOT NULL DEFAULT 'native'` | `'native'`（trellis 原生）/ `'cli-import'`（镜像） |
| `source_jsonl_path TEXT` | 镜像源 jsonl 绝对路径（增量重读用） |
| `synced_uuid TEXT` | 上次同步到的末行 uuid（增量游标，避免每次全量重解析） |

镜像 session 的根节点 `claude_session_id` = 源 session id，但**不进**上面的去重集合
查询会自动排除——因为去重查的是 trellis 自己 spawn 的，镜像 session 的 origin 是
`cli-import`，查询需排除 `origin='cli-import'` 的行，否则镜像 session 会把自己的源
文件也加进排除集（无害但混淆）。查询加 `AND origin != 'cli-import'`（或 JOIN sessions）。

## 实时 watcher

- **启动点**：`instrumentation.ts` 的 `register()`（Next server 启动钩子）拉起单例 watcher。
  备选：复用 `lib/server/sqlite.ts` `getDB()` 首调 boot 路径（但那要等首个请求）。优先
  instrumentation——无请求也能 watch。
- **监听**：对每个 opt-in 目录 `fs.watch`（macOS 原生 FSEvents，递归）。jsonl 变更 →
  debounce（CLI 高频 append，~300ms 合并）→ 从 `synced_uuid` 之后增量解析 → 追加/更新
  节点 + 写 `search_index`。
- **幂等**：节点 id 由 `(session_id, turn 首条 user uuid)` 派生（确定性），重复同步 upsert
  不产生重复节点。
- **新会话发现**：opt-in 目录里出现新 jsonl（非 trellis 自己的）→ 自动建镜像 session。

## API + UI

- `GET /api/cli-sessions`：列出可镜像的 CLI 会话（扫 opt-in 目录，排除 trellis 自有 +
  已镜像，返回 cwd / 标题（首条 user 文本截断）/ 行数 / mtime）。
- `POST /api/cli-sync/dirs`：增删 opt-in 目录（持久化在哪？→ 新表 `cli_sync_dirs` 或
  复用一个 settings kv；倾向新表，简洁）。
- UI：设置/命令面板里一个「镜像 CLI 会话」入口 → 目录多选 + 已镜像列表。镜像 session 在
  SessionPicker / SessionTabs 打 origin 标（只读镜像，禁止发新问题，输入框 disable + 提示）。

## 分阶段实施

- **Stage A**：解析器 `lib/server/cli-import.ts` + 一次性导入函数。CLI 脚本跑通单个 jsonl
  → 节点树，验证 collapse / 去重 / 分叉正确（证据：拿本项目某个真 jsonl 导入，节点数/
  父子关系/工具调用对得上）。**先不碰 UI、不开 watcher。**
- **Stage B**：实时 watcher（instrumentation 启动 + 增量游标 + debounce + upsert 幂等）。
- **Stage C**：opt-in 选择器 UI + `/api/cli-sessions` + 镜像标记 + 只读门禁。
- **Stage D（独立，可选）**：续聊——从镜像 session 某节点 `--fork-session` 复制成原生
  session 再聊，不碰源 jsonl。

## 开放问题

- Q1：镜像 session 的 mode 标什么？源 jsonl 的 cwd 决定 → 有 cwd 标 `project`、无标
  `chat`？还是统一新 mode `mirror`？倾向复用 `project` + origin 标，不新增 mode。
- Q2：opt-in 目录持久化——新表 vs settings kv。倾向新表 `cli_sync_dirs(path, added_at)`。
- Q3：大 jsonl（实测最大 2.8MB / 1584 行）首次导入性能——同步解析够快还是要分批？
  Stage A 实测后定。
- Q4：源 jsonl 被用户手动删除/`/clear` 后，镜像 session 怎么办？保留（历史快照）还是
  联动删？倾向保留 + 标「源已失效」。
