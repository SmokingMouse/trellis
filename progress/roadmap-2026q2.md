# Roadmap: 替代 Claude Code CLI + GPT 客户端（2026 Q2，4-6 周）

## 北极星

让 Trellis 成为日常默认入口，能吃掉两条工作流：

- **GPT 网页客户端**：日常补认知、查信息、聊概念 → 由 **Chat** 模式承接
- **Claude Code CLI**：在某个仓库做一次性操作 / 长期项目协作 → 由 **Workspace** / **Project** 模式承接

当前主要痛点：Chat 缺图片输入、缺联网、缺跨 session 找回历史；Workspace/Project 缺 cwd 绑定 + 工具调用可见性，导致用户宁愿回 raw CLI。

## 模式语义最终定稿

三档平级、不可中途互转、一棵树一个模式。

| 模式 | 类比 | cwd | 默认工具 | 跨节点 CLI 记忆 |
|---|---|---|---|---|
| **Chat** | GPT 网页客户端 | 无 | `WebSearch + WebFetch` | 无 |
| **Workspace** | 一次性的 Claude Code CLI | 必选 | 全开（bypassPermissions）| 无（每分支独立）|
| **Project** | 持续协作的项目同事 / Claude Projects | 必选 | 全开 | 有（resume session）|

迁移映射：`lean → chat`、`cli-single → workspace`、`cli-multi → project`。

---

## 三波节奏

### 第一波（Week 1-2）— 让 Chat 立得住，Workspace/Project 有 cwd

**Stage 14: 模式重命名 + Workspace 引入**

- DB migration：`sessions.workspace_path TEXT NULL`、`sessions.context_mode` 值域改 `chat | workspace | project`（带兼容映射）
- CLI spawn：三档统一注入 `cwd`；Chat 用 `~`，Workspace/Project 用 `session.workspace_path`
- Chat 模式 `--tools "WebSearch,WebFetch"`（不再全空）
- `components/ModePicker.tsx` 重命名 + 文案重写 + 嵌套 workspace picker
- `components/WorkspacePicker.tsx` 新增：扫 `~/.claude/projects/` 拿最近 cwd / `.git` 检测短名 / 支持 pin / Browse 兜底
- 创建流程：QuestionInput 旁边 mode chip（默认 Chat），切 Workspace/Project 时强制选 cwd
- Header workspace badge：Workspace/Project 模式显示，Chat 隐藏
- session 创建后 mode + workspace 锁定，不可改（顶栏只展示，要换就开新 session）

→ [spec](mode-workspace-rebuild.md) 单独写

**Stage 15: 图片输入（vision，全模式可用）**

- QuestionInput 接受粘贴 / 拖拽图片
- 图片 base64 走 claude `--input-format stream-json` 多模态 / codex 多模态 attachment 字段
- 节点 schema：`attachments` 列 JSON，存图片 base64 + mime + size
- ChatNode / NodeFullView：question 区下方渲染图片缩略图，点开大图
- 移动端：相机/相册触发

**Stage 16: 跨 session 全文搜索（FTS5）**

- SQLite FTS5 虚拟表覆盖 nodes.question + nodes.response + notes.text + reference.content_md
- 触发器：node/note 写入时同步索引
- `⌘P` 全局搜索 modal：结果按 session 分组，显示 mode + workspace facet
- 跳转：点结果 → 切到目标 session + active 该节点 + scroll 到匹配段
- 历史 session 一次性回填脚本（启动时检测 FTS 表为空则全量索引）

→ Q2 中段 Chat 体验 ≈ GPT 客户端 80%

### 第二波（Week 3-4）— 让 Workspace/Project 超过 raw CLI

**Stage 17: Tool call / Bash 可视化**

最关键的一步。Workspace/Project 现在是黑盒，看不到 claude 跑了什么命令。

- llm provider 解析 stream-json 的 `tool_use` + `tool_result` 块，转换成 SSE `tool_call` event
- 节点 schema：`tool_calls` 列 JSON 数组，每条 `{ id, name, input, output, ok, duration_ms }`
- ChatNode / NodeFullView：response 上方折叠区"🔧 Tool calls (N)"，点开展示每次调用的 input / output（output 长截断 + 展开）
- 流式期间逐条 append，已完成 tool 立即可见
- Bash 输出超过 200 行折叠到 scroll 区域
- WebFetch / WebSearch 单独 icon 区分
- Token 计量重新拆桶：tool 调用产生的 token 单独统计，在 footer 标 🔧

**Stage 18: Skill 调用入口**

把用户 `~/.claude/skills/` 下 50+ skill 直接接入。

- 输入框检测 `/<skill-name>` 前缀 → 触发 skill picker（fuzzy match）
- skill 列表：扫 `~/.claude/skills/*/SKILL.md` 拿 name + description，缓存到 sessionStorage
- 选中 skill → 走 SkillTool 路径（Workspace / Project 模式才支持，Chat 不支持因为无 cwd / 工具）
- skill 调用作为特殊 `tool_call` 渲染（Stage 17 同款 UI）
- 输入框右下角小角标显示当前命中的 skill 名 + ESC 取消

