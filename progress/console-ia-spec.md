# 设置与功能排布重组（Console IA）

- **状态**: 批 1 / 2 / 3 / 5 / 6 已完成并实测（2026-07-31 · S89，**未 commit**）；批 4 已降级待观察
- **ADR**: [`decisions/2026-07-31-console-ia.md`](decisions/2026-07-31-console-ia.md)
- **前序**: `custom-agents-plan.md:304`（当初就写了「顺手把 settings 改成左侧 tab」，没做）

---

## 1. 问题：原来的组织原则被 Agent / 任务撑破了

`app/settings/page.tsx:5-8` 与 `decisions.md` 的 2026-07-29 条目写着当初的取舍——**刻意不做偏好
中心，一切配置都语境化**；`/settings` 存在的唯一理由是「更新没有语境化的家」。

在只有画布 + 会话的时候这条成立。S88 之后不成立了：**Agent 和 Task 是持久对象**（有 CRUD、
跨 session 存活、按 id 被引用），它们**结构上没有"当下语境"可挂**。于是各被甩成一张整页，
两张页互不对等，Header 上多了一个图标，而"哪些东西可以配"这件事再也数不清了。

### 实测到的散乱（全部有 file:line 依据）

**入口不对称**
- Header 只有 ⏱ `/tasks`（`components/Header.tsx:374-385`）和 ⚙ `/settings`（`:386-395`）两个口。
- **Agent 管理要走两跳**：`/settings` 右上「🎭 Agent 管理 →」（`app/settings/page.tsx:149-156`）
  或 `/tasks` 顶栏（`app/tasks/page.tsx:171-177`）。
- 三角缺一条边：`/tasks` → `/settings/agents` 有链，`/settings/agents` → `/tasks` 没有
  （`app/settings/agents/page.tsx:107-109` 只链回 `/settings`）。
- 两页都自带 `h-dvh overflow-y-auto` 且注释写着同一条原因——同一批被甩出 SPA 的整页，
  只有一个拿到了 Header 位。

**同一套「运行配置」被手写了三遍**（agent / workspace / contextMode / model / approval）
- 新会话：`ModePicker.tsx` + `AgentPicker.tsx` + `ModelPicker.tsx`
- 任务定义：`app/tasks/page.tsx:262` 的 workspace 是**裸绝对路径 input**，不走 WorkspacePicker、
  不接 `workspaces` 表、没有 `workspace_id` 外键；contextMode 的 `<select>`（`:290-301`）文案
  另手写一套；agent 下拉（`:271-289`）第三次重复实现。
- agent 定义：`app/settings/agents/page.tsx` 的 model / tools 又一份。

**表单漏字段（后端实现了，UI 没有入口）**
- `agents.permission` / `agents.require_approval`：`lib/server/agents.ts:31-32, 222-226` 读写齐全、
  `lib/llm/sdk-adapter.ts:69-77` 真的进 spawn，**管理页零编辑入口**。
- `tasks` 的 `timeoutMs` / `overlapPolicy` / `maxBudgetUsd` / `model` / `enabled`：
  `lib/server/tasks.ts:34-52` 全有，`app/tasks/page.tsx:236-300` **只暴露 6 项**。
- 中止任务运行：`app/api/task-runs/[id]/abort/route.ts` 存在，**页面上没有任何按钮调它**。

**语义真冲突**
- `tasks.model` 实际存的是 **providerId**（`lib/server/tasks.ts` 的 `isProviderId(task.model)`），
  而 `agents.model` 存的是 CLI 模型名（如 `haiku`）——**同名不同义**。
- `require_approval` 有两个源：`sessions.require_approval`（ModePicker 可改）与
  `agents.require_approval`（无 UI）。优先级没有写在任何地方。
- `sessions.kind`（`user|task`）与 `nodes.kind`（`qa|reference`）同名不同义。
- `agents.skills`（引用哪些本机 skill 目录）与既有的 slash skill（`/xxx` 补全）是同一批
  `~/.claude/skills/`，走两条完全不同的路（pack symlink + `Skill` 工具 vs 纯文本补全），
  UI 上都叫「技能」。

**其它**
- `TaskToast` 只挂在 `app/page.tsx:133`，**在 `/tasks` 页反而收不到任务完成提示**。
- project 模式下**根本没有 Agent 选择入口**：`QuestionInput.tsx:256-258` 只在 `draftMode === "chat"`
  时渲染 AgentPicker（`AgentPicker.tsx:8` 的注释还声称"两个 mode 都能选"）。只能靠 `@提及` 或任务。
