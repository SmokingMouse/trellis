# Open Failures

## 待查

- **主目录 `next dev` 起的实例前端永远停在「加载中…」，React 从不 hydrate**（S75，:3164 实测）。证据：`document.body.firstElementChild` 上 `__react*` fiber key 数 = 0（纯 SSR HTML）、全部 `_next` chunk 均 200、console 无 error、`/api/sessions` 只有 curl 打的没有浏览器打的（说明 effect 从未跑）、`matchMedia` 正常。**已排除**是 S75 改动引入——`git stash` 回干净 main 后同样复现。**假设**（未验）：Turbopack 那条 `Parsing CSS source code failed`（`app/globals.css` 的 `::highlight(branch-source)` 被判非法伪元素，dev 日志里刷了 7 次）打断了 client bundle 的执行链。**下个 session 先打这个**：临时注释掉该 CSS 规则重起 dev，看 fiber 是否挂上；挂上即坐实，那条规则要么换写法要么加 `@supports` 包一层。prod（`next start`）不受影响，:3088 实测正常。

## 已结案

- **prod（launchd）spawn 出来的 claude 一律认证失败：`Failed to authenticate: OAuth session expired and could not be refreshed`**（S90 发现，S93 破案修复）→ `resolved`。**起作用的是**：`security delete-generic-password -s "Claude Code-credentials"` 删掉 Keychain 里 7-26 停更的死凭证副本（refresh token 被文件侧单次轮换作废后永久判死；launchd 上下文的 claude 读 keychain、终端读 `~/.claude/.credentials.json`，所以终端永远复现不出来——S90 五条排除全扑空的原因）。修后验证三级全绿：一次性 launchd job 裸跑 `claude -p`（修前 80ms 本地判死 `api_ms:0`，修后真调 API 返 "ok"）→ 真 prod 任务 run `45350b21` done/6 token。**方法论**：怀疑 launchd 特有故障时，判定必须用一次性 launchd job（`launchctl bootstrap gui/$(id -u) <plist>`），`env -i` 复制得了 env、复制不了「不是 launchd」。复发哨兵：keychain 条目重新出现且 mdat 冻结。机器级事实在 workspace.md 凭证表 + 复发坑表。
