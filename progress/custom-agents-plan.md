# Trellis Agent 管理 + 自动化任务

> **状态（S87 收尾）**：A1-A4 + T1-T4 **全部已实现并实测**。本文保留为设计依据与
> 决策理由的存档 —— 落地过程中被实测推翻/修正的地方，以 `progress/facts.md` 和
> `sessions.md` 的 S87 条目为准（尤其：`strictMcp` 救不回 MCP、技能需要 `Skill`
> 工具、spawn ENOENT 逃出 try/catch、instrumentation 不共享模块实例四条）。
> 唯一未做：**SDK 发 npm**（对外不可逆，待用户确认）。

## Context

Trellis 目前只能「用默认人设跟 claude 聊天」：system prompt 是 6 个硬编码预设、创建时锁定、且 project 模式被强制置 null；skill 只是前端把 `/name` 补全进输入框；子 agent 只渲染不定义；全仓没有任何定时/后台任务机制。

要做的是一层**可复用的 Agent 抽象**——把「提示词 + 模型 + 技能 + 工具 + 隔离度」冻结成一个有 id 的实体，然后让它成为后续能力的公共底座：本轮的「开会话选人设 / @提及派活 / 定时任务」，以及下一步的「飞书群绑定 / 多 agent 讨论组」。**抽象对不对比这轮做多少更重要。**

### 已实测的底层能力（claude CLI v2.1.207）

底层不是 SDK 是 `spawn("claude")`（`@smokingmouse/agent` 的 `ClaudeBackend`）。四条已跑通：

| 能力 | 命令 | 结果 |
|---|---|---|
| 内联注入 agent 并激活为**主 agent** | `--agents '{...}' --agent tester` | ✅ prompt / model / tools 全生效 |
| 任意路径绑定 agent + skill | `--plugin-dir <pack> --agent zoro` | ✅ |
| 按 agent 裁剪技能 | `--plugin-dir <pack> --setting-sources=` | ✅ pack 内 skill 可用，本机 80 个 skill 全不可见 |
| 坑 | `--safe-mode` | ❌ 会连 `--agents` 一起禁掉，不可混用 |

**缺口全在 SDK 包装层**：`RunOptions`（`~/sdk/packages/agent/src/backend.ts:20-114`）没有 `agent` / `agents` / `pluginDirs` / `disallowedTools` / `extraArgs` 字段。CLI 侧一个都不缺。

---

## 一、六条架构决策

1. **DB 为真相源，spawn 时物化。** `agents` 表存定义；无技能的 agent 走 `--agents` 内联 JSON（零 fs 操作），有技能的才物化成 plugin dir 走 `--plugin-dir`。**这条把最脆的物化逻辑从关键路径上摘掉了**——现有 5 个预设全部属于无技能档。

2. **`agent_id IS NULL` 就是「默认 Agent」，不建行。** 执行链写成 `if (agentId) { 新逻辑 } else { 今天的代码一行不改 }`，物理上杜绝默认路径回归。

3. **隔离度按 agent 可选。** 默认 Agent 不隔离（读 CLAUDE.md / 全局 settings / 本机全部 skill + MCP）；自定义 Agent 默认隔离（`--setting-sources=`）+ 一个「继承本机环境」开关。

4. **agent 只改「人设 + 能力面」，绝不碰「上下文与身份」。** `workspace` / `cwd` / `resume` / `forkSession` / `persistence` / `attachments` / `onCanUseTool` 原封不动——这是不撞坏 chat B-fork 与 project per-lineage isolation 的安全带。

5. **任务与 cron 同一张表、同一条执行路径，只有触发器不同。** 触发器**独立成表**（一对多），所以「每天 9 点自动跑 + 我想随手点一下」是同一个任务；未来飞书群只是多一个 `kind='lark'` 的 trigger 行。

6. **任务执行落在 session/nodes 上，不另造渲染。** 每个任务一个常驻会话（`sessions.kind='task'`，从主侧栏隐藏），每次执行 = 一个平行根节点。用户点进去看到的界面与自己手动提问完全一样，还能就地分叉追问。

---

## 二、数据模型

全部加进 `lib/server/sqlite.ts:28 migrate()`，沿用既有风格（`CREATE TABLE IF NOT EXISTS` + `pragma_table_info` 探测 ALTER）。**`PRAGMA user_version` 不动**（无数据改写）。