- ~25 个 localStorage key 散在 8 个文件里，`trellis-theme` / `trellis-palette` 在
  `hooks/useTheme.ts:17-18` 与 `app/layout.tsx:33,36` **双份硬编码**（layout 里有注释承认）。

---

## 2. 组织原则：把三类东西分开

| 类别 | 判据 | 有哪些 | 该住哪 |
|---|---|---|---|
| **持久对象** | 有 CRUD、跨 session 存活、被 id 引用 | agent、task、provider/模型目录、project/workspace、CLI attach 目录 | **一个管理台**（`/settings` 左 tab 壳） |
| **当下语境** | per-session / per-message，创建时锁定 | mode、workspace、agent、model、approval | **留在原地**，但必须是同一个组件 |
| **UI 偏好** | per-browser，随时可改，无副作用 | 主题、发送键、上下文深度、内容宽度、终端钉住、侧栏 | 原地控件不动 + 管理台加**可穷举镜像** |

第四类是**运行产物**（任务的每次执行）——它不属于设置，属于工作面，应该回到主 SPA。

---

## 3. 目标态

```
Header:  ☰  Trellis  🔍  ⚡  🧠  📁  📓  导出▾  ModeBadge  模型▾  主题▾   ⚙
                                                                        │
侧栏                                                             /settings（左 tab 壳）
├ 项目 A                                                         ├ 🎭 Agent
│  └ session…                                                    ├ ⏱ 自动化任务
├ 项目 B                                                         ├ 🧠 模型与 Provider
├ ⚙️ 自动化   ← 新增折叠组（照「🗄 已归档」）                      ├ 📁 工作区 / CLI
│  └ 每日简报  ✓ 09:00                                           ├ 🎚 偏好
│  └ 仓库巡检  ⚠ error                                           └ 🔄 版本与更新
└ 🗄 已归档
```

- Header 只留**一个** ⚙（去掉 ⏱）。理由：任务的**日常入口是侧栏**（看跑没跑、看结果），
  `/settings/tasks` 只负责**定义 CRUD**，属于低频。
- 管理台的左 tab 天然补齐三角互链。
- 主 SPA 与管理台仍用 `<a>` 硬导航（保留 `Header.tsx:386-388` 的既有理由：别把 React Flow 状态背走）；
  管理台**内部** tab 切换用 `<Link>`（同一个壳，无 React Flow）。

---

## 4. 改动清单（按批，可独立发布）

### 批 1 · 导航收拢（纯前端，零数据模型改动）

| # | 改动 | 位置 |
|---|---|---|
| 1.1 | 新建 `app/settings/layout.tsx` 左 tab 壳（tab 定义抽成常量数组，一处加 tab 全站生效） | 新文件 |
| 1.2 | 现 `/settings` 内容降为 `/settings/update`；`/settings` 重定向到默认 tab（建议 `agents`） | `app/settings/page.tsx` |
| 1.3 | `/tasks` 迁到 `/settings/tasks`；`app/tasks/page.tsx` 保留为 redirect（书签兼容） | `app/tasks/page.tsx` |
| 1.4 | Header 去掉 ⏱ 链接 | `components/Header.tsx:374-385` |
| 1.5 | 删掉三处手写的页间互链（tab 壳接管） | `settings/page.tsx:149-156`、`tasks/page.tsx:171-177`、`agents/page.tsx:107-109` |
| 1.6 | `TaskToast` 提到全站可见 | 见风险 R2，**方案未定，做之前先定** |

**判据**：从任意一页到任意另一页 ≤1 次点击；Agent 管理从 2 跳降到 1 跳。

### 批 2 · 管理台 tab 内容补齐 —— ✅ 已完成（S89）

| # | 改动 | 依据 |
|---|---|---|
| 2.1 | 「🧠 模型与 Provider」tab：把 `ModelConfigModal` 的表单提成 `components/ModelConfigForm.tsx`，modal 与 tab 共用。ModelPicker 底部入口保留（`ModelPicker.tsx:119-126`），但改成跳 tab 还是继续开 modal 由实现时定 | 现唯一入口埋在下拉底部 |
| 2.2 | 「📁 工作区 / CLI」tab：列 `projects` / `workspaces` 表 + git 状态角标 + worktree 回收；把 CLI attach（现藏在 `SessionSidebar.tsx:589` 一个长 title 的小按钮）挪进来一份 | 侧栏角落的管理动作没有家 |
| 2.3 | Agent 表单补 `permission` / `requireApproval` 两个字段 | `lib/server/agents.ts:222-226` |
| 2.4 | 任务表单补 `timeoutMs` / `overlapPolicy` / `maxBudgetUsd` / `enabled` | `lib/server/tasks.ts:34-52` |
| 2.5 | 任务运行历史加「中止」按钮 | `app/api/task-runs/[id]/abort/route.ts` 已存在 |

