# 独立观察页退役

- 删除独立观察页、线程列表接口、专属 fixture 与移动脚本；外部会话入口统一到主页（`TRELLIS_AS_ADOPT`）。
- 依赖核对：主页 AsProjectControls 共用 SSE，迁到节点 as/stream；共用事件类型、日志 reducer、连接恢复及 SSE 缓冲保留为 thread 命名，删除列表刷新与单例。
- AS 总开关仅更名 isAgentServerEnabled，语义不变；createProjectClient、审批与租约继续保留。
- 验证：`bunx tsc --noEmit` exit 0；`bun test` 276 pass / 0 fail；旧入口与专属文件引用扫描零命中。
- 统一 env-i 前缀独占运行 `mobile-as-adopt.sh`、`mobile-as-project.sh`、`mobile-new-session.sh`，均 exit 0；主页权限、日志、跨端审批与收编流程通过。证据在契约 `fj-as-observe-retire-6552/out/`。
- 主控裁定：允许普通 push 本分支；D4 使用认证请求验 404；主仓进度已由主控提交。PR #51 保留主控更新的进度首页，本单变更记录在此。
- Next：合并 PR、主仓 ff-only 更新并部署；仅当运行中的节点全为 external 时可按授权 FORCE 部署，最后保存生产验活证据。
