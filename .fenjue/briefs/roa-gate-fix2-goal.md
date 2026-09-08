目标：修四审返工项（复核报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-review-36dd/out/review.md`，先读其「P0-1 / P0-2 / P1-1」与末尾返工建议）。上一轮修复 eb2416e 的主线成立（readonly 不再别名 plan、argv 落到真进程、聊天驱动 Bash 门正确），不要推倒。

leader 裁决（与 decisions.md「只读线程的写保护由 daemon 强制」一致）：
1. **P0-1**：独立 bash turn（`input:[{type:"bash"}]`）的门与 `readonly_auto_allow` 开关解耦——开关只决定「名单内命令是否免审」，永远不决定「是否有门」。`readonly_auto_allow=false` 时 readonly/plan 线程的所有独立 bash turn 一律走审批。回归测试：`readonlyAutoAllow:false` + readonly 线程 + 独立 bash turn 写命令 → `pendingRequests=1` 且命令从未写给子进程。
2. **P0-2**：default / acceptEdits 线程的独立 bash turn 同样过经纪人：名单内免审留痕，名单外产生审批；bypassPermissions / dontAsk 直接执行但留 engineEvent 审计行。五种模式各一条参数化测试。
3. **P1-1**：readonly 线程拒绝写工具（Edit/Write/MultiEdit/NotebookEdit）的 `readonly_denied` 审计行在真机不可达——查清是 `--disallowedTools` 让 CLI 根本不发 can_use_tool、还是持久化路径没走到；修到「真机可观测到审计行」（若 CLI 层已挡住，则在 daemon 侧于工具列表裁剪时写一条 `readonly_tools_disabled` 审计，并在文档写明两层语义）。
4. 真机冒烟（显式 `--model sonnet`，断言 init 帧 model）：readonly（auto_allow 开 / 关各一次）、plan、default、acceptEdits 五种情形的独立 bash turn `touch <mktemp>/x`，断言文件不落地且有审批或审计行；readonly 线程 Edit 的审计行可查到。证据（thread id、init 帧 model、pendingRequests、approvals 行）写进 out/result.md。
5. 文档同步 docs/agent-server 权限章节：开关语义、五种模式的独立 bash turn 行为表。

产物目录 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/`。提交到本分支。