```sql
-- Agent 定义
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,        -- @提及名 + --agent 值 + pack 内文件名；^[a-z0-9][a-z0-9-]{0,31}$
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  system_prompt TEXT NOT NULL DEFAULT '',
  model TEXT,                       -- NULL = 跟随会话
  tools_json TEXT,                  -- NULL = 不限制
  disallowed_tools_json TEXT,
  skills_json TEXT,                 -- SkillRef[]，见下
  inherit_env INTEGER NOT NULL DEFAULT 0,
  permission TEXT, require_approval INTEGER,   -- NULL = 跟随会话
  builtin INTEGER NOT NULL DEFAULT 0,          -- 可改可停用，不可删
  enabled INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 任务定义（= agent + prompt + workspace 冻成一个按钮）
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, name TEXT NOT NULL,
  agent_id TEXT,                    -- 刻意不写 FOREIGN KEY：本库 foreign_keys=ON，两表落地顺序不同会炸
  prompt TEXT NOT NULL,
  workspace_path TEXT, context_mode TEXT NOT NULL DEFAULT 'project', model TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  home_session_id TEXT,             -- 该任务的常驻会话
  timeout_ms INTEGER NOT NULL DEFAULT 1800000,
  overlap_policy TEXT NOT NULL DEFAULT 'skip',
  notify_on TEXT NOT NULL DEFAULT 'error',
  max_budget_usd REAL, max_retries INTEGER NOT NULL DEFAULT 0,  -- 列留着，本轮不通电
  created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);

-- 触发器：手动 = 零行；cron/fs/git/session_done/(未来)lark 各一行
CREATE TABLE IF NOT EXISTS task_triggers (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  config_json TEXT NOT NULL,        -- cron:{expr} fs:{dir,ext,debounceMs} git:{repoPath,branch,pollMs}
  last_fired_at INTEGER, cursor TEXT,
  created_at INTEGER NOT NULL
);

-- 每次执行的留档
CREATE TABLE IF NOT EXISTS task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  trigger_id TEXT, trigger_kind TEXT NOT NULL,
  status TEXT NOT NULL,             -- pending|running|done|error|timeout|skipped|aborted
  session_id TEXT, node_id TEXT,    -- node_id 是通往全部既有渲染的钥匙
  scheduled_for INTEGER NOT NULL,   -- ★ 必须对齐到整分钟的槽位时间戳，不是 Date.now()
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER, ended_at INTEGER, error_message TEXT,
  prompt_snapshot TEXT, agent_id_snapshot TEXT,
  token_input INTEGER NOT NULL DEFAULT 0, token_output INTEGER NOT NULL DEFAULT 0,
  notified_at INTEGER, created_at INTEGER NOT NULL
);

-- ★ 抢槽去重：一个 trigger 的一个槽位全库只能有一条 run。多进程 tick / 重启 catch-up
--   重复计算都撞在这里。partial index 让手动触发（trigger_id IS NULL）不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS task_runs_slot
  ON task_runs(trigger_id, scheduled_for, attempt) WHERE trigger_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS scheduler_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), last_tick_at INTEGER NOT NULL
);
```

探测式 ALTER（照 `sqlite.ts:369-393` 的 `lineage_isolation` 写法）：

```sql
sessions.agent_id  TEXT REFERENCES agents(id) ON DELETE SET NULL  -- SET NULL 不是 CASCADE：删 agent 不连坐删历史
sessions.kind      TEXT NOT NULL DEFAULT 'user'                   -- 'user' | 'task'
nodes.agent_id     TEXT      -- 这一轮实际由谁答
nodes.agent_scope  TEXT      -- NULL | 'session' | 'mention'
```

`lib/server/repo.ts:327 listSessions` / `countArchivedSessions` 加 `AND kind='user'` 过滤。

**技能怎么存**：`skills_json` = `{kind:"host", name}` 判别式数组，只引用本机 `~/.claude/skills/<name>`。**明确不做「在 Trellis 里写 skill 正文」**——本机真实 skill 全是多文件包（`scripts/` `references/` 带可执行脚本），Web textarea 只能产单文件 SKILL.md，覆盖不了主场景。schema 留 `kind:"inline"` 判别位不实现。

---

## 三、阶段 0：三个实测 ✅ 已完成（结论已落 `progress/facts.md`）

