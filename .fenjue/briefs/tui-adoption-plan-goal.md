你是 Opus 方案坐席，只读。输入：两份调研报告——
- Claude Code TUI 核心设计拆解：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cc-tui-design-c117/out/cc-tui-design.md`（62 KB，§9 十条原则、§10 三张表、§11 最短路径）
- 我们 agent-tui 的自审：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-self-audit2-*/out/agent-tui-audit.md`
- 开源复用评估（OpenTUI / opencode TUI / pi / gemini-cli / Ink，含同机基准）：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-oss-tui-eval-*/out/oss-tui-eval.md`
源码可核对：Claude Code 快照 `/Users/smokingmouse/python/ai/claude-code`，我们的 `apps/agent-tui/` 与 `packages/agent-server/`。

产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/tui-adoption-plan.md`（中文，progress 风格 spec，给用户拍板用，每个判断带 file:line 或报告章节指针）：

1. 目标架构：内核不变（agent-server 协议、引擎无关，「协议类型即 UI 类型」，不复制 REPL 单体与适配器降级）；UI 分层图（屏幕缓冲层 / DOM 语义层 / 键位系统 / 协议消息渲染层 / 模态协议 / 虚拟列表）。
2. **渲染层取舍（这是用户要拍板的核心）**，三条路各给工作量（人日或坐席单数）、风险、能拿到什么、拿不到什么，并给出你的推荐与理由：
   (a) 引入上游 Ink（MIT）+ React，接受字符串 diff 模型的性能上限；
   (b) 保留现有自绘 ANSI 渲染器，按 Claude Code 的设计增量改造：packed cell 缓冲 + intern pool + damage/blit + Patch[]/optimizer + 帧 instrumentation，再补 focus 栈/hit-test/声明式光标；
   (c) 自研一套按 Claude Code fork 设计的完整渲染引擎（含 Yoga 布局 + React reconciler）；
   (d) 复用开源：OpenTUI（MIT，Zig 原生 cell 缓冲 + React/Solid + keymap）作渲染层重写组件，或整体 fork opencode 的 TUI 客户端改接我们的协议，或复用 pi 的 TUI 库——以开源复用评估报告的实测数据为准。用户明确问过「能不能直接复用开源社区的代码」，(d) 必须与 (b) 正面比较。
   用自审报告里的现状（渲染方式、单帧耗时基准、测试面）算账，不许拍脑袋。
   **leader 的默认假设（需用两份报告的数据证实或推翻）**：渲染层用 OpenTUI（@opentui/core + keymap），应用层以 fork opencode 的 TUI 客户端为起点，把它的 SDK 客户端与 session/message/part 模型换成我们 agent-server 的客户端与 Item/turn/pending 事件，保留我们的租约、发送去重、审批握手与 Herdr/fj 宿主集成（ready 握手、OSC 状态、fjContext）；若耦合面评估表明 opencode TUI 与其 SDK/事件总线缠得过深，则退到「OpenTUI + 自写组件、移植现有 controller 逻辑」。方案必须写明这个假设被推翻的判据。

3. 分阶段拆解：每阶段可独立验收、每单 ≤ 半天，写清交付物、验收命令（可直接进 fj --verify）、依赖关系（能并行的标出来）、回归面（现有 174 个 TUI 测试与 PTY E2E 哪些能复用）。第一阶段必须包含帧级 instrumentation 与可量化的性能基线（10000 条历史单帧、流式 token 帧、宽字符）。
4. 协议侧配套：为「UI 只写渲染器」需要 agent-server 协议补哪些结构化事件（progress / 通用权限请求含 cancel / 任务真相源 / 命令列表推送 / capability 运行时声明），每项标 P0/P1。
5. 风险与回退：每阶段的回退开关；私有源码只做设计参考、不整段抄代码的合规约束如何在 review 里机械检查（例如 diff 里禁止出现 Claude Code 特有标识符清单）。

不改任何文件；临时文件只放 mktemp。
