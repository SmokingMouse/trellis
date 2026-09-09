# 待办层实现与回归

fj-pending-bar-5cfe 实现跨会话待办聚合、既有 SSE 更新、桌面条、手机 sheet 和审批层级。HTTP 仅读内存快照，AS 订阅维护本地投影；去处理复用 openNodeInSession。

单测曾通过 304 项，新增 store 测试 2 项通过。手机回归两批在 sheet 第二项跨会话跳转超时；按契约停机。progress/README.md 未改。

证据：主仓 `.fenjue/tasks/fj-pending-bar-5cfe/out/blocker.md` 与两份 mobile-followup-approval 日志。

Next：主控按契约独立复跑验收；最终命令、截图和提交见主仓 `.fenjue/tasks/fj-pending-bar-5cfe/out/result.md`。

续轮：按主控裁决改为先 dialog.close、await openNodeInSession、再滚动高亮；导航顺序/错误传播 2 单测与 tsc 通过，手机第二项跨会话断言通过。后续桌面重开阅读会话出现两次约 5 秒 hydrate 超时，页面退回空会话，桌面跳转断言失败；按「再跑不过就发 blocker」再次停止。详细证据见同 out 的 resume-blocker.md。

再次续轮定位：服务端同请求约 0.2ms，浏览器失败请求 requestStart=0，原因是旧文档保留 SSE 占满 HTTP/1 连接。两个全局流增加 pagehide 释放和 BFCache pageshow 恢复；导航 ticket 保证仅最新载入生效，真正超时重试一次。修后浏览器会话请求约 2–3ms，跨会话跳转及就地审批通过。精简壳正文为全局横幅留出 44px，并保留 Header 隐藏时横幅贴安全区的行为。