1. **symlink skill 可被 `--plugin-dir` 加载** ✅ → content hash 只含技能**名字列表**，skill 正文改动自动跟随、永不重物化。两个命名细节：skill 名取**目录名**不取 frontmatter 的 `name`；列表里带 plugin 前缀显示为 `trellis-pack:linked-zebra`。
2. **`--agents` + `--agent` + `--setting-sources=` 三者同给** ✅ 组合生效。
3. **❌ 推翻原设计：`--setting-sources=` 会连本机 MCP 一起砍掉，`--strict-mcp-config` 与此无关。** 判据取 `stream-json` 首条 `system/init` 的 `mcp_servers`/`tools`（问模型「你有哪些工具」不可靠，基线也答 NONE）。基线 = `mcp_servers:[{codex,connected}]` / 28 tools / 141 slash_commands；加 `--setting-sources=` → `[]` / 25 tools / **38 slash_commands**；再加 `--strict-mcp-config` **数字一模一样**。
   **后果**：拆 SDK 的 `strictMcp` 开关救不回 MCP。**「隔离」的定义因此变成「无 CLAUDE.md + 无本机 skill + 无 MCP」三件套**，这是产品事实不是技术债，必须写进 UI 文案。要给隔离 agent 配 MCP 只能显式 `--mcp-config`（= 原推迟项「agent 级 MCP 配置」，它从「锦上添花」升级为「隔离 agent 想用 MCP 的唯一出路」）。
   附带发现：内置 plugin skill（`deep-research`/`dataviz`/`verify`/`code-review` 等）在隔离下**仍然存在**；cwd 会影响 MCP 装载（同命令在 `/tmp` 下 codex server 停在 `pending`，在仓库目录才 `connected`）。

---

## 四、SDK 改动与发布链

### 改什么（一次改完，只发一次版）

`~/sdk/packages/agent/src/backend.ts` 的 `RunOptions` 加 6 个字段：
`agent?: string` · `agents?: Record<string,unknown>|string` · `pluginDirs?: string[]` · `disallowedTools?: string[]` · `strictMcp?: boolean` · `extraArgs?: string[]`

`~/sdk/packages/agent/src/backends/claude.ts:92-131` argv 拼装，插在 `--tools`(`:124`) 之后、`--workspace`(`:127`) 之前，**顺序焊死在 SDK 里**（plugin 先注册，`--agent` 才选得中）：
```
--plugin-dir(可重复) → --agents → --agent → --disallowedTools → ...extraArgs
```
外加三处小改：`:117-123` 拆出 `strictMcp`（**注意：阶段 0 实测证明它救不回 MCP，加它只为语义正确 + 未来配 `--mcp-config` 时能用，不再是「保留本机 MCP」的手段**）；`:113-116` 加 `environmentSkills===false` 与 agent 系字段的互斥保护（防 `--safe-mode` 静默吃掉 `--agents`，实测会报 `--agent 'x' not found`）；`capabilities():64` 加 `customAgents: true` 供 trellis 做版本探测。

**`extraArgs` 是核心价值**：它把发布链从「每次加 flag 发一次版」降成一次性成本，后续 `--max-budget-usd` / `--effort` / `--mcp-config` 全不用再发版。约束：只允许在 `lib/llm/sdk-adapter.ts` 一处构造、只从结构化 DB 字段派生，绝不接用户自由文本（否则可从后门塞 `--dangerously-skip-permissions` 绕过审批闸）。

### 发布链（已核实，比预想的更硬）

- `make setup` = `bun install + check`，**`SDK_HOME` / `SDK_REPO` 被完全忽略**——`update-trellis.sh:67` 传了也没用，BOE 上那个 sm-toolkit checkout 目前根本没接进 trellis。
- `make link-sdk` 只对 `make dev` 有效。`make deploy` 会在新 release 目录里跑 `bun install`，**本机 prod 部署同样会回到 registry 版本**。

所以：**开发期 `make link-sdk` 本机迭代；任何一次 `make deploy` 之前必须先 `npm publish`。** 一次性发 0.4.0，之后靠 `extraArgs` 免于再发。

**静默失效是这里最大的风险**：SDK 版本不对时，多传的字段被 TS 结构类型放过、被运行时无声丢弃 → agent 完全不生效但 spawn 正常、回答正常。缓解（约 10 行，强烈建议做）：`instrumentation.ts` 里探测 `capabilities().customAgents`，为假就 `console.error` + 在 `/settings/agents` 顶部挂红色横幅。

---

## 五、执行链改造

### `modeToRunOptions` 不新增分支

现有三分支（`sdk-adapter.ts:78-95` 纯 chat / `:63-70` enhanced / `:102-110` project）一行不改，改成统一后处理：

```ts
export function modeToRunOptions(mode, model, req): RunOptions {
  const base = /* 现有三分支，原样 */;
  return req.agent ? applyAgent(base, req.agent) : base;
}
function applyAgent(base: RunOptions, a: AgentSpawn): RunOptions;
```

