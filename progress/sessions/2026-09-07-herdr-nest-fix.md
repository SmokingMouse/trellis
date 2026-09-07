# Herdr 嵌套返工（fj-hb-nest-fix-115b）

- P1-1：仓库按名称/路径、worktree 主 checkout 置顶后按名称/路径、合并会话按名称/路径/ID 排序，状态不再参与排序。
- 验证：`bun test lib/herdr-ui.test.ts`。
- P1-2：workspace 事件对比元数据后立刻重建；worktree 通知按需快照，覆盖新建/切换/移除。
- P2-1：缺失/失败/detached 分支统一显示「未知分支」，单测覆盖主 checkout 和 linked checkout。
- P2-2：两层角标只在折叠时渲染；mobile-herdr 展开态断言同步，浏览器会话按进程隔离。E2E 待统一运行。
- P2-3：前后端统一移除尾斜杠（保留根路径），不存在的 checkout 同样归一；测试覆盖同路径合并和非空标签。
- P2-4：异步 git，成功缓存 60 秒、失败 10 秒，合并在途请求；结构立即发布，分支解析完成再更新 ETag/SSE，过时结果不会复活已关闭工作区。
- fake-herdr 增加倒序 checkout、状态对调、新建/关闭 workspace；mobile-herdr 断言不重排、10 秒内嵌套、未知分支/尾斜杠、手机两层折叠角标。
- Next：运行契约四项验证并检查端口/锁与 3490 存活。
