目标：外部线程收编已上线（生产 release 0f126ab5e，`TRELLIS_AS_ADOPT=on`），只读观察页失去存在意义，删掉它及其专属代码、脚本与文档引用；PR 合 main 并部署。本 worktree 从 main（含 PR #48/#49）拉出；本单**允许 git push**（只推本分支）。

## 删什么

- 路由与组件：`app/console/threads/page.tsx`（及 `app/console` 目录若为空）、`app/api/as/threads/route.ts`、`app/api/as/threads/[id]/stream/route.ts`、`components/ThreadLogView.tsx`。
- 库代码：`lib/as-shadow.ts`、`lib/as-log.ts`、`lib/server/as-sse.ts` 及 `lib/server/as-client.ts` 里的 `ShadowClient` / `getShadowClient` **仅当**没有其它使用者（先 `rg` 全仓核对：收编 `lib/server/as-adopt.ts`、第二步 `as-project.ts`、`createProjectClient` 等若复用了 AgentClient 封装或类型，保留被复用的部分，只删观察页专属部分）。相关测试同步删或改。
- 脚本：`scripts/mobile-verify/mobile-as-shadow.sh`、`as-shadow-fixture.ts`、`as-shadow-http-verify.ts`（先核对 `as-adopt` / `as-project` 的 fixture 是否 import 了它们，有依赖就把共用部分搬到被依赖方再删）。
- 文档：README、`.env.example`、`docs/`、`progress/` 里对 `/console/threads`「会话观察」「影子只读页」的说明改为指向主页收编（`TRELLIS_AS_ADOPT`）；`progress/sidebar-tree-ia.md` 不动。
- `isShadowEnabled` 若只服务观察页则删；`TRELLIS_AS` 总开关语义不变。

## 验收

- `bunx tsc --noEmit`、`bun test` 全绿；`rg -n "console/threads|ThreadLogView|as-shadow|mobile-as-shadow" app components lib scripts README.md docs` 零命中（progress/ 历史记录除外）。
- 统一前缀独占跑 `mobile-as-adopt.sh`、`mobile-as-project.sh`、`mobile-new-session.sh` 各一次绿（前缀 `env -i HOME=/Users/smokingmouse PATH="$PATH" TRELLIS_LARK=off TRELLIS_SCHEDULER=off TRELLIS_HOOKS=off TRELLIS_HERDR=off TRELLIS_VERIFY_SOURCE_DB=/Users/smokingmouse/.trellis/data.db`），跑完 3471–3480 无监听、锁已清。
- `gh pr create --base main` → `gh pr merge --merge`；主仓 `git pull --ff-only`；主仓 `make deploy`（先看 `readlink ~/.trellis/current` 与 `ls -t ~/.trellis/releases | head -1` 确认没有别的部署在跑；验活失败等负载降后重试一次，仍失败回滚并报 blocker）；部署后生产 `/console/threads` 返回 404、`/__gate/health` next=ready、首页 200、`/api/sessions` 里仍能看到 origin=external 的收编会话。
- `out/result.md`：删除清单、保留了什么及原因、命令与 exit、PR 与合并提交、release 名、生产验活证据、回退（`make rollback`）。**不要发 partial result**，中间只用 progress；完成后发唯一一封 done。
