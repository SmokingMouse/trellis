# 侧栏排布波 2（fj-sidebar-wave2-c6c6）

- 新增按项目 / 按时间、四来源筛选和含已归档；同一会话集合只渲染一种排布。归档行可阅读 / 恢复，灰显并标注归档；时间行保留项目 / 工作区和来源。
- 退役新侧栏的 Herdr / 最近组，Herdr 仅向会话行提供状态 map；降级说明仅在 Herdr 来源筛选显示。多话题数量来自可见根计数，来源 / 话题 / 状态不再随 hover 消失。
- 速记、暂存区、主目录显式命名；空工作区按项目折叠。工具条、原折叠集合、旧归档和 TreePanel 更早状态共用 localStorage hook；波 1 已删除的隐藏组不再引入。
- 回退 flag：构建时 `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off`（或 `0`）恢复波 1 旧组；默认启用、排布默认按项目。旧组代码保留一个版本；切 flag 后需重新 build。
- 验证：287 个单测 / 1153 断言及 tsc 通过；本基线 10 条手机 shell 回归及字体扫描通过。真实隔离快照 3497（`.backup` + `next start`）桌面四态、手机两态通过；flag off 重新构建实测恢复旧组。3471–3480 / 3497 无监听、验证锁已清；未访问 3088。
- 同一快照、统一来源修复后 DOM 导航行：旧布局 163 → 新布局 141（分组 56 → 48、会话行 98 → 93、链行 7 → 0、Herdr 组 / 归档尾行各 1 → 0）。原 user-only 骨架为 139 行，修复带回此前被遗漏的工作区层，单独保留原始证据。快照含 95 个活跃会话，按时间全部展示；按项目默认另有 2 个会话位于既有已合并折叠组。实际行数未达到方案约 60 行的估计，没有为凑数截断会话。
- 稍后再读脚本补真实滚动：快照长问题使回答位于视口下方 5121px，懒挂载前没有操作按钮；滚到回答后原有全部断言通过。首次失败和修后日志保留，未改产品行为。
- 主控裁决已落实：波 1 遗漏的项目树来源过滤纳入本波。`lib/session-source.ts` 的唯一来源谓词供 `listSessions`、`listRecentChains`、`listProjectTree` 及归档计数共用，Herdr / task 不再因 user-only 计数落入暂存区。
- 验收基线按最新补充裁决：现有 10 条手机 shell 脚本，字体扫描单列、不计入 10 条。main 已有 `mobile-as-adopt.sh`，但本分支不含其依赖的 PR #48；本波未合并该 PR 或选跑此非强制脚本。
- 上次提到的第二个过滤条件是 `listProjectTree` 的 `(sessionCount > 0 || createdBy !== "discovered") && pathExists(path)`：默认隐藏无活跃会话的 discovered 工作区（包括仅归档目录）及不存在的目录，保留主动新建 / 扫描登记的空工作区。它不区分来源或 `dir:` / 伪项目；flag off / 旧调用方保留该过滤。按补充裁决，V2 显式请求 `/api/sessions?includeEmptyWorkspaces=1`，保留所有现存空工作区，让仅归档会话在含归档时仍归原工作区；失效路径始终隐藏。单测对比四来源计数、V2 与旧骨架语义，截图脚本检查归档会话工作区位置。

证据目录：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave2-c6c6/out/`。

整合契约 `fj-sidebar-wave2-integrate-b80f`：先原样提交启动时已有的归档骨架修复为 `ad8d954`，再以 `acc5d72` 合并 `origin/main`（`0f126ab`，PR #48 / #49）。`repo.ts` / `types.ts` 的话题计数与收编字段取并集，`failures.md` 保留双方记录；外部来源接入既有 chip 与来源筛选，收编项目映射、共享 SQL 谓词及 V2 flag 语义保留。`bunx tsc --noEmit` exit 0、`bun test` 290 pass；11 条隔离手机回归及 main 额外的 `mobile-as-adopt-live.sh` 全部首次 exit 0。3497 生产快照两图核实系统项目下收编会话、8 条外部会话时间排序与 backend chip。截图首次碰到其他 worktree 的锁，等待正常释放后完成；最终 3471–3480 / 3497 无监听且锁不存在。证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave2-integrate-b80f/out/result.md`。

Next：交付主控独立验收 PR #50；本分支仅本地提交，不 push、不合 PR、不部署。
