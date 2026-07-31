# ADR：自定义 Agent 层（+ 自动化任务的地基）

- **日期**: 2026-07-31（Session 87）
- **状态**: A1 已落地并验证；A2-A4 / T1-T4 待做
- **完整实施计划**: [`custom-agents-plan.md`](../custom-agents-plan.md)（含 A2-A4 / T1-T4 的建表 SQL、调度器设计、风险清单）

## 背景

Trellis 此前只能「用默认人设跟 claude 聊天」：system prompt 是 6 个硬编码预设、创建时锁定、且 project 模式被强制置 null（人设来自 CLAUDE.md）；skill 只是前端把 `/name` 补全进输入框；子 agent 只渲染不定义；全仓没有任何定时 / 后台任务机制。

用户要的不只是「能配提示词」，而是一层**可复用的 Agent 抽象**当地基 —— 本轮的「开会话选人设 / @提及派活 / 定时任务」，以及下一步的「飞书群绑定 / 多 agent 讨论组」，都要能按 id 引用同一个实体。**抽象对不对比这轮做多少更重要。**

## 决策

### 1. Trellis 自己拥有 Agent 定义，不寄生 `~/.claude/agents/`

DB（`agents` 表）为真相源，spawn 时物化成 CLI 能吃的形式。

**Why**：定时任务、飞书群、讨论组都需要**按 id 引用**一个 agent 并附加元数据（使用统计、默认 workspace、绑定的群），md 文件的 frontmatter 塞不下，扫目录也做不了 join。用户明确否决了寄生方案。

**Alternatives**：
- 读写 `~/.claude/agents/*.md`（**我的初始提案，被用户一问推翻**）—— 与 CLI 共享定义是优点，但 Trellis 独有的字段没地方放，且列表 / 统计 / 外键全要扫目录。
- `~/.trellis/agents/` 目录为源 —— 可 git 版本化、可整包搬机器，但同样是「列表要扫目录、并发写要自己防」。**保留为将来的导入导出格式**。

### 2. 两个物化档次，按有没有技能自动选

无技能 → `--agents '<json>'`（零 fs 操作）；有技能 → `--plugin-dir <pack>`（内容寻址目录 + symlink 引用本机 skill）。

**Why**：把最脆的物化逻辑从关键路径上摘掉。现有 5 个内置人设全在第一档，A1 因此完全不碰文件系统就能端到端跑通。

### 3. `agent_id IS NULL` 就是「默认 Agent」，不建行

**Why**：执行链因此能写成 `if (agentId) { 新逻辑 } else { 今天的代码原封不动 }`，**物理上杜绝默认路径回归**。这是「不选 agent 的会话行为一字不变」这条验收能成立的唯一实现方式。

### 4. 隔离度按 agent 可选，且「隔离」的代价必须写在选项上

内置 5 个纯人设 `inherit_env=1`（换语气不是进沙箱）；新建的自定义 agent 默认隔离（可复现、能搬机器）。

**关键实测约束**：`--setting-sources=` 会**连本机 MCP 一起砍掉**，`--strict-mcp-config` 与此无关（见 `facts.md`）。所以「隔离」= 无 CLAUDE.md + 无本机 skill + **无 MCP** 三件套。这**推翻了原计划里「拆 SDK 的 strictMcp 开关保留 MCP」那一条**。要给隔离 agent 配 MCP 只能显式 `--mcp-config` —— 原本的「推迟项：agent 级 MCP 配置」因此从锦上添花升级为「隔离 agent 想用 MCP 的唯一出路」。

### 5. agent 只改「人设 + 能力面」，绝不碰「上下文与身份」

`applyAgent()` 只动 `agent/agents/pluginDirs/systemPrompt/settingSources/tools/disallowedTools/model/permission/askTools`；`workspace / cwd / resume / forkSession / persistence / attachments / env / onCanUseTool` 一概不动。

**Why**：后面那几个字段撑着 chat B-fork 和 project per-lineage isolation 两套本来就很脆的机制。这是整个设计的安全带。

同理，`chat/route.ts:283-291` 那段「project 强制 systemPrompt = null」**一行不改** —— agent 走全新的 `sessions.agent_id` 通道，两条路独立，存量会话零风险零迁移。

### 6. 会话人设创建时锁定，但 agent 定义是 live 引用

锁定同 mode / workspace / require_approval 的既有纪律，顺带消灭一个未知（`--resume` + `--agent` 的行为 CLI 无文档）。

定义改了老会话跟着变（用户改 agent 的动机 100% 是「上次答得不好，改了再问」，快照与直觉相反）。代价是丢失历史复现，用 `nodes.agent_id` 每轮落一份兜底。

### 7. 任务与 cron 同一张表、同一条执行路径，触发器独立成表

`tasks`（agent + prompt + workspace）+ `task_triggers`（一对多）+ `task_runs`。手动触发 = 零个 trigger 行；cron = 一个 `kind='cron'` 行；未来飞书群 = 一个 `kind='lark'` 行。

**Why**：「每天 9 点自动跑 **而且** 我想随手点一下」必须是同一个任务，触发方式做成 tasks 的一列就得建两行、复制 prompt。且每个 trigger 有自己的运行时状态（cron 的下次触发、git 的 sha 游标），挂在 tasks 上会变成一堆互斥的 nullable 列。

任务执行落在 session/nodes 上（每任务一个 `kind='task'` 的常驻会话，每次执行一个平行根节点）—— Trellis 的全部渲染能力都长在 session/nodes 上，另造一套等于重写 UI，而复用之后用户还能就地分叉追问。

## 被推翻 / 被纠正的判断（留档以免再犯）

1. **「技能没法按 agent 裁剪」—— 错**。`--plugin-dir` + `--setting-sources=` 就是干净的裁剪机制，实测通过。
2. **「拆 SDK 的 `strictMcp` 就能给隔离 agent 保留本机 MCP」—— 错**。MCP 来自 settings sources，关了就没了。
3. **判断 CLI 能力时问模型「你有哪些工具」不可靠** —— 基线也答 NONE。判据必须取 `--output-format stream-json --verbose` 首条 `system/init` 事件的 `mcp_servers` / `tools` / `slash_commands` 字段。

## 后果

- SDK（`@smokingmouse/agent`）多了 6 个 `RunOptions` 字段，其中 `extraArgs` 是通用逃生舱 —— 把发布链从「每加一个 flag 发一次版」降成一次性成本。约束：只允许在 `lib/llm/sdk-adapter.ts` 一处构造、只从结构化 DB 字段派生，绝不接用户自由文本（否则可从后门塞 `--dangerously-skip-permissions` 绕过审批闸）。
- **上线前必须 `npm publish`**：`make setup` 忽略 `SDK_HOME`，`make deploy` 在新 release 目录里跑 `bun install` 会冲掉 `make link-sdk`。所以 link 只对 `make dev` 有效，本机 prod 部署同样需要已发布的包。
- 自定义 agent 仅 claude family（照抄 `require_approval` 的钳制）。会话 provider 可中途切到 codex，届时 agent 静默失效 —— UI 必须把 agent chip 变灰说明，否则是谎言级 UI。