`applyAgent` 规则：

| 字段 | agent + 隔离（默认） | agent + 继承环境 |
|---|---|---|
| `agent` / `agents` / `pluginDirs` | 按 spawn plan 二选一 | 同 |
| `systemPrompt` | **删掉**（与 `--agent` 互斥，agent 赢，不做叠加） | **删掉** |
| `settingSources` | `false` | 不动 |
| `strictMcp` | 不传（实测证明它救不回 MCP；隔离 = 无 MCP，UI 文案讲明白） | 不适用 |
| `tools` / `disallowedTools` / `model` / `permission` / `askTools` | agent 显式配了才覆盖，否则保持原值 | 同 |
| `workspace` `cwd` `resume` `forkSession` `persistence` `attachments` `env` `onCanUseTool` | **原封不动** | **原封不动** |

**不与 `chat/route.ts:283-291` 的 project systemPrompt 钳制打架**：那段一行不改，agent 走全新的 `sessions.agent_id` 通道，两条路独立。存量会话零风险、零迁移。

### 会话人设的继承与生命周期

`app/api/chat/route.ts` 加 4 处 `resolvedAgentId`，与 `resolvedSystemPrompt` / `resolvedRequireApproval` 完全同构：并行 root(`:263`) 取 `existing.agentId` · 新建 root(`:288`) 取 body + 钳制 · branch(`:352`) / retry(`:380`) 取父 session。`:410-610` 的 resume id 路由**一行不改**。

- **创建时锁定，不可中途改**（同 mode / workspace / require_approval 的既有纪律）。顺手消灭一个未知：`--resume` + `--agent` 的行为 CLI 没文档。想换人设的出口是 @提及或开新会话。
- **agent 定义被改 → 老会话用新定义（live 引用）**。用户改 agent 的动机 100% 是「上次答得不好，改了再问」，快照与直觉相反。代价是丢失历史复现，用 `nodes.agent_id` 每轮落一份兜底（至少知道哪轮是谁答的）。
- **codex 钳制成仅 claude family**（照抄 `:307-310`）。会话 provider 可中途改（`repo.ts:370`），切到 codex 后 agent 静默失效——UI 必须把 agent chip 变灰 + tooltip 说明，否则是谎言级 UI。

### @提及派活

单独起进程：`persistence:false` + `resume:null` + `forkSession:false`，`cwd` 仍取 `spawnCwd`。**不 resume 主线**（会把外援人设写进主线 CLI session）、**不 fork**（会在 jsonl 目录留孤儿 session 让 `nativeLineageForNode` 认错 tip）。上下文靠现成的 `buildHistoryForNode(nodeId, {maxDepth:4})`（`chat/route.ts:468-470` 已有这条降级路径），零新代码。

`nodes.agent_scope='mention'` 标记 → `TurnCard.tsx` 答案区头部一枚 🤖 chip（**仅 mention 显示**，会话级显示在 Header 的 ModeBadge 上，否则每张卡都挂一枚是噪音）。

与 `/skill` 补全不冲突：现有两个匹配器都硬绑开头的 `/`（`useSkillSuggestions.ts:24` / `lib/commands.ts:150`），新 `hooks/useAgentMentions.ts` 用 `/^@([^\s]*)$/`，两个正则永不同时命中。**只解析开头的 @**（句中提及要处理转义/多提及/邮箱误触，复杂度爆炸且不符合「单轮定向」语义）。

### 物化（`lib/server/agent-pack.ts`）

内容寻址：`~/.trellis/agent-packs/<agentId>/<contentHash>/`。hash 命中 = 目录已存在 = 直接用，一次 `existsSync` 就够。并发安全靠**写临时目录 + 原子 rename**，撞 `EEXIST` 视为「别人已建好」，不需要锁。清理 = 每次成功物化后 best-effort 删掉同 agent 下非当前 hash 且 mtime > 24h 的兄弟目录（24h 保证不删掉长跑 run 正在用的旧 pack）。

物化调用点在 `app/api/chat/route.ts`（解析完 agent、`startRun` 之前），**不放进 `sdk-adapter.ts`**——那层至今是纯函数无 IO 且被 codex 共用。

```ts
export type AgentSpawnPlan =
  | { via: "inline"; slug: string; agentsJson: string }
  | { via: "plugin"; slug: string; pluginDir: string; hash: string };
export function resolveAgentSpawn(a: AgentRecord): AgentSpawnPlan;   // 幂等
```

