复核 codex-ingress slice 1（fj-tui-ingress-slice1-9065，产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-slice1-9065/out/`：result.md、d3-smoke.log、wire.ndjson、smoke.db；方案 `.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` 同前缀）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。分支 feat/codex-ingress（本 worktree）。所有真机实验用隔离 daemon（mktemp 下 HOME/socket/DB、随机端口），不碰生产 daemon 与 `~/.agent-server`。
必做：
1. 冒烟 `packages/agent-server/scripts/codex-remote-smoke.py` 连跑 3 次全过；读 wire.ndjson 核对五判据的证据链（thread/started、turn/completed、审批经 broker：approvals 表 decided_by.label 前缀 codex-tui:、resume 后真实再发一轮、interrupt 在活动 turn 上生效）。
2. 开关：`codex_ingress.enabled=false`（默认）时 daemon 行为与 feat/agent-server 逐字节等价——跑 packages/agent-server 全量测试 + 对同一段 as/1 交互录 wire 对比；`enabled=true` 但无 TUI 连接时对现有 as/1 客户端零影响。
3. 路由与 ID 规则反例：同一连接开两个线程交替发 turn（事件不串线）；用 native UUID resume 一个由 as/1 客户端创建的 Codex 线程；未知 UUID / 非 UUID / 他人线程 resume 的错误码；断开连接后线程与进程不被杀（detach ≠ close）。
4. 传输与认证：错误 token、无 token、非 loopback 绑定的拒绝路径；20 MiB 单帧（图片/长历史）是否通过 128 MiB 上限而不被 16 MiB 旧限截断。
5. 语义核对：turn/interrupt 无活动 turn 时与上游 0.153.4 一致（坐席自述：空 ID 成功、具名无活动返回 -32600 原文）；thread/name/set 持久化并在 thread/list 回读；方案风险表 #7——TUI 自己的 `codex_tui` 动态工具与非四类 native server request 在 passthrough 下是否仍被 codex.ts:217 拒掉，实测一次。
6. 治理：readonly 线程经 TUI 发写命令走审批而非直执行；serviceTier 非 default 被拒；model guard 生效。
评级 P0（无审批写 / 事件串线 / 开关关不掉）/ P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp。
