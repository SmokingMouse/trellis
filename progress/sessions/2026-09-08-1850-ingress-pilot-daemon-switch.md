# S160 · 2026-09-08 17:30–18:50 · slice 2/3 与租约修复收口；试点 daemon 切到 ingress 构建；fj 显示端切 codex-tui 并起两单试点

## codex-ingress

- slice 2 返工 → Opus 二审通过（干净 checkout 两后端 3/3、三条裁决真机、41 反例零回归，P2×3 记 backlog）。
- slice 3（多线程 / fork / 分页 / 断线恢复）交付并验收；Opus 复核：九判据两后端 3/3、517 测试、自生成官方 schema 校验响应 492 条 + 通知 293 条零失败、断线不杀线程、租约释放、pending 重放成立；唯一 P1 = 跨后端双线程判据 `list_contains_both_backends` 未真正跑 → slice3-fix 在跑（先合 feat/codex-ingress）。
- 租约修复（129f581）：resume/attach 不取租约，升权取短租约即释放，close/interrupt 不受他人租约门控；冒烟加 external_client_reply_while_attached_ok，通过验收。
- fj runner（焚决 70f7de6）`--runner codex-tui`：fj 自建线程注入契约、pane 起官方 `codex --remote … resume <uuid>`、93 行旁挂 reporter、去 ready-file；Opus 复核：fj 侧无 P0，两条跨组件缺口按裁决结案（Herdr protocol 19 无 waiting/done → 接受 idle+message 表达；AS 租约 → 已修）。

## 运行面切换

- 试点 daemon：库备份后从 feat-agent-server(b45cc7c) 切到 **feat-codex-ingress(129f581) dist**，`~/.agent-server/config.toml` 新建并开 `[codex_ingress] enabled=true, claude_threads=true, port=0`；pid 32072，endpoint.json 暴露 `codexIngressUrl: ws://127.0.0.1:54371`；approvals 24 行迁移无损。本次 kill 后无自动重起，直接 pane run 起新的。
- fj bundle 切到焚决 70f7de6（备份 `fj.js.bak-quickwin-*`），runners/codex-tui.md 装入安装副本；policy 加 `codex_bin`。
- codex-tui runner 试点：#1 as-readonly-p2-whitelist（Codex，find/rg/grep/file 白名单化）、#2 ingress-docs（Claude sonnet，协议章节校对 + README + 人类 quickstart）——两块 pane 都是官方 Codex TUI（`• Working (esc to interrupt)` / `› Ask Codex to do anything`），Claude 线程显示 `sonnet default`。`herdr agent get <seat>` 查无（reporter 的注册方式待核，fj status 正常）。

## Next

- slice3-fix → review2 → slice 4（治理硬化 + unix:// + 两个 daemon bug + 升级回归）；试点 3 单稳后 `FJ_RUNNER_DEFAULT=codex-tui`，agent-tui 退役（一周 dogfood 后删）。
- 用户待决不变：桥 / 影子与第二步 / mobile 两分支合并、AS 合 main 与发包、daemon 常驻、3490 实例停。
