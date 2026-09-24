---
# fj next 的机械开关（true/false）。改了立即生效，不用重启什么。
auto_ack_progress: true              # progress 信自动 ack，记进 task.json.last_progress
auto_ack_blocker_with_fallback: true # 有 fallback 的 blocker 视为「按 fallback 继续」，自动 ack
auto_settle_on_result: true          # 收到 result 立即独立验收（复跑 verify + 越界审计）
auto_close_accepted: true            # 验收通过立即关单归档
auto_retire_seat: true               # 关单后退位：writable 单先让坐席清服务，再关 pane
auto_rework_on_settle_fail: false    # 验收不过自动返工一次（不超 max_reworks）；默认交 leader 判断
nudge_stalled: true                  # 超 heartbeat 无信自动催一次，再超才报事件
takeover: false                      # 队列空了从 backlog.md 取下一单提示 leader 派
max_parallel_seats: 8
herdr_check_interval_ms: 15000
archive_window_hours: 24
setup_cmd: bun install
seats:
  gemini:
    kind: claude
    runner: native
    permission: full
    env_file: ~/.config/herdr-leader/presets/gemini-flash.env
  worker:                       # 2026-09-17 S176：实现位 = Claude 官方 opus（TUI runner，不吃 Fable）
    kind: claude
    runner: codex-tui
    model: opus
    permission: full
  reviewer:                     # 2026-09-16 17:30 改成 Claude 官方 opus：cpa 的 codex 号池 auth_unavailable（gpt-6-astra / 5.6 全挂），与 gemini 仍异源
    kind: claude
    runner: codex-tui
    model: opus
    permission: full
  reviewer-codex:               # 网关 codex 恢复后可切回
    kind: codex
    runner: codex-tui
    model: gpt-6-astra
    permission: full
    service_tier: default
agent_tui_bin: /Users/smokingmouse/.herdr/worktrees/sm-toolkit/feat-tui-display-quickwin/apps/agent-tui/bin/agent-tui   # 过渡期：急救版（feat/tui-display-quickwin e54fd64+），终审通过 2026-09-08 16:15；ingress 落地后退役
codex_bin: /Users/smokingmouse/.nvm/versions/node/v24.14.1/bin/codex   # codex-tui runner（官方 TUI 0.153.4）；ingress URL 从 endpoint.json 读，token env 默认 FJ_CODEX_INGRESS_TOKEN
---

# 授权卡（leader 接管时读一遍；用日常语言写）

## 不用问我，直接做
- 清理临时文件、关闭已验收的 pane
- blocker 带合理 fallback 的，按 fallback 走
- 需要选默认项的技术选择（库 / 目录 / 命名）

- **本轮落地授权（用户 2026-09-08 20:1x 明令「直接都干完，不需要经过我」）**：sm-toolkit feat/codex-ingress 合 main 与发 PR、焚决合 main、daemon launchd 常驻、Trellis feat/ship-d 的 PR 合并与 `make deploy` 上线、给一个项目开 TRELLIS_AS 切流——全部不再问用户；验活脚本不绿不部署，部署后验活失败立即回退（上一版镜像 / TRELLIS_AS=off）。仅限本轮清单，新方向仍问。

## 必须问我
- 发布、定价、对外发消息、动生产环境
- 删除未合入的分支或 worktree
- 同一失败出现两次之后怎么办

- **模型选择硬规则（用户 2026-09-07 明令）**：Fable 5.1 只做 leader 与裁决，执行类坐席（实现 / 探针 / 调研 / review）一律不用 Fable：`--kind claude` 必须带 `--env-file ~/.config/herdr-leader/presets/claude-official.env -- --model opus`（或 sonnet / gemini-flash 预设），本机 `~/.claude/settings.json` 默认 model 是 fable，裸起 claude 就会烧 Fable 额度。**默认 runner 已是 codex-tui（`FJ_RUNNER_DEFAULT`），它不接受 --env-file / 原生 agent 参数，写法是 `--runner codex-tui --kind claude --model opus --permission full`；只有 `--runner native` 才用 --env-file 形式（S174 踩坑）。**
- **Linux devbox 坐席走 llm 的方式（用户 2026-09-24 明令「使用 llm 命令的方式」）**：本机 claude 没有自己的登录态，裸起即「Not logged in」；坐席用 `~/.config/herdr-leader/seat-presets.yaml` 里复刻 `llm cpa:<model>` 环境的预设（`gemini37` 实现 / `cpa-sonnet5` review）。实测 cpa 的 `ag/claude-*` 多轮工具调用必 400、不能当坐席；super-relay `alwaysday1_max` 自报 Fable 5，按上条不用；`cpa-sonnet5` 烧本人 Claude 订阅，只给 review 这类短时高价值单（本轮 review-access 用户已拍板）。本 policy frontmatter 的 worker/reviewer 预设是 Mac 路径，这台机器不可用。
- **codex 坐席不开 fast（用户 2026-09-07 明令）**：起位加 `-c 'service_tier="default"'`；已在跑的用 `/fast` 切回 default。
