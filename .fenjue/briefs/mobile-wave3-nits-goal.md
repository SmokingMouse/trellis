目标：修三波 review-c2 遗留的 4 条（阶段 2 试点第 7 单，你是 Claude sonnet 坐席，走 agent-tui runner）。分支 feat/mobile-nits-wave3，基于 main 92c6539。worktree 没有 node_modules，先 `bun install --cwd .`。

原文与复现步骤在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-review-c2-5e39/out/review.md`，每条先按原文复现、再修、再用断言证明：
- C2-1 收藏超过 50 条时第 51 条起没有任何入口：「还有 N 条」改成可点的加载更多（API 加 cursor 或 offset 分页；只提 limit 不算修好，必须能翻到全部）。
- C2-2 R-2 修法的反向缺口：别处（另一标签页 / 设备）取消的收藏本地不会被清——toggle 回包广播，或打开列表时定向核对后清理。
- C2-3 恢复 chrome 时若已滚到底，scrollTop 补偿被 clamp，残留一次位移。
- H-3 useScrollHide 模块级单例改成实例级，多处挂载互不干扰。
每条加回归断言：C2-1/C2-2 进 `scripts/mobile-verify/mobile-read-later.sh`，C2-3/H-3 进对应脚本（header-hide 相关脚本或 mobile-slim-shell.sh）。

约束：桌面零回归；手机热区 ≥44px 不退；不改 DB schema，除非迁移幂等且有测试。交付前七条手机脚本 `scripts/mobile-verify/*.sh` 整套独占重跑全绿；跑完确认 3471–3478 端口与 `/tmp/trellis-mobile-verify.lock` 已释放，交付后不要再跑这些脚本（验收会在你 idle 后复跑，脚本抢端口会互相打架）。提交到本分支。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`：每条修法、断言位置、脚本输出摘要。
