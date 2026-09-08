# 侧栏信息架构波 1（fj-sidebar-wave1-cc46）

- 统一 user/lark/herdr/task 会话及最近链列表，来源 chip 为 ⚓ / ⏱ / 💬；归档计数与列表同口径。删除稍后再读、定时任务、未归组三个区域，未归组会话并入暂存区。
- 删除 Outline 手机 drawer、Header 不可达按钮及两处已隐藏树组；Herdr 降级说明保持 PR #46 实现。
- 验证发现最新 Herdr 会话初始化会覆盖入站普通会话深链；`app/page.tsx` 自举时直接传入目标 session，安全区脚本修前两次等待失败、修后通过，手机首屏结构未改。
- 修正验证夹具：AS thread 复用只统计本次会话；followup 的手机/桌面段等待目标回答加载；Herdr 仅在专用 HOME/fake socket 子进程启用被测服务；收藏后断言侧栏组数不变。
- 固定生产快照 API：42 → 87 个活跃会话，原会话零丢失；Herdr 排除数 43 → 0，其中已关闭 pane 的 26 个全部可达；归档 11 → 11。区域类型 8 → 5，实际标题行 12 → 10（含 6 个项目）。
- `bun test`：278 pass / 0 fail；`bunx tsc --noEmit` 通过。10 条手机脚本最终全绿（main 无 mobile-as-adopt）；3471–3480/3494 无监听、锁已清，D1–D6 全过。截图、SQL、初次失败及命令 exit 见下方 result。
- 待主控裁决：`lib/server/workspaces.ts:361` 的 user-only 工作区计数仍隐藏 24 个实际存在的 discovered 工作区；本契约未列此第三处谓词，未擅改，其会话经暂存区保留可达。已通过 blocker 信箱报告。

证据：`/Users/smokingmouse/python/learning/trellis/.fenjue/tasks/fj-sidebar-wave1-cc46/out/result.md`。

Next：主控验收本分支并裁决第三处谓词；本坐席不 push、不 PR、不部署。
