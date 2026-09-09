# S170 · 2026-09-09 15:00–16:10 · 默认 runner 切 codex-tui、投研 git init、待办层交付

## 已落地

- **`FJ_RUNNER_DEFAULT=codex-tui`**（用户拍板）：写入 `~/.zshenv`，新 shell 验证生效；记进 `~/.config/herdr-leader/environment.md`。效果：所有 leader 新起的坐席默认走 agent-server daemon（官方 Codex TUI 显示端），被收编后主页有真流、可审批可中断。已在跑的 leader 进程需重开 pane 或显式 `--runner codex-tui`。
- **投研 `git init`**（用户拍板）：`~/python/learning/投研` 初始化为 git 仓库，收编归属把它当真实项目根；该目录当时为空（只有 `.git`），已告知用户。
- **待办层**（fj-pending-bar-5cfe，验收 5/5，PR feat/pending-bar 合 main 并部署，release 见 `~/.trellis/current`）：`lib/server/pending.ts` 内存投影（run-bus 持久化 pending + as-project/as-adopt 订阅维护的 pendingRequests），`/api/sessions`、`/api/runs` 只同步读内存快照、不连 AS、无新增轮询，随既有 SSE 推送 `pending_snapshot`；桌面 Header 下「有 N 项等你处理」横条（单项 / 折叠 / 展开、去处理、就地允许一次 / 拒绝、远端处理撤卡）；审批卡改为「允许一次」主 / 「拒绝」次 / 「本轮总是允许」文字按钮；手机复用等待横幅 + sheet；导航用 store `openNodeInSession`。两次停机：① 手机跨会话「去处理」走 URL 载入失败 → 改用 store 导航；② 桌面重开会话 5.1 秒 hydrate AbortError → **真根因是两条全局 SSE 占满 HTTP/1 连接**（请求 5.1 秒在发送前被取消，服务端实际 0.2 ms；我最初猜 AS 连接超时是错的），修：SSE pagehide 释放 + BFCache 处理，hydrate 被新导航取代时不重置 URL、真超时重试一次；修后 `/api/sessions/<id>` 1.6–5.8 ms。312 单测、11 条脚本绿。

## 教训

- 「响应恰好 5 秒」不一定是服务端超时，也可能是浏览器连接池被 SSE 占满、请求根本没发出去；判断前先看 requestStart/responseStart 是否为 0。

## Next

- 观察一天后 AS 切流扩到全部项目（删 `TRELLIS_AS_PROJECT_ID`）。
- backlog：`codex-interrupt-leaves-exec-alive`（P1）、`deploy-guard-counts-external-sessions`、`as-adopt-list-noise-grows-with-history`、launchd PATH 补 rg、`codex-ingress-upgrade-check-interrupt-flaky`、`codex-ingress-picker-model-save`。
