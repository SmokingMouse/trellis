# 动线渲染重做（Agent / 子 Agent / Workflow）

状态：**L0+L1+L2 已落地**（2026-07-30）· L3 磁盘钻进未做

落地文件：`lib/tool-tree.ts`（替代已删除的 `lib/subagents.ts`）· `lib/tool-registry.ts` ·
`lib/line-diff.ts` · `components/tools/`（替代已删除的 `ToolCallsPanel.tsx` /
`SubagentPanel.tsx`）· SDK `packages/agent` 0.3.3（**未发版**，靠 `make link-sdk`）。
验证见文末。

## 病根

`lib/subagents.ts:57` 判定「这是子 Agent」用的是 `c.agent !== undefined`。
但 CLI 对**三种**东西发同一套 `system/task_*` 通知，靠 `task_type` 区分：

| task_type | 是什么 | taskId 前缀 |
|---|---|---|
| `local_agent` | 真子 Agent（Task/Agent 工具） | `a…` |
| `local_bash` | **任何长跑 Bash**（后台的和前台慢命令都算） | `b…` |
| `local_workflow` | Workflow 工具 | `w…` |

`task_type` 被丢了两次：SDK `taskData()` 没抽（`sdk/packages/agent/src/backends/claude.ts:371`），
adapter 又 `void phase`（`lib/llm/sdk-adapter.ts:133`）。于是慢 Bash 和 Workflow 全被
误判成子 Agent。

### 实测证据（2026-07-30，CC 2.1.x，`/tmp/cc-probe/`）

慢 Bash（**注意第二条是前台 `sleep 12`，不是后台任务**）：
```json
{"subtype":"task_started","task_id":"bueospjmx","tool_use_id":"toolu_019pb…",
 "description":"Sleep 6s then echo in background","task_type":"local_bash"}
{"subtype":"task_started","task_id":"baz4tkekb","tool_use_id":"toolu_01Qrd…",
 "description":"Sleep 12 seconds","task_type":"local_bash"}
{"subtype":"task_notification","task_id":"baz4tkekb","status":"completed",
 "output_file":"","summary":"Sleep 12 seconds"}          ← summary == 描述本身
```

### 三个症状全是下游

| 症状 | 机制 |
|---|---|
| 标签 fallback 成「子 Agent」 | Bash 没有 `subagent_type`（`lib/subagents.ts:141`） |
| 「没有调用工具」 | 慢 Bash 本来就没有子调用（`SubagentPanel.tsx:177`） |
| 「它交回的报告」里是 prompt | `report = c.agent?.summary ?? c.output`（`lib/subagents.ts:76`），
  `local_bash` 的 summary 就是描述本身 → 短路掉真正的 stdout |

**最严重的不是难看**：被 claim 进 group 后 `output` 在 🔧 主工具链也不显示了
（`lib/subagents.ts:70,81`），**命令结果彻底不可见**。生产库 `~/.trellis/data.db`
实测：5 个受影响节点里 4 个的「子 Agent 组」全是 Bash，共 21 个。

## Workflow：进度树本来就在 stream 里

实测 `task_progress` 携带全量快照（不是增量），`task_started` 带 `workflow_name`：

```json
"workflow_progress": [
  {"type":"workflow_phase","index":1,"title":"Alpha"},
  {"type":"workflow_agent","index":1,"label":"alpha-1","phaseIndex":1,"phaseTitle":"Alpha",
   "agentId":"a8b00be6e75783269","model":"claude-opus-5[1m]","fallbackModel":"claude-opus-5",
   "state":"start|done","queuedAt":…,"startedAt":…,"lastProgressAt":…,"attempt":1,
   "promptPreview":"…","tokens":25175,"toolCalls":0,"durationMs":8855,"resultPreview":"ALPHA_OK"}
]
```

**推论：Workflow 面板不需要读磁盘。** 快照全量 → patch 语义的浅合并天然正确
（`run-bus.ts:529` `mergeAgentMeta`）。只在部分 `task_progress` 上出现（CLI 侧 1s 批处理），
浅合并会保留上一份，符合预期。

## 方案

### L0 事件层 — 把 task_type 接通

1. SDK `taskData()` 补抽 `task_type` / `workflow_name` / `workflow_progress`；发 0.3.3
2. `lib/llm/sdk-adapter.ts:133` 停止 `void phase`，透传 `phase` + 上述三个字段
3. `SubagentMeta` → `TaskMeta`（它现在描述三种 task，不只是子 agent）：
   加 `taskType` / `phase` / `workflowName` / `workflowProgress`
4. trellis 侧 **同时**用 taskId 前缀（`a`/`b`/`w`）兜底，不等 SDK 发版就能修 bug；
   SDK 到位后前缀降级为 fallback

落库无 migration —— `tool_calls_json` 单列（`repo.ts:1070`）。

### L1 视图模型 — 一棵树取代两个平铺列表

`splitToolChain(calls) → {main, groups}` 换成 `buildToolTree(calls) → ToolNode[]`：

```ts
type ToolKind = "tool" | "subagent" | "workflow" | "longRunning";
type ToolNode = { call: ToolCall; kind: ToolKind; children: ToolNode[] };
```

kind 判定优先级（每一级都是上一级缺失时的降级）：
1. `agent.taskType` → local_agent / local_workflow / local_bash
2. `name ∈ {Agent, Task}` 或有 children → subagent；`name === "Workflow"` → workflow
3. `agent.taskId` 前缀 a/b/w
4. 否则 tool

两处直接修好：
- `longRunning` 回归主时间线（只是多一个 ⏱ 标记），`output` 恢复可见
- `report` 只在 `kind === "subagent"` 时取 `agent.summary`，其余一律 `output`

### L2 渲染注册表 — 两级表

