# ship-d D5 返工

- 原因：`app/page.tsx` 先 hydrate 最新会话，再 preview URL 目标；Composer 已挂载时目标节点可能尚未载入，Header 的上下文按钮依赖 activeNodeId 及 lineage。切流后最新 AS 会话让这段六按钮中间态更易命中，不是 AS 在 Header 多塞控件。
- 当前生产库快照首次完整复跑通过。定向延迟目标会话 HTTP 2 秒后稳定重现：输入框就绪时六按钮，目标节点就绪时七按钮，唯一差集为“上下文占用，点击查看详情”。证据：契约 out/d5-delay-probe.log。
- 修复仅限 mobile-safe-area.sh：真正使用 TRELLIS_VERIFY_SOURCE_DB 并记录快照 AS 绑定数量；桌面对照等待指定节点和上下文按钮；按精确按钮集合匹配再逐项验尺寸，额外/缺失按钮仍失败，不放宽几何基线。
- 当前生产库含 1 个 AS 会话；同一 env -i 隔离前缀完整运行两次 exit 0，见 d5-fixed-{1,2}.log、d5-fixed-status.log。bash -n 与 git diff --check 均通过。
- Next：小 PR 合入并部署，后续发布/验活证据追加主仓 `.fenjue/tasks/fj-trellis-ship-d-6529/out/result.md`；不修改 UI 或生产 AS 切流配置。
