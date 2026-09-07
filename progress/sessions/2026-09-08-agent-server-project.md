# agent-server project 切流

- 契约 fj-trellis-step2-8442；独立 feat/agent-server-step2。
- vendor 升至 sm-toolkit 7913839；写客户端声明审批与 engineEvent 能力，提供短 lease 与 permission/set。
- 验证：vendor 脚本成功；协议新增 bash 输入已适配影子文本显示。
- Next：提交验收；任意 fromItemId 分叉留上游 backlog，不阻塞本单。
- 已接入 project 双写投影、幂等 turn 重放/catchup、图片输入、审批/interrupt 分流、权限控件与系统日志。TS 检查通过。
- 阻塞已上报 fj：7913839 的 thread/fork 明确拒绝 fromItemId；等待主控提供上游修复或范围决策，其他验收继续。
- 验证：bun test 117 pass；mobile-as-shadow exit 0；mobile-as-project 三轮单引擎、网页刷新、第二端审批、权限/系统日志、DB 对比、中断与降级均通过，最终 fromItemId 分叉 HTTP 503 导致 exit 1。
- 最终独立验证：tsc exit 0；bun test 118 pass/0 fail；slim-shell/new-session/branch-chain 全 exit 0；project 最新补验双向审批、图片路径、精确 catchup、创建参数与热 bypass 拒绝全部通过，唯 fromItemId 503；D5 清理 exit 0，3490 未触碰。报告与日志在契约 out/report.md，阻塞期间不发 result。
- 绑定模型：sessions.binding_type 默认 legacy，pane 仅保留解析接口；as_threads 按 daemon/thread 记录会话，as_turns 保存节点与分叉坐标。boot reap 排除 daemon 驱动的节点。
- 主控裁决收窄分叉：显式 fork 从最新节点调用无 fromItemId 的 thread/fork；早期节点明确拒绝，保留旧节点数据与绑定。普通续聊继续复用 thread。
- 同 thread 的节点控件共享 EventSource，避免长链重复订阅耗尽浏览器连接。复跑 D3 exit 0，包含 tip 新绑定、早期节点失败网页截图、旧数据比较与降级；D1/D2/D5 exit 0。最终报告和 proof.json 位于契约 out。
