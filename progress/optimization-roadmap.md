# Trellis 优化方案 Roadmap — 锚定「替代 GPT 成为个人核心对话问答平台」

> 生成于 2026-06-07。本文档基于对全仓库代码的实测测绘（4 个只读 agent 按四维度 grep + 读代码确认，全部结论带 `file:line` 证据），不是凭空想象。
> **目标**：给出一条从交互 / UI / 功能性 / 对话内核四个维度优化 trellis 的可执行路径，让你「想问点什么不再下意识打开 chatgpt.com」。

---

## 0. 现状定位（一句话）

Trellis 当前是一个**成熟度 ~75% 的「树状画布对话工具」**，已完成 Stage 1–17：三模式（chat/workspace/project）、树状分支、画布可视化、图片输入、FTS 全文搜索、工具调用可视化、durable streams。

**它在三件事上已经超过 GPT**：① 树状分支对话（vs GPT 线性 thread）② 工作目录绑定 + 工具调用可视化（吃掉 Claude Code CLI）③ 断线不杀生成的 durable streams（移动端鲁棒性）。

**但要替代 GPT 成为「日常默认入口」，还差的不是功能广度，而是三层体验**：
1. **交互手感**——发送/编辑/复制这些高频动作还有摩擦，不如 GPT「一发一收」顺滑；
2. **UI 精致度**——视觉已是中等偏上，但代码块交互、移动端导航、响应式有硬伤；
3. **对话质量内核**——system prompt 写死、上下文折叠策略写死、无语义记忆，这是「回答好不好」的根。

### 与现有 `roadmap-2026q2.md` 的关系（不重复造）

| | 现有 roadmap-2026q2 | 本文档 |
|---|---|---|
| 视角 | **功能广度**：Stage 18 skill / 19 文件 / 20 plan / 21 memory / 22 subagent | **体验深度**：交互手感 + UI 精致 + 对话内核 |
| 状态 | Stage 18–22 待做 | 全新补充 + 复用其中 3 项 |

本文档**复用并对齐**现有 roadmap 的三项（下文标注 `↩Stage`）：`C1 文件附件 = Stage 19`、`C2 含 Stage 21 Memory`、`C4 Skill 入口 = Stage 18`。其余为现有 roadmap 未覆盖的体验维度新增项。

### 图例

- **优先级**：`P0` = 替代 GPT 的硬门槛，不做就会下意识切回 chatgpt.com（高频痛点）；`P1` = 做了明显拉开体验差距；`P2` = 锦上添花 / 长期。
- **工作量**：`S` ≈ 半天；`M` ≈ 1–2 天；`L` ≈ 3–5 天。

---

## 维度 A：交互 / 响应手感

> 总评：trellis 的设计优先级是「树状协作 > 聊天手感」——为了数据完整性（immutable node tree）和防误触（Cmd+Enter）牺牲了 GPT 那种即时反馈的爽感。日常高频对话场景下这是最先被感知的落差。

| # | 任务 | 现状 vs GPT 差距 | 改动方向 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| A1 | 流式期间实时 markdown 渲染 | 流式只 `textContent` 纯文本直写（`ChatNode.tsx:94`），完成才一次性渲染 markdown；GPT 流式同步出代码高亮/格式 | 流式期间用 rAF 节流增量渲染 markdown（或轻量增量解析器），代码块边流边高亮 | **P0** | M |
| A2 | 编辑已发消息 + 改问法重生成 | 无 edit message（grep 确认）；`retryNode`（`sessionStore.ts:548`）只能原样重试；GPT 核心闭环是「问→看→改→再问」 | 节点 question 可编辑 → 重跑该节点（树语义见开放决策 Q1） | **P0** | M–L |
| A3 | 代码块复制 + 回复整体复制 | 无任何复制按钮（两 agent grep `copy/clipboard` 均空）；GPT 代码块「复制」是标配 | `md-components.ts` 给 `pre/code` 包 copy 按钮；回复 footer 加「复制全文」 | **P0** | S |
| A4 | 发送键策略可配（默认对齐 GPT） | `Cmd+Enter` 发送 / `Enter` 换行（`QuestionInput.tsx:131-136`）；GPT 是 `Enter` 直接发，高频聊天摩擦低 3 倍 | 加设置「Enter 发送 / Cmd+Enter 发送」开关，Chat 模式默认 Enter 发送 | P1 | S |
| A5 | 节点间键盘导航 | 仅 `J/K` 跳未读 + `B` 回父 + `F` 全屏（`useUnreadNavigation.ts`、`NodeFullView.tsx:148`）；无「上/下一条」「聚焦相邻节点」 | 方向键/快捷键在树上移动 active 节点 + 居中 | P1 | S–M |
| A6 | 全局命令面板 | 无全局 palette（`⌘K` 已被选区分叉占用，`BranchPopover.tsx:51`）；GPT/现代工具有命令面板 | 新键位（如 `⌘J`）开命令面板：切模型/新对话/搜索/导出/跳节点 | P2 | M |