参考 `slopus/happy` 的两级注册表 + `claude-code-viewer` 的降级铁律。

`lib/tool-registry/meta.ts` —— 90% 的工具只加一行，不写 React：
```ts
type ToolMeta = {
  icon?: string;
  title?: string | ((call: ToolCall) => string);
  summary?: (call: ToolCall) => string | null;      // 一行摘要
  subtitle?: (call: ToolCall) => string | null;
  minimal?: boolean | ((node: ToolNode) => boolean); // 折成一行 / 展开卡片
  resultPolicy?: "show" | "hideOnSuccess" | "hidden";
};
```

`lib/tool-registry/views/` —— 只给真需要专门视图的：
`Edit/Write/MultiEdit → diff`、`TodoWrite → 清单`、`Workflow → 进度面板`、`Agent/Task → 子 agent 卡`。

两条铁律（抄来的，都有踩坑背景）：
- 视图返回 `null` 或 schema 不匹配 → **自动降级**到现有的 raw JSON 渲染，注册表永远炸不了
- `resultPolicy` 无论怎么配，**`status === "error"` 永远完整显示**

现有 `oneLineSummary`（`ToolCallsPanel.tsx:208`）不删，降级成 default meta 的 summary 实现。

### L3 —— 本轮不做

磁盘 adapter（读 `~/.claude/projects/<slug>/<sessionId>/subagents/agent-*.jsonl`
钻进子 agent 完整对话）。数据已确认存在：`.meta.json` = `{agentType, description,
toolUseId, parentAgentId, spawnDepth}`，`toolUseId` 直接 join 主线的 Task tool_use。
真做时按隔离原则：单模块、探测失败静默降级回 summary 视图。

## 布局取向

现在「🤖 子 Agent」是独立一区，和 🔧 主工具链分离，**时间顺序断了**。
建议改成**单一时间线**：子 Agent / Workflow 就是时间线里的一张可展开卡片。
运行中可见性（原 `LiveHeader` 解决的问题）改由卡片自身承担 —— 抄 happy 的动态 minimal：
子工具一开始跑就自动展开。

## 实施中发现的两处计划外问题

1. **SDK 的 `stdout ?? content` 吞输出**（`backends/claude.ts`）。后台化的 Bash 和无输出
   命令都报 `stdout: ""`，空串是非 nullish → 把 content 里真正有信息的那句
   （`Command running in background with ID: …` / `(Bash completed with no output)`）
   顶掉。和「被当子 Agent 吞进分组」叠加，才是命令结果彻底消失的完整成因。
   改成「空 stdout 让位给 content」。
2. **失败的行必须默认展开**（`ToolRow.rowAutoOpen`）。渲染冒烟测试暴露的：
   `resultPolicy` 有「错误永不隐藏」的铁律，但行默认收起 → 错误内容还是在一次点击
   之后。不默认展开的话这条铁律只是口号。

## 验证（2026-07-30）

- `bun scripts/test-tool-tree.ts` — 34 项 ALL PASS。三个真 fixture 各覆盖一种 task_type
  （`subagent-stream` / `bash-task-stream` / `workflow-stream`，后两条是本次实测录的），
  外加降级链（无 taskType 时的 a/b/w 前缀 → 工具名）与树不变式（孤儿 / 环 / 排序 / 去重）。
- `bun scripts/test-timeline-render.tsx` — 45 项 ALL PASS。真渲染成 HTML，覆盖四种 kind
  的 body、四条降级路径（Edit/TodoWrite/Workflow 输入不合规 → RawView）、错误铁律、展开规则。
- **生产库回放**（`~/.trellis/data.db`，全是没有 taskType 的旧行 → 走前缀降级链）：
  21 条曾被误判为子 Agent 的 Bash 全部归位 `longRunning`，**20 条命令输出恢复可见**
  （剩 1 条是 SDK 修复前录的空 stdout，历史数据救不回）；4 个真子 Agent 分类不变。
- `tsc --noEmit` ✓ · `eslint`（新增文件零问题）✓ · `bun --bun run build` ✓

## 遗留

- ~~SDK 未发版~~ **已发 `@smokingmouse/agent@0.3.3`**（2026-07-30），trellis 依赖收紧到
  `^0.3.3` 并解链回注册表版本，全套验证在真 registry 包上复跑通过。
  依赖是硬的，不是可选升级 —— 0.3.2 上实测：分类靠 taskId 前缀链仍然全对、
  `report` 不再吞 output，但 `workflowProgress` 拿不到（Workflow 降级成原始视图），
  且**空 stdout 仍会把 content 顶掉**（后台 / 无输出命令的输出还是空的），
  即「结果不可见」只修好一半。`scripts/test-tool-tree.ts` 开头留了版本闸兜这个。
- **浏览器人工验收未做** —— 本 session 无浏览器工具。数据层与渲染输出（HTML 断言）
  都验过了，但流式态观感（面板自动展开 / 运行中子 Agent 自动展开 / LiveHeader
  取最深运行节点）和视觉效果只能人跑一遍。
- L3 磁盘钻进（读 `<sessionId>/subagents/agent-*.jsonl` 看子 agent 完整对话）未做。

## 参考调研

- `slopus/happy` —— 唯一做对渲染架构的：归一化 view model（`ToolCallMessage{tool, children}`）
  + 两级注册表（元数据表 / 组件表，inline 和 full 分开）。钻进只显示最后 3 行，是它的短板
- `riba2534/happyclaw` —— 反面：三个 surface 各写一遍 switch；工具轨迹不落库，turn 结束动线消失
- `claudecodeui` —— `ToolDisplayConfig` 的 input/result 分开配 + `hideOnSuccess` + 错误永不隐藏
- `claude-code-viewer` —— visualizer 返回 null 自动降级 raw
