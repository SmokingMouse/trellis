# Herdr 嵌套返工（fj-hb-nest-fix-115b）

- P1-1：仓库按名称/路径、worktree 主 checkout 置顶后按名称/路径、合并会话按名称/路径/ID 排序，状态不再参与排序。
- 验证：`bun test lib/herdr-ui.test.ts`。
- P1-2：workspace 事件对比元数据后立刻重建；worktree 通知按需快照，覆盖新建/切换/移除。
- P2-1：缺失/失败/detached 分支统一显示「未知分支」，单测覆盖主 checkout 和 linked checkout。
- P2-2：两层角标只在折叠时渲染；mobile-herdr 展开态断言同步，浏览器会话按进程隔离。E2E 待统一运行。
- P2-3：前后端统一移除尾斜杠（保留根路径），不存在的 checkout 同样归一；测试覆盖同路径合并和非空标签。
- P2-4：异步 git，成功缓存 60 秒、失败 10 秒，合并在途请求；结构立即发布，分支解析完成再更新 ETag/SSE，过时结果不会复活已关闭工作区。
- fake-herdr 增加倒序 checkout、状态对调、新建/关闭 workspace；mobile-herdr 断言不重排、10 秒内嵌套、未知分支/尾斜杠、手机两层折叠角标。
- 最终验证：`bunx tsc --noEmit` exit 0；`bun test` 216 pass / 0 fail / 703 expect；`env -i HOME=$HOME PATH=$PATH sh scripts/mobile-verify/mobile-herdr.sh </dev/null` exit 0；同环境 `mobile-slim-shell.sh` exit 0。D5 exit 0：3471–3482 全空闲、验证锁释放、3490 原 PID 59510/监听子进程 59512 存活。
- 证据：契约 `fj-hb-nest-fix-115b/out/` 的 tsc.log、bun-test.log、mobile-herdr.log、mobile-slim-shell.log、d5.log；首轮 E2E 主动终止（143），测试卡片结束事件修正后复跑通过。
- Next：交主控独立验收；未 push，未操作 .next-user-verify 与 3490 进程。

## N1 续修（fj-hb-nest-fix2-238c）

- workspace 事件在写入本地 Map 前判断：未知 ID 或显式 worktree 值变化才按需快照；已知非 git 工作区省略该 key 不再触发快照。worktree_* 事件保持原逻辑。
- 两条 N1 回归先在旧实现上失败；覆盖三类 workspace 事件各十次不重拉、未知 workspace、元数据添加/切换/清空及相同元数据不重拉。
- Next：定向测试与契约 D1–D5 全量验证。
