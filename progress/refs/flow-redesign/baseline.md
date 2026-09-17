# Trellis 会话页「🧰 动线」卡现状基线记录（Baseline Report）

> 契约号：`fj-baseline-3a12`  
> 记录日期：2026-09-17  
> 审计组件：`components/tools/ToolTimeline.tsx`、`components/tools/ToolRow.tsx`、`components/tools/views/WorkflowView.tsx`、`components/tools/views/SubagentView.tsx`

---

## 一、截图清单与状态对应表

| 截图文件名 | 视口尺寸 | 对应节点与会话 | 界面展开/收起状态说明 |
|---|---|---|---|
| `out/shots/desktop-workflow-expanded.png` | 1440×900 | 节点 `baseline-workflow-node`（会话 `baseline-workflow-session`） | 动线卡展开，Workflow 面板完整展开：包含 2 个 Phase（Alpha、Beta）与 2 个子 Agent（alpha-1、beta-1）行，并展开 Agent 内部任务/结果预览详情与工作流脚本 |
| `out/shots/desktop-workflow-collapsed.png` | 1440×900 | 节点 `baseline-workflow-node`（会话 `baseline-workflow-session`） | 动线卡展开，但 Workflow 内所有已完成 PhaseBlock 处于默认收起态（仅显示 ✔ Alpha 1/1、✔ Beta 1/1 单行头） |
| `out/shots/mobile-workflow-expanded.png` | 390×844 | 节点 `baseline-workflow-node`（会话 `baseline-workflow-session`） | 移动端视口下，动线卡展开，Workflow 阶段与子 Agent 行展开态 |
| `out/shots/mobile-workflow-collapsed.png` | 390×844 | 节点 `baseline-workflow-node`（会话 `baseline-workflow-session`） | 移动端视口下，动线卡展开，Workflow 内 PhaseBlock 处于默认收起态 |
| `out/shots/desktop-timeline-expanded.png` | 1440×900 | 节点 `baseline-composite-node`（会话 `baseline-composite-session`） | 动线卡展开同框总览：包含普通工具段落（Read/Edit/Write 展开显示内联 Diff）、长跑 Bash 行（`⏱ cargo test`）、子 Agent 卡（`🤖 Explore` 展开任务/子工具链/报告）、失败行（`❌ Bash` 自动展开报错）同框 |
| `out/shots/desktop-timeline-collapsed.png` | 1440×900 | 节点 `baseline-composite-node`（会话 `baseline-composite-session`） | 桌面端视口下，动线卡整体折叠态（仅保留 Header 单行条目） |
| `out/shots/mobile-timeline-collapsed.png` | 390×844 | 节点 `baseline-composite-node`（会话 `baseline-composite-session`） | 移动端视口下，动线卡整体折叠态（Header 单行展示步数、子 Agent 计数与失败计数） |
| `out/shots/mobile-timeline-expanded.png` | 390×844 | 节点 `baseline-composite-node`（会话 `baseline-composite-session`） | 移动端视口下，动线卡展开态，展示复合工具条目排布 |
| `out/shots/desktop-longrunning-bash.png` | 1440×900 | 节点 `baseline-composite-node`（会话 `baseline-composite-session`） | 桌面端单独展开长跑 Bash 行（`⏱`）Body，展示其执行输出 stdout 内容 |
| `out/shots/desktop-real-subagents-fd584384.png` | 1440×900 | 节点 `f9e50b5f-6a2f-465b-a4cb-d0080923eed2`（会话 `fd584384-d4a4-4d0b-bb56-05789c68dda9`） | 真实生产库数据：包含 4 个真实生产 Subagent（`Agent`）调用的展开视图 |
| `out/shots/desktop-real-longbash-26a1d3a7.png` | 1440×900 | 节点 `bb023c4c-0980-4986-b812-974cce6dc82b`（会话 `26a1d3a7-3b18-4b2e-ab6a-6c21186fe3a3`） | 真实生产库数据：包含 2 条真实生产 `local_bash` 慢命令与 10 条普通工具的动线展开视图 |

---

## 二、当前字段渲染与未渲染字段对照清单

对照 `lib/types.ts` 定义，系统性核对动线卡（`ToolTimeline` / `ToolRow`）与工作流面板（`WorkflowView` / `SubagentView`）的字段露出现状。

### 1. Workflow 进展条目（`WorkflowAgentEntry` & `WorkflowPhaseEntry`）

