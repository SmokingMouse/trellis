### agent-server 影子模式（契约 fj-as-migrate-1-84a5）

- 新增独立 `/console/threads`、`/api/as/threads` 与 SSE，复用 AgentClient 的 initialize/reconnect/sinceSeq；启动连接失败只 warn。未改 chat/run-bus/tasks/飞书链路。
- 本地绝对路径 file 依赖为临时接入；Trellis overrides 解决上游 workspace:*，postinstall 仅实体化 node_modules 内 package.json（Bun 文件软链使 Turbopack 报 redirect JSON 错误），上游分支未写入。
- 只读客户端不声明审批响应能力，以 2 秒 attach 快照观察待审批项，避免改变 daemon orphan policy。每个 SSE 独立客户端/游标，取消即关闭；正文按 item.id upsert。
- 验证：`bunx tsc --noEmit` 通过；`bun test` 91 pass / 0 fail；`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-as-shadow.sh </dev/null` 通过。公开 MockEngine/daemon/client 接口实跑，手机 5 条日志与 daemon 逐项相同，恢复 URL sinceSeq=7 → cursor=10，Last-Event-ID 覆盖初始 URL，审批只读、44px、横向与纵向滚动断言通过。3471–3482 无监听，互斥锁已清理。
- 证据：契约 out/report.md、mobile-as-shadow.log、as-browser-proof.json、as-http-proof.json 及四张截图；脚本默认产物路径见 `scripts/mobile-verify/mobile-as-shadow.sh`，可用 AS_SHADOW_OUT 覆盖。
- Next：主控独立复跑验收；正式发布/vendoring、租户到 daemon 的权限映射与 Herdr 外部会话去重待决定。可选真实 Codex TUI 验收未运行，未启动真实 Claude/Codex。