---

## 六、调度器

### cron：自己写匹配器，不引依赖

`lib/server/cron.ts` 纯函数。**不写「推算下一次触发」的算法，写「这一分钟匹不匹配」的匹配器**——彻底绕开月末/跨年/`dom`&`dow` OR 语义这些最容易写错的边界。catch-up 也用同一个匹配器逐分钟回扫（1440 次 Set 查表，微秒级）。支持 `*` `*/n` `a,b,c` `a-b` 五字段，不做秒级/`L`/`W`/`#`。时区一律服务器本地（两台机器都在 `Asia/Shanghai`，无 DST），`config_json` 留 `tz` 字段不实现。

```ts
export function parseCron(expr): CronFields | null;
export function cronMatches(f, d: Date): boolean;
export function describeCron(expr): string;              // → "每个工作日 09:00"
export function nextFireAfter(f, from: Date): number | null;   // 仅供 UI 回显
```

### `lib/server/task-scheduler.ts`

挂在 `instrumentation.ts:register()` 末尾（紧跟 `startCliSyncWatcher()`），照 `started` 守卫做幂等。

- **tick 60s，但首次对齐到整分钟边界 +2s 再起 interval**。不对齐的话 09:00:58 启动的进程会永远踩不准 `0 9 * * *`。
- **去重靠 `task_runs_slot` 唯一索引抢槽**（`claimSlot()` 返回 runId 或 null）。**不做进程租约**——索引已保证正确性，租约只换来日志干净，代价是多一张表 + 心跳 + 过期判定 + 一类新故障（租约卡死→全库不调度）。
- **两台实例不共享 DB**（`BOE_HOME` 是独立 `$HOME`，`PROD_DB` 各自解析），跨机器双触发不存在。代价是任务定义不互通——**这是对的，`workspace_path` 本来就是机器本地路径**，UI 上讲明白即可。
- **catch-up 只补窗口内最近一次**，窗口 6h（模块常量，不做配置项）。不全补：`*/10` 挂一夜 → 开机瞬间 144 个 run 排队烧光 token。不完全不补：定时任务的价值就是「我睡了它也跑」，而崩溃退避重启和 `make deploy` 都是常态。
- **并发上限 2**，只管任务 run，**不看用户交互 run**（否则用户开三个 tab 就把定时任务饿死；反过来用户提问也永远不该被后台任务卡住）。
- **`overlap_policy='skip'` 必须写一条 `status='skipped'` 的留档**，否则用户看到的是「今天怎么没跑」的静默黑洞。`queue`/`kill` 两档列留着、UI 灰掉（语义没想清楚：queue 排到什么时候过期？kill 掉正在 Edit 的 agent 半个文件怎么办）。

### 部署闸（必做）

`scripts/deploy.ts:396 smoke()` 会 `VACUUM INTO` 出一份**真数据快照**再起一个完整实例（`:415` env）——它会加载 `instrumentation.ts`、看到真任务表、**真 spawn claude 去跑**，花真钱动真 workspace。必须：`startTaskScheduler()` 开头加 `if (process.env.TRELLIS_SCHEDULER === "off") return`，并在 smoke env 里加 `TRELLIS_SCHEDULER: "off"`。

---

## 七、可靠性

### `run-bus` 唯一的改动：`onSettled` 钩子（约 5 行）

```ts
// lib/server/run-bus.ts:245 startRun 的 args 增加
onSettled?: (r: { status: "done"|"error"; errorMessage?: string; usage: {...} }) => void;
```

调用点在 `:562` 的 finally 内、**`:587 finalizeNode()` 之后**（早了任务层读到旧状态）、**`:651 reconcileAttachedTurn` / `:663 backfillNativeTurnUuid` 那串 best-effort import 之前**（晚了通知要等数秒，且那些块任一 hang 住通知就永远不来）。整段 try/catch 吞异常。

### boot reap 必须成对（漏了会静默瘫痪整个功能）

`sqlite.ts:546-552` 那条无差别 `UPDATE nodes SET status='error' WHERE status='streaming'` 把任务节点标 error 是**事实正确**的。真正的问题是 SIGKILL 时 `onSettled` 一次都不跑 → **`task_runs` 那行永远卡在 `running` → `overlap_policy='skip'` 永久跳过后续所有执行**。

必须在紧邻位置加对称的一条（**放在 `migrate()` 里而不是调度器启动时**——`getDB()` 触发 migrate 远早于 instrumentation，分开会开出一个「节点已 error 但 run 仍 running」的不一致窗口）：