| 字段名 | 类型 | 是否渲染 | 渲染位置 / 呈现方式 | 未渲染原因及影响 |
|---|---|:---:|---|---|
| `WorkflowPhaseEntry.title` | `string` | **是** | `PhaseBlock` 标题行 | 正常渲染 |
| `WorkflowPhaseEntry.index` | `number` | **是**（间接） | 用于 Phase 排序与匹配 Key，界面展示为完成进度 `done/total` | 正常作为标识 |
| `WorkflowAgentEntry.label` | `string` | **是** | `AgentRow` 摘要行（`font-mono` 标签名） | 正常渲染 |
| `WorkflowAgentEntry.state` | `string` | **是** | `AgentRow` 左侧 Pill（`done` → 绿色「完成」；其他 → 黄色「运行中」） | 正常渲染 |
| `WorkflowAgentEntry.tokens` | `number` | **是** | `AgentRow` 摘要行右侧指标（经 `formatTokens`） | 正常渲染 |
| `WorkflowAgentEntry.toolCalls` | `number` | **是** | `AgentRow` 摘要行右侧指标（如 `2 工具`） | 正常渲染 |
| `WorkflowAgentEntry.durationMs` | `number` | **是** | `AgentRow` 摘要行右侧指标（经 `formatDuration`） | 正常渲染 |
| `WorkflowAgentEntry.model` | `string` | **是** | `AgentRow` 展开后的 `<details>` 顶部文本（`font-mono text-ink-faint`） | 需手动展开 details 才能看到 |
| `WorkflowAgentEntry.promptPreview` | `string` | **是** | `AgentRow` 展开后的「交给它的任务」`<pre>` 区域 | 需手动展开 details 才能看到 |
| `WorkflowAgentEntry.resultPreview` | `string` | **是** | `AgentRow` 展开后的「它交回的结果」`<pre>` 区域 | 需手动展开 details 才能看到 |
| `WorkflowAgentEntry.agentId` | `string` | **否** | 仅作为 React Key（`key={`${a.index}-${a.agentId ?? a.label}`}`） | **未露出**。用户无法排查底层子 agent 的真实系统 id |
| `WorkflowAgentEntry.fallbackModel` | `string` | **否** | 无渲染代码 | **未露出**。发生模型降级（如 Opus 切 Sonnet/Flash）时界面毫无察觉 |
| `WorkflowAgentEntry.attempt` | `number` | **否** | 无渲染代码 | **未露出**。工作流重试/尝试次数丢失，无法判断是否为重试跑通 |
| `WorkflowAgentEntry.queuedAt` | `number` | **否** | 无渲染代码 | **未露出**。无法诊断排队与并发调度延迟 |
| `WorkflowAgentEntry.startedAt` | `number` | **否** | 无渲染代码 | **未露出**。缺少绝对起止时间戳 |
| `WorkflowAgentEntry.lastProgressAt` | `number` | **否** | 无渲染代码 | **未露出**。无法判断卡死或最后心跳时间 |
| `WorkflowAgentEntry.phaseTitle` | `string` | **否**（显式） | 仅在 loose（未归属阶段）时归入「其他」 | 在阶段内时已由父 Phase 标题代劳，未在 row 内重复打印 |

### 2. 任务元数据（`TaskMeta`）

| 字段名 | 类型 | 是否渲染 | 渲染位置 / 呈现方式 | 未渲染原因及影响 |
|---|---|:---:|---|---|
| `workflowName` | `string` | **是** | `ToolRow` 标题（`rowTitle`）及 `WorkflowView` 概览行首 | 正常渲染 |
| `description` | `string` | **是** | `ToolRow` 摘要文本（`rowSummary`） | 正常渲染 |
| `prompt` | `string` | **是** | `WorkflowView` 的「⚙ 工作流脚本」及 `SubagentView` 的「📋 交给它的任务」 | 正常渲染 |
| `summary` | `string` | **是**（部分） | 仅在 `subagent` 下作为 `report` 渲染在「📄 它交回的报告」；在 `local_bash` 与 `local_workflow` 下主动丢弃 | 防止回声覆盖真实 stdout（属于有意策略） |
| `totalTokens` | `number` | **是** | `ToolRow` 右侧统计（经 `formatTokens`）及 `WorkflowView` 顶部汇总 | 正常渲染 |
| `toolUses` | `number` | **是** | `ToolRow` 右侧统计（`n 工具`） | 正常渲染 |
| `durationMs` | `number` | **是** | `ToolRow` 右侧统计（经 `formatDuration`） | 正常渲染 |
| `subagentType` | `string` | **是** | `ToolRow` 标题（`rowTitle`，如 `Explore`） | 正常渲染 |
| `taskId` | `string` | **否** | 仅用于降级推断 `taskKindOf`（`a/b/w` 前缀） | **未露出**。任务 ID（如 `wl2zl75gq`）完全不展示，无法配合 CLI/日志追溯 |
| `taskType` | `TaskKind` | **否**（文字） | 映射为图标（🤖/⚙/⏱）与视图路由 | 原始枚举字符串不直接打印 |
| `phase` | `string` | **否** | 无渲染代码 | **未露出**。CLI 内部生命周期 phase（`progress`/`completed`）不显示 |
| `status` | `string` | **是**（部分） | 仅在判断 `failed` 时用于将 Pill 变红（`node.meta.status === 'failed'`） | 具体状态字符不展示 |
| `lastToolName` | `string` | **否**（完成态） | 仅在 live 实时流期间参与面包屑计算 | **完成态未露出**。回顾时无法看到子 agent 最后调用的工具名 |
| `outputFile` | `string` | **否** | 无渲染代码 | **未露出**。产物落盘路径未在界面显示 |