**Stage 19: 文件附件**

- ReferencePicker 接受拖拽本地文件（PDF / Excel / Word / md / code）
- PDF → 调 `pdf` skill 抽 markdown
- Excel → xlsx → markdown 表格（用 sheetjs 或调 skill）
- code 文件 → 直接读 + 语言标注（用扩展名识别）
- 文件路径同时存 `ref_source_uri`，Workspace 模式下 AI 能直接 Read 原文件
- 同样的子节点划词追问能力，跟现有 reference 节点一致

→ Q2 中段 Workspace/Project 体感超过 raw CLI

### 第三波（Week 5-6）— 把树状结构优势放大

**Stage 20: Plan 节点 type**

- 新 `kind: "plan"`：节点 question = 目标，response = 步骤列表（markdown checklist）
- 每个步骤一键"展开成子节点"——子节点是 qa，自动用步骤文本当 question
- 步骤完成度同步回 plan 节点的 checklist
- 跟 ~/.claude/CLAUDE.md 的 "Plan → Execute → Verify → Learn" 原生对齐
- 创建路径：QuestionInput 旁边 mode chip 边上加一个 📋 切换（plan 是 mode 的修饰符，不是独立 mode）

**Stage 21: Memory 桥接**

- 节点上"沉淀到 memory"按钮 → 触发 Memory skill 写入 `~/.claude/memory/`
- 节点旁边显示相关 memory 卡片（基于 description 简单 FTS 匹配）
- Workspace/Project 模式下，session init 自动把当前 workspace 相关 memory 注入 system prompt
- 写入时让用户确认类型（user / feedback / project / reference / insight）

**Stage 22（可选，看时间）: Subagent 子树可视化**

- 检测 stream-json 的 `Agent` tool_use → 渲染成内嵌子树（不是节点的子节点，是节点内部的"小画布"）
- 子 agent 的 tool call 是子树的节点
- 子 agent 完成回主流程时 collapse 子树成一个总结块
- 这是 multi-agent 工作流的最佳可视化形态，但实现复杂，看时间

---

## 不在 scope

- 后台任务 / cron / 定时节点（嫁接 /loop / /schedule）→ Q3
- Hook 配置 UI → Q3
- 多人协作 / 用户系统 → 永不（定位是单人单机）
- 节点的横向引用（A 引 B 的某段）→ Q3
- Voice input → 低优
- 自动 mode 互转（Workspace → Project 升级路径）→ 不做，开新 session 替代
- 节点级 workspace override → 不做，一棵树一个 workspace

## 验收标准

按波次：

**第一波**：
- 新装用户开第一个 session → 默认 Chat → 能联网搜 → 能贴图问"这张图里是啥"
- ⌘P 全局搜出现 3 个月前问过的概念能跳过去
- 切 Workspace + 选 trellis 仓库 → AI 能 ls / cat 文件

**第二波**：
- Workspace 模式下让 AI 改一个组件 → 看得到它 Read 了哪些文件、改了什么 diff、跑了什么测试
- 输入 `/feishu-cli-read` → skill picker 弹出 → 选完直接调
- 拖一份 PDF 进来 → reference 节点出现，划词能追问

**第三波**：
- Plan 节点拆步骤 → 每步展开成子节点 → checklist 同步
- 节点一键存 memory → 后续 session 自动注入

**北极星指标**：
- 用 Trellis 处理某个仓库的开发任务，从开始到结束没有切回 `cd repo && claude` 的冲动
- 想问点什么不再下意识打开 chatgpt.com

## 开放问题

1. **图片输入在 Codex 那边的支持度**：Codex CLI 多模态参数是否稳定，需要 spike 一次。如果 Codex 短期不支持图片，Chat 模式下图片只走 Claude provider，加个 fallback 提示。
2. **Tool call 可视化的 stream-json 解析复杂度**：claude stream-json 的 tool block 嵌套有几种 case（包含 input / output / error / streaming partial），需要逐个枚举。先做 happy path，error / partial 后续补。
3. **Skill 调用的 cwd 问题**：很多 skill（feishu / 雪球 / pdf）跟当前 workspace 无关，运行时 cwd 应该是哪？提案：skill 总是在 `~` 跑，跟 Workspace 的 cwd 解耦。但 Workspace 模式下用户期望 AI 在仓库里看文件，得有个明确的语义区分。
4. **FTS5 索引大小**：长期使用后索引可能膨胀，需要 vacuum 策略；先不优化等真的成问题。
5. **Plan 节点跟现有 qa / reference 节点的混排**：plan 节点的"步骤"是 placeholder 还是 hydrated 子节点？倾向 placeholder，展开时才真创建——避免 plan 一改就要批量删孤儿节点。
