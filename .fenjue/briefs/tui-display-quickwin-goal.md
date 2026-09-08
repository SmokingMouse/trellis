目标：agent-tui 时间线的信息设计急救（阶段 2，你是 Claude sonnet 坐席，走 agent-tui runner）。用户实际截图里的现状：工具调用以 `$ cmd` + 全量 stdout 原样倾倒（grep 几十行、--help 上百行全铺开）、空的 reasoning 也占一行「Reasoning: [折叠 · Ctrl-R 展开]」、三行状态头里全是占位符（`ctx [??????????] ?% / ~200000`、`tokens —`、`effort —`）、所有内容同色无层次、长行在单词中间硬折（`cc_stri` / `ngs.txt`）。对人来说没法看。分支 feat/tui-display-quickwin（基于 feat/agent-server），worktree 无 node_modules，先 `bun install`。只改 apps/agent-tui。

设计参照（只参考规则，不抄代码）：Claude Code 的做法——工具调用一行摘要，结果默认折叠成几行并提示展开；见 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-cc-tui-design-c117/out/cc-tui-design.md` §2.3「折叠与展开」。

交付（按优先级，全部要做）：
1. **工具调用与命令**：一行头部 = 状态符号 + 命令/工具名 + 关键参数（按列宽截断，末尾 `…`）+ 耗时；输出默认折叠：成功只留最后 3 行，失败留退出码 + 最后 5 行，并显示「… 共 N 行 · Ctrl-O 展开」；Ctrl-O 在当前/最近一个可展开项上切换展开，展开后同键收起。Read/Grep/Glob/Edit 等非命令工具：单行摘要（如 `Read protocol.md:230–285`、`Grep "approvals" → 12 处`、`Edit claude.ts +12/−3`），输出同样折叠。
2. **reasoning**：文本为空的不渲染；非空默认折叠成一行「思考 N 字 · Ctrl-R」。
3. **状态头**：压到最多两行；未知值不显示（不要 `?`、`—`、`[??????????]`）；ctx 条只在拿到窗口大小时画；线程 id 缩短到前 8 位。
4. **层次**：用户消息、助手正文、工具块、系统提示用不同颜色/亮度（工具输出用 dim），turn 之间一条细分隔线；助手正文按词折行（ASCII 不在单词中间断，CJK 按字符），保留终端的 NO_COLOR 约定。
5. **底部提示**：一行、dim，只留最常用五个键；其余进 `/help`。

约束：不改协议客户端、租约、审批握手、按键路由的语义；不引入新依赖；`bun test apps/agent-tui/src` 全绿——`render.test.ts` 的 4 个快照允许更新，但每个变更的快照要在 out/result.md 里贴前后对比并说明；新增测试：一个 500 行命令输出的 fixture 在折叠态渲染 ≤ 8 行、Ctrl-O 后完整、再按收起；一个空 reasoning 不占行的断言；一个状态头无占位符的断言。交付前用 `apps/agent-tui/bin/agent-tui`（重新打包）真机连一次 daemon 看效果，截屏（`herdr pane read` 或 PTY 快照）附进 out/。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。提交到本分支。
