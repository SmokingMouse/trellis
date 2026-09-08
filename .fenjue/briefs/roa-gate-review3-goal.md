复核只读门三次返工 fj-as-readonly-gate-fix3-5a3a（产物 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-fix3-5a3a/out/result.md`，先读；五审报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-readonly-gate-review2-ea71/out/review.md`）。你是 Opus 复核坐席，只读，产物 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/review.md`。

必做：
1. P1-1 真机（显式 `--model sonnet`，断言 init 帧 model）：起 readonly 线程 → 用另一个客户端在 spawn 之后 attach → 能查到 `readonly_tools_disabled` 审计行（approvals 表，含 threadId 与禁用工具列表）；bypassPermissions / dontAsk 线程跑一条 `ls` → 查到 `permission_auto_response` 行。P2-2 文档句已修正。
2. **迁移安全**（本轮新增风险）：fix3 把 approvals 表 turn_id 改为可空并用 12 步重建迁移。用真实 daemon 库的副本验证：`sqlite3 ~/.agent-server/agent-server.db ".backup <mktemp>/copy.db"` 后，以该副本为 TRELLIS/AS 数据路径起一个隔离 daemon（不同 socket，不碰生产 daemon 与 `~/.agent-server`），确认迁移成功、既有 approvals 行数与内容不丢、幂等（再启一次不重复迁移）、失败时不留半迁移状态；核对 item-log / thread-manager 对 turn_id 为空行的读取路径。
3. 门与解耦回归（五审 T1–T3 与五模式矩阵）抽核 3 条真机，确认本轮没有把上一轮修好的门改坏；packages/agent-server 全量测试绿。

评级 P0 / P1 / P2；结论只能是「通过」或「需返工（列 P0/P1）」。不改源码；临时文件只放 mktemp；绝不对生产库做写操作。
