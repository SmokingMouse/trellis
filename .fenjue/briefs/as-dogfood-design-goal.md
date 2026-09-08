产出《fj 坐席改走 agent-tui 的实施方案》，落 out/design.md。背景：herdr-leader 的 fj（~/.claude/skills/herdr-leader/scripts/fj 及同目录源码、references/playbook.md、seats.md、runners/）现在在 Herdr pane 里裸起 claude/codex 原生 TUI，用 herdr agent prompt 注入契约、靠 herdr 的 agent_status 判忙闲、坐席用 fj mail 汇报、验收靠 settle 复跑 verify。目标是把执行坐席改成：pane 里起 apps/agent-tui 连本机 agent-server daemon，每坐席一个 thread，让 Trellis 能 attach 同一 thread。你要给出可实施的方案，不写代码。内容：
(1) daemon 常驻：launchd 起法、socket/token 位置、多 daemon 还是单 daemon、崩溃恢复与 thread resume（读 packages/agent-server/src/daemon 与 docs/agent-server/README.md、protocol.md）。
(2) 起坐席：fj task launch 新增 --runner agent-tui 时的序列（切 pane → 起 agent-tui 指定 backend/model/cwd → thread/start → 契约作为首轮 turn 注入 → 记 thread id 到 task.json）；模型显式指定（禁止落到 fable）；codex 走 gpt-6-astra 普通档。
(3) 审批策略：等价 codex -a never / claude --dangerously-skip-permissions 的 AS 侧配置（thread/start 的 permission 参数或 daemon 策略），以及 leader/Trellis 想介入审批时怎么切换。
(4) 状态与汇报：Herdr agent_status 对 agent-tui 是否仍能识别忙闲（读 agent-tui 如何上报 pane.report_agent_session / 标题）；fj mail 在坐席内照常可用；fj next 的停滞/催醒依赖什么信号；settle/verify 完全不变。
(5) 观测：Trellis attach 同一 thread 需要什么（thread id 从哪拿、cwd 对应 worktree）；与现有桥的 pane 绑定如何共存（同一坐席同时有 pane 与 thread，绑定类型取 thread）。
(6) 回滚开关与分阶段：先 codex 坐席、再 claude 坐席；每阶段退出标准（连续 N 单无 AS 丢消息/审批卡死、settle 通过率不低于现状）。
(7) 实现拆解：按文件列改动点（fj 源码、agent-tui、daemon、herdr-leader references），每项估量级与依赖，可并行的标出来。
只读；不改仓库与 skill 文件；不启动真 claude/codex；临时物只在 /tmp。首行「结论：」一句话。完成发 result。blocker 期间不发 result。
