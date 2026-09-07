# agent-server project 切流

- 契约 fj-trellis-step2-8442；独立 feat/agent-server-step2。
- vendor 升至 sm-toolkit 7913839；写客户端声明审批与 engineEvent 能力，提供短 lease 与 permission/set。
- 验证：vendor 脚本成功；协议新增 bash 输入已适配影子文本显示。
- Next：绑定解析、project 运行投影与分流、移动端验收。
- 已接入 project 双写投影、幂等 turn 重放/catchup、图片输入、审批/interrupt 分流、权限控件与系统日志。TS 检查通过。
- 阻塞已上报 fj：7913839 的 thread/fork 明确拒绝 fromItemId；等待主控提供上游修复或范围决策，其他验收继续。
- 绑定模型：sessions.binding_type 默认 legacy，pane 仅保留解析接口；as_threads 按 daemon/thread 记录会话，as_turns 保存节点与分叉坐标。boot reap 排除 daemon 驱动的节点。
