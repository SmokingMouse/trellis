# agent-server vendor 返工

- vendor 从 `12daba705eeb543b1c984c64d361efd7dedcc58d` 更新至执行时上游 HEAD `236650b90b923b7bfea398988031dc05a41c99f5`，包含分叉边界、播种守卫和 pending 过滤修复。
- 独立 git archive → install → tsc → 去 map/映射注释重建，78 文件逐字节相同；按相对路径排序的 SHA256 manifest 摘要为 `ce436ce8596234cf9d190ac8fc3a3afa81a2065edc1ab176189d15d107edf0f2`。
- `itemToolCall` 优先用协议状态，修复 inherited failed 工具无完成时间时一直显示 running。Mock 回归覆盖运行中 fork、播种中断后 resume、pending 能力/订阅过滤、分叉的分叉保留原生坐标；移动 mock 产出 checkpoint，核查引擎 options 确实走 native fork。
- `bunx tsc --noEmit` exit 0；`bun test` 130 pass / 0 fail / 458 assertions。移动验收与干净 clone 装建尚在执行。
- Next：完成剩余验收后通过契约 `fj-trellis-step2c-31e1` 信箱交付主控复核；不 push。
