# 侧栏排布波 2（fj-sidebar-wave2-c6c6）

- 新增按项目 / 按时间、四来源筛选和含已归档；同一会话集合只渲染一种排布。归档行可阅读 / 恢复，灰显并标注归档；时间行保留项目 / 工作区和来源。
- 退役新侧栏的 Herdr / 最近组，Herdr 仅向会话行提供状态 map；降级说明仅在 Herdr 来源筛选显示。多话题数量来自可见根计数，来源 / 话题 / 状态不再随 hover 消失。
- 速记、暂存区、主目录显式命名；空工作区按项目折叠。工具条、原折叠集合、旧归档和 TreePanel 更早状态共用 localStorage hook；波 1 已删除的隐藏组不再引入。
- 回退 flag：构建时 `NEXT_PUBLIC_TRELLIS_SIDEBAR_V2=off`（或 `0`）恢复波 1 旧组；默认启用、排布默认按项目。旧组代码保留一个版本；切 flag 后需重新 build。
- 验证：286 个单测 / tsc 通过；本基线 10 条手机 shell 回归及字体扫描通过。真实隔离快照 3497（`.backup` + `next start`）桌面四态、手机两态通过；同一快照 DOM 导航行 139 → 115（94 个唯一会话）。flag off 已实测。未访问 3088。
- 待主控裁决：沿用波 1 的 `listProjectTree` user-only 计数会把部分 Herdr / 仅归档工作区会话归入暂存区；是否在本波纳入骨架修复。主仓随后合入 #48，本基线缺 `mobile-as-adopt.sh`，第 11 条 shell 验收是否要求同步新 main。已通过契约 blocker 上报，尚未改该谓词或同步基线。

证据目录：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave2-c6c6/out/`。

Next：主控明确骨架与验收基线后补齐收尾；不 push、不 PR、不部署。