**A1 展开**：当前流式直写 DOM 绕过 React（性能好），但代价是「流式期间全程纯文本、代码无高亮」（交互 agent 确认）。GPT 体验里「边出边格式化」是质感关键。风险：增量 markdown 解析在未闭合代码块/表格时会闪烁，需做「最后一个未完成块降级为纯文本、已完成块才渲染」的策略。

**A2 展开**：这是 GPT 替代度最高频的缺口（「改一个字重问」每天发生）。但 trellis 是 immutable tree，「编辑」语义需决策（见 **开放决策 Q1**）——是「原地改 question + 清空并重跑下游子树」，还是「编辑= 在父节点开一个新 sibling 分支」。前者符合 GPT 直觉，后者符合 trellis 树哲学。方案文档先两案并列，执行时定。

---

## 维度 B：UI / 信息密度

> 总评：整体视觉**中等偏上、接近产品级**（玻璃态、完整深色模式、未读/已读/流式/错误的细致状态色、脉冲动效）。短板集中在「代码块交互、移动端导航、响应式」三处硬伤，以及 a11y 细节。

| # | 任务 | 现状 vs GPT 差距 | 改动方向 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| B1 | 响应式卡片宽度 + 移动端 Outline 可达 | 卡片 600px 固定宽（`ChatNode.tsx`）；`sm/md` 响应式类几乎只在 Header 用；Outline `hidden md:block`（`Outline.tsx:79`）移动端**完全消失**；GPT 移动端侧栏可滑出 | 卡片宽度随视口；移动端给 Outline 抽屉/底部入口 | **P0** | M |
| B2 | 代码块语言标签 + 视觉完善 | 有 github 高亮但无语言标签（`globals.css:99-336` 确认）；GPT 代码块顶部有「python」标签 + 复制 | 代码块顶 bar：语言名 + 复制按钮（与 A3 协同实现） | P1 | S |
| B3 | 长回复折叠 / TOC | 节点内 `max-h-[420px]` 滚动（`ChatNode.tsx:292`），长回复卡在小滚动区体验差 | 长回复「展开/收起」+ 长内容自动生成 TOC 锚点 | P1 | S–M |
| B4 | 首屏引导 / 建议问题 | 有基础空状态（QuestionInput 首屏「想深入探索什么？」）；GPT 有 suggested prompts + 最近会话 | 首屏加最近 session 快捷入口 + 示例问题卡片 | P2 | S |
| B5 | a11y：focus-visible + 对比度 + 允许缩放 | 无 `focus-visible` 类（agent 确认）；`userScalable=false`（`layout.tsx:21`）禁了移动端缩放；部分 `stone-400` 对比度疑似不足 WCAG AA | 补 focus ring；审低对比度；移动端解禁缩放（或仅画布禁） | P2 | S |

**B1 展开**：移动端 Outline 完全隐藏意味着手机上**失去整棵树的导航能力**——而树状导航恰是 trellis 的杀手锏，移动端把它藏了等于阉割核心优势。这条 P0 不是为了「好看」，是为了移动端可用性。

---

## 维度 C：功能性能力

> 总评：图片输入 ✅、FTS 搜索 ✅、工具可视化 ✅、导出 ✅，但对标 GPT 的能力清单还缺四块硬的：文件分析、跨对话记忆、语义检索、Codex 侧对齐。

**ChatGPT 核心功能 vs Trellis 现状对照**（agent 实测）：

