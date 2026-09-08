# S158 · 2026-09-08 13:30–14:45 · 用户两次改向：不自研 TUI → 单一 TUI（Codex 官方）+ AS 对齐协议；只读门线收口；daemon 重启

## 改向脉络

1. 方案单（OpenTUI 渲染层 + 自写组件，18–20 单）出稿并获点头，阶段 0 与 1a 起单（合规脚本 / 依赖锁 / 基准夹具，均已通过：现有渲染器完整历史 p50/p95 30.9/33.1 ms，10000×216 单帧 158 ms，OpenTUI 0.19/0.25 ms）。
2. 用户看到坐席 pane 截图（工具输出全量倾倒、空 reasoning 占行、状态头占位符、无层次、硬折行）后明令：**不在 TUI 上下功夫，找现成能用的 TUI，把协议和 app server 对齐，不要增加开发量**；随后追问「不能复用同一套 TUI 吗」。
3. 两路 spike 同跑：
   - Claude Code 原生 TUI 直连：**证伪**。公开 2.1.258 的 direct-connect（`claude cc://host:port/token` + POST /sessions + WS stream-json）被 `bun:bundle` 编译期宏裁掉，无 flag/env 可开；remote-control 走 Anthropic 端点，`--sdk-url` 方向相反。留作盯梢项。
   - Codex 官方 TUI：**成立**。上游 CLI 公开 `--remote ADDR`（ws:// / unix://，bearer 经 HTTP upgrade），TUI 经 RemoteAppServerClient 连外部 app-server；18 行 Bun 代理让官方 0.153.4 TUI 跑通。推荐路径 (a)：AS 新增 app-server 协议 ingress，Codex 线程 native passthrough + AS 治理，估小接入 1–2 日、可用版 6–10 日；映射不可逆（保留 native 帧为真相源，AS 投影旁路）；治理冲突点：租约、经纪人一次提交、readonly 副作用入口、serviceTier/model guard；Claude 线程需 AS 合成 native item。
4. 处置：OpenTUI 阶段 1b–8 放弃（plan 标 [-]），阶段 0/1a 产物保留；agent-tui 信息设计急救单（折叠 / Ctrl-O / 状态头 / 分色 / 按词折行）照常收尾作过渡；起 tui-ingress-design（Opus）出四切片方案（Codex 端到端 / Claude 显示 / 多线程恢复 / 硬化与升级回归，目标 ≤ 8 坐席日）。

## 只读门线（agent-server）收口

- gate-fix（eb2416e）→ 四审需返工（门与 readonly_auto_allow 绑死、default/acceptEdits 独立 bash turn 无门、拒写审计不可达）→ gate-fix2（1ec942f）→ 五审需返工（仅 P1：禁用事实未持久化；leader 裁决持久化不放宽）→ gate-fix3（b45cc7c，approvals 迁移 turn_id 可空）→ 六审**通过**（迁移在生产库副本验证不丢行、幂等、可回滚）。P2 遗留记 backlog。
- daemon：13:57 以 1ec942f dist 重启（pid 91610）；b45cc7c dist 已重建，等坐席空闲再重启（重启前备份库）。实弹：pane 里排队的启动命令会在 kill 后自动再起 daemon。
- 事故：fix3 首个坐席显示端 pane 消失导致引擎 turn 被中断（backlog `agent-tui-detach-interrupts-turn`）；重挂显示端 + reply 续做后通过。

## 其它

- 阶段 2 计数：Claude 坐席 14 过 14（含 wave1-nits、gate-fix3、cc 两 spike、review3）。
- 清理：4 个残留 agent-browser 守护进程已关（用户点头），Chrome 44 → 0。
- 安装副本 seats.md 追加 daemon 重启实弹。

## Next

- ingress 方案 → 用户拍板 → slice 1（Codex 端到端）实现 + Opus 复核（官方 TUI PTY 冒烟）；slice 2 Claude 显示。
- 急救单验收 → 异源复核 → 切 bin（过渡期）。
- 空闲窗口重启 daemon（b45cc7c）。用户待决：Herdr 桥、影子与第二步、AS 合 main 与发包、daemon 常驻、mobile-nits 两分支合并。