```sql
UPDATE task_runs SET status='error', error_message='interrupted', ended_at=<now>
 WHERE status IN ('running','pending');   -- pending 也要 reap，否则重启复活过期任务 = 绕过 catch-up 窗口无限补跑
```

UI 侧配套：`error_message='interrupted'` 渲染成灰色「中断」而非红色「失败」，否则一次例行部署就让整页变红。

### 超时与重试

**时间闸本轮就上**：`setTimeout(task.timeout_ms)` → `abortRun(nodeId)`（`run-bus.ts:804`），timer 句柄存模块级 Map，`finishTaskRun` 里 clear。默认 30min。
**成本闸 `--max-budget-usd` 推迟**——它要走 `extraArgs`，等 SDK 发版后再通电。**自动重试不做**（列留着）：LLM 任务失败几乎全是 prompt/环境/权限问题，盲重试是重复烧钱，用户看到原因后手点 ▶ 效率更高。

### 通知

`lib/server/notify.ts` 定义 `NotifyChannel` 接口 + `registerChannel` 扇出（逐个 try/catch，通知发不出去绝不影响任务留档）。**未来飞书群回复 = 再注册一个 channel，任务层零改动**；而「飞书消息进来当触发器」是 `task_triggers.kind='lark'`，与本层正交——这就是触发器拆表换来的红利。

本轮两个最小渠道：① 站内 SSE + toast，照抄 `lib/server/cli-sync-events.ts` / `app/api/cli-sync/events/route.ts` / `hooks/useCliSyncEvents.ts` 三个现成文件，复用 `components/DoneToast.tsx`；② `~/.trellis/notify.json` 命令模板（照 `lib/deploy-state.ts` 的「状态存文件」范例），用 `Bun.spawn` 传 argv 不拼 shell，用户填 phone-push 或 curl 都行。**`notify_on` 默认 `error`**——成功是常态，每次都推会让人一周内关掉通知。

### 事件触发

- **fs**：把 `cli-sync-watcher.ts:195` 那套（`fs.watch` + watchers Map + debounce Map + `refreshWatches()`）抽成通用 `lib/server/fs-watch-pool.ts`（约 60 行），任务层用自己的实例。**明确不动 `cli-sync-watcher.ts`**（重构它是纯风险零收益）。**只 watch 单层目录 + 后缀过滤**——Linux 的 recursive watch 是 walk 出来的、大目录很贵。
- **git**：不用 hook（侵入别人仓库、clone 不带、语义也不对），走调度器 tick 的第二条腿轮询 `git ls-remote`（比 fetch 轻得多，不落地 object）。**超时必须设**（10s，`AbortSignal.timeout` + kill），失败只 warn **不动 cursor**（动了会在网络恢复后误触发）。想监听本地提交就 watch `<repo>/.git/refs/heads` 走 fs 触发器。
- **session_done**：复用 `onSettled`。**必须防自触发**（任务自己的落点节点结束也会走这个钩子 → 无限循环烧钱）：`onNodeSettled` 开头查 `SELECT 1 FROM task_runs WHERE node_id=?` 命中即 return；建 trigger 时校验 `config.sessionId != tasks.home_session_id`。

---

## 八、UI

- **`app/settings/agents/page.tsx`** —— 整页不用 modal。编辑器要装大 textarea + 技能多选（本机上百个 skill 需搜索过滤）+ 工具白/黑名单 + 三个开关 + 模型，`ModelConfigModal` 那种 3-5 字段的 modal 装不下。建议顺手把 settings 改成左侧 tab（`更新` / `Agent`）。
- **`components/AgentPicker.tsx`** —— 原地改造 `SystemPromptPicker.tsx`，保留它那个锚定居中下拉的外壳，内容换成 agents 列表（含伪条目「默认助手」）+ 底部「管理 Agent →」。**删掉 `:76` 的 `if (draftMode !== "chat") return null`**（agent 两个 mode 都能选，这是可见的行为变更）。保留 `FEYNMAN_PROMPT` 导出（`QuestionInput.tsx:66` 靠引用相等切提示语），判据改成 `draftAgentSlug === "feynman" || draftSystemPrompt === FEYNMAN_PROMPT`。
- **`app/tasks/page.tsx`** —— 双栏：左任务列表（名字 / agent / 「下次：明天 09:00」/ 上次结果色点 / **▶ 立即运行** / 启用开关），右选中任务的运行历史。点一条 run → `router.push('/?session=<sid>&node=<nid>')` 深链回主 SPA（需要给 `app/page.tsx` 加 searchParams 支持）。新建/编辑走 `components/TaskEditorModal.tsx`（字段少，modal 合适）。
- **cron 配置：6 个预设 + 自定义 + 实时双回显**。裸 cron 串的问题不是难写而是写错了不知道——`describeCron` + `nextFireAfter` 回显「每个工作日 09:00 · 下次：明天（周三）09:00」才是关键。
- **状态：不进 `stores/sessionStore.ts`**（已 3166 行）。新建 `stores/agentStore.ts`（约 120 行，只管列表 CRUD）；`sessionStore` 只加 `draftAgentId` + `setDraftAgentId` 两个字段（与已有 `draftSystemPrompt` `:368` 严格同构，因为 `streamRoot` `:1251` 在它手里）。任务页用页面本地 state + 自轮询，照 `app/settings/page.tsx:88` 的既有模式（有活时 3s / 平时 20s）。
- **server 层新文件** `lib/server/agents.ts` / `lib/server/tasks.ts`，**不塞进 1900 行的 `repo.ts`**。

