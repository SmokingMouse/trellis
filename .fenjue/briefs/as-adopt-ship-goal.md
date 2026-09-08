目标：把「外部线程收编主页」上线：feat/as-adopt（f54ced4，二审通过）→ PR 合 main → make deploy → 生产打开 `TRELLIS_AS_ADOPT=on` → 真机验活 → 写明回退。本 worktree = feat/as-adopt；origin 已有同名分支（主控已推）。本单**允许 git push**（只推 feat/as-adopt 与合并所需提交，不推别的分支）。

## 输入

- 二审报告 `/Users/smokingmouse/python/learning/trellis/.fenjue/archive/fj-as-adopt-review2-ebce/out/review2.md`（结论通过；N-1～N-3 三条知情项）；返工交付 `.fenjue/archive/fj-as-adopt-fix-4fb3/out/result.md`；语义 `.fenjue/briefs/as-adopt-goal.md` + `as-adopt-fix-goal.md`。
- 生产：Trellis 3088（网关）/3187（Next），配置真源 `~/.trellis/shared/.env.local`（当前 `TRELLIS_AS=on`、`TRELLIS_AS_PROJECT=on`、`TRELLIS_AS_PROJECT_ID=<暂存区>`），重启 `launchctl kickstart -k gui/$(id -u)/com.smokingmouse.trellis`（网关是 `com.smokingmouse.trellis-gw`，部署脚本会处理）。`make deploy` = 新目录 build + 预检 + 原子切换 + 验活失败自动回滚；`make rollback` 回上一 release。daemon endpoint `~/.sm-toolkit/agent-server.sock.endpoint.json`（端口每次重启会变），token `~/.agent-server/token`。生产上 daemon 有别的坐席线程在跑，**只碰你自建的临时线程**。
- 主仓 `/Users/smokingmouse/python/learning/trellis` 有主控未提交的 progress/.fenjue 改动：合并后 `git pull --ff-only` 即可（PR 不碰这些文件）；不要 stash/reset 主仓。

## 步骤

1. 在本 worktree `git merge origin/main`（main 现含侧栏波 1，预检无冲突；若有冲突按语义解），`bunx tsc --noEmit`、`bun test` 全绿，统一前缀独占跑 `mobile-as-adopt.sh`、`mobile-as-project.sh`、`mobile-new-session.sh` 各一次绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），push。
2. README 收编段落补一句二审 N-1（每轮 `thread/list` 底噪随历史线程数线性增长，约 160 条线程后单轮超 100 KB，已记 backlog）与 N-2（非 git 目录项目如「投研」不参与归属，其下外部线程进「外部会话」）。
3. `gh pr create --base main --head feat/as-adopt`（正文写语义、开关、回退、二审结论链接）→ `gh pr merge --merge`。主仓 `git pull --ff-only` 到合并提交。
4. 主仓 `make deploy`（先确认没有别的部署在跑：`ls -t ~/.trellis/releases | head -1` 与 `readlink ~/.trellis/current`；机器负载高时验活可能超时，失败就等负载降后重跑一次，仍失败才报 blocker）。验活：`/__gate/health` next=ready，首页与旧会话页 200。
5. 打开开关：`~/.trellis/shared/.env.local` 先备份为 `.env.local.pre-as-adopt`，加 `TRELLIS_AS_ADOPT=on`，`launchctl kickstart -k gui/$(id -u)/com.smokingmouse.trellis`，健康 200。
6. 真机验活（生产实例，不是隔离实例）：用 as/1 对常驻 daemon 建一条显式 `model: sonnet` 临时线程（cwd 用 `~/.trellis/scratch/` 下新建临时目录），先外部跑一轮；≤5 秒后生产 `/api/sessions`（带 cookie，token 在 .env.local 的 TRELLIS_TOKEN）里出现该会话且归「外部会话」项目；在生产页面（agent-browser，桌面 1440×900 + 手机 390×844 截图）打开它看到回填节点；主页续问一轮拿到回复；删除该会话后线程仍活；最后 close 该临时线程并删掉临时目录。同时用二审的 `svc-probe2.ts` 思路观察 10 分钟生产 daemon 负载：每轮只 1 次 list、无变化零 attach（数字写进 result）。
7. 回退写进 result：`TRELLIS_AS_ADOPT=off`（或删掉该行）+ kickstart 即停止收编，已收编会话保留只读；代码回退 `make rollback`。

## 交付

- `out/result.md`：每步命令与 exit、PR 链接与合并提交、release 名、开关前后 env diff、真机证据（截图、API 片段、探针数字）、回退方法、已知限制（N-1～N-3）。**不要发 partial result**，中间只用 progress；全部完成后发唯一一封 result（done）。验活任一步失败且重试一次仍失败：立即 `TRELLIS_AS_ADOPT=off` 回退并 kickstart，再报 blocker。
