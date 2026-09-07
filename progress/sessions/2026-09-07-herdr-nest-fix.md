# Herdr 嵌套返工（fj-hb-nest-fix-115b）

- P1-1：仓库按名称/路径、worktree 主 checkout 置顶后按名称/路径、合并会话按名称/路径/ID 排序，状态不再参与排序。
- 验证：`bun test lib/herdr-ui.test.ts`。
- Next：完成元数据刷新和 P2 项，运行契约四项验证。
