### agent-server 影子模式返工（契约 fj-as-migrate-1-fix-31ae）

- P0-1/P2-4：从 sm-toolkit `94b02551fe4b3b5013a1ef5a5d199f2e217fa2ea` 的临时归档副本构建，提交 vendor/agent-server/dist + 最小 manifest + VENDORED_FROM；相对 file 依赖，根 overrides 删除，agent 固定既有已发布 0.8.0。同步命令见 scripts/vendor-agent-server.sh。原源工作树未写入。
- P1-1/P2-5：干净 clone 经 ignore-scripts 安装后 manifest 实测是普通文件，因此删除 prepare 脚本与 postinstall；build 明确使用 Bun，Turbopack root 支持 /tmp clone。
- P1-2/P2-1：默认关（TRELLIS_AS=on 或配置 TRELLIS_AS_SOCKET 才启用）。只由 Trellis 管理 1 秒到 5 分钟指数退避，连续故障只警告一次、恢复记录一次；closed 后重新读取 token、重建客户端、重新 attach/轮询。
- P1-3：仅 running 轮询，idle 清除 timer；快照按 pending id 与 inProgress payload 长度抑制重复；投影无变化保留原对象。200KB 静态输出 10 秒复现已转单测，冗余快照字节为 0。
- P2-2/P2-3/P2-6：错误与轮次状态可见；贴底跟随、上滑停止与回底按钮（控件交互不抢滚）；首个完整快照不计入实时背压，后续慢消费者限额保留。
- 验证：tsc、完整 bun test、mobile-as-shadow、mobile-slim-shell 已通过。新增真实 Mock daemon SIGKILL/同 socket 重启、token 失效恢复、2MB 首帧等测试；手机增加错误/轮次与自动跟随断言。证据在新契约 out/result.md 及日志。
- Next：按主控最新指令交付 result 待独立验收。D4 原带固定目录删除的命令被工具自动审批拒绝；fallback scripts/verify-as-clean.ts 已完成，仅清理自己 mkdtemp 创建的 clone，install --ignore-scripts 与 build 均 exit 0。交付明确保留原命令未执行的限制，不将等价验证冒充原命令通过。
