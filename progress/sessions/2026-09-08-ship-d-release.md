# ship-d 上线复验 · fj-trellis-ship-d-6529

- 从 sm-toolkit main 已提交快照 `40ddc5bea77faa62f8ffba5862b5c0ded272b6fb` 重新 vendor，未读取源工作区未提交改动；VENDORED_FROM 更新，file 依赖重新安装。
- 新协议要求显式模型：首次 bun test 257 pass / 15 fail，同源 model_required。Mock daemon fixtures 显式 defaultModel=sonnet，影子测试显式模型；生产模型守卫不变。修后 273 pass / 0 fail / 1079 assertions，tsc exit 0。
- 为单项目切流补 TRELLIS_AS_PROJECT_ID 精确筛选：在 canonical workspace 归组后判 projects.id，未知归属保持 legacy，不改存量绑定。子进程回归验证匹配、不匹配、未知归属和未配置兼容语义。
- 七条基础手机脚本（含集成 CSS 修复后的 safe-area）全绿；AS 影子与第二步使用生产 SQLite backup、隔离 HOME/DB/socket、Mock daemon、禁用调度器/飞书/钩子，E2E 均 exit 0。
- 初次单项目回归断言已通过但落入 unknown regression case 尾部；修正测试分派后整套通过。原始失败与修后日志均保存在契约 out，不删除失败证据。
- 上线目标：PR 合入 main 后 make deploy，生产首页/已有会话/Herdr 嵌套与手机截图验活，再对暂存区项目显式 sonnet 验证 AS 事件及审批。回退：shared/.env.local 中 TRELLIS_AS=off 后重启；只停止新绑定可移除 TRELLIS_AS_PROJECT 后重启。
- Next：生产部署和切流结果以主仓 `.fenjue/tasks/fj-trellis-ship-d-6529/out/result.md` 为准。分支仅本地提交，禁止 push；远端分支发布已通过 fj blocker 请主控执行。