---

## 九、落地顺序

| 阶段 | 内容 | 验收 |
|---|---|---|
| **0** | 三个 CLI 实测（symlink skill / 三 flag 组合 / MCP 连带杀伤） | 三条结论落进 `progress/facts.md`，带命令输出 |
| **A1** | SDK 6 字段 + `make link-sdk`；`agents` 表 + `seedBuiltinAgents`（5 个内置）；`lib/server/agents.ts`；`/api/agents`；`applyAgent` + route.ts 4 处；`AgentPicker`（**只做选择器，编辑器后置**，测试 agent 用 curl 建） | 建一个只给 `["Read","Grep"]` 的隔离 agent，开 project 会话选它：① 人设生效 ② 拒绝写文件 ③ 本机 skill 不可见 ④ **不选 agent 的会话行为一字不变**（这条最重要，要对比一次现有会话） |
| **A2** | `agent-pack.ts` 的 `via:"plugin"` 分支（内容寻址 + 原子 rename + sweep） | agent 配一个 host skill，隔离模式下能调起，本机其余 skill 全消失 |
| **A3** | `app/settings/agents` 列表 + 编辑器；`stores/agentStore.ts`；ModeBadge agent chip + codex 灰化 | 全程点界面建 agent 并用起来 |
| **A4** | @提及：`nodes.agent_id/agent_scope`、`useAgentMentions`、`SkillPickerList` 第三组、`TurnCard` chip、route.ts mention 分支 | 会话中途 `@critic 挑刺`，结果作为节点回来且主线人格不变 |
| **T1** | `cron.ts` 纯函数 + `scripts/test-cron.ts`；三张任务表 + `sessions.kind` + **task_runs boot reap**；`tasks.ts`（含 `claimSlot` / `startTaskRun` / `finishTaskRun`）；`run-bus` 的 `onSettled`；`/api/tasks/*`；`app/tasks/page.tsx`（**先只支持手动触发**）；`app/page.tsx` 深链 | 建任务「在 X 目录跑 git log 并总结这周改了什么」→ 点 ▶ → 看到 run 走完 → 点进去在主 SPA 里看到完整工具卡片，且能就地分叉追问 |
| **T2** | `task-scheduler.ts`（对齐 tick + catchUp）+ `instrumentation.ts` 挂载 + `TRELLIS_SCHEDULER=off` 闸 + `deploy.ts` smoke env；cron 配置 UI | 建 `*/2 * * * *` 任务看它自己跑两次；kill 进程 5min 后重启，确认 catch-up **只补一次**、中断的 run 被 reap 成 error 而非留在 running |
| **T3** | `notify.ts` + `task-events.ts` + SSE + toast + 命令模板渠道 | 跑一个必然失败的任务看到 toast + 手机推送；成功任务在 `notify_on='error'` 下不推 |
| **T4** | `fs-watch-pool.ts` + fs/git/session_done 触发器（含自触发防护）；**SDK `npm publish 0.4.0`** + package.json bump + 两端上线；`--max-budget-usd` 通电 | BOE 上跑通一个定时任务 |

`make deploy` 依赖已发布的 SDK——**A1~T3 全程只在 `make dev` 下验证**，T4 才收口上线。

---

## 十、最脆弱的四点