**判据（已验）**：`agents` / `tasks` 两张表里没有任何一个用户字段只能由 API 改。
系统字段白名单（不给 UI，有意）：`agents.sortOrder` · `tasks.homeSessionId` · `tasks.maxRetries`（schema 有列但代码里没用到）。

**实施中挖出的计划外缺陷**：`overlapPolicy` 这一列**根本不在 `TaskInput` 里**，
createTask / updateTask 都写不进去 —— 即调度器读它、但没有任何途径能设置它。
如果只按原计划「表单加个 select」就完事，那个开关会静默失效，正是这一轮一路在挑的
「谎言级 UI」。已一并补全服务端（`lib/server/tasks.ts` 的 TaskInput / createTask / updateTask）。

新增：`GET /api/workspaces`（只读回 `listProjectTree()`）—— `/api/workspaces/recent` 不回
id/kind/createdBy，而「能不能删这个 worktree」的判据恰好是 `createdBy==='trellis' && kind==='worktree'`；
复用 `/api/sessions` 又会把管理台耦到那条流式期间 ~1.6 次/秒的热路径上。

### 批 3 · 抽共用运行配置（治重叠的主刀）—— ✅ 已完成（S89）

> **实施时偏离了本条的原计划，理由如下**（原文：新建一个 `RunConfig.tsx` 带 draft / task /
> agent 三种 variant）。读完三处实现后判断那是**假抽象**：draft 是空状态首屏的图标分段器
> （那一屏最重要的选择，值得占地方），task 是表单里的一行 select（旁边还有 name / prompt /
> 通知，分段器会喧宾夺主）—— **控件形态本来就该不同**，硬塞进一个组件只能得到一个巨大的
> variant 分支。
>
> 真正在漂的是**文案与语义**，不是布局。所以实际做成：

- **`lib/run-config.ts`** 🆕 文案 / 语义唯一真源（无 JSX，图标留在各组件）：
  `contextModeOptions(provider)`（含 `short` 给 select、`title` 给 hover）· `workspaceRequired`
  · `AGENT_DEFAULT_LABEL` / `AGENT_DEFAULT_HINT` / `agentHint()` · `agentSupported()` /
  `AGENT_UNSUPPORTED_HINT` · `approvalCopy()` / `approvalAvailable()` · `basename()`
- **`components/run-config/WorkspaceField.tsx`** 🆕 三处运行配置里**唯一真正同一个的控件**，
  所以只有它被抽成组件。支持受控 open（ModePicker 靠它保住「切到 project 自动弹 picker」
  这条既有行为）。
- 消费方改为引用共享真源：`ModePicker` · `AgentPicker` · `ModeBadge` · `app/settings/tasks/page.tsx`

**顺带修掉的**：
- 3.1 ✅ project 模式补 Agent 入口 —— `QuestionInput.tsx` 原来整块被 `draftMode === "chat"`
  关着，而服务端 `chat/route.ts:336` 对 agentId 的钳制条件**只有「claude 家族」、不看 mode**。
  即 project 会话一直支持 agent，只是界面上没入口，只能靠 `@提及`。已实测截图确认入口出现。
- 3.2 ⚠️ **原描述有误** —— ModeBadge 的 AgentChip **早就做了**灰化 + 说明（`ModeBadge.tsx:87`），
  不是「至今未做」。真实的缺陷小得多：它手写 `model.startsWith("codex")` 判家族，
  **漏掉 mock**（服务端钳制条件是 `providerFamily(...) === "claude"`，mock 会话同样拿不到
  agent 却会显示成生效）。已改走 `agentSupported()`。
  另外 `AgentPicker` 在非 claude 下原本 `return null` 整个消失 —— 若用户先选了 agent 再换模型，
  那个选择就无声失效。改成：选过就留一枚灰 chip 说明，没选过才不出现。
