# Herdr 嵌套返工（fj-hb-nest-fix-115b）

- P1-1：仓库按名称/路径、worktree 主 checkout 置顶后按名称/路径、合并会话按名称/路径/ID 排序，状态不再参与排序。
- 验证：`bun test lib/herdr-ui.test.ts`。
- P1-2：workspace 事件对比元数据后立刻重建；worktree 通知按需快照，覆盖新建/切换/移除。
- P2-1：缺失/失败/detached 分支统一显示「未知分支」，单测覆盖主 checkout 和 linked checkout。
- Next：完成元数据刷新和 P2 项，运行契约四项验证。
