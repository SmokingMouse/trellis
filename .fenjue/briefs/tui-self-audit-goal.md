你是 gpt-6-astra 调研坐席，只读。对象：我们的 `apps/agent-tui/`（以及它依赖的 `packages/agent-server` 协议面）。目的：给「参考 Claude Code TUI 核心设计改造 agent-tui」做基线。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/agent-tui-audit.md`（中文，每条带 `file:line`）：

1. 现状架构：技术栈（渲染库与版本、状态管理、事件循环）、模块图、代码量、测试面（PTY E2E、按键矩阵测试）。
2. 现有交互清单：会话（/new /threads /fork /resume 重连）、输入（图片、@ 补全、/ 补全、多行、粘贴）、模式（Shift+Tab、/permissions、plan 卡、/effort、/model、/compact、上下文条）、观测（系统日志条、子 agent 面板、任务列表）、审批与 pendingRequests、引擎命令（! shell、/diff /context /usage /mcp /rewind）、模态按键路由（卡 > 确认 > 选择器 > 输入）。每项标：实现位置、成熟度（可用 / 勉强 / 缺）、已知问题（引用 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-*/out/review.md` 里未收口的 P2）。
3. 结构性弱点：从零发明导致的坑——渲染性能（长会话重绘、流式）、宽字符与 IME、resize、焦点与按键路由的可维护性、组件复用、主题与设计系统缺失、测试脆弱点（PTY 计时）。
4. 与 agent-server 协议的耦合面：TUI 哪些能力受协议限制（列协议缺口），哪些是纯 UI 问题。
5. 结论：如果按「引擎无关内核 + 成熟 TUI 交互」重构，哪些模块可保留、哪些应替换、替换的风险与回归面（现有 PTY E2E 能否复用）。

不改任何文件；临时文件只放 mktemp 目录。