- 干掉 `app/settings/tasks/page.tsx` 的**裸绝对路径 input** → WorkspaceField。副作用是任务表单
  白拿了空白沙箱 / 新建 worktree / 最近列表 / 目录浏览（原来一样都没有）。

**判据（已验）**：mode 文案在 `lib/run-config.ts` 之外零命中；组件层没有第二个手写的
workspace 路径 input；tsc ✓ / lint 35 = baseline 零新增 / build ✓；隔离实例上端到端建了一个
任务，WorkspacePicker 选出的绝对路径正确落 `tasks.workspace_path`。

### 批 4 · 任务运行回主 SPA（**已降级 —— S89 实测推翻了它的前提**）

> **2026-07-31 更新**：批 1 验证期间查了真库快照，`tasks` / `task_runs` / `sessions WHERE kind='task'`
> **三张表全是 0 行**（见 `facts.md` 第一条，含复现命令）。S88 做完的整套任务系统上线至今
> **一次都没被用过**。
>
> 这推翻了批 4 的前提。原本的论证是「`/tasks` 把运行历史在 SPA 外重实现了一遍，把落点露出来
> 就能免费拿到工具卡片 / 分叉 / 搜索」—— 成立，但**收益乘以零流量等于零**。而它的判据
> （一周内从侧栏进入任务会话 > 0）在有人先建出任务之前**结构上不可能达成**。
>
> **改判**：批 4 从「杠杆项」降为「等有任务之后再做」。真正该先答的问题变成 **为什么零使用**，
> 三个候选（按可证伪性排序，都能被批 1/批 3 顺带证伪或坐实）：
> ① 入口太深（S89 前要 2 跳 + 藏在一个 ⏱ 图标后）→ 批 1 已把它变成 1 跳，观察一周；
> ② 建任务的表单劝退（裸路径 input、缺 timeout/overlap/budget、cron 只能从预设里挑）→ 批 3 + 批 2 修；
> ③ 需求本身不成立（本机 CLI + cron 已经够用，不需要 trellis 代管）→ 若 ①② 修完仍为 0，就该
>    考虑砍掉而不是继续加功能。
>
> **顺序因此调整为 1 → 3 → 2 → 5 → 6 →（观察）→ 4**。下面的原始设计保留，等前提回来再用。


任务的执行落点**已经是** session/node（`lib/server/tasks.ts:374-376` 打 `kind='task'`，
`lib/server/repo.ts:342-352` 从列表里滤掉）。`/tasks` 页现在等于把「列表 + 运行历史 + 深链」
在 SPA 外又实现了一遍。

| # | 改动 |
|---|---|
| 4.1 | `listSessions` 加 `kind` 参数（`lib/server/repo.ts:342`），默认仍只回 `user` |
| 4.2 | 侧栏底部新增「⚙️ 自动化」折叠组，照 `🗄 已归档`（`SessionSidebar.tsx:617`）的实现 |
| 4.3 | 每行 = 一个任务（对应它的 home session），角标显示最近一次 run 状态（✓ / ⚠ / ▶ 运行中） |
| 4.4 | 点进去 = 主 SPA 正常打开该 session，免费拿到工具卡片 / 就地分叉追问 / 搜索 / TaskToast |
| 4.5 | `/settings/tasks` 的运行历史列表退化为跳链（保留，因为它按 run 排序而侧栏按任务排序） |

**前置调研（必须先做，见 R1）**：一个任务会话有 N 个平行根节点（一个每日任务一个月 30 个），
canvas / linear 两个视图在这个形状下怎么表现？

**判据**：`workspaces.created_by='trellis'` 那次教训的同款行为指标——上线一周内，
**从侧栏进入任务会话的次数 > 0**（否则说明这个组和 `/settings/tasks` 一样没人用）。

### 批 5 · 偏好层（镜像式）—— ✅ 已完成（S89）

| # | 改动 |
|---|---|
| 5.1 | 新建 `lib/prefs.ts`：集中 key 常量 + 类型 + 读写。把 8 个文件里的字面量收进来 |
| 5.2 | 修 `trellis-theme` / `trellis-palette` 双份硬编码（`hooks/useTheme.ts:17-18` 与 `app/layout.tsx:33,36`）——layout 的首屏防闪脚本从常量生成 |
| 5.3 | 管理台「🎚 偏好」tab 渲染**镜像清单**，与原地控件共用同一个 store |

