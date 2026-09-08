目标：codex-ingress slice 4「治理硬化与升级回归」（也是 codex-tui runner 试点第 3 单：你的显示端就是官方 Codex TUI）。你是 gpt-6-astra 实现坐席，分支 feat/codex-ingress-s4（基于 feat/codex-ingress，含租约修复；slice 3 的多线程/分页/断线在 feat/codex-ingress-s3 上另有返工在跑，你交付前 `git merge feat/codex-ingress-s3` 一次，解冲突后全量回归）。worktree 无 node_modules 先 `bun install`。
方案：`/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-design-cd8e/out/tui-ingress-design.md` §1.2 两种传输、§4.3 副作用入口白名单 fail-closed + readonly deny 表、§5「slice 4」小节、§7 风险表。前三片与复核在 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-tui-ingress-*/out/`。
交付：
1. `unix://` 端点：WebSocket over Unix socket（不是现有 NDJSON unix 端口），默认路径跟随 CODEX_HOME 规则，官方 TUI `codex --remote unix://…` 真机连通；endpoint.json 暴露。
2. 副作用方法白名单 fail-closed 全覆盖：逐条列出官方 0.153.4 客户端方法表（config write、fs/write/remove、command/exec、thread/shellCommand、plugin/marketplace、workspace 等）→ 放行 / 按策略拒绝 / readonly 线程显式 deny 表；未知方法一律拒绝并留审计；单测覆盖整表。
3. 两个 daemon 缺陷（backlog）：a) 引擎进程死亡或 interrupt 未收尾时 activeTurn 清理，thread/close 在引擎已死时必须可用（复现：kill 引擎 → close 成功，不报 Thread is busy）；b) 显示端（agent-tui / codex TUI）断开或崩溃不得中断引擎 turn（复现：turn 进行中关掉显示端 → turn 继续完成）。
4. 升级回归：钉 codex-cli 0.153.4 与协议 schema（`codex app-server generate-json-schema --experimental` 生成物入库），`scripts/codex-ingress-upgrade-check.sh`：新版本 codex 二进制下重跑全部冒烟判据与 schema 校验并输出差异报告。
5. slice 2 二审 P2×3（`.fenjue/archive/fj-tui-ingress-slice2-review2-d860/out/review.md` §P2）一并收。
6. 全量测试与 typecheck 绿；两种后端全部判据冒烟各 3 次（含 unix://）；协议文档更新。产出 `$FENJUE_ROOT/.fenjue/tasks/$FENJUE_CID/out/result.md`。提交到本分支，交付时 `git status --short` 为空。