### 3. 工具调用实体（`ToolCall`）

| 字段名 | 类型 | 是否渲染 | 渲染位置 / 呈现方式 | 未渲染原因及影响 |
|---|---|:---:|---|---|
| `name` | `string` | **是** | `ToolRow` 行标题（无 TaskMeta 时）或普通工具名称 | 正常渲染 |
| `status` | `ToolCallStatus` | **是** | `StatusPill`（「完成」/「失败」/「运行中」/「已中断」） | 正常渲染 |
| `durationMs` | `number` | **是** | `ToolRow` 右侧指标；段落汇总时长 | 正常渲染 |
| `input` | `unknown` | **是** | `RawView` 的「输入」代码块，或专用 View（DiffView 显示行改动） | 正常渲染 |
| `output` | `string` | **是** | `RawView` / `WorkflowView`「返回」代码块 | 正常渲染（超长有 max-h 滚动） |
| `stderr` | `string` | **是** | `RawView` 的「STDERR」高亮红字块（仅非空且失败时） | 正常渲染 |
| `id` | `string` | **否** | 仅作为 React 循环 key 及关联 `parentToolUseId` | **未露出**。`toolu_xxx` 底层调用 ID 在前端不可见 |
| `startedAt` / `endedAt` | `number` | **否**（绝对值） | 仅计算相对差值 `durationMs` 或驱动 live 动态计时器 | **未露出**。无法查阅某个工具执行的具体时分秒时间戳 |
| `parentToolUseId` | `string` | **否** | 仅内部用于递归构建 `buildToolTree` 的树状父子引用 | 不直接显示 ID |

---

## 三、交互清单与状态规则

### 1. 可点击交互元素
1. **动线卡主头部（`ToolTimeline` 折叠按钮）**：
   - 点击切换整张动线卡的展开 / 折叠。
   - 包含角标统计（步数、子 Agent 数、慢命令数、失败数、总耗时、总 Tokens）。
2. **段落收起行（`SegmentRow`）**：
   - 针对连续多个普通单步工具（如连续 Read/Edit/Write），界面将其合并收起为 `⋯ N 步 Tool ×N [已自动收起]`。
   - 点击整行切换展开 / 收起，展开后逐行显示具体的普通 `ToolRow`。
3. **独立工具行（`ToolRow`）**：
   - 针对委派实体（子 Agent、Workflow、长跑 Bash）、失败错误行、以及特定 Diff 行。
   - 点击整行切换展开 / 收起其对应的详细 Body。
4. **工作流阶段块（`PhaseBlock`）**：
   - 工作流中的阶段标题栏（如 `✔ Alpha 1/1`）。
   - 点击切换展开该阶段下的 Agent 列表；若阶段下无 Agent 则禁用点击。
5. **Agent 行折叠区（`AgentRow` details）**：
   - 点击 `<summary>` 原生展开 / 收起，露出 Agent 的模型名、任务 prompt 预览、结果 result 预览。
6. **工作流脚本折叠区（`WorkflowView` details）**：
   - 点击「⚙ 工作流脚本」展开查看原始脚本内容。
7. **子 Agent 任务折叠区（`SubagentView` details）**：
   - 点击「📋 交给它的任务」展开查看父级下达的 Prompt。

### 2. 展开 / 折叠规则（自动展开与点击置顶机制）
- **动线卡（`ToolTimeline`）规则**：
  - 静态/历史完成态节点（`live: false`）：**默认折叠**，界面仅露出单行 Header。
  - 实时运行中节点（`live: true`）：**默认展开**。
  - 用户一旦手动点击（`userOpen !== null`），则强行以用户的点击选择为准，不再随 live 状态变化自动收折。
- **段落折叠（`SegmentRow`）规则**：
  - 默认全部处于收起态（`open: false`）。
  - 特殊豁免：若整个时间线只有一段纯普通工具且非实时（`!live && entries.length === 1 && entries[0].type === "segment"`），系统自动跳过 SegmentRow 直接铺平展开（避免用户“白点一次”）。
