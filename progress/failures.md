# Open Failures

## 待查

- **prod（launchd）spawn 出来的 claude 一律认证失败：`Failed to authenticate: OAuth session expired and could not be refreshed`，1 秒内失败、0 token**（S90 实测，两次任务 run：`e36742ae` / `4d36c94c`，`claude:claude-sonnet-5` 与默认 provider 都是这条）。**这不是任务链路的问题**——建任务/抢槽/建会话/spawn/捕获错误/留档全跑通了，死在最后一步 spawn。**已排除**：① 本机凭证过期（裸 `claude -p` 正常，`~/.claude/.credentials.json` mtime 今天 11:30）；② proxy（`env -u http_proxy…` 下正常）；③ launchd 的 PATH/HOME（用 plist 里那份 PATH + `env -i` 复现，正常）；④ 环境变量污染（`ps eww` 里没有任何 `ANTHROPIC_*`/`CLAUDE_*`，`shared/.env.local` 只有 4 个 `TRELLIS_*` key）；⑤ `--model opus`（默认 provider `claude-opus` 走 `NATIVE_TIER_ALIASES` 直通、不注 env，单独加这个 flag 复现也正常）。**即：在 trellis 进程外用同样的 PATH/HOME/model 怎么都复现不出来。** 旁证：`nodes` 表最近一次 `done` 停在 **07-28 10:52**，此后到今天只有我这两条 error —— 所以很可能 prod 的交互式会话也早就是坏的，只是三天没人用所以没人知道。**下个 session 先打这个**：在 prod 里发一句普通聊天（不是任务），若同样报 OAuth → 是 prod 实例级故障、与自动化任务无关，先 `launchctl kickstart -k` 重启看是否自愈；若聊天正常而任务失败 → 差异只可能在 `lib/server/tasks.ts:launch()` 构造的那份 StreamRequest 里，逐字段对照 `app/api/chat/route.ts` 的调用。

- **主目录 `next dev` 起的实例前端永远停在「加载中…」，React 从不 hydrate**（S75，:3164 实测）。证据：`document.body.firstElementChild` 上 `__react*` fiber key 数 = 0（纯 SSR HTML）、全部 `_next` chunk 均 200、console 无 error、`/api/sessions` 只有 curl 打的没有浏览器打的（说明 effect 从未跑）、`matchMedia` 正常。**已排除**是 S75 改动引入——`git stash` 回干净 main 后同样复现。**假设**（未验）：Turbopack 那条 `Parsing CSS source code failed`（`app/globals.css` 的 `::highlight(branch-source)` 被判非法伪元素，dev 日志里刷了 7 次）打断了 client bundle 的执行链。**下个 session 先打这个**：临时注释掉该 CSS 规则重起 dev，看 fiber 是否挂上；挂上即坐实，那条规则要么换写法要么加 `@supports` 包一层。prod（`next start`）不受影响，:3088 实测正常。

## 已结案

（暂无）