| 功能 | trellis | 缺口 |
|---|---|---|
| 基础对话 / 图片理解 / 全文搜索 / 模型切换 | ✅ | — |
| 联网搜索 | 部分 | Chat 模式 WebSearch✅；**Codex chat 完全离线** |
| 文件上传分析（PDF/Word/Excel） | ❌ | 仅图片，文件留 Stage 19 |
| 长期记忆 / 自定义指令 | 部分 | 仅 project per-root 单线程；**system prompt 写死、无 UI** |
| 图片生成 / 语音 | ❌ | 无（需付费 API，定位待定） |
| 深度研究模式 | ❌ | WebSearch 可用但无专用 UI |

| # | 任务 | 现状 vs GPT 差距 | 改动方向 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| C1 ↩Stage19 | 文件附件（PDF/Word/Excel/code） | 仅图片（Stage 15）；GPT 能传 PDF 直接分析 | 拖拽进 reference 节点：PDF→`pdf` skill 抽 md / Excel→表格 / code→直读 | **P0** | L |
| C2 ↩Stage21 | 跨对话记忆 + 自定义指令 UI | 仅 project per-root 记忆；system prompt 硬编码（`prompt.ts:32-33`）无 UI；GPT 有 memory + custom instructions | ① custom instructions 编辑器注入 system prompt ② 节点↔`~/.claude/memory/` 桥接 | **P0** | M–L |
| C3 | 语义检索补 FTS | FTS5 是 trigram 子串匹配（`sqlite.ts:120`），非语义；「找回那次聊过类似概念的对话」搜不到 | embedding 索引 + 语义/FTS 混合检索（需 embedding API，见 Q2） | P1 | L |
| C4 ↩Stage18 | Skill 调用入口 | 无（roadmap 已规划）；50+ 本地 skill 接不进来 | 输入 `/<skill>` 触发 picker，走 SkillTool 路径 | P1 | M |
| C5 | 模型选择 session 级 + 每轮可选 | 全局切换（`ModelPicker`，全局 state）；无成本/质量按需权衡 | session 级绑定 + 可选每轮升降级（haiku↔opus） | P2 | S–M |
| C6 | 图片生成 / 语音 | 完全无；GPT 有 | 需第三方付费 API（见 Q3），与「单人单机 CLI」定位契合度待定 | P2 | L |

**C2 展开**：这是「替代 GPT」的第二大高频缺口。GPT 的 memory + 自定义指令让它「记住你是谁、怎么跟你说话」。trellis 的 `~/.claude/CLAUDE.md` 在 workspace/project 自动加载，但 chat 模式 system prompt 写死成「简洁有耐心的助教…不调用任何工具」（`prompt.ts:32-33`），用户改不了、是黑盒。最小可用版：先做 custom instructions 编辑器（P0 子项，S–M），Memory 桥接（Stage 21，M）随后。

---

## 维度 D：对话质量内核

> 总评：这一层决定「回答好不好」，是替代 GPT 的根，却最隐形。三个写死的策略（system prompt、上下文折叠 depth=2、工具结果无闭环）限制了回答质量上限。

| # | 任务 | 现状 vs GPT 差距 | 改动方向 | 优先级 | 工作量 |
|---|---|---|---|---|---|
| D1 | System Prompt / 角色可配 | chat 模式 system prompt 硬编码（`prompt.ts:32-33`）；直接决定回答风格/质量却不可改 | 可配 system prompt：全局默认 + per-session 覆盖 + 预设角色库（与 C2 协同） | **P0** | S–M |
| D2 | 上下文组装策略可调/可视 | chat/workspace 历史折叠 `maxDepth=2` 硬编码（`repo.ts:802-871`）；深树时模型只看 2 层祖先，可能丢关键上下文；GPT 是完整线性历史 | depth 可配 + 「带哪些祖先」可视化手选 + 超长自动摘要 | P1 | M |
| D3 | 工具结果闭环 + 失败重试 | tool output 存了但模型对结果无二次处理框架、工具失败无自动重试（架构 agent 确认；agent-gateway 是否已支持需执行时确认） | tool result 回灌模型继续推理 + 失败重试 UI | P1 | M |
| D4 | 思考过程（thinking）可视化 | claude thinking 块不渲染（Stage 17 caveat 确认）；GPT o1/深研展示推理 | 可选折叠展示 `assistant.content[].type==="thinking"` | P2 | S |
| D5 | 同问多版本并排对比 | 只能原地 retry，无多版本对比；trellis 树状天然适合 | 同一问题生成 N 版并排（复用现有 sibling 机制） | P2 | M |

