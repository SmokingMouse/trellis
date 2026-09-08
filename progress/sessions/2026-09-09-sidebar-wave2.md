# 侧栏排布波 2（fj-sidebar-wave2-c6c6）

- 新增按项目 / 按时间、四来源筛选和含已归档；同一会话集合只渲染一种排布。归档行可阅读 / 恢复，灰显并标注归档；时间行保留项目 / 工作区和来源。
- 退役新侧栏的 Herdr / 最近组，Herdr 仅向会话行提供状态 map；降级说明仅在 Herdr 来源筛选显示。多话题数量来自可见根计数，来源 / 话题 / 状态不再随 hover 消失。
- 速记、暂存区、主目录显式命名；空工作区按项目折叠。工具条、原折叠集合、旧归档和 TreePanel 更早状态共用 localStorage hook；波 1 已删除的隐藏组不再引入。
- 回退 flag：构建时 `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off`（或 `0`）恢复波 1 旧组；默认启用、排布默认按项目。旧组代码保留一个版本；切 flag 后需重新 build。
- 验证：287 个单测 / 1153 断言及 tsc 通过；本基线 10 条手机 shell 回归及字体扫描通过。真实隔离快照 3497（`.backup` + `next start`）桌面四态、手机两态通过；flag off 重新构建实测恢复旧组。3471–3480 / 3497 无监听、验证锁已清；未访问 3088。
- 同一快照、统一来源修复后 DOM 导航行：旧布局 163 → 新布局 141（分组 56 → 48、会话行 98 → 93、链行 7 → 0、Herdr 组 / 归档尾行各 1 → 0）。原 user-only 骨架为 139 行，修复带回此前被遗漏的工作区层，单独保留原始证据。快照含 95 个活跃会话，按时间全部展示；按项目默认另有 2 个会话位于既有已合并折叠组。实际行数未达到方案约 60 行的估计，没有为凑数截断会话。
- 稍后再读脚本补真实滚动：快照长问题使回答位于视口下方 5121px，懒挂载前没有操作按钮；滚到回答后原有全部断言通过。首次失败和修后日志保留，未改产品行为。
- 主控裁决已落实：波 1 遗漏的项目树来源过滤纳入本波。`lib/session-source.ts` 的唯一来源谓词供 `listSessions`、`listRecentChains`、`listProjectTree` 及归档计数共用，Herdr / task 不再因 user-only 计数落入暂存区。
- 验收基线按契约 out/decision.md 第 2 条：现有 10 条手机 shell 脚本 + 字体扫描；随后续 PR #48 加入 main 的 `mobile-as-adopt.sh` 不强制，本分支不引入该 PR。
- 上次提到的第二个过滤条件是 `listProjectTree` 的 `(sessionCount > 0 || createdBy !== "discovered") && pathExists(path)`：隐藏无活跃会话的 discovered 工作区（包括仅归档目录）及不存在的目录，保留主动新建 / 扫描登记的空工作区。它不区分来源或 `dir:` / 伪项目，按裁决保留并在代码加注释；无可见工作区的项目仍隐藏。新增单测对比所有来源的项目树计数与统一列表，覆盖 Herdr / task、归档和空 / 失效目录。

证据目录：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave2-c6c6/out/`。

Next：交付主控独立验收；不 push、不 PR、不部署。
