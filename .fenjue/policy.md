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
agent_tui_bin: /Users/smokingmouse/.herdr/worktrees/sm-toolkit/feat-tui-display-quickwin/apps/agent-tui/bin/agent-tui   # 过渡期：急救版（feat/tui-display-quickwin e54fd64+），终审通过 2026-09-08 16:15；ingress 落地后退役
codex_bin: /Users/smokingmouse/.nvm/versions/node/v24.14.1/bin/codex   # codex-tui runner（官方 TUI 0.153.4）；ingress URL 从 endpoint.json 读，token env 默认 FJ_CODEX_INGRESS_TOKEN
---

# 授权卡（leader 接管时读一遍；用日常语言写）

## 不用问我，直接做
- 清理临时文件、关闭已验收的 pane
- blocker 带合理 fallback 的，按 fallback 走
- 需要选默认项的技术选择（库 / 目录 / 命名）

## 必须问我
- 发布、定价、对外发消息、动生产环境
- 删除未合入的分支或 worktree
- 同一失败出现两次之后怎么办

- **模型选择硬规则（用户 2026-09-07 明令）**：Fable 5.1 只做 leader 与裁决，执行类坐席（实现 / 探针 / 调研 / review）一律不用 Fable：`--kind claude` 必须带 `--env-file ~/.config/herdr-leader/presets/claude-official.env -- --model opus`（或 sonnet / gemini-flash 预设），本机 `~/.claude/settings.json` 默认 model 是 fable，裸起 claude 就会烧 Fable 额度。
- **codex 坐席不开 fast（用户 2026-09-07 明令）**：起位加 `-c 'service_tier="default"'`；已在跑的用 `/fast` 切回 default。