**D2 展开**：`maxDepth=2` 是个隐形的回答质量杀手——分支聊深了之后，模型实际只看到「直接父 + 祖父」两层（`repo.ts` 确认），更早的关键铺垫丢了。这解释了「为什么深分支后 AI 好像忘了前面说的」。GPT 没这问题（线性全历史）。trellis 树状结构其实能更聪明地选上下文（按 anchor / 按相关性），但当前策略是粗暴折叠。

---

## 统一执行清单（按优先级排序 = 你要的「路径」）

### 第一阶段 · P0（替代 GPT 的硬门槛，建议按此顺序做）

> 顺序原则：先 quick win 攒手感（S 优先），再啃中大件。

| 序 | 任务 | 维度 | 工作量 | 一句话价值 |
|---|---|---|---|---|
| 1 | **A3** 代码块/回复复制 | 交互 | S | 半天见效，每天都用 |
| 2 | **D1** System Prompt 可配 | 内核 | S–M | 解锁回答风格，黑盒变白盒 |
| 3 | **A4** Enter 发送（并入设置） | 交互 | S | 抹平最刺手的发送摩擦 |
| 4 | **A1** 流式实时 markdown | 交互 | M | 长回复质感对齐 GPT |
| 5 | **B1** 响应式 + 移动端 Outline | UI | M | 救回移动端核心导航 |
| 6 | **A2** 编辑消息 + 重生成 | 交互 | M–L | 补上「问-看-改」闭环（先定 Q1） |
| 7 | **C2** 自定义指令 + 记忆桥接 | 功能 | M–L | 「记住我是谁」 |
| 8 | **C1** 文件附件（↩Stage19） | 功能 | L | 传 PDF 分析，吃掉一类任务 |

→ **第一阶段验收**：日常想问问题第一反应打开 trellis 而非 chatgpt.com；能传 PDF 问；能改问法重问；能复制代码；手机上能用。

### 第二阶段 · P1（拉开体验差距）

`B2` 代码块语言标签 → `A5` 节点键盘导航 → `D2` 上下文策略可调 → `B3` 长回复折叠 → `C4` Skill 入口（↩Stage18）→ `D3` 工具结果闭环 → `C3` 语义检索（先定 Q2）

### 第三阶段 · P2（锦上添花 / 长期）

`B4` 首屏引导 → `B5` a11y → `C5` 模型 session 级 → `D4` thinking 可视化 → `D5` 多版本对比 → `A6` 命令面板 → `C6` 图片生成/语音（先定 Q3）

---

## 需你拍板的开放决策（执行到对应任务前确认）

> 这些是「方向性」选择，不影响现在出方案，但执行到具体任务前需你定。对应 goal 的 *Pause if* 条款。

| Q | 决策点 | 选项 | 倾向 |
|---|---|---|---|
| **Q1** | **A2 编辑消息的树语义** | A. 原地改 question + 清空重跑下游子树（GPT 直觉） / B. 编辑 = 在父节点开新 sibling 分支（trellis 树哲学，无损） | 倾向 **B**——保留树的 immutable 优势，「改问法」本就是「换条路走」 |
| **Q2** | **C3 语义检索是否引 embedding API** | A. 引（OpenAI/Voyage/本地 bge，可能付费/需下模型） / B. 不引，FTS 够用 | 看你搜索痛感；本地 embedding（bge-small）零成本可先试 |
| **Q3** | **C6 图片生成/语音是否做** | A. 做（需付费 API，偏离单人单机 CLI 定位） / B. 不做，定位聚焦「文本对话 + 代码协作」 | 倾向 **B**——与现有「替代 GPT 客户端 + Claude Code CLI」定位更一致，图片生成可走已有 `ai-legion` skill |
| **Q4** | **A6 命令面板键位** | `⌘K` 已被选区分叉占用，命令面板用 `⌘J` / `⌘/` / 其他 | 低优，做到再定 |

---

## 不在本 roadmap scope（继承 roadmap-2026q2 的边界）

- 多人协作 / 用户系统 / 云同步 → 永不（单人单机定位）
- 后台任务 / cron / hook 配置 UI → Q3（嫁接 `/loop`、`/schedule`）
- Plan 节点（Stage 20）/ Subagent 子树可视化（Stage 22）→ 属功能广度，归现有 roadmap，本文档不重复
