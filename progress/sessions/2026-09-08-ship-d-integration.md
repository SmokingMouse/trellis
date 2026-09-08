# feat/ship-d 集成验收（fj-trellis-integrate-d-2925）

从 `21de979` 按序合入 Herdr `19d0438` → AS 影子 `b691c8e` → AS 第二步 `22cc2f0` → 手机 Wave 3 `f7dba61` → Wave 1 `6a77648`。五步类型检查均 exit 0；全量测试依次 218、241、261、272、272 pass，无失败。

- 第二步冲突：保留 Herdr Composer 分流，同时向普通 Composer 传入 fork；SessionRow/查询保留 herdr_alive 和 binding_type；SQLite 保留两套迁移；失败档案取并集。
- Wave 3 冲突：safe-area 验收在取消新树后重新打开树面板，再等待过滤按钮。
- AS 两套手机脚本支持 `TRELLIS_VERIFY_SOURCE_DB`，通过 SQLite `.backup` 创建临时数据库；本轮使用生产库副本、临时 HOME、隔离 MockEngine daemon、`next build`/`next start`，关闭 Lark、调度器与 hooks。
- 六条核心手机脚本全部 exit 0；AS shadow/project 与额外 Herdr 手机验收 exit 0。影子覆盖实时、断线补齐、日志一致和跟随；第二步覆盖跨端审批、原生分叉、重试保留与降级。
- safe-area 唯一一次执行 exit 1：AS threads.css 直接定义 env，违反仅 globals.css 定义安全区的静态守闸。假设由 `rg -l -F 'env(safe-area-inset-' app components` 证实；改为消费既有 `--safe-*` 后该命令仅输出 globals.css，字号扫描通过。修后 AS shadow 全套 exit 0。遵照契约不重试 safe-area，未声称其余几何断言已通过；已通过 blocker 信箱报告。
- 最终 `bunx tsc --noEmit` exit 0；`bun test` 272 pass / 0 fail / 1058 assertions；五分支祖先检查、3471–3478 端口及锁清理检查、`git diff --check` 均 exit 0。
- vendor 与第二步分支逐字一致，未重新 vendor、部署或 push。

完整命令、首轮失败与复验日志：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-trellis-integrate-d-2925/out/result.md`。

Next：主控验收本分支；safe-area 后续整条复跑仍需主控解除本契约的不重试限制。
