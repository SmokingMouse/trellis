目标：Trellis 上线（用户已授权，不再问）。你是 gpt-6-astra 实现坐席（显示端是官方 Codex TUI），分支 feat/ship-d（本 worktree，四波已集成，HEAD 见 git log；node_modules 已装）。
步骤：
1) 重新 vendor agent-server：从 `~/sm-toolkit`（main，已含 codex-ingress）按仓内既有同步脚本（见 `vendor/agent-server/VENDORED_FROM` 与 prepare/sync 脚本）更新 `vendor/agent-server`，VENDORED_FROM 记新提交；`bunx tsc --noEmit`、`bun test` 绿。
2) 验收：七条手机脚本整套（含 `mobile-safe-area.sh`，集成单已修 CSS 冲突 3b3449f，本次必须跑绿；仍失败则修到绿，记录）；AS 影子/第二步 E2E 与手机验收在生产库副本 + 隔离实例上（起法见集成单 result：`.fenjue/archive/fj-trellis-integrate-d-2925/out/result.md`，前缀 /Users/smokingmouse/python/learning/trellis）。
3) 上线：`gh pr create --base main --head feat/ship-d`（标题「ship-d: Herdr 桥 + AS 影子/第二步 + mobile nits + vendor bump」，正文列各分支、复核 cid、回退方式；末尾「🤖 Generated with [Claude Code](https://claude.com/claude-code)」）→ `gh pr merge --merge --delete-branch=false` → 主仓 `/Users/smokingmouse/python/learning/trellis` `git pull --ff-only`（主仓 main 有本地 docs 提交 21de979 已包含在本分支内，pull 应可 ff；若不能 ff，用 `git pull --rebase` 并报告）→ `make deploy`（部署流程与验活见 `.fenjue/archive/fj-ship-c-6211/out/`）→ 验活：生产端口首页 200、一个已有会话页 200、Herdr 侧栏嵌套渲染、手机视口截图。
4) 切流：给一个项目开 TRELLIS_AS（读 `docs/agent-server/trellis-migration.md` 与生产 env 文件确定变量名与项目标识；选最近活跃但非最重要的项目），写清回退：TRELLIS_AS=off 或去掉 TRELLIS_AS_PROJECT 后重启；切流后用该项目真实起一个会话走 AS（显式 sonnet），验证事件流与审批卡；失败立即回退并报告。
5) 产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`（PR、合并提交、部署输出、验活证据、切流项目与回退命令）。
