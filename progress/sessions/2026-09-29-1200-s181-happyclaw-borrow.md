# S181 · 2026-09-29 · 对照 happyclaw 上游补输入框 / 删除细节

## 做了什么
- 对照 happyclaw 上游 cef72b28（本地 fork 落后 400 提交），出可抄清单。
- 分支 composer-polish 落 6 条：混合粘贴不丢文字、上传瞬时失败重试、草稿按会话存 + 发送失败回填、对话输入框拖拽、删除 6s 撤销、后台系统通知；隔离实例 agent-browser 逐条实测通过。

## 决定
- [decision] 删除撤销用延迟提交 + pagehide flush（拒绝服务端软删 / 回收站：要改 schema）；会话撤销期先归档（拒绝前端本地隐藏：刷新就复现）。
- [decision] 会话撤销会丢任务 home_session 绑定，接受。

## Next
已上线 prod e7a18374e；再议排队 / steer（S180 因后端不支持没做）。
