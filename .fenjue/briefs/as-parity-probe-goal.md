产出《Claude Code 原生功能 → agent-server 对齐清单》，落 out/parity.md。背景：agent-server（本 worktree packages/agent-server，claude 引擎在 src/engines/claude.ts 与 claude-mapper.ts，薄 TUI 在 apps/agent-tui）用 Claude Code 的 headless stream-json 协议驱动引擎；用户准备把亲手用的 Claude 会话也改成起 agent-tui，问「为什么没有原生那些功能」。你要给出可核的答案。做法：
(1) 列全原生功能清单：从本机 claude 二进制/bundle 里 grep 出 headless 协议的 control_request / control_response 子类型、stream-json 输入类型、CLI flags（--permission-mode、--model、--resume、--fork-session、--mcp-config、--allowedTools 等）；从 `claude --help` 与官方文档（用 WebFetch 读 docs.anthropic.com 的 Claude Code 文档，只引官方页）列斜杠命令、权限模式、plan mode、MCP、hooks、子 agent、AskUserQuestion、compact、Remote Control、图片粘贴、@ 文件、vim 模式、自定义命令、skills 等。
(2) 每项分三档并给证据：A 引擎层已有（headless 协议里有对应指令/事件，写出子类型名或 flag）；B 壳层要画（能力在引擎里但交互要 agent-tui 实现，写出需要渲染/输入什么）；C 真做不到（headless 没有暴露，写出为什么）。再标 daemon 现状：已透传 / 未透传（读 claude.ts、claude-mapper.ts、protocol schema 逐项核）。
(3) 用户实际使用频率：只读扫描 ~/.claude/projects/**/*.jsonl 近 60 天的用户消息，统计 <command-name> 斜杠命令、@ 文件引用、图片粘贴、AskUserQuestion 出现次数、permission_mode 分布（transcript 里有）、hooks 触发；加上 ~/.claude/settings.json 与 ~/.claude/commands、skills 目录的配置面。只出聚合数字与命令名，不引用任何对话内容。
(4) 按「用户频率 × 缺口大小」给追平顺序，每项估 agent-tui 的实现量级（小/中/大）与依赖的协议改动。
(5) 结论段回答用户的问题：哪些是"能力本来就在、只差壳"，哪些是真没有。
只读；不改仓库；不启动真 claude 跑额度（bundle grep 与 --help 即可）；临时物只在 /tmp。首行「结论：」一句话。完成发 result。blocker 期间不发 result。
