你是 Opus 调研坐席，只读。对象：本地 Claude Code 源码快照 `/Users/smokingmouse/python/ai/claude-code`（2026-03 source map 泄露版，TypeScript + Bun，约 1900 文件 51 万行；`README.md` 与 `/Users/smokingmouse/SmokingMouse'Notes/10-Projects/ai-studio/articles/claude-code-源码架构分析.md` 的 §5「UI 层」是已有地图，先读）。
目的：我们自己的 agent-tui（内核是 agent-server 协议，引擎无关）不再从零发明交互，而是参考 Claude Code TUI 的核心设计。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/cc-tui-design.md`（中文，5000–9000 字，每个结论带 `file:line` 指针）：

1. 渲染栈：`src/ink/` 这个 fork 相比上游 Ink 改了什么、为什么（reconciler / screen / frame / output / log-update / optimizer / line-width-cache / static 区与动态区 / resize / clearTerminal / hit-test 与 selection / focus / terminal-focus-state / hyperlinks / bidi）；哪些改动是长会话、流式输出、宽字符下性能与正确性的关键。
2. 应用状态与消息模型：App / REPL 的状态切分（`src/state/`、`src/screens/`、`src/components/App.tsx`、Message / MessageModel / MessageResponse），流式消息如何渲染与折叠（CtrlOToExpand、CompactSummary、diff 组件），消息列表如何避免全量重绘。
3. 输入：BaseTextInput / PromptInput 的编辑模型（多行、粘贴、历史、撤销、光标、IME 与宽字符）、`src/keybindings/`（可配置快捷键、冲突警告）、`src/vim/`、`src/ink/parse-keypress.ts`、补全（@ 文件、/ 命令、skill）、bash 模式（BashModeProgress）。
4. 模态与焦点：审批 / 权限对话框（permission 相关组件、BypassPermissionsModeDialog、AutoModeOptInDialog）、CustomSelect 与 design-system、焦点栈与按键路由（谁吞键、全局快捷键如何不被吞）、dialogLaunchers。
5. 模式与状态栏：权限模式 / plan 模式 / effort / model 切换的 UI 与状态流、上下文条（ContextVisualization、MemoryUsageIndicator、cost）、spinner、通知、IDE 状态。
6. 命令面：`src/commands/` 的注册 / 发现 / 参数 / 权限模型，本地命令与需要引擎的命令怎么分层。
7. 多 agent 与后台任务的呈现：CoordinatorAgentStatus、AgentProgressLine、`src/tasks/`、`src/coordinator/`。
8. 远程 / 服务端形态：`src/server/`、`src/remote/`、`src/bridge/`——Claude Code 自己是否已有「UI 与内核分离」的协议（这直接对应我们的 agent-server），差异在哪。
9. 提炼「核心设计原则」清单（10 条以内），加三张表：值得照抄的设计、可以不要的、必须绕开的（与我们引擎无关内核冲突的）。

硬约束：这是私有源码，只做设计参考，报告里不得整段抄代码（≤5 行片段用于指认即可）；不改任何文件；临时文件只放 mktemp 目录。