- **工具行（`ToolRow.rowAutoOpen`）规则**：
  - **自动展开（无需用户点击）的三类热数据**：
    1. **执行失败（`status === "error"`）**：铁律保证，任何失败行必须立即可见，严禁隐藏报错。
    2. **实时委派中（`live && running && kind !== "tool"`）**：实时流式运行中的子 Agent / Workflow 骨架行保持展开。
    3. **当前最新计划（`currentTodo === true`）**：最后一个 `TodoWrite` 工具调用保持展开。
    4. **特定视图默认行为（`defaultOpen`）**：非 live 状态下，如果注册表中配置了 `defaultOpen: true`（如 DiffView、TodoView），则默认展开。
- **工作流阶段（`PhaseBlock`）规则**：
  - **活跃阶段（包含未完成 agent）**：`running === true`，**默认自动展开**铺开 Agent 行。
  - **全部完成阶段（所有 agent 均为 done）**：`running === false`，**默认自动收起**成单行标题与勾选记号。用户点击后可强制展开。

### 3. 运行中态表现（Running State）
> *注：当前只读数据库环境下无实时活跃进程，以下规则根据 `ToolTimeline.tsx`、`ToolRow.tsx`、`WorkflowView.tsx` 及 `SubagentView.tsx` 源码严格梳理，标记为「未实测（代码规则）」。*
- **面包屑导航**：在 `ToolTimeline` 顶部 Header 中，若 `live === true`，通过 `runningChain(tree)` 计算并实时显示当前正在执行的最深路径（例如 `⚙ wf › 🤖 agent › 工具`）。
- **秒级动态计时器（`useElapsed`）**：针对 `running` 的工具行，前端通过 `setInterval(..., 1000)` 每秒刷新已耗时（`elapsed`），使得长耗时 Bash 或 Agent 在执行期间能直观看到秒数持续跳动，而不是静止在 0。
- **状态徽章（`StatusPill`）**：
  - 实时运行态显示为黄色 Warn 徽章「**运行中**」。
  - 若数据流中断或会话退出时工具状态仍为 running，则降级显示灰色中性徽章「**已中断**」，避免永久残留“运行中”假象。
- **Workflow 运行态**：
  - 顶部汇总增加黄色「**N 运行中**」文本。
  - 尚未完成的阶段块自动展开，其中的 Agent 行显示黄色「运行中」Pill。
- **Subagent 运行态**：
  - 内部子工具链尚未开始调用时，显示斜体灰色文字 *"还没开始调工具…"；完成态且无工具调用时则显示 *"没有调用工具"*。

---

## 四、可用性问题清单（事实记录，不作方案推演）

1. **信息下钻层级过深，核心产出到达阻力大**  
   在回顾已完成的工作流时，用户若要看某个 Agent 的实际产出（`resultPreview`），必须连续点击 4 层折叠层级：① 展开「动线」卡 → ② 展开「Workflow」行 → ③ 展开「Phase」阶段块 → ④ 点击 Agent 下的 `<details>` 摘要。完整展开需要 4 次精密点击。

2. **工作流全部跑完后界面呈现“空壳化”**  
   根据 `PhaseBlock` 的规则，所有 Agent 完成后阶段块会自动全部收起。当用户打开一个耗费几十秒跑完的 Workflow 详情时，中央区域仅显示两行带有小勾的标题（如 `✔ Alpha 1/1`），核心执行结果、摘要和耗时指标全部被隐藏，第一视觉完全看不到工作流到底输出了什么。

3. **大量关键诊断元数据在界面被完全丢弃**  
   底层数据结构中真实采集的字段：`agentId`（唯一标识）、`attempt`（重试轮次）、`queuedAt`（排队进入时间）、`startedAt`（精确启动时间戳）、`fallbackModel`（降级备选模型）等，前端组件均无任何渲染对应。在发生降级调用或重试时，用户从前端画面无法获取任何排查线索。

4. **移动端小视口（390px）下行头信息严重拥挤与截断**  
   在移动端宽度下，`ToolRow` 一行内并排了折叠三角图标、状态 Pill、类型图标、标题（如 `probe-wf`）、摘要（如 `tiny probe`）以及右侧三个统计量（`3 工具 · 50.3k · 12.9 s`）。在 390px 宽度下，Flex 布局导致核心摘要文本被强制截断至仅剩 2~4 个汉字或省略号，且右侧数字与摘要紧贴，可读性严重受损。

5. **长文本预览与脚本缺少结构化排版与操作能力**  
   工作流脚本（`meta.prompt`）、交给 Agent 的任务（`promptPreview`）以及交回的结果（`resultPreview`）直接采用 `<pre>` 原生标签渲染，虽设置了最大高度，但缺乏代码高亮、无复制按钮、无法快捷全屏预览，长文本阅读体验局促。