1. **SDK 静默失效。** 版本不对时多传的字段被 TS 结构类型放过、被运行时无声丢弃 → agent 完全不生效但一切"正常"。必须做 `capabilities().customAgents` 探测 + 红色横幅。
2. **`onSettled` + boot reap 必须成对落地，只做一个比都不做更危险。** 漏了 reap，一次崩溃就让某任务因 `skip` 策略**永久停跑**且界面无异常。
3. **`claimSlot` 里必须精确区分唯一约束冲突与其它 DB 错误。** 图省事写成 `catch { return null }`，磁盘满/锁超时/schema 不匹配全被吞成「已被占」→ **任务默默再也不跑，日志一个字都没有**。只有 `code?.startsWith("SQLITE_CONSTRAINT")` 才返回 null。
4. **`scheduled_for` 必须是对齐整分钟的槽位时间戳，不能是 `Date.now()`。** 写成 now() 则唯一索引形同虚设；叠加 `server.ts:165` 的崩溃退避**反复**重启 × 每次重启跑一次 catch-up = **崩溃循环直接变成烧钱循环**。

---

## 十一、明确砍掉 / 推迟

**砍掉**：在 Trellis 里写 skill 正文（真实 skill 是多文件包）· 老会话 `system_prompt → agent_id` 回填（收益只是 chip 好看，风险是把工作正常的会话推进新路径）· `--append-system-prompt` 叠加人设（混合两个人设来源是日后「为什么它不听我的」的温床）· 自动重试 · 调度器进程租约 · 多实例任务同步（任务天然属于它该跑的那台机器）

**推迟**：agent 级 MCP 配置（需要一个 MCP 编辑器，是另一个完整功能）· agent 定义版本快照/回放 · `overlap_policy` 的 queue/kill 两档 · cron 时区 · **多 agent 讨论组 / 飞书群绑定**（本轮只保证抽象容得下：agent 有稳定 id+slug，调用收敛成 `resolveAgentSpawn()` 一个函数；触发器已拆表，飞书只是多一个 `kind` 值）

---

## 关键文件

- `lib/server/sqlite.ts` — `migrate():28` 加 4 张表 + 4 个 ALTER + `seedBuiltinAgents()`；`:546` boot reap 旁并排加 `task_runs` 对称 reap
- `lib/llm/sdk-adapter.ts` — `modeToRunOptions:36` 加 `applyAgent()` 后处理（唯一的「Trellis 概念 → RunOptions」翻译层）
- `app/api/chat/route.ts` — 4 处 `resolvedAgentId`（`:263/:288/:352/:380`）+ codex 钳制（照抄 `:307-310`）+ `resolveAgentSpawn` 调用点 + mention 分支；`:283-291` 的 project 钳制**一行不改**
- `lib/server/run-bus.ts` — `startRun():245` 加 `onSettled`，`finalizeNode():587` 之后调用（任务留档/通知/超时清理的唯一挂钩点）
- `lib/server/repo.ts` — 复用 `createRootInSession:838` / `createSessionWithRoot:760`；`listSessions:327` 加 `kind='user'` 过滤
- `instrumentation.ts` — 调度器唯一启动挂载点，紧跟 `startCliSyncWatcher()`
- `scripts/deploy.ts` — `smoke():396` 的 env(`:415`) 必须加 `TRELLIS_SCHEDULER: "off"`
- `components/SystemPromptPicker.tsx` — 改造成 `AgentPicker`；`:35-70` 的 5 个预设文本是 `seedBuiltinAgents` 的逐字来源
- `lib/server/cli-sync-watcher.ts` — `:195` 的 fs.watch + debounce 结构是 `fs-watch-pool.ts` 的抽取范例（**本身不动**）
- `~/sdk/packages/agent/src/backend.ts` `:20-114` + `backends/claude.ts` `:92-131` — RunOptions 6 字段 + argv 拼装

新建：`lib/server/agents.ts` · `lib/server/agent-pack.ts` · `lib/server/tasks.ts` · `lib/server/task-scheduler.ts` · `lib/server/cron.ts` · `lib/server/notify.ts` · `lib/server/fs-watch-pool.ts` · `stores/agentStore.ts` · `app/settings/agents/page.tsx` · `app/tasks/page.tsx`

**类型命名注意**：`lib/types.ts:111` 已有 `TaskMeta` / `TaskKind` 指 claude 的 Task 工具（子 agent 调用），被 `run-bus` / `tool-tree` / `sdk-adapter` 广泛引用。自动化任务的 TS 类型新建 `lib/automation-types.ts`，用 `AutomationTask` / `TaskTrigger` / `TaskRun`；SQL 表名保持 `tasks` / `task_runs`（命名空间独立）。
