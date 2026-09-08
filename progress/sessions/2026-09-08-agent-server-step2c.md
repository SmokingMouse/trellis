# agent-server vendor 返工

- vendor 从 `12daba705eeb543b1c984c64d361efd7dedcc58d` 更新至执行时上游 HEAD `236650b90b923b7bfea398988031dc05a41c99f5`，包含分叉边界、播种守卫和 pending 过滤修复。
- 独立 git archive → install → tsc → 去 map/映射注释重建，78 文件逐字节相同；按相对路径排序的 SHA256 manifest 摘要为 `ce436ce8596234cf9d190ac8fc3a3afa81a2065edc1ab176189d15d107edf0f2`。
- `itemToolCall` 优先用协议状态，修复 inherited failed 工具无完成时间时一直显示 running。Mock 回归覆盖运行中 fork、播种中断后 resume、pending 能力/订阅过滤、分叉的分叉保留原生坐标；移动 mock 产出 checkpoint，核查引擎 options 确实走 native fork。
- `bunx tsc --noEmit` exit 0；`bun test` 130 pass / 0 fail / 458 assertions。`env -i` 两套 mobile-as 脚本均 exit 0；实现提交 `ca0505f` 的干净 clone `bun install --frozen-lockfile`（744 packages）和 `bun --bun run build` 均 exit 0。
- D5 当前上游 HEAD 一致；D6 测试端口 3471–3482 无监听、测试锁不存在、3490 保持原 PID 13395 监听。原始日志与可复跑 vendor-check 在契约 `fj-trellis-step2c-31e1` 的 out/，全程 mock、未 push。
- Next：交主控独立复核。
- D4 返验：无锁/端口竞争的独占运行仍失败于 N9。修复 `ThreadLogView` 将内容收缩夹到底部误判成用户上滑；移动脚本增加确定性布局收缩断言，保留底部点击、4px 上滑和全部原用例，原 env-i D4 修后 exit 0。证据：契约 out/d4-exclusive-reverify.log、d4-layout-fix.log。