**明确不做**：不把原地的 popover / 输入框脚注搬走。语境化仍是主路径，镜像清单只解决
「我知道有这个设置，但找不到在哪改」。

**判据（调整并已验）**：原判据是「所有 localStorage 调用点都走 prefs.ts」。实施时改为
**只收拢 key 名、不接管读写逻辑** —— 57 个调用点里 41 个在 `stores/sessionStore.ts`（3000+ 行的
核心，且它**早已把自己的 key 集中声明在文件顶部**并带着有价值的注释）。为了一条形式判据去重写
那 41 处读写，是拿主路径的回归风险换一个好看的 grep 结果。真正在漂的只有主题那两个 key
（useTheme.ts 与 layout.tsx 各硬编码一份，后者还留着「keep them in sync」的注释）——那一处已
物理消除：layout 的首屏防闪脚本现在从 `PREF_KEYS` **插值生成**。实测：在偏好 tab 改皮肤 →
localStorage 写入 → 刷新后 `html[data-theme]` 正确，两条路读的是同一个 key。

### 批 6 · 语义冲突修复 —— ✅ 已完成（S89）

| # | 冲突 | 处理 |
|---|---|---|
| 6.1 | `tasks.model` 存 providerId ≠ `agents.model` 存模型名 | 加列 `tasks.provider_id` 迁移 + 废弃旧列，或至少在 UI/类型上改名并加注释。**建议前者**，趁 tasks 表还年轻 |
| 6.2 | `require_approval` 双源（session / agent） | 定死优先级（建议 agent 覆盖 session，与 `agents.model` 同构），写进 `facts.md` + UI 提示 |
| 6.3 | `sessions.kind` vs `nodes.kind` | 加注释即可，不改名（改名要动 SQL 全站） |
| 6.4 | agent 的「技能」vs slash 「技能」 | UI 文案区分：agent 侧叫「挂载技能」，slash 侧维持「技能」 |

---

## 5. 风险与未决

**R1 · 任务会话的多根渲染（批 4 的前置）**
`repo.ts:347` 的注释给的隐藏理由是「一个每日任务一个月能产 30 个节点」。侧栏噪音其实很小
（**行数 = 任务数，不是运行数**），真正的未知是**打开那个 session 之后**：canvas 会横向越来越宽、
linear 只走一条 lineage。做批 4 之前必须先在真库副本上打开一个多次运行过的任务会话看实际表现。
可能的降级：只渲染最近 N 个根 + 「加载更早的运行」。

**R2 · TaskToast 多挂 = 多条 SSE**
`TaskToast.tsx` 自订阅 `/api/tasks/events`（手写读取 + 重连）。挂到 `app/layout.tsx` 需要
client 包一层，且 `/login` 页要跳过（未登录时那条 SSE 会 401 循环重连）。
批 4 做完后这条会自然缓解（任务结果在侧栏可见，toast 的必要性下降），**可以考虑推迟**。

**R3 · Header 去掉 ⏱ 后任务入口变远** —— *S89 已处理，且删除条件被收紧*
批 1 已按此保留 ⏱ 并改指 `/settings/tasks`。原计划是批 4 上线后删掉它。
**但零使用那条实测把结论推得更远**：既然「入口太深」是零使用的头号嫌疑，
在任务真被用起来之前**不能删**这个入口 —— 那等于在诊断没做完的时候先把嫌疑加重一档。
删除条件改为：任务真的被用起来 **且** 侧栏已有替代入口。

**R4 · 批 6.1 的迁移**
`tasks.model` 改列涉及数据迁移。`migrate()` 至今全是加法 DDL（`decisions.md` 2026-07-28 条目
把这一点列为"本仓库适合搬运"的理由之一），第一次做减法要格外小心，建议加列 + 双写 + 读时兜底，
旧列留一个版本再删。

---

## 6. 明确不做

- **不把语境化控件搬进管理台**。`decisions.md` 2026-07-29 那条的核心理由（"搬进来只是多一跳"）
  至今成立，批 5 只加镜像不搬家。
- **不动 agent / task 的执行链**。`applyAgent()` 的边界（ADR 决策 5：只改人设 + 能力面，
  绝不碰上下文与身份）在本轮全程不碰。
- **不做快捷键自定义**。`KeyboardHelp` 保持只读，`lib/shortcuts.ts` 仍是静态注册表。
  （但可以顺手补登记 `⌃\`` 和 `⌘B/⌘I`——它们现在按 `?` 看不到。）
- **不改 `/login`**。
